import type { TranscriptEntry } from "./transcript-store.js";

interface Follower {
  entry(entry: TranscriptEntry): void;
  end(): void;
}

/**
 * Entries of transcripts as this process records them, for clients that follow a
 * transcript live (ADR 0017). Nothing is kept: a follower reads the history from the
 * transcript store and gets from here what is recorded after it subscribed.
 */
export function createLiveTranscripts() {
  const followers = new Map<string, Set<Follower>>();
  const each = (taskId: string, call: (follower: Follower) => void) => followers.get(taskId)?.forEach(call);

  return {
    /** An entry of the task's transcript was kept. */
    recorded(taskId: string, entry: TranscriptEntry): void {
      each(taskId, (follower) => follower.entry(entry));
    },
    /** The task ended; no entry follows. */
    ended(taskId: string): void {
      each(taskId, (follower) => follower.end());
    },
    /**
     * Follows a task's transcript: buffers what is recorded from now on, so nothing
     * recorded while the history is read gets lost. `start` hands over the history read
     * after subscribing and whether the task had ended by then.
     */
    follow(taskId: string, after: number) {
      const queue: TranscriptEntry[] = [];
      let last = after;
      let ended = false;
      let closed = false;
      let wake: (() => void) | undefined;
      const follower: Follower = {
        entry: (entry) => {
          queue.push(entry);
          wake?.();
        },
        end: () => {
          ended = true;
          wake?.();
        },
      };
      const set = followers.get(taskId) ?? new Set();
      set.add(follower);
      followers.set(taskId, set);
      const close = () => {
        closed = true;
        set.delete(follower);
        if (set.size === 0 && followers.get(taskId) === set) followers.delete(taskId);
        wake?.();
      };

      return {
        close,
        /** The entries after `after`: the history first, then live ones until the task ends or the follower closes. */
        start(history: TranscriptEntry[], endedBefore: boolean): AsyncIterableIterator<TranscriptEntry> {
          queue.unshift(...history);
          if (endedBefore) ended = true;
          const iterator: AsyncIterableIterator<TranscriptEntry> = {
            [Symbol.asyncIterator]: () => iterator,
            async next() {
              for (;;) {
                if (closed) return { done: true, value: undefined };
                const entry = queue.shift();
                if (entry) {
                  // History and live entries overlap; positions tell which were seen.
                  if (entry.position <= last) continue;
                  last = entry.position;
                  return { done: false, value: entry };
                }
                if (ended) {
                  close();
                  return { done: true, value: undefined };
                }
                await new Promise<void>((resolve) => (wake = resolve));
                wake = undefined;
              }
            },
            async return() {
              close();
              return { done: true, value: undefined };
            },
          };
          return iterator;
        },
      };
    },
  };
}
