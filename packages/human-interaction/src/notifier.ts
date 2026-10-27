import type { ApprovalEvents, ControlPlane, PlatformEvents, RunEvents, Subscription } from "@tendworks/shared";
import type { Notification, NotificationDelivery } from "./notification-delivery.js";
import type { NotificationStore } from "./notification-store.js";

type RunNotifiedEvent = RunEvents.RunStartedEvent | RunEvents.RunCompletedEvent | RunEvents.RunFailedEvent | ApprovalEvents.ApprovalRequestedEvent;
type NotifiedEvent = RunNotifiedEvent | PlatformEvents.PlatformHealthChangedEvent;
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
    types: ["dev.tendworks.run.started", "dev.tendworks.run.completed", "dev.tendworks.run.failed", "dev.tendworks.approval.requested", "dev.tendworks.platform.health-changed"],

    async handle(event: NotifiedEvent): Promise<void> {
      // A platform event belongs to no run, so to the platform scope.
      const { workspace, origin }: NotifierRun = event.type === "dev.tendworks.platform.health-changed" ? {} : await runOf(event.runid);
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
  if (event.type === "dev.tendworks.platform.health-changed") {
    const { status, components } = event.data;
    const names = components.map(({ name }) => name).join(", ");
    const messages = components.flatMap(({ name, message }) => (message ? [`${name}: ${message}`] : [])).join("; ");
    return {
      id: crypto.randomUUID(),
      createdAt,
      deliveries: [],
      kind: status === "unhealthy" ? "platform.degraded" : "platform.recovered",
      title: `Platform ${status === "unhealthy" ? "degraded" : "recovered"}: ${names}`,
      ...(messages ? { detail: messages } : {}),
    };
  }
  const { origin } = run;
  const item = origin?.kind === "trigger" ? origin.item : undefined;
  // The triggering item's link, e.g. the issue.
  const itemLinks: Artifact[] = item?.url ? [{ name: item.key, url: item.url, description: item.title }] : [];
  const retry = origin?.retryOf === undefined ? "" : ` (retry of ${short(origin.retryOf)})`;
  const runNotification = (kind: RunNotificationKind, subject: string | undefined, lines: string[]) => ({
    id: crypto.randomUUID(),
    kind,
    runId: event.runid,
    title: [STATUS[kind], run.workspace ? `${run.workspace}/${event.data.workflow}` : event.data.workflow, subject].filter(Boolean).join(" · "),
    // One entry per line, the short run id last, so every channel shows the same message.
    detail: [...lines, `Run ${short(event.runid)}${retry}`].join("\n"),
    createdAt,
    deliveries: [],
  });
  const linesOf = (links: Artifact[]) => links.map(({ name, url }) => `${name}: ${url}`);
  const subject = item && `${item.key} ${item.title}`;
  if (event.type === "dev.tendworks.approval.requested") {
    const { id, question, answers, links } = event.data;
    const offered = answers.map(({ label }) => `"${label}"`).join(", ");
    const requested = links.map(({ title, url }) => ({ name: title, url }));
    return {
      ...runNotification("approval.requested", question, [`Answers: ${offered}. Answer with: tend approval answer ${id} "<answer>"`, ...linesOf(requested)]),
      // The request's links, so a channel that links one opens the first, like a run's first artifact.
      ...(requested.length > 0 ? { artifacts: requested } : {}),
    };
  }
  if (event.type === "dev.tendworks.run.started") {
    return { ...runNotification("run.started", subject, linesOf(itemLinks)), ...(itemLinks.length > 0 ? { artifacts: itemLinks } : {}) };
  }
  // The message lists the triggering item before the run's artifacts; a channel that links
  // one links the first artifact (e.g. the pull request), else the triggering item.
  const artifacts = [...event.data.artifacts, ...itemLinks];
  const links = linesOf([...itemLinks, ...event.data.artifacts]);
  if (event.type === "dev.tendworks.run.completed") return { ...runNotification("run.completed", subject, links), artifacts };
  const { error } = event.data;
  return { ...runNotification("run.failed", subject, [`${error.instance}: ${error.title}${error.detail ? `: ${error.detail}` : ""}`, ...links]), artifacts };
}

type Artifact = NonNullable<Notification["artifacts"]>[number];
type RunNotificationKind = Exclude<NotificationKind, `platform.${string}`>;

const STATUS: Record<RunNotificationKind, string> = { "run.started": "Started", "run.completed": "Completed", "run.failed": "Failed", "approval.requested": "Approval needed" };

/** The first eight characters of a run id: enough to tell runs apart at a glance. */
function short(runId: string): string {
  return runId.slice(0, 8);
}
