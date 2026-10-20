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
  delivery: { status: "failed", attemptedAt: "2026-10-18T11:00:03.000Z", error: "delivery channel unavailable" },
};

const delivered: Notification = {
  id: "1a7b-notification-completed",
  kind: "run.completed",
  runId: "0b6c4c1e-run-completed",
  title: "Run 0b6c4c1e-run-completed of hello-agent completed",
  createdAt: "2026-10-18T10:00:03.000Z",
  delivery: { status: "delivered", attemptedAt: "2026-10-18T10:00:03.000Z" },
};

describe("notifications page", () => {
  it("lists notifications newest first with type, time, run, delivery status and title", async () => {
    openNotifications({ notifications: { list: async () => [failed, delivered] } });

    const table = await screen.findByRole("table", { name: "Notifications" });
    expect(rows(table)).toEqual([
      ["Time", "Type", "Run", "Delivery", "Notification"],
      [
        "2026-10-18T11:00:03.000Z",
        "run.failed",
        "7f1d2a9e-run-failed",
        "failed: delivery channel unavailable",
        "Run 7f1d2a9e-run-failed of hello-agent failed/do/0/implement: Agent task ended in state TASK_STATE_FAILED",
      ],
      ["2026-10-18T10:00:03.000Z", "run.completed", "0b6c4c1e-run-completed", "delivered", "Run 0b6c4c1e-run-completed of hello-agent completed"],
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
