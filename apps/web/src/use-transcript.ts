import { followTranscript, TranscriptStreamRefusedError, TranscriptStreamUnreachableError, type TranscriptStreamAnswer } from "@tendworks/platform";
import { useEffect, useRef, useState } from "react";
import { AnswerError, UNREACHABLE } from "./answers.js";
import type { TranscriptEntry } from "./transcript.js";

export type { TranscriptStreamAnswer };

/** Opens a transcript stream with the generated client, continuing after the entry the header names (ADR 0017). */
export type OpenTranscriptStream = (header: { "Last-Event-ID"?: string }) => Promise<TranscriptStreamAnswer>;

export type TranscriptView =
  | { phase: "loading" }
  /** There is no such transcript (404). */
  | { phase: "missing" }
  /** The history could not be read. */
  | { phase: "failed"; error: string }
  | {
      phase: "shown";
      entries: TranscriptEntry[];
      /** Entries still arrive from the live stream. */
      following: boolean;
      /** Why following stopped before the transcript ended, if it did. */
      lost?: string;
    };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What the operator reads when following broke off. */
function lostBecause(error: unknown): string {
  if (error instanceof TranscriptStreamUnreachableError) return UNREACHABLE;
  if (error instanceof TranscriptStreamRefusedError) return AnswerError.from(error.response.status, error.problem).message;
  return messageOf(error);
}

/** The first wait before following a lost transcript again; it doubles with each failure, up to the maximum. */
const RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;

/** A platform that cannot be reached or is unavailable for a while (5xx) may answer later; a refusal (4xx) will not. */
const worthRetrying = (error: unknown) => !(error instanceof TranscriptStreamRefusedError) || error.response.status >= 500;

/**
 * A transcript as the operator follows it (ADR 0017), for run steps and chats alike: its
 * history from `read`, then, while `live`, each new entry from the stream `open` opens,
 * after the last entry of the history. A dropped stream is resumed with `Last-Event-ID`,
 * so no entry is missing or shown twice. When following gives up (`lost`), it tries again
 * with a growing wait, and at once when the tab becomes visible again. Keep `read` and `open` stable (`useCallback`); a
 * new one, or a change of `live`, reads the history again (e.g. once a step has ended).
 * `read` rejects with an `AnswerError` of status 404 for a transcript that does not exist.
 * `onEnded` is called when the stream says the task ended, e.g. to read its owner again.
 */
export function useTranscript({
  read,
  open,
  live,
  onEnded,
}: {
  read: () => Promise<TranscriptEntry[]>;
  open: OpenTranscriptStream;
  live: boolean;
  onEnded?: (() => void) | undefined;
}): TranscriptView {
  const [view, setView] = useState<TranscriptView>({ phase: "loading" });
  // The latest callback, without following anew when it changes.
  const ended = useRef(onEnded);
  useEffect(() => {
    ended.current = onEnded;
  });

  useEffect(() => {
    let active = true;
    const stop = new AbortController();
    const update = (change: (view: Extract<TranscriptView, { phase: "shown" }>) => TranscriptView) =>
      active && setView((current) => (current.phase === "shown" ? change(current) : current));

    // After following gave up: the next attempt, its timer, and how many failed in a row.
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    let waiting = false;
    const tryAgain = () => {
      if (!active || !waiting) return;
      clearTimeout(retry);
      waiting = false;
      follow();
    };
    // A tab coming back (e.g. a laptop waking up) need not wait for the next attempt.
    const onVisible = () => document.visibilityState === "visible" && tryAgain();
    document.addEventListener("visibilitychange", onVisible);

    // The position of the last entry shown, after which following continues.
    let last = -1;
    // Settles through its handlers, which never throw.
    const follow = (): void =>
      void followTranscript<TranscriptEntry>({
        // The stream's body is cancelled on `stop`; the request itself gets no signal, as one
        // from another realm (e.g. jsdom's in the view tests) is refused by `Request`.
        open: async (header) => {
          const answer = await open(header);
          if (answer.response.ok) {
            retries = 0;
            update(({ phase, entries }) => ({ phase, entries, following: true }));
          }
          return answer;
        },
        after: last,
        signal: stop.signal,
        onEntry: (entry) => {
          last = entry.position;
          update((current) => ({ ...current, entries: [...current.entries, entry] }));
        },
      }).then(
        (outcome) => {
          update((current) => ({ ...current, following: false }));
          if (active && outcome === "ended") ended.current?.();
        },
        (error: unknown) => {
          update((current) => ({ ...current, following: false, lost: lostBecause(error) }));
          if (!active || !worthRetrying(error)) return;
          waiting = true;
          retry = setTimeout(tryAgain, Math.min(RETRY_MS * 2 ** retries++, MAX_RETRY_MS));
        },
      );

    read().then(
      (entries) => {
        if (!active) return;
        setView({ phase: "shown", entries, following: live });
        if (!live) return;
        last = entries.at(-1)?.position ?? -1;
        follow();
      },
      (error: unknown) => {
        if (!active) return;
        setView(error instanceof AnswerError && error.status === 404 ? { phase: "missing" } : { phase: "failed", error: messageOf(error) });
      },
    );
    return () => {
      active = false;
      stop.abort();
      clearTimeout(retry);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [read, open, live]);

  return view;
}
