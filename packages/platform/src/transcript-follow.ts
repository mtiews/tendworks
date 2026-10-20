import { readServerSentEvents } from "./server-sent-events.js";

/** What a client call that opens a transcript stream answers (as the generated client does with `parseAs: "stream"`). */
export interface TranscriptStreamAnswer {
  data?: ReadableStream<Uint8Array> | null | undefined;
  /** The problem document of a refusal, if any. */
  error?: unknown;
  response: Response;
}

export interface FollowTranscriptOptions<Entry extends { position: number }> {
  /**
   * Opens the stream, continuing after the entry the header names, if any. It may pass
   * `signal` on to its request; following stops on it either way.
   */
  open: (header: { "Last-Event-ID"?: string }, signal: AbortSignal) => Promise<TranscriptStreamAnswer>;
  /** The position of the last entry the caller has already, e.g. the last one of the history; -1 for none. */
  after?: number;
  /** Stops following. */
  signal: AbortSignal;
  /** Gets each entry once, in order. */
  onEntry: (entry: Entry) => void;
  /** Waiting before a reconnect; replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait before a reconnect. */
  retryMs?: number;
  /** Failed connections in a row before following gives up. */
  attempts?: number;
}

export type FollowTranscriptOutcome = "ended" | "stopped" | "missing";

/** The stream could not be reached, or broke off, too many times in a row; `cause` is the last reason. */
export class TranscriptStreamUnreachableError extends Error {
  constructor(override readonly cause: unknown) {
    super(`the transcript stream cannot be reached (${cause instanceof Error ? cause.message : String(cause)})`);
  }
}

/** The platform answered the stream request with something other than a stream (e.g. 401, 503). */
export class TranscriptStreamRefusedError extends Error {
  constructor(
    readonly response: Response,
    readonly problem: unknown,
  ) {
    super(`the transcript stream was refused (HTTP ${response.status})`);
  }
}

const RETRY_MS = 1000;
const ATTEMPTS = 5;

/**
 * Follows a transcript stream (ADR 0017) after position `after`, handing each entry to
 * `onEntry` exactly once: a broken connection is resumed with `Last-Event-ID` after the
 * last entry handed over, and an entry at or before that position is skipped. Ends when
 * the stream says the task ended (`ended`), when `signal` aborts (`stopped`), or when
 * there is no such stream (`missing`). Rejects with {@link TranscriptStreamUnreachableError}
 * after `attempts` failed connections in a row and with {@link TranscriptStreamRefusedError}
 * for any answer other than a stream or 404. Uses only web standards, so it runs in browsers too.
 */
export async function followTranscript<Entry extends { position: number }>({
  open,
  after = -1,
  signal,
  onEntry,
  sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  retryMs = RETRY_MS,
  attempts = ATTEMPTS,
}: FollowTranscriptOptions<Entry>): Promise<FollowTranscriptOutcome> {
  const stopped = new Promise<"stopped">((resolve) => {
    if (signal.aborted) resolve("stopped");
    signal.addEventListener("abort", () => resolve("stopped"), { once: true });
  });
  let last = after;
  for (let failures = 0; !signal.aborted; ) {
    let answer;
    try {
      answer = await open(last < 0 ? {} : { "Last-Event-ID": String(last) }, signal);
    } catch (cause) {
      if (signal.aborted) break;
      if (++failures >= attempts) throw new TranscriptStreamUnreachableError(cause);
      await sleep(retryMs);
      continue;
    }
    const { data, error, response } = answer;
    if (response.status === 404) {
      void data?.cancel().catch(() => {});
      return "missing";
    }
    if (!response.ok || !data) throw new TranscriptStreamRefusedError(response, error);
    const events = readServerSentEvents(data, signal);
    try {
      for (;;) {
        const next = await Promise.race([events.next(), stopped]);
        if (next === "stopped") {
          void events.return(undefined);
          return next;
        }
        if (next.done) break;
        failures = 0;
        if (next.value.event === "end") return "ended";
        if (next.value.event !== "entry") continue;
        const entry = JSON.parse(next.value.data) as Entry;
        if (entry.position <= last) continue;
        last = entry.position;
        onEntry(entry);
      }
    } catch {
      // The connection broke; resumed below.
    }
    if (signal.aborted) break;
    if (++failures >= attempts) throw new TranscriptStreamUnreachableError(new Error("the transcript stream broke off"));
    await sleep(retryMs);
  }
  return "stopped";
}
