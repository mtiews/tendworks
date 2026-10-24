import type { Notification } from "@tendworks/control-plane";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { API_TOKEN, renderApp, type PlatformOptions } from "./support/platform.js";
import { rows } from "./support/table.js";

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

describe("notifications page", () => {
  it("lists notifications newest first with type, time, run, delivery status per channel, title and artifacts", async () => {
    openNotifications({ notifications: { list: async () => [failed, delivered, unselected] } });

    const table = await screen.findByRole("table", { name: "Notifications" });
    expect(rows(table)).toEqual([
      ["Time", "Type", "Run", "Delivery", "Notification"],
      [
        "2026-10-18T11:00:03.000Z",
        "run.failed",
        "7f1d2a9e-run-failed",
        "log: deliveredphone: failed: Pushover refused the message (HTTP 400): application token is invalid",
        "Run 7f1d2a9e-run-failed of hello-agent failed/do/0/implement: Agent task ended in state TASK_STATE_FAILED",
      ],
      ["2026-10-18T10:00:03.000Z", "run.completed", "0b6c4c1e-run-completed", "log: delivered", "Run 0b6c4c1e-run-completed of develop-issue completedpull-requestpreview"],
      ["2026-10-18T09:00:03.000Z", "approval.requested", "5e0f-run-waiting", "no channel", "Approval needed: Deploy?"],
    ]);
  });

  it("links a run notification's artifacts, the first one first", async () => {
    openNotifications({ notifications: { list: async () => [delivered] } });

    const table = await screen.findByRole("table", { name: "Notifications" });
    expect(within(table).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["0b6c4c1e-run-completed", "/ui/runs/0b6c4c1e-run-completed"],
      ["pull-request", "https://git.example/acme/app/pull/7"],
      ["preview", "https://preview.example/app/7"],
    ]);
  });

  it("links each notification to its run", async () => {
    openNotifications({ notifications: { list: async () => [failed] } });

    const table = await screen.findByRole("table", { name: "Notifications" });
    expect(within(table).getByRole("link", { name: "7f1d2a9e-run-failed" }).getAttribute("href")).toBe("/ui/runs/7f1d2a9e-run-failed");
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
