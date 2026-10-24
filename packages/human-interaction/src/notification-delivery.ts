import type { ControlPlane } from "@tendworks/shared";

export type Notification = ControlPlane.components["schemas"]["notification"];

/**
 * Port through which a notification channel brings a notification to the human, e.g.
 * as a Pushover message (ADR 0025). Rejects with the reason when delivery failed, e.g.
 * because the service refused the message. The same notification may arrive more than once.
 *
 * @port
 */
export interface NotificationDelivery {
  deliver(notification: Notification): Promise<void>;
}

export interface FakeNotificationDeliveryOptions {
  /** When true, every delivery fails. */
  refuse?: boolean;
  /** Where each delivered notification is written as one line; defaults to the console. */
  log?: (line: string) => void;
}

/**
 * Writes each notification to a log and keeps it in `delivered`, or refuses every one;
 * the `fake` channel, for tests and demos.
 */
export function createFakeNotificationDelivery({ refuse = false, log = console.info }: FakeNotificationDeliveryOptions = {}): NotificationDelivery & {
  delivered: Notification[];
} {
  const delivered: Notification[] = [];
  return {
    delivered,
    async deliver(notification) {
      if (refuse) throw new Error("the fake channel refuses every notification");
      const detail = notification.detail ? ` (${notification.detail})` : "";
      const link = notification.artifacts?.[0] ? ` <${notification.artifacts[0].url}>` : "";
      log(`notification ${notification.id} [${notification.kind}] ${notification.title}${detail}${link}`);
      delivered.push(structuredClone(notification));
    },
  };
}
