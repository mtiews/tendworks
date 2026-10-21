import { createInMemoryApprovals, createInMemoryRuns, type ApprovalRequest } from "@tendworks/control-plane";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { READ_TOKEN, renderApp, signedIn } from "./support/platform.js";
import { rows } from "./support/table.js";

const PULL_REQUEST = "https://github.com/acme/playground/pull/13";

// The request of `tend approval`'s tests, so the page shows what `tend approval list` shows.
const pending: ApprovalRequest = {
  id: "5e1f-approval-pending",
  runId: "0b6c4c1e-run",
  workflow: "develop-issue",
  action: "merge",
  pullRequest: PULL_REQUEST,
  policy: "ask-before-merge",
  question: "Merge https://github.com/acme/playground/pull/13 for run 0b6c4c1e-run of develop-issue?",
  status: "pending",
  createdAt: "2026-10-19T10:00:00.000Z",
};

const approved: ApprovalRequest = {
  ...pending,
  id: "3c2a-approval-approved",
  runId: "9a8b-run",
  pullRequest: "https://github.com/acme/playground/pull/12",
  question: "Merge https://github.com/acme/playground/pull/12 for run 9a8b-run of develop-issue?",
  status: "approved",
  createdAt: "2026-10-19T11:00:00.000Z",
  decidedAt: "2026-10-19T11:02:00.000Z",
};

