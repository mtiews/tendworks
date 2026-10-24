import type { SecretResolver } from "@tendworks/platform";
import type { NotificationChannel } from "@tendworks/shared";
import { createFakeNotificationDelivery, type NotificationDelivery } from "./notification-delivery.js";
import type { NotifierChannel } from "./notifier.js";
import { createPushoverNotificationDelivery } from "./pushover/pushover-notification-delivery.js";

type SecretRef = NotificationChannel.NotificationSecretRef;

export interface NotifierChannelsOptions {
  /** Resolves the channels' secret references: only platform secrets (ADR 0008). */
  secrets: SecretResolver;
  /** Where the fake channel writes; defaults to the console. */
  log?: (line: string) => void;
  fetch?: typeof fetch;
}

/** The configured notification channels, each with the delivery its integration selects (ADR 0025). */
export function notifierChannelsFor(channels: readonly NotificationChannel.NotificationChannel[], options: NotifierChannelsOptions): NotifierChannel[] {
  return channels.map(({ metadata, spec }) => ({ name: metadata.name, events: spec.events, delivery: deliveryFor(spec, options) }));
}

function deliveryFor(spec: NotificationChannel.NotificationChannelSpec, { secrets, log, fetch }: NotifierChannelsOptions): NotificationDelivery {
  if (spec.integration === "fake") return createFakeNotificationDelivery({ refuse: spec.fake?.refuse ?? false, ...(log ? { log } : {}) });
  const settings = spec.pushover!;
  // Resolved at each delivery, so a missing secret fails that delivery (naming the
  // secret, never a value) instead of the start.
  const resolve = ({ secretRef: { name } }: SecretRef) => {
    const value = secrets.resolve(name);
    if (!value) throw new Error(secrets.problem(name) ?? `secret ${name} is not set`);
    return value;
  };
  return createPushoverNotificationDelivery({
    credentials: () => ({ token: resolve(settings.token), user: resolve(settings.user) }),
    ...(settings.priority === undefined ? {} : { priority: settings.priority }),
    ...(fetch ? { fetch } : {}),
  });
}
