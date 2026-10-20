import { useCallback, useEffect, useState } from "react";

/** How often lists refresh themselves (spec #38): about every 5 seconds. */
export const POLL_INTERVAL_MS = 5_000;

export interface Polled<T> {
  /** The latest answer; kept while a later poll fails, so a hiccup does not blank the view. */
  data: T | undefined;
  /** Why the latest poll failed; `undefined` once a poll succeeds again. */
  error: unknown;
  /** `true` until the first poll answered or failed. */
  loading: boolean;
  /** Polls at once, e.g. after the operator changed what the list shows. */
  refresh: () => void;
}

/**
 * Calls `load` now and again `intervalMs` after each answer, while the tab is visible: a
 * hidden tab stops polling, and becoming visible again polls at once. A new `load` (e.g.
 * other parameters) starts over, so keep it stable with `useCallback`.
 */
export function usePolling<T>(load: () => Promise<T>, intervalMs: number = POLL_INTERVAL_MS): Polled<T> {
  const [state, setState] = useState<Omit<Polled<T>, "refresh">>({ data: undefined, error: undefined, loading: true });
  // Each refresh starts the polling over, which polls at once.
  const [round, setRound] = useState(0);
  const refresh = useCallback(() => setRound((previous) => previous + 1), []);

  useEffect(() => {
    let stopped = false;
    let polling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      timer = undefined;
      polling = true;
      try {
        const data = await load();
        if (!stopped) setState({ data, error: undefined, loading: false });
      } catch (error: unknown) {
        if (!stopped) setState((previous) => ({ data: previous.data, error, loading: false }));
      } finally {
        polling = false;
      }
      if (!stopped && !document.hidden) timer = setTimeout(() => void poll(), intervalMs);
    };

    const visibilityChanged = () => {
      if (document.hidden) {
        clearTimeout(timer);
        timer = undefined;
      } else if (!polling && timer === undefined) {
        void poll();
      }
    };

    void poll();
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [load, intervalMs, round]);

  return { ...state, refresh };
}
