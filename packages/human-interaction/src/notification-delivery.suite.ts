import { describe, expect, it } from "vitest";
import type { Notification, NotificationDelivery } from "./notification-delivery.js";

export interface NotificationDeliverySetup {
  /** A delivery that accepts notifications, and the notifications its receiver got so far. */
  accepting(): { delivery: NotificationDelivery; received(): Notification["id"][] };
  /** A delivery whose receiver refuses every notification. */
  refusing(): NotificationDelivery;
}

export const SUITE_NOTIFICATION: Notification = {
  id: "4f9c0a52-notification",
  kind: "run.completed",
  runId: "run-1",
  title: "Run run-1 of develop-issue completed",
  artifacts: [{ name: "pull-request", url: "https://git.example/acme/app/pull/7" }],
  createdAt: "2026-10-18T10:00:00.000Z",
  deliveries: [{ channel: "phone", status: "pending" }],
};

/** The behaviour every notification delivery must show; runs against the fake and each adapter. */
export function describeNotificationDelivery(name: string, setup: NotificationDeliverySetup) {
  describe(`notification delivery: ${name}`, () => {
    it("brings a notification to its receiver, also a second time (at-least-once delivery)", async () => {
      const { delivery, received } = setup.accepting();

      await expect(delivery.deliver(SUITE_NOTIFICATION)).resolves.toBeUndefined();
      await expect(delivery.deliver(SUITE_NOTIFICATION)).resolves.toBeUndefined();

      expect(received()).toHaveLength(2);
    });

    it("rejects with the reason when the receiver refuses the notification", async () => {
      await expect(setup.refusing().deliver(SUITE_NOTIFICATION)).rejects.toThrow(/refuse/);
    });
  });
}
