import type { Notification, NotificationDelivery } from "../notification-delivery.js";

const MESSAGES_URL = "https://api.pushover.net/1/messages.json";
// Pushover's limits (https://pushover.net/api#limits), in characters.
const TITLE_LIMIT = 250;
const MESSAGE_LIMIT = 1024;
const URL_LIMIT = 512;
const URL_TITLE_LIMIT = 100;

export interface PushoverCredentials {
  /** The application's API token. */
  token: string;
  /** The user or group key. */
  user: string;
}

export interface PushoverNotificationDeliveryOptions {
  /** Resolved at each delivery; throws when a secret is missing, which fails that delivery. */
  credentials: () => PushoverCredentials;
  fetch?: typeof fetch;
}

/**
 * Delivers notifications as Pushover messages (ADR 0025): with the priority the notifier
 * resolved (Pushover's default, 0, without), the title as title, the detail
 * and the artifacts as message, the first artifact as the message's link, the time the
 * notification was recorded as the message's time. A message Pushover refuses (4xx)
 * rejects with its errors; Pushover asks not to repeat such a request unchanged.
 */
export function createPushoverNotificationDelivery({ credentials, fetch = globalThis.fetch }: PushoverNotificationDeliveryOptions): NotificationDelivery {
  return {
    async deliver(notification, { priority } = {}) {
      const { token, user } = credentials();
      const response = await fetch(MESSAGES_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token, user, ...messageOf(notification), ...(priority === undefined ? {} : { priority: String(priority) }) }),
      });
      if (response.ok) return;
      throw new Error(`Pushover refused the message (HTTP ${response.status}): ${await errorsOf(response)}`);
    },
  };
}

function messageOf(notification: Notification): Record<string, string> {
  const artifacts = notification.artifacts ?? [];
  const lines = [...(notification.detail ? [notification.detail] : []), ...artifacts.map(({ name, url }) => `${name}: ${url}`)];
  const link = artifacts[0];
  return {
    title: shorten(notification.title, TITLE_LIMIT),
    message: shorten(lines.length > 0 ? lines.join("\n") : notification.title, MESSAGE_LIMIT),
    timestamp: String(Math.floor(Date.parse(notification.createdAt) / 1000)),
    ...(link && link.url.length <= URL_LIMIT ? { url: link.url, url_title: shorten(link.description ?? link.name, URL_TITLE_LIMIT) } : {}),
  };
}

function shorten(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

async function errorsOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { errors?: unknown };
    if (Array.isArray(body.errors) && body.errors.length > 0) return body.errors.map(String).join("; ");
  } catch {
    // not JSON: fall through to the status text
  }
  return response.statusText || "no reason given";
}
