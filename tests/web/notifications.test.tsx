import type { Notification } from "@tendworks/control-plane";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { API_TOKEN, renderApp, type PlatformOptions } from "./support/platform.js";

function openNotifications(options: PlatformOptions = {}) {
  window.sessionStorage.setItem("tendworks.token", API_TOKEN);
  return renderApp({ path: "/ui/notifications", ...options });
}

// The notifications of `tend notification list`'s tests, so the page shows what `tend` shows.
const failed: Notification = {
  id: "9d2e-notification-failed",
  kind: "run.failed",
  runId: "7f1d2a9e-run-failed",
  title: "Run 7f1d2a9e-run-failed of hello-agent failed",
  detail: "/do/0/implement: Agent task ended in state TASK_STATE_FAILED",
  createdAt: "2026-10-18T11:00:03.000Z",
  artifacts: [],
  deliveries: [
    { channel: "log", status: "delivered", attemptedAt: "2026-10-18T11:00:03.000Z" },
    { channel: "phone", status: "failed", attemptedAt: "2026-10-18T11:00:03.000Z", error: "Pushover refused the message (HTTP 400): application token is invalid" },
  ],
};

const delivered: Notification = {
  id: "1a7b-notification-completed",
  kind: "run.completed",
  runId: "0b6c4c1e-run-completed",
  title: "Run 0b6c4c1e-run-completed of develop-issue completed",
  artifacts: [
    { name: "pull-request", url: "https://git.example/acme/app/pull/7" },
    { name: "preview", url: "https://preview.example/app/7" },
  ],
  createdAt: "2026-10-18T10:00:03.000Z",
  deliveries: [{ channel: "log", status: "delivered", attemptedAt: "2026-10-18T10:00:03.000Z" }],
};

const unselected: Notification = {
  id: "77c1-notification-approval",
  kind: "approval.requested",
  runId: "5e0f-run-waiting",
  title: "Approval needed: Deploy?",
  createdAt: "2026-10-18T09:00:03.000Z",
  deliveries: [],
};

const { runId: _runId, ...withoutRun } = unselected;

describe("notifications in the inbox", () => {
  it("lists notifications newest first, one row each with event, time, title, artifacts, delivery per channel and run", async () => {
    openNotifications({ notifications: { list: async () => [failed, delivered, unselected] } });

    const list = await screen.findByRole("list", { name: "Notifications" });
    const rows = list.querySelectorAll(":scope > li");
    expect([...rows].map((row) => within(row as HTMLElement).getByText(/^(run|approval)./).textContent)).toEqual(["run.failed", "run.completed", "approval.requested"]);
    const [first, second, third] = [...rows] as HTMLElement[];
    expect(first!.querySelector("time")?.getAttribute("datetime")).toBe(failed.createdAt);
    expect(first!.textContent).toContain("Run 7f1d2a9e-run-failed of hello-agent failed");
    expect(first!.textContent).toContain("/do/0/implement: Agent task ended in state TASK_STATE_FAILED");
    expect(within(first!).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "log: delivered",
      "phone: failed: Pushover refused the message (HTTP 400): application token is invalid",
    ]);
    expect(within(second!).getAllByRole("link").map((link) => link.textContent)).toEqual(["pull-request", "preview", "Run 0b6c4c1e"]);
    expect(third!.textContent).toContain("Approval needed: Deploy?");
  });

  it("makes a failed delivery stand out and says when no subscription sends a notification", async () => {
    openNotifications({ notifications: { list: async () => [failed, unselected] } });

    const list = await screen.findByRole("list", { name: "Notifications" });
    expect(within(list).getByText(/phone: failed/).className).toContain("state-unhealthy");
    expect(within(list).getByText(/log: delivered/).className).not.toContain("state-unhealthy");
    expect(within(list).getByText("No subscription sends this notification to a channel.")).toBeTruthy();
  });

  it("links a run notification's artifacts, the first one first", async () => {
    openNotifications({ notifications: { list: async () => [delivered] } });

    const list = await screen.findByRole("list", { name: "Notifications" });
    expect(within(list).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["pull-request", "https://git.example/acme/app/pull/7"],
      ["preview", "https://preview.example/app/7"],
      ["Run 0b6c4c1e", "/ui/runs/0b6c4c1e-run-completed"],
    ]);
  });

  it("leads each notification to its run, and marks one without a run as the platform's", async () => {
    openNotifications({ notifications: { list: async () => [failed, withoutRun] } });

    const list = await screen.findByRole("list", { name: "Notifications" });
    expect(within(list).getByRole("link", { name: "Run 7f1d2a9e" }).getAttribute("href")).toBe("/ui/runs/7f1d2a9e-run-failed");
    expect(within(list).getByText("platform")).toBeTruthy();
  });

  it("is the first tab of the inbox", async () => {
    openNotifications({ notifications: { list: async () => [] } });

    expect(await screen.findByRole("link", { name: "Notifications", current: "page" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Inbox" })).toBeTruthy();
  });

  it("says when there are no notifications yet", async () => {
    openNotifications({ notifications: { list: async () => [] } });

    expect(await screen.findByText("No notifications yet.")).toBeTruthy();
  });

  it("says when notifications cannot be read", async () => {
    openNotifications({ notifications: { list: () => Promise.reject(new Error("store down")) } });

    expect((await screen.findByRole("alert")).textContent).toBe("Cannot read the notifications. Is the platform running?");
  });
});
