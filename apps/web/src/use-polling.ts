import { useEffect, useRef, useState } from "react";

/** How often lists refresh themselves (spec #38). */
export const POLL_MS = 5_000;

export interface Polled<T> {
  /** The last answer; it stays while a later fetch fails. */
  data: T | undefined;
  /** Why the last fetch failed; `undefined` once a fetch succeeds again. */
  error: Error | undefined;
  /** True until the first fetch settled. */
  loading: boolean;
}

/**
 * Fetches with `load` now and about every 5 seconds, paused while the tab is hidden and
 * fetching again as soon as it becomes visible, so a forgotten tab does not keep loading.
 * `load` may change between renders; the next fetch uses the latest. A change of `key`
 * (e.g. the id of what is shown) starts over.
 */
export function usePolling<T>(load: () => Promise<T>, key: string = ""): Polled<T> {
  const [state, setState] = useState<Polled<T> & { key: string }>({ data: undefined, error: undefined, loading: true, key });
  const latest = useRef(load);
  useEffect(() => {
    latest.current = load;
  });

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = document.hidden ? undefined : setTimeout(() => {
        if (!document.hidden) void fetchNow();
      }, POLL_MS);
    };
    const fetchNow = async () => {
      clearTimeout(timer);
      try {
        const data = await latest.current();
        if (active) setState({ data, error: undefined, loading: false, key });
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if (active) setState((previous) => ({ data: previous.key === key ? previous.data : undefined, error, loading: false, key }));
      }
      if (active) schedule();
    };
    const visibilityChanged = () => {
      if (document.hidden) clearTimeout(timer);
      else void fetchNow();
    };
    void fetchNow();
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [key]);

  return state.key === key ? { data: state.data, error: state.error, loading: state.loading } : { data: undefined, error: undefined, loading: true };
}
