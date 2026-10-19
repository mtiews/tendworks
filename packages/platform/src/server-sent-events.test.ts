import { describe, expect, it } from "vitest";
import { readServerSentEvents, serverSentEventStream, type ServerSentEvent } from "./index.js";

const text = async (stream: ReadableStream<Uint8Array>) => new Response(stream).text();
const bytes = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
async function collect(events: AsyncIterable<ServerSentEvent>): Promise<ServerSentEvent[]> {
  const all: ServerSentEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}
async function* list(...events: ServerSentEvent[]) {
  yield* events;
}

describe("server-sent events", () => {
  it("writes events in the text/event-stream format, data over several lines included", async () => {
    const stream = serverSentEventStream(list({ id: "0", data: '{"a":1}' }, { event: "end", data: "two\nlines" }));

    expect(await text(stream)).toBe('id: 0\ndata: {"a":1}\n\nevent: end\ndata: two\ndata: lines\n\n');
  });

  it("reads back what it writes, however the bytes are split", async () => {
    const events = [{ id: "7", data: '{"text":"héllo"}' }, { event: "end", data: "a\nb" }];
    const written = await text(serverSentEventStream(list(...events)));
    const encoded = new TextEncoder().encode(written);
    const split = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });

    expect(await collect(readServerSentEvents(split))).toEqual(events);
  });

  it("reads CRLF line ends, comments, fields without a space and ignores events without data", async () => {
    const events = await collect(readServerSentEvents(bytes(": keep-alive\r\n\r\nid:3\r\nevent:entry\r\ndata:x\r\n\r\nid: 4\r\n\r\nretry: 10\ndata: y\n\n")));

    expect(events).toEqual([{ id: "3", event: "entry", data: "x" }, { data: "y" }]);
  });

  it("drops an event the stream ended in the middle of", async () => {
    expect(await collect(readServerSentEvents(bytes("data: whole\n\ndata: cut")))).toEqual([{ data: "whole" }]);
  });

  it("sends a comment while no event comes, so idle connections stay open", async () => {
    let release!: () => void;
    async function* late() {
      await new Promise<void>((resolve) => (release = resolve));
      yield { data: "late" };
    }
    const reader = serverSentEventStream(late(), { keepAliveMs: 5 }).getReader();

    const first = new TextDecoder().decode((await reader.read()).value);
    release();
    let rest = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += new TextDecoder().decode(chunk.value);

    expect(first).toBe(":\n\n");
    expect(rest.endsWith("data: late\n\n")).toBe(true);
  });

  it("stops the events when the reader cancels the stream", async () => {
    let stopped = false;
    async function* endless() {
      try {
        for (let i = 0; ; i++) yield { data: String(i) };
      } finally {
        stopped = true;
      }
    }
    const reader = serverSentEventStream(endless()).getReader();

    await reader.read();
    await reader.cancel();

    expect(stopped).toBe(true);
  });

  it("errors the stream when the events fail", async () => {
    async function* failing(): AsyncGenerator<ServerSentEvent> {
      yield { data: "first" };
      throw new Error("gone");
    }

    await expect(text(serverSentEventStream(failing()))).rejects.toThrow("gone");
  });
});