const decisions = (requests: Request[]) => requests.filter((request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/decision"));

function openApprovals(requests: ApprovalRequest[], token?: string) {
  signedIn(token);
  const approvals = createInMemoryApprovals(requests);
  return { approvals, ...renderApp({ path: "/ui/approval-requests", approvals }) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("approval requests page", () => {
  it("lists pending requests first, then decided ones with their decision, like `tend approval list`", async () => {
    openApprovals([approved, pending]);

    const table = await screen.findByRole("table", { name: "Approval requests" });
    expect(rows(table)).toEqual([
      ["Status", "Question", "Run", "Requested", "Decided", "Actions"],
      ["pending", `${pending.question}merge · ask-before-merge`, "0b6c4c1e-run", pending.createdAt, "", "ApproveReject"],
      ["approved", `${approved.question}merge · ask-before-merge`, "9a8b-run", approved.createdAt, approved.decidedAt, ""],
    ]);
    expect(screen.getByRole("link", { name: "0b6c4c1e-run" }).getAttribute("href")).toBe("/ui/runs/0b6c4c1e-run");
  });

  it("shows how long ago each request was made", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-21T12:00:00.000Z"), shouldAdvanceTime: true });
    const at = (iso: string, id: string) => ({ ...approved, id, createdAt: iso });
    openApprovals([at("2026-10-21T11:59:30.000Z", "a"), at("2026-10-21T11:15:00.000Z", "b"), at("2026-10-21T07:00:00.000Z", "c"), at("2026-10-18T12:00:00.000Z", "d")]);

    const table = await screen.findByRole("table", { name: "Approval requests" });
    const ages = [...table.querySelectorAll("tbody tr")].map((row) => row.querySelectorAll("time")[0]?.textContent);
    expect(ages).toEqual(["just now", "45 min ago", "5 h ago", "3 days ago"]);
  });

  it("approves a pending request only after the operator confirms", async () => {
    const { user, platform } = openApprovals([pending]);
    const table = await screen.findByRole("table", { name: "Approval requests" });

    await user.click(within(table).getByRole("button", { name: "Approve" }));
    const confirmation = screen.getByRole("alertdialog", { name: "Approve this request?" });
    expect(confirmation.textContent).toContain(pending.question);
    expect(decisions(platform.requests)).toEqual([]);
    await user.click(within(confirmation).getByRole("button", { name: "Approve" }));

    expect(await screen.findByText("approved")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(await Promise.all(decisions(platform.requests).map((request) => request.json()))).toEqual([{ decision: "approve" }]);
  });

  it("rejects a pending request after confirmation", async () => {
    const { user } = openApprovals([pending]);

    await user.click(await screen.findByRole("button", { name: "Reject" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Reject this request?" })).getByRole("button", { name: "Reject" }));

    expect(await screen.findByText("rejected")).toBeTruthy();
  });

  it("decides nothing when the operator cancels the confirmation or presses Escape", async () => {
    const { user, platform } = openApprovals([pending]);

    const approve = await screen.findByRole("button", { name: "Approve" });
    await user.click(approve);
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Approve" }));

    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(document.activeElement).toBe(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();

    expect(decisions(platform.requests)).toEqual([]);
    expect(screen.getByText("pending")).toBeTruthy();
  });

  it("shows a request decided elsewhere (`tend`, another tab) as decided without a reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { approvals } = openApprovals([pending]);
    await screen.findByRole("button", { name: "Approve" });

    await approvals.decide(pending.id, "reject");
    await act(() => vi.advanceTimersByTimeAsync(5_000));

    expect(await screen.findByText("rejected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("says when the request was decided the other way meanwhile, and shows that decision", async () => {
    const { user, approvals } = openApprovals([pending]);
    await user.click(await screen.findByRole("button", { name: "Approve" }));

    await approvals.decide(pending.id, "reject");
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Approve" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Approval request already decided (409)");
    expect(await screen.findByText("rejected")).toBeTruthy();
  });

  it("links the URLs in the question, opening them in a new tab", async () => {
    openApprovals([pending]);

    const table = await screen.findByRole("table", { name: "Approval requests" });
    const link = within(table).getByRole("link", { name: PULL_REQUEST });
    expect(link.getAttribute("href")).toBe(PULL_REQUEST);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("keeps trailing punctuation out of links and leaves other URL schemes as text", async () => {
    const question = "Merge (https://github.com/acme/playground/pull/13), see https://example.test/notes. Or javascript:alert(1)?";
    openApprovals([{ ...pending, question }]);

    const table = await screen.findByRole("table", { name: "Approval requests" });
    const links = within(table)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("target") === "_blank");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["https://github.com/acme/playground/pull/13", "https://example.test/notes"]);
    expect(links.map((link) => link.textContent)).toEqual(["https://github.com/acme/playground/pull/13", "https://example.test/notes"]);
    expect(rows(table)[1]?.[1]).toBe(`${question}merge · ask-before-merge`);
  });

  it("offers no actions in read-only mode", async () => {
    openApprovals([pending, approved], READ_TOKEN);

    const table = await screen.findByRole("table", { name: "Approval requests" });
    expect(rows(table)[0]).toEqual(["Status", "Question", "Run", "Requested", "Decided"]);
    expect(within(table).queryAllByRole("button")).toEqual([]);
  });

  it("says when there are no approval requests, and when they cannot be read", async () => {
    openApprovals([]);
    expect(await screen.findByText("No approval requests yet.")).toBeTruthy();

    cleanup();
    signedIn();
    renderApp({ path: "/ui/approval-requests" });
    expect((await screen.findByRole("alert")).textContent).toBe("Cannot read the approval requests. Is the platform running?");
  });
});

function openRun(requests: ApprovalRequest[], token?: string) {
  signedIn(token);
  const runs = createInMemoryRuns();
  runs.runs.set(pending.runId, { id: pending.runId, workflow: "develop-issue", status: "running", input: {}, steps: [], createdAt: pending.createdAt });
  const approvals = createInMemoryApprovals(requests);
  return { approvals, ...renderApp({ path: `/ui/runs/${pending.runId}`, runs, approvals }) };
}

const otherRun: ApprovalRequest = { ...pending, id: "7d7d-approval-other", runId: "other-run", question: "Merge for another run?" };

describe("pending approval request on the run detail", () => {
  it("shows the run's pending request and approves it after confirmation", async () => {
    const { user, platform } = openRun([otherRun, pending]);

    const region = await screen.findByRole("region", { name: "Approval request" });
    expect(region.textContent).toContain(pending.question);
    expect(region.textContent).not.toContain(otherRun.question);
    await user.click(within(region).getByRole("button", { name: "Approve" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Approve this request?" })).getByRole("button", { name: "Approve" }));

    expect((await screen.findByRole("status")).textContent).toBe("Approval request approved. The run continues.");
    expect(screen.queryByRole("region", { name: "Approval request" })).toBeNull();
    expect(await Promise.all(decisions(platform.requests).map((request) => request.json()))).toEqual([{ decision: "approve" }]);
  });

  it("rejects the run's pending request after confirmation", async () => {
    const { user } = openRun([pending]);

    await user.click(await screen.findByRole("button", { name: "Reject" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Reject this request?" })).getByRole("button", { name: "Reject" }));

    expect((await screen.findByRole("status")).textContent).toBe("Approval request rejected. The run continues.");
  });

  it("says when the request was decided elsewhere meanwhile", async () => {
    const { user, approvals } = openRun([pending]);
    await user.click(await screen.findByRole("button", { name: "Approve" }));

    await approvals.decide(pending.id, "reject");
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Approve" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Approval request already decided (409)");
    expect(screen.queryByRole("region", { name: "Approval request" })).toBeNull();
  });

  it("shows nothing for a run without a pending request", async () => {
    const { platform } = openRun([otherRun, { ...pending, status: "approved", decidedAt: pending.createdAt }]);

    await screen.findByText("No steps yet.");
    await waitFor(() => expect(platform.requests.some((request) => new URL(request.url).pathname === "/approval-requests")).toBe(true));
    await act(() => Promise.resolve());
    expect(screen.queryByRole("region", { name: "Approval request" })).toBeNull();
  });

  it("links the URLs in the question, opening them in a new tab", async () => {
    openRun([pending]);

    const region = await screen.findByRole("region", { name: "Approval request" });
    const link = within(region).getByRole("link", { name: PULL_REQUEST });
    expect(link.getAttribute("href")).toBe(PULL_REQUEST);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("shows the pending request without actions in read-only mode", async () => {
    openRun([pending], READ_TOKEN);

    const region = await screen.findByRole("region", { name: "Approval request" });
    expect(region.textContent).toContain(pending.question);
    expect(within(region).queryAllByRole("button")).toEqual([]);
  });
});

