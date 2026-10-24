/** A message as the stub accepted it, with the fields of Pushover's message API. */
export interface StubPushoverMessage {
  token: string;
  user: string;
  message: string;
  title?: string;
  url?: string;
  url_title?: string;
  priority?: number;
  timestamp?: number;
}

export interface StubPushoverApiOptions {
  /** The only application token the stub accepts. */
  token: string;
  /** The only user key the stub accepts. */
  user: string;
  /** When set, every message is refused with this HTTP status, like Pushover over its monthly limit (429). */
  refuseWith?: number;
}

/**
 * A `fetch` that answers like Pushover's message API (https://pushover.net/api): POST
 * https://api.pushover.net/1/messages.json with form-encoded or JSON parameters,
 * `{ status: 1, request }` for an accepted message and a 4xx with `{ status: 0, errors }`
 * for an invalid one (unknown token or user, missing message, values over Pushover's
 * limits). Everything else is 404. Accepted messages are kept in `messages`.
 */
export function stubPushoverApi({ token, user, refuseWith }: StubPushoverApiOptions): typeof fetch & { messages: StubPushoverMessage[] } {
  const messages: StubPushoverMessage[] = [];
  const stub = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://api.pushover.net") throw new TypeError(`fetch failed: unexpected host ${url.host}`);
    if (request.method !== "POST" || url.pathname !== "/1/messages.json") return json(404, { status: 0, errors: ["not found"] });
    const request_id = crypto.randomUUID();
    if (refuseWith !== undefined) return json(refuseWith, { status: 0, errors: ["message limit reached"], request: request_id });

    const fields = (request.headers.get("content-type") ?? "").startsWith("application/json")
      ? Object.fromEntries(Object.entries((await request.json()) as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
      : Object.fromEntries(new URLSearchParams(await request.text()));
    const errors: string[] = [];
    if (fields.token !== token) errors.push("application token is invalid");
    if (fields.user !== user) errors.push("user identifier is not a valid user, group, or subscribed user key");
    if (!fields.message) errors.push("message cannot be blank");
    if ((fields.message ?? "").length > 1024) errors.push("message is too long");
    if ((fields.title ?? "").length > 250) errors.push("title is too long");
    if ((fields.url ?? "").length > 512) errors.push("url is too long");
    if ((fields.url_title ?? "").length > 100) errors.push("url_title is too long");
    const priority = fields.priority === undefined ? undefined : Number(fields.priority);
    if (priority !== undefined && !(Number.isInteger(priority) && priority >= -2 && priority <= 2)) errors.push("priority is invalid");
    if (priority === 2 && (fields.retry === undefined || fields.expire === undefined)) errors.push("retry and expire are required for emergency priority");
    if (errors.length > 0) return json(400, { status: 0, errors, request: request_id });

    messages.push({
      token: fields.token!,
      user: fields.user!,
      message: fields.message!,
      ...(fields.title === undefined ? {} : { title: fields.title }),
      ...(fields.url === undefined ? {} : { url: fields.url }),
      ...(fields.url_title === undefined ? {} : { url_title: fields.url_title }),
      ...(priority === undefined ? {} : { priority }),
      ...(fields.timestamp === undefined ? {} : { timestamp: Number(fields.timestamp) }),
    });
    return json(200, { status: 1, request: request_id });
  };
  return Object.assign(stub, { messages });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
