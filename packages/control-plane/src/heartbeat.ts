import type { PlatformStatus } from "./status.js";

export interface HeartbeatOptions {
  /** The URL to call (`TEND_HEARTBEAT_URL`); unset or blank: there is no heartbeat. */
  url: string | undefined;
  /** The check behind `GET /status`. */
  check: () => Promise<PlatformStatus>;
  fetch?: typeof fetch;
  /** Called with the reason when a ping fails. */
  onError?: (error: unknown) => void;
}

export interface Heartbeat {
  /** Pings now and then every `everyMs` (default five minutes) until {@link stop}; does nothing without a URL. */
  start(everyMs?: number): void;
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;

/**
 * Lets an external monitor alarm when the platform stops reporting (ADR 0026): while
 * `GET /status` is healthy, calls the configured URL with a bodyless GET. The call carries
 * no secrets and no state. A failed ping is reported to `onError` and not retried before
 * the next interval; while the platform is degraded nothing is sent.
 */
export function createHeartbeat({ url, check, fetch: send = fetch, onError = () => {} }: HeartbeatOptions): Heartbeat {
  const target = url?.trim() || undefined;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function ping(target: string) {
    if (running) return;
    running = true;
    try {
      if ((await check()).status !== "healthy") return;
      const response = await send(target, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`heartbeat answered HTTP ${response.status}`);
    } catch (error) {
      onError(error);
    } finally {
      running = false;
    }
  }

  return {
    start(everyMs = DEFAULT_INTERVAL_MS) {
      if (!target || timer) return;
      timer = setInterval(() => void ping(target), everyMs);
      timer.unref();
      void ping(target);
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
