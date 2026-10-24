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
  workflow: "wait-for-merge",
  step: "/do/1/confirmMerge",
  action: "merge-pull-request",
  policy: "careful",
  question: "Merge https://github.com/acme/playground/pull/13, then continue?",
  links: [{ title: "Pull request", url: PULL_REQUEST }],
  answers: [
    { label: "Merged – continue", outcome: "continue" },
    { label: "Cancel", outcome: "stop" },
  ],
  status: "pending",
  createdAt: "2026-10-19T10:00:00.000Z",
};

const decided: ApprovalRequest = {
  ...pending,
  id: "3c2a-approval-decided",
  runId: "9a8b-run",
  question: "Merge https://github.com/acme/playground/pull/12, then continue?",
  links: [],
  status: "decided",
  answer: "Merged – continue",
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
  it("lists pending requests first with their answers, then decided ones with the chosen answer, like `tend approval list`", async () => {
    openApprovals([decided, pending]);

    const table = await screen.findByRole("table", { name: "Approval requests" });
    expect(rows(table)).toEqual([
      ["Status", "Question", "Run", "Requested", "Decided", "Actions"],
      ["pending", `${pending.question}Pull requestmerge-pull-request · careful`, "0b6c4c1e-run", pending.createdAt, "", "Merged – continueCancel"],
      ["decided", `${decided.question}merge-pull-request · careful`, "9a8b-run", decided.createdAt, `Merged – continue${decided.decidedAt}`, ""],
    ]);
    expect(screen.getByRole("link", { name: "0b6c4c1e-run" }).getAttribute("href")).toBe("/ui/runs/0b6c4c1e-run");
  });

  it("shows the request's links, opening them in a new tab", async () => {
    openApprovals([pending]);

    const link = await screen.findByRole("link", { name: "Pull request" });
    expect(link.getAttribute("href")).toBe(PULL_REQUEST);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("names only the action when no policy applied", async () => {
    const { policy: _policy, ...unpolicied } = pending;
    openApprovals([unpolicied]);

    const table = await screen.findByRole("table", { name: "Approval requests" });
    expect(rows(table)[1]?.[1]).toBe(`${pending.question}Pull requestmerge-pull-request`);
  });

  it("shows how long ago each request was made", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-21T12:00:00.000Z"), shouldAdvanceTime: true });
    const at = (iso: string, id: string) => ({ ...decided, id, createdAt: iso });
    openApprovals([at("2026-10-21T11:59:30.000Z", "a"), at("2026-10-21T11:15:00.000Z", "b"), at("2026-10-21T07:00:00.000Z", "c"), at("2026-10-18T12:00:00.000Z", "d")]);

    const table = await screen.findByRole("table", { name: "Approval requests" });
    const ages = [...table.querySelectorAll("tbody tr")].map((row) => row.querySelectorAll("time")[0]?.textContent);
    expect(ages).toEqual(["just now", "45 min ago", "5 h ago", "3 days ago"]);
  });

  it("decides a pending request with an answer only after the operator confirms what the run then does", async () => {
    const { user, platform } = openApprovals([pending]);
    const table = await screen.findByRole("table", { name: "Approval requests" });

    await user.click(within(table).getByRole("button", { name: "Merged – continue" }));
    const confirmation = screen.getByRole("alertdialog", { name: "Answer “Merged – continue”?" });
    expect(confirmation.textContent).toContain(pending.question);
    expect(confirmation.textContent).toContain("The run continues.");
    expect(decisions(platform.requests)).toEqual([]);
    await user.click(within(confirmation).getByRole("button", { name: "Merged – continue" }));

    expect(await screen.findByText("decided")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(await Promise.all(decisions(platform.requests).map((request) => request.json()))).toEqual([{ answer: "Merged – continue" }]);
  });

  it("says that an answer that stops ends the run", async () => {
    const { user } = openApprovals([pending]);

    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    const confirmation = screen.getByRole("alertdialog", { name: "Answer “Cancel”?" });
    expect(confirmation.textContent).toContain("The run stops.");
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));

    expect(await screen.findByText("decided")).toBeTruthy();
    expect(within(screen.getByRole("table", { name: "Approval requests" })).getByText("Cancel")).toBeTruthy();
  });

  it("decides nothing when the operator cancels the confirmation or presses Escape", async () => {
    const { user, platform } = openApprovals([pending]);

    const proceed = await screen.findByRole("button", { name: "Merged – continue" });
    await user.click(proceed);
    // The safe choice is not called Cancel, since an answer may be.
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Merged – continue" }));

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Not now" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();

    expect(decisions(platform.requests)).toEqual([]);
    expect(screen.getByText("pending")).toBeTruthy();
  });

  it("shows a request decided elsewhere (`tend`, another tab) as decided without a reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { approvals } = openApprovals([pending]);
    await screen.findByRole("button", { name: "Merged – continue" });

    await approvals.decide(pending.id, "Cancel");
    await act(() => vi.advanceTimersByTimeAsync(5_000));

    expect(await screen.findByText("decided")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Merged – continue" })).toBeNull();
  });

  it("says when the request was decided with another answer meanwhile, and shows that answer", async () => {
    const { user, approvals } = openApprovals([pending]);
    await user.click(await screen.findByRole("button", { name: "Merged – continue" }));

    await approvals.decide(pending.id, "Cancel");
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Merged – continue" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Approval request already decided (409)");
    expect(await screen.findByText("decided")).toBeTruthy();
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
    openApprovals([{ ...pending, question, links: [] }]);

    const table = await screen.findByRole("table", { name: "Approval requests" });
    const links = within(table)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("target") === "_blank");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["https://github.com/acme/playground/pull/13", "https://example.test/notes"]);
    expect(links.map((link) => link.textContent)).toEqual(["https://github.com/acme/playground/pull/13", "https://example.test/notes"]);
    expect(rows(table)[1]?.[1]).toBe(`${question}merge-pull-request · careful`);
  });

  it("offers no answers to choose in read-only mode", async () => {
    openApprovals([pending, decided], READ_TOKEN);

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
  runs.runs.set(pending.runId, { id: pending.runId, workflow: "wait-for-merge", status: "running", input: {}, steps: [], createdAt: pending.createdAt });
  const approvals = createInMemoryApprovals(requests);
  return { approvals, ...renderApp({ path: `/ui/runs/${pending.runId}`, runs, approvals }) };
}

const otherRun: ApprovalRequest = { ...pending, id: "7d7d-approval-other", runId: "other-run", question: "Merge for another run?" };

describe("pending approval request on the run detail", () => {
  it("shows the run's pending request with its links and decides it with an answer after confirmation", async () => {
    const { user, platform } = openRun([otherRun, pending]);

    const region = await screen.findByRole("region", { name: "Approval request" });
    expect(region.textContent).toContain(pending.question);
    expect(region.textContent).not.toContain(otherRun.question);
    expect(within(region).getByRole("link", { name: "Pull request" }).getAttribute("href")).toBe(PULL_REQUEST);
    await user.click(within(region).getByRole("button", { name: "Merged – continue" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Answer “Merged – continue”?" })).getByRole("button", { name: "Merged – continue" }));

    expect((await screen.findByRole("status")).textContent).toBe("Answered “Merged – continue”. The run continues.");
    expect(screen.queryByRole("region", { name: "Approval request" })).toBeNull();
    expect(await Promise.all(decisions(platform.requests).map((request) => request.json()))).toEqual([{ answer: "Merged – continue" }]);
  });

  it("says that the run stops after an answer that stops it", async () => {
    const { user } = openRun([pending]);

    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Answer “Cancel”?" })).getByRole("button", { name: "Cancel" }));

    expect((await screen.findByRole("status")).textContent).toBe("Answered “Cancel”. The run stops.");
  });

  it("says when the request was decided elsewhere meanwhile", async () => {
    const { user, approvals } = openRun([pending]);
    await user.click(await screen.findByRole("button", { name: "Merged – continue" }));

    await approvals.decide(pending.id, "Cancel");
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Merged – continue" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Approval request already decided (409)");
    expect(screen.queryByRole("region", { name: "Approval request" })).toBeNull();
  });

  it("shows nothing for a run without a pending request", async () => {
    const { platform } = openRun([otherRun, { ...pending, status: "decided", answer: "Cancel", decidedAt: pending.createdAt }]);

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

  it("shows the pending request without answers to choose in read-only mode", async () => {
    openRun([pending], READ_TOKEN);

    const region = await screen.findByRole("region", { name: "Approval request" });
    expect(region.textContent).toContain(pending.question);
    expect(within(region).getByRole("link", { name: "Pull request" })).toBeTruthy();
    expect(within(region).queryAllByRole("button")).toEqual([]);
  });
});
