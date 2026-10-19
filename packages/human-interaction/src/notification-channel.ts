import type { ControlPlane } from "@tendworks/shared";

export type Notification = ControlPlane.components["schemas"]["notification"];

/**
 * Port to the channel that brings a notification to the human (later ntfy or Web Push).
 * Rejects when delivery failed. The same notification may arrive more than once.
 *
 * @port
 */
export interface NotificationChannel {
  deliver(notification: Notification): Promise<void>;
}

/** Writes notifications to a log instead of delivering them; the channel of the walking skeleton. */
export function createLoggingNotificationChannel(log: (line: string) => void = console.log): NotificationChannel {
  return {
    async deliver(notification) {
      const detail = notification.detail ? ` (${notification.detail})` : "";
      log(`notification ${notification.id} [${notification.kind}] ${notification.title}${detail}`);
    },
  };
}

/** Keeps delivered notifications in memory, or fails every delivery; for tests. */
export function createInMemoryNotificationChannel({ failDelivery = false } = {}): NotificationChannel & { delivered: Notification[] } {
  const delivered: Notification[] = [];
  return {
    delivered,
    async deliver(notification) {
      if (failDelivery) throw new Error("delivery channel unavailable");
      delivered.push(structuredClone(notification));
    },
  };
}
