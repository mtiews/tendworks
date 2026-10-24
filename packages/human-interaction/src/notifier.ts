import type { ApprovalEvents, RunEvents } from "@tendworks/shared";
import type { Notification, NotificationDelivery } from "./notification-delivery.js";
import type { NotificationStore } from "./notification-store.js";

type NotifiedEvent = RunEvents.RunCompletedEvent | RunEvents.RunFailedEvent | ApprovalEvents.ApprovalRequestedEvent;
export type NotificationKind = Notification["kind"];

/** A configured notification channel: its name, the kinds it selects, and how it delivers. */
export interface NotifierChannel {
  name: string;
  events: readonly NotificationKind[];
  delivery: NotificationDelivery;
}

export interface NotifierOptions {
  store: NotificationStore;
  /** Every configured channel; each notification goes to those that select its kind. */
  channels: readonly NotifierChannel[];
  now?: () => Date;
}

/**
 * Consumer of run outcomes and approval requests: records a notification for every
 * completed or failed run and every new approval request, then delivers it to every
 * channel that selects its kind, recording the outcome per channel (ADR 0025).
 * Idempotent, so it can sit behind an at-least-once subscription: a redelivered event
 * delivers only to the channels still pending. A failing channel is recorded on the
 * notification and fails neither the event nor the other channels.
 */
export function createNotifier({ store, channels, now = () => new Date() }: NotifierOptions) {
  const byName = new Map(channels.map((channel) => [channel.name, channel]));
  return {
    /** Event types the notifier consumes. */
    types: ["dev.tendworks.run.completed", "dev.tendworks.run.failed", "dev.tendworks.approval.requested"],

    async handle(event: NotifiedEvent): Promise<void> {
      const fresh = toNotification(event, now().toISOString());
      const selecting = channels.filter(({ events }) => events.includes(fresh.kind)).map(({ name }) => name).sort();
      const notification = await store.record(`${event.source} ${event.id}`, {
        ...fresh,
        deliveries: selecting.map((channel) => ({ channel, status: "pending" as const })),
      });
      for (const { channel: name, status } of notification.deliveries) {
        const channel = byName.get(name);
        // Delivered or failed before, or no longer configured: nothing to do for this channel.
        if (status !== "pending" || !channel) continue;
        const attemptedAt = now().toISOString();
        try {
          await channel.delivery.deliver(notification);
          await store.updateDelivery(notification.id, { channel: name, status: "delivered", attemptedAt });
        } catch (error) {
          await store.updateDelivery(notification.id, {
            channel: name,
            status: "failed",
            attemptedAt,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
  };
}

function toNotification(event: NotifiedEvent, createdAt: string): Notification {
  const base = { id: crypto.randomUUID(), runId: event.runid, createdAt, deliveries: [] };
  if (event.type === "dev.tendworks.approval.requested") {
    const { id, question, answers } = event.data;
    const offered = answers.map(({ label }) => `"${label}"`).join(", ");
    return { ...base, kind: "approval.requested", title: `Approval needed: ${question}`, detail: `Answers: ${offered}. Answer with: tend approval answer ${id} "<answer>"` };
  }
  const { artifacts } = event.data;
  if (event.type === "dev.tendworks.run.completed") {
    return { ...base, kind: "run.completed", title: `Run ${event.runid} of ${event.data.workflow} completed`, artifacts };
  }
  const { error } = event.data;
  return {
    ...base,
    kind: "run.failed",
    title: `Run ${event.runid} of ${event.data.workflow} failed`,
    detail: `${error.instance}: ${error.title}${error.detail ? `: ${error.detail}` : ""}`,
    artifacts,
  };
}
