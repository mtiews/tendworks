import type { ApprovalEvents, RunEvents } from "@tendworks/shared";
import type { Notification, NotificationChannel } from "./notification-channel.js";
import type { NotificationStore } from "./notification-store.js";

type NotifiedEvent = RunEvents.RunCompletedEvent | RunEvents.RunFailedEvent | ApprovalEvents.ApprovalRequestedEvent;

export interface NotifierOptions {
  store: NotificationStore;
  channel: NotificationChannel;
  now?: () => Date;
}

/**
 * Consumer of run outcomes and approval requests: records a notification for every
 * completed or failed run and every new approval request, then delivers it. Idempotent, so it can sit behind an at-least-once subscription.
 * A failing channel is recorded on the notification and does not fail the event.
 */
export function createNotifier({ store, channel, now = () => new Date() }: NotifierOptions) {
  return {
    /** Event types the notifier consumes. */
    types: ["dev.tendworks.run.completed", "dev.tendworks.run.failed", "dev.tendworks.approval.requested"],

    async handle(event: NotifiedEvent): Promise<void> {
      const notification = await store.record(`${event.source} ${event.id}`, toNotification(event, now().toISOString()));
      // Delivered or failed before: the event is a redelivery, so do not notify twice.
      if (notification.delivery.status !== "pending") return;
      const attemptedAt = now().toISOString();
      try {
        await channel.deliver(notification);
        await store.updateDelivery(notification.id, { status: "delivered", attemptedAt });
      } catch (error) {
        await store.updateDelivery(notification.id, {
          status: "failed",
          attemptedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

function toNotification(event: NotifiedEvent, createdAt: string): Notification {
  const base = { id: crypto.randomUUID(), runId: event.runid, createdAt, delivery: { status: "pending" as const } };
  if (event.type === "dev.tendworks.approval.requested") {
    const { id, question } = event.data;
    return { ...base, kind: "approval.requested", title: `Approval needed: ${question}`, detail: `Answer with: tend approval approve ${id} (or reject ${id})` };
  }
  if (event.type === "dev.tendworks.run.completed") {
    return { ...base, kind: "run.completed", title: `Run ${event.runid} of ${event.data.workflow} completed` };
  }
  const { error } = event.data;
  return {
    ...base,
    kind: "run.failed",
    title: `Run ${event.runid} of ${event.data.workflow} failed`,
    detail: `${error.instance}: ${error.title}${error.detail ? `: ${error.detail}` : ""}`,
  };
}
