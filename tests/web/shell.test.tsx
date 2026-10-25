import { createInMemoryApprovals, type ApprovalRequest, type Notification } from "@tendworks/control-plane";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { READ_TOKEN, renderApp, signedIn, phoneWidth } from "./support/platform.js";

const pending: ApprovalRequest = {
  id: "5e1f-approval-pending",
  runId: "0b6c4c1e-run",
  workflow: "wait-for-merge",
  step: "/do/1/confirmMerge",
  action: "merge-pull-request",
  question: "Merge, then continue?",
  links: [],
  answers: [{ label: "Merged", outcome: "continue" }],
  status: "pending",
  createdAt: "2026-10-19T10:00:00.000Z",
};

const failedDelivery: Notification = {
  id: "9d2e-notification-failed",
  kind: "run.failed",
  runId: "7f1d2a9e-run",
  title: "Run failed",
  createdAt: "2026-10-18T11:00:03.000Z",
  artifacts: [],
  deliveries: [{ channel: "phone", status: "failed", attemptedAt: "2026-10-18T11:00:03.000Z", error: "refused" }],
};

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "matchMedia");
});

describe("desktop shell", () => {
  it("has one main navigation with the brand mark, the five sections and sign-out, marking the current section", async () => {
    signedIn();
    renderApp({ path: "/ui/runs" });

    const navigation = await screen.findByRole("navigation", { name: "Main" });
    expect(screen.getByRole("link", { name: "Tendworks" })).toBeTruthy();
    for (const name of ["Overview", "Runs", "Chats", "Inbox", "More"]) expect(screen.getByRole("link", { name })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Runs", current: "page" })).toBeTruthy();
    expect(navigation.querySelectorAll("[aria-current]")).toHaveLength(1);
  });

  it("marks the section of a detail view and of the inbox tabs", async () => {
    signedIn();
    renderApp({ path: "/ui/subscriptions" });

    expect(await screen.findByRole("link", { name: "Inbox", current: "page" })).toBeTruthy();
  });

  it("badges Runs with the pending approval requests and Inbox with notifications that failed to deliver", async () => {
    signedIn();
    renderApp({ path: "/ui/overview", approvals: createInMemoryApprovals([pending]), notifications: { list: async () => [failedDelivery] } });

    const runs = await screen.findByRole("link", { name: "Runs" });
    await waitFor(() => expect(runs.getAttribute("aria-describedby")).toBeTruthy());
    expect(document.getElementById(runs.getAttribute("aria-describedby") ?? "")?.textContent).toBe("1 approval request waits for an answer");
    const inbox = screen.getByRole("link", { name: "Inbox" });
    await waitFor(() => expect(inbox.getAttribute("aria-describedby")).toBeTruthy());
    expect(document.getElementById(inbox.getAttribute("aria-describedby") ?? "")?.textContent).toBe("1 notification with a failed delivery");
  });

  it("shows no badge when nothing waits and when the counts cannot be read", async () => {
    signedIn();
    renderApp({ path: "/ui/overview", approvals: { ...createInMemoryApprovals(), list: () => Promise.reject(new Error("store down")) } });

    const runs = await screen.findByRole("link", { name: "Runs" });
    expect(runs.getAttribute("aria-describedby")).toBeNull();
    expect(screen.getByRole("link", { name: "Inbox" }).getAttribute("aria-describedby")).toBeNull();
  });

  it("keeps showing that the token is read-only", async () => {
    signedIn(READ_TOKEN);
    renderApp({ path: "/ui/runs" });

    expect(await screen.findByText("Read-only")).toBeTruthy();
  });
});

describe("phone shell", () => {
  it("shows bottom tabs in place of the rail, and sign-out under More", async () => {
    phoneWidth(true);
    signedIn();
    const { user } = renderApp({ path: "/ui/overview" });

    const navigation = await screen.findByRole("navigation", { name: "Main" });
    expect([...navigation.querySelectorAll("a")].map((link) => link.getAttribute("aria-label"))).toEqual(["Overview", "Runs", "Chats", "Inbox", "More"]);
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();

    await user.click(screen.getByRole("link", { name: "More" }));
    expect(await screen.findByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.getByText("Full access")).toBeTruthy();
  });

  it("offers a back button on a detail view and none on a list", async () => {
    phoneWidth(true);
    signedIn();
    renderApp({ path: "/ui/chats/new" });

    expect((await screen.findByRole("link", { name: "Back" })).getAttribute("href")).toBe("/ui/chats");
    cleanup();
    renderApp({ path: "/ui/chats" });
    await screen.findByRole("heading", { name: "Chats" });
    expect(screen.queryByRole("link", { name: "Back" })).toBeNull();
  });
});

describe("start page", () => {
  it("opens the overview at / by default", async () => {
    signedIn();
    renderApp({ path: "/ui/" });

    expect(await screen.findByRole("link", { name: "Overview", current: "page" })).toBeTruthy();
  });

  it("opens the runs after choosing them under More, also after a reload", async () => {
    signedIn();
    const { user } = renderApp({ path: "/ui/more" });

    await user.click(await screen.findByRole("radio", { name: "Runs" }));
    cleanup();
    renderApp({ path: "/ui/" });

    expect(await screen.findByRole("heading", { name: "Runs" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Runs", current: "page" })).toBeTruthy();
  });

  it("still works where the browser keeps no storage", async () => {
    signedIn();
    const { user } = renderApp({ path: "/ui/more" });
    // The token was checked on the way in; from here on the browser refuses every read and write.
    const blocked = () => {
      throw new Error("storage blocked");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);

    await user.click(await screen.findByRole("radio", { name: "Runs" }));
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "Runs" }).checked).toBe(true);
  });
});
