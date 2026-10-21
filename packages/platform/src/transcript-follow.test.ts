import { describe, expect, it } from "vitest";
import { followTranscript, serverSentEventStream, TranscriptStreamRefusedError, TranscriptStreamUnreachableError, type ServerSentEvent, type TranscriptStreamAnswer } from "./index.js";

interface Entry {
  position: number;
  text: string;
}

const entries: Entry[] = ["a", "b", "c", "d"].map((text, position) => ({ position, text }));

/** What one connection to the stream does after sending the entries it was given. */
type Connection = { send: Entry[]; then: "end" | "cut" | "stay" } | { status: number } | { refused: Error };

/** A transcript stream whose connections behave as scripted, one script per connection; records the Last-Event-ID of each. */
function stream(...connections: Connection[]) {
  const headers: (string | undefined)[] = [];
  const open = async (header: { "Last-Event-ID"?: string }): Promise<TranscriptStreamAnswer> => {
    headers.push(header["Last-Event-ID"]);
    const connection = connections.shift();
    if (!connection) throw new Error("no more connections scripted");
    if ("refused" in connection) throw connection.refused;
    if ("status" in connection) return { error: { title: "Agent runtime unavailable" }, response: new Response(null, { status: connection.status }) };
    const { send, then } = connection;
    async function* events(): AsyncGenerator<ServerSentEvent> {
      for (const entry of send) yield { id: String(entry.position), event: "entry", data: JSON.stringify(entry) };
      if (then === "end") yield { event: "end", data: "{}" };
      if (then === "cut") throw new TypeError("terminated");
      if (then === "stay") await new Promise(() => {});
    }
    return { data: serverSentEventStream(events()), response: new Response(null, { status: 200 }) };
  };
  return { open, headers };
}

function follow(open: ReturnType<typeof stream>["open"], { after = -1, signal = new AbortController().signal } = {}) {
  const received: Entry[] = [];
  const outcome = followTranscript<Entry>({ open, after, signal, sleep: async () => {}, onEntry: (entry) => received.push(entry) });
  return { outcome, received };
}

describe("following a transcript", () => {
  it("hands over each entry as it comes until the stream says the task ended", async () => {
    const { open, headers } = stream({ send: entries, then: "end" });

    const { outcome, received } = follow(open);

    expect(await outcome).toBe("ended");
    expect(received).toEqual(entries);
    expect(headers).toEqual([undefined]);
  });

  it("continues after the entry it was told to, e.g. the last one of the history", async () => {
    const { open, headers } = stream({ send: entries.slice(2), then: "end" });

    const { outcome, received } = follow(open, { after: 1 });

    expect(await outcome).toBe("ended");
    expect(received).toEqual(entries.slice(2));
    expect(headers).toEqual(["1"]);
  });

  it("reconnects after a dropped connection with Last-Event-ID, without gaps or duplicates", async () => {
    // The second connection sends an entry again that the first already handed over.
    const { open, headers } = stream({ send: entries.slice(0, 2), then: "cut" }, { send: entries.slice(1), then: "end" });

    const { outcome, received } = follow(open);

    expect(await outcome).toBe("ended");
    expect(received).toEqual(entries);
    expect(headers).toEqual([undefined, "1"]);
  });

  it("reconnects when the platform cannot be reached for a moment", async () => {
    const { open, headers } = stream({ send: entries.slice(0, 1), then: "cut" }, { refused: new TypeError("fetch failed") }, { send: entries.slice(1), then: "end" });

    const { outcome, received } = follow(open);

    expect(await outcome).toBe("ended");
    expect(received).toEqual(entries);
    expect(headers).toEqual([undefined, "0", "0"]);
  });

  it("gives up after five failed connections in a row", async () => {
    const refused = new TypeError("fetch failed");
    const { open, headers } = stream(...Array.from({ length: 5 }, () => ({ refused })));

    const { outcome } = follow(open);

    const error = await outcome.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TranscriptStreamUnreachableError);
    expect((error as TranscriptStreamUnreachableError).cause).toBe(refused);
    expect(headers).toHaveLength(5);
  });

  it("gives up after five connections in a row that broke off before any entry", async () => {
    const { open } = stream(...Array.from({ length: 5 }, (): Connection => ({ send: [], then: "cut" })));

    await expect(follow(open).outcome).rejects.toThrow(TranscriptStreamUnreachableError);
  });

  it("says when there is no such stream", async () => {
    const { open } = stream({ status: 404 });

    expect(await follow(open).outcome).toBe("missing");
  });

  it("fails with the platform's answer when it refuses the stream", async () => {
    const { open } = stream({ status: 503 });

    const error = await follow(open).outcome.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TranscriptStreamRefusedError);
    expect((error as TranscriptStreamRefusedError).response.status).toBe(503);
    expect((error as TranscriptStreamRefusedError).problem).toEqual({ title: "Agent runtime unavailable" });
  });

  it("stops when told to, also while the stream stays open", async () => {
    const stop = new AbortController();
    const { open } = stream({ send: entries.slice(0, 1), then: "stay" });

    const { outcome, received } = follow(open, { signal: stop.signal });
    await expect.poll(() => received).toHaveLength(1);
    stop.abort();

    expect(await outcome).toBe("stopped");
  });
});
