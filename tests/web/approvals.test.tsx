import { createInMemoryApprovals, createInMemoryRuns, type ApprovalRequest } from "@tendworks/control-plane";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { READ_TOKEN, renderApp, signedIn } from "./support/platform.js";

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

describe("decided approval requests in the inbox", () => {
  it("lists only decided requests, newest first, each with question, answer, decision time and a link to its run", async () => {
    const older: ApprovalRequest = { ...decided, id: "1b1b-approval-older", runId: "8c8c-run", answer: "Cancel", decidedAt: "2026-10-19T09:02:00.000Z" };
    openApprovals([decided, pending, older]);

    const list = await screen.findByRole("list", { name: "Approval requests" });
    const cards = within(list).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain(decided.question);
    expect(cards[0]!.textContent).toContain("Merged – continue");
    expect(cards[0]!.querySelector("time")?.getAttribute("datetime")).toBe(decided.decidedAt);
    expect(cards[0]!.textContent).not.toContain(pending.question);
    expect(cards[1]!.querySelector(".answer-stop")?.textContent).toBe("Cancel");
    expect(within(cards[0]!).getByRole("link", { name: "Run 9a8b-run" }).getAttribute("href")).toBe("/ui/runs/9a8b-run");
  });

  it("is a tab of the inbox next to notifications and subscriptions", async () => {
    const { user } = openApprovals([decided]);

    const tabs = await screen.findByRole("navigation", { name: "Inbox" });
    expect(within(tabs).getAllByRole("link").map((link) => link.textContent)).toEqual(["Notifications", "Subscriptions", "Approval requests"]);
    expect(within(tabs).getByRole("link", { name: "Approval requests", current: "page" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Inbox", current: "page" })).toBeTruthy();

    await user.click(within(tabs).getByRole("link", { name: "Subscriptions" }));
    expect(await screen.findByRole("link", { name: "Subscriptions", current: "page" })).toBeTruthy();
  });

  it("offers no answers: pending requests are answered in the workbench", async () => {
    openApprovals([pending, decided]);

    const list = await screen.findByRole("list", { name: "Approval requests" });
    expect(within(list).queryAllByRole("button")).toEqual([]);
  });

  it("shows the question's links and action, opening links in a new tab", async () => {
    openApprovals([{ ...decided, links: [{ title: "Pull request", url: PULL_REQUEST }] }]);

    const link = await screen.findByRole("link", { name: "Pull request" });
    expect(link.getAttribute("href")).toBe(PULL_REQUEST);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByText("merge-pull-request · careful")).toBeTruthy();
  });

  it("links the URLs in the question and keeps trailing punctuation and other schemes out of links", async () => {
    const question = "Merge (https://github.com/acme/playground/pull/13), see https://example.test/notes. Or javascript:alert(1)?";
    openApprovals([{ ...decided, question, links: [] }]);

    const list = await screen.findByRole("list", { name: "Approval requests" });
    const links = within(list)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("target") === "_blank");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["https://github.com/acme/playground/pull/13", "https://example.test/notes"]);
  });

  it("says when no request was decided yet, and when they cannot be read", async () => {
    openApprovals([pending]);
    expect(await screen.findByText("No decided approval requests yet.")).toBeTruthy();

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
