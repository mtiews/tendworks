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
  if (error instanceof TranscriptStreamRefusedError) {
    const problem = error.problem as { title?: unknown } | undefined;
    return new AnswerError(error.response.status, typeof problem?.title === "string" ? problem.title : undefined).message;
  }
  return messageOf(error);
}

/**
 * A transcript as the operator follows it (ADR 0017), for run steps and chats alike: its
 * history from `read`, then, while `live`, each new entry from the stream `open` opens,
 * after the last entry of the history. A dropped stream is resumed with `Last-Event-ID`,
 * so no entry is missing or shown twice. Keep `read` and `open` stable (`useCallback`); a
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

    read().then(
      (entries) => {
        if (!active) return;
        setView({ phase: "shown", entries, following: live });
        if (!live) return;
        followTranscript<TranscriptEntry>({
          // The stream's body is cancelled on `stop`; the request itself gets no signal, as one
          // from another realm (e.g. jsdom's in the view tests) is refused by `Request`.
          open: (header) => open(header),
          after: entries.at(-1)?.position ?? -1,
          signal: stop.signal,
          onEntry: (entry) => update((current) => ({ ...current, entries: [...current.entries, entry] })),
        }).then(
          (outcome) => {
            update((current) => ({ ...current, following: false }));
            if (active && outcome === "ended") ended.current?.();
          },
          (error: unknown) => update((current) => ({ ...current, following: false, lost: lostBecause(error) })),
        );
      },
      (error: unknown) => {
        if (!active) return;
        setView(error instanceof AnswerError && error.status === 404 ? { phase: "missing" } : { phase: "failed", error: messageOf(error) });
      },
    );
    return () => {
      active = false;
      stop.abort();
    };
  }, [read, open, live]);

  return view;
}
