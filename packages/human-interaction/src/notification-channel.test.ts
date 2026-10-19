import { describe, expect, it } from "vitest";
import {
  createInMemoryNotificationChannel,
  createLoggingNotificationChannel,
  type Notification,
  type NotificationChannel,
} from "./notification-channel.js";

const notification: Notification = {
  id: "4f9c0a52-notification",
  kind: "run.failed",
  runId: "run-1",
  title: "Run run-1 of hello-agent failed",
  detail: "/do/0/implement: Agent task failed",
  createdAt: "2026-10-18T10:00:00.000Z",
  delivery: { status: "pending" },
};

/** The behaviour every notification channel must show; runs against each adapter. */
function describeNotificationChannel(name: string, setup: () => NotificationChannel) {
  describe(`notification channel: ${name}`, () => {
    it("accepts a notification, also a second time (at-least-once delivery)", async () => {
      const channel = setup();

      await expect(channel.deliver(notification)).resolves.toBeUndefined();
      await expect(channel.deliver(notification)).resolves.toBeUndefined();
    });
  });
}

describeNotificationChannel("logging", () => createLoggingNotificationChannel(() => {}));
describeNotificationChannel("in memory", () => createInMemoryNotificationChannel());

describe("logging notification channel", () => {
  it("writes the notification as one log line", async () => {
    const lines: string[] = [];

    await createLoggingNotificationChannel((line) => lines.push(line)).deliver(notification);

    expect(lines).toEqual([
      "notification 4f9c0a52-notification [run.failed] Run run-1 of hello-agent failed (/do/0/implement: Agent task failed)",
    ]);
  });
});

describe("in-memory notification channel", () => {
  it("rejects every delivery when told to fail", async () => {
    await expect(createInMemoryNotificationChannel({ failDelivery: true }).deliver(notification)).rejects.toThrow(
      "delivery channel unavailable",
    );
  });
});
