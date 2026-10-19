/** One event of a `text/event-stream` (Server-Sent Events, WHATWG HTML). */
export interface ServerSentEvent {
  id?: string;
  /** The event type; absent means `message`. */
  event?: string;
  data: string;
}

export interface ServerSentEventStreamOptions {
  /** Sends a comment after this long without an event, so proxies and clients keep an idle connection open. */
  keepAliveMs?: number;
}

const encoder = new TextEncoder();

function format({ id, event, data }: ServerSentEvent): string {
  const fields = [...(id === undefined ? [] : [`id: ${id}`]), ...(event === undefined ? [] : [`event: ${event}`]), ...data.split("\n").map((line) => `data: ${line}`)];
  return `${fields.join("\n")}\n\n`;
}

/**
 * Writes events as a `text/event-stream` body. The stream ends when the events end;
 * a reader that cancels the stream ends the events (`return()` of their iterator).
 */
export function serverSentEventStream(events: AsyncIterable<ServerSentEvent>, { keepAliveMs }: ServerSentEventStreamOptions = {}): ReadableStream<Uint8Array> {
  const iterator = events[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setInterval> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (keepAliveMs !== undefined) {
        timer = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(":\n\n"));
          } catch {
            clearInterval(timer);
          }
        }, keepAliveMs);
      }
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(format(next.value)));
      } catch (error) {
        controller.error(error);
      } finally {
        clearInterval(timer);
      }
    },
    async cancel() {
      clearInterval(timer);
      await iterator.return?.();
    },
  });
}

/**
 * Reads the events of a `text/event-stream` body as they arrive. Comments and events
 * without data are skipped, and so is an event the stream ended in the middle of.
 */
export async function* readServerSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerSentEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event: { id?: string; event?: string; data?: string[] } = {};
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      // A CR at the end may be the first half of a CRLF still to come.
      const lines = buffer.split(/\r\n|\r(?!$)|\n/);
      buffer = lines.pop()!;
      for (const line of lines) {
        if (line === "") {
          if (event.data !== undefined) {
            yield { ...(event.id === undefined ? {} : { id: event.id }), ...(event.event === undefined ? {} : { event: event.event }), data: event.data.join("\n") };
          }
          event = {};
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "data") event.data = [...(event.data ?? []), value];
        else if (field === "id" || field === "event") event[field] = value;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
