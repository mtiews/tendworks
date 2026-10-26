import { eventEnvelope, newTraceparent } from "@tendworks/platform";
import type { PlatformEvents } from "@tendworks/shared";
import type { ComponentStatus, PlatformStatus } from "./status.js";

export type { PlatformStatus };
export type PlatformHealthChangedEvent = PlatformEvents.PlatformHealthChangedEvent;

/**
 * Where the control plane publishes events about the platform: the server hands over the
 * event bus (ADR 0026), tests a list. Rejects when the event could not be published.
 */
export interface PlatformEventPublisher {
  publish(event: PlatformHealthChangedEvent): Promise<void>;
}

export interface PlatformMonitorOptions {
  /** The check behind `GET /status`. */
  check: () => Promise<PlatformStatus>;
  publisher: PlatformEventPublisher;
  now?: () => Date;
  /** Called with the reason when a periodic check or publish fails. */
  onError?: (error: unknown) => void;
}

export interface PlatformMonitor {
  /** One check; may publish `platform.health-changed`. Rejects when the check or the publishing fails. */
  tick(): Promise<void>;
  /** Checks now and then every `everyMs` (default one minute) until {@link stop}. */
  start(everyMs?: number): void;
  stop(): void;
}

const SOURCE = "/tendworks/control-plane";
const DEFAULT_INTERVAL_MS = 60_000;
/** The longest interval a Node.js timer keeps; a longer one fires at once. */
const MAX_INTERVAL_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

export class PlatformCheckIntervalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformCheckIntervalError";
  }
}

/**
 * The monitor's interval in milliseconds from `TEND_PLATFORM_CHECK_SECONDS`: whole seconds,
 * one minute when unset or empty (compose passes an unset variable as empty). Throws a
 * {@link PlatformCheckIntervalError} for anything else, so the server refuses it at startup.
 */
export function platformCheckIntervalMs(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_INTERVAL_MS;
  const seconds = /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  if (!(seconds <= MAX_INTERVAL_SECONDS)) {
    throw new PlatformCheckIntervalError(`TEND_PLATFORM_CHECK_SECONDS: ${JSON.stringify(value)} is not a whole number of seconds from 1 to ${MAX_INTERVAL_SECONDS}`);
  }
  return seconds * 1000;
}

/**
 * Watches the components behind `GET /status` and publishes `platform.health-changed` when
 * the set of unhealthy components changes (ADR 0026). A change counts only after two equal
 * results in a row, so a single failed check publishes nothing; equal means the same
 * components are unhealthy, whatever their messages say. The platform starts out as
 * healthy, so a platform that starts unhealthy publishes after two checks. The published
 * state is kept in memory only.
 */
export function createPlatformMonitor({ check, publisher, now = () => new Date(), onError = () => {} }: PlatformMonitorOptions): PlatformMonitor {
  /** The unhealthy components of the last published state, by name. */
  let published = new Map<string, ComponentStatus>();
  let candidate: { signature: string; seen: number } | undefined;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const signatureOf = (names: Iterable<string>) => [...names].sort().join("\n");

  async function tick() {
    const { components } = await check();
    const unhealthy = new Map(components.filter(({ status }) => status === "unhealthy").map((component) => [component.name, component]));
    const signature = signatureOf(unhealthy.keys());
    if (signature === signatureOf(published.keys())) {
      candidate = undefined;
      return;
    }
    candidate = candidate?.signature === signature ? { signature, seen: candidate.seen + 1 } : { signature, seen: 1 };
    if (candidate.seen < 2) return;

    const time = now().toISOString();
    const degraded = unhealthy.size > 0;
    const affected = degraded ? [...unhealthy.values()] : [...published.values()].map(({ name }) => ({ name, status: "healthy" as const }));
    await publisher.publish({
      ...eventEnvelope({ id: `health-changed:${time}`, source: SOURCE, subject: "platform/health", time, traceparent: newTraceparent() }),
      type: "dev.tendworks.platform.health-changed",
      data: { status: degraded ? "unhealthy" : "healthy", components: affected },
    });
    // Only after publishing: a failed publish is tried again at the next check.
    published = unhealthy;
    candidate = undefined;
  }

  const guarded = async () => {
    // A slow check never overlaps the next one.
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (error) {
      onError(error);
    } finally {
      running = false;
    }
  };

  return {
    tick,
    start(everyMs = DEFAULT_INTERVAL_MS) {
      if (timer) return;
      timer = setInterval(() => void guarded(), everyMs);
      timer.unref();
      void guarded();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
