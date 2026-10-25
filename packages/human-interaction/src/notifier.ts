import type { ApprovalEvents, ControlPlane, RunEvents, Subscription } from "@tendworks/shared";
import type { Notification, NotificationDelivery } from "./notification-delivery.js";
import type { NotificationStore } from "./notification-store.js";

type NotifiedEvent = RunEvents.RunStartedEvent | RunEvents.RunCompletedEvent | RunEvents.RunFailedEvent | ApprovalEvents.ApprovalRequestedEvent;
export type NotificationKind = Notification["kind"];

/** A configured notification channel: its name, its default priority, and how it delivers. It selects no events. */
export interface NotifierChannel {
  name: string;
  /** Used where no matching subscription names a priority. */
  priority?: number;
  delivery: NotificationDelivery;
}

/** What a subscription asks of the notifier (ADR 0026): events of one scope, to channels by name. */
export type NotifierSubscription = Subscription.SubscriptionSpec;

/** What the notifier needs to know of a run beyond its events: where it works and what started it. */
export interface NotifierRun {
  /** The workspace the run works in; none puts its events in the platform scope. */
  workspace?: string | undefined;
  origin?: ControlPlane.components["schemas"]["runOrigin"] | undefined;
}

export interface NotifierOptions {
  store: NotificationStore;
  /** Every configured channel. */
  channels: readonly NotifierChannel[];
  /** Every configured subscription; a notification goes to the channels its matching subscriptions name. */
  subscriptions: readonly NotifierSubscription[];
  /**
   * Orchestration's record of a run: its workspace (none for a run without one, whose events
   * belong to the platform scope) and its origin. A rejection fails the event, so the bus
   * delivers it again.
   */
  runOf?: (runId: string) => Promise<NotifierRun>;
  now?: () => Date;
}

/**
 * Consumer of run starts and outcomes and approval requests: records a notification for every
 * started, completed or failed run and every new approval request, then delivers it through the
 * subscriptions of its scope (the run's workspace, else the platform) that select its kind:
 * once per channel they name, with the highest of their priorities, else the channel's
 * default. Without a matching subscription the notification is only recorded. The outcome
 * is recorded per channel (ADR 0025, 0026).
 * Idempotent, so it can sit behind an at-least-once subscription: a redelivered event
 * delivers only to the channels still pending. A failing channel is recorded on the
 * notification and fails neither the event nor the other channels.
 */
export function createNotifier({ store, channels, subscriptions, runOf = async () => ({}), now = () => new Date() }: NotifierOptions) {
  const byName = new Map(channels.map((channel) => [channel.name, channel]));
  return {
    /** Event types the notifier consumes. */
    types: ["dev.tendworks.run.started", "dev.tendworks.run.completed", "dev.tendworks.run.failed", "dev.tendworks.approval.requested"],

    async handle(event: NotifiedEvent): Promise<void> {
      const { workspace, origin } = await runOf(event.runid);
      const fresh = toNotification(event, now().toISOString(), { workspace, origin });
      const priorities = matching(subscriptions, workspace, fresh.kind);
      const notification = await store.record(`${event.source} ${event.id}`, {
        ...fresh,
        deliveries: [...priorities.keys()].filter((name) => byName.has(name)).sort().map((channel) => ({ channel, status: "pending" as const })),
      });
      for (const { channel: name, status } of notification.deliveries) {
        const channel = byName.get(name);
        // Delivered or failed before, or no longer configured: nothing to do for this channel.
        if (status !== "pending" || !channel) continue;
        const attemptedAt = now().toISOString();
        try {
          const priority = priorities.get(name) ?? channel.priority;
          await channel.delivery.deliver(notification, priority === undefined ? {} : { priority });
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

/** The channels a notification of `kind` in the scope reaches, each with the highest priority its matching subscriptions name (none: the channel's default). */
function matching(subscriptions: readonly NotifierSubscription[], workspace: string | undefined, kind: NotificationKind): Map<string, number | undefined> {
  const channels = new Map<string, number | undefined>();
  for (const { scope, events, channels: named, priority } of subscriptions) {
    const inScope = "workspace" in scope ? scope.workspace === workspace : workspace === undefined;
    if (!inScope || !events.includes(kind)) continue;
    for (const channel of named) {
      const known = channels.get(channel);
      channels.set(channel, known === undefined ? priority : priority === undefined ? known : Math.max(known, priority));
    }
  }
  return channels;
}

function toNotification(event: NotifiedEvent, createdAt: string, run: NotifierRun): Notification {
  const base = { id: crypto.randomUUID(), runId: event.runid, createdAt, deliveries: [] };
  if (event.type === "dev.tendworks.approval.requested") {
    const { id, question, answers, links } = event.data;
    const offered = answers.map(({ label }) => `"${label}"`).join(", ");
    return {
      ...base,
      kind: "approval.requested",
      title: `Approval needed: ${question}`,
      detail: `Answers: ${offered}. Answer with: tend approval answer ${id} "<answer>"`,
      // The request's links, so a channel that links one opens the first, like a run's first artifact.
      ...(links.length > 0 ? { artifacts: links.map(({ title, url }) => ({ name: title, url })) } : {}),
    };
  }
  if (event.type === "dev.tendworks.run.started") {
    const { workspace, origin } = run;
    const item = origin?.kind === "trigger" ? origin.item : undefined;
    const startedBy = origin?.kind === "trigger" ? `${origin.item.title} (${origin.item.key})` : "manual";
    return {
      ...base,
      kind: "run.started",
      title: `Run ${event.runid} of ${event.data.workflow} started`,
      detail: `${workspace ? `Workspace: ${workspace}. ` : ""}Started by: ${startedBy}`,
      // The origin's link, so a channel that links one opens e.g. the issue.
      ...(item?.url ? { artifacts: [{ name: item.key, url: item.url, description: item.title }] } : {}),
    };
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
