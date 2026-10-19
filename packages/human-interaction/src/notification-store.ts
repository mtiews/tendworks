import type { Notification } from "./notification-channel.js";

export type Delivery = Notification["delivery"];

/**
 * Human interaction's record of notifications.
 *
 * @port
 */
export interface NotificationStore {
  /**
   * Records a notification caused by the event `cause` (its source and id). When that
   * event was already recorded, keeps the existing notification and returns it.
   */
  record(cause: string, notification: Notification): Promise<Notification>;
  /** Stores the outcome of a delivery attempt. */
  updateDelivery(id: string, delivery: Delivery): Promise<void>;
  /** Notifications, newest first. */
  list(options?: { limit?: number }): Promise<Notification[]>;
}

/** Notification store in memory, for tests. */
export function createInMemoryNotificationStore(): NotificationStore {
  const byCause = new Map<string, Notification>();
  const clone = <T>(value: T): T => structuredClone(value);

  return {
    async record(cause, notification) {
      if (!byCause.has(cause)) byCause.set(cause, clone(notification));
      return clone(byCause.get(cause)!);
    },
    async updateDelivery(id, delivery) {
      const notification = [...byCause.values()].find((known) => known.id === id);
      if (!notification) throw new Error(`unknown notification ${id}`);
      notification.delivery = clone(delivery);
    },
    async list({ limit = 100 } = {}) {
      return [...byCause.values()].reverse().slice(0, limit).map(clone);
    },
  };
}
