import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHeartbeat } from "./heartbeat.js";
import type { PlatformStatus } from "./status.js";

const MINUTE = 60_000;

const PING_URL = "https://monitor.example/ping/abc";

function setup(url: string | undefined) {
  let status: PlatformStatus["status"] = "healthy";
  const calls: string[] = [];
  const errors: unknown[] = [];
  let respond: () => Promise<Response> = async () => new Response("OK");
  const heartbeat = createHeartbeat({
    url,
    check: async () => ({ status, components: [], checkedAt: new Date().toISOString() }),
    fetch: async (target: string | URL | Request) => {
      calls.push(target as string);
      return respond();
    },
    onError: (error) => errors.push(error),
  });
  return { heartbeat, calls, errors, setStatus: (next: PlatformStatus["status"]) => (status = next), failWith: (next: () => Promise<Response>) => (respond = next) };
}

describe("the heartbeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("pings at once and then every five minutes while the platform is healthy", async () => {
    const { heartbeat, calls } = setup(PING_URL);
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([PING_URL]);
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(calls).toHaveLength(3);
    heartbeat.stop();
  });

  it("does not ping while the platform is degraded and resumes when it recovers", async () => {
    const { heartbeat, calls, setStatus } = setup(PING_URL);
    setStatus("unhealthy");
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(calls).toEqual([]);
    setStatus("healthy");
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(calls).toHaveLength(1);
    heartbeat.stop();
  });

  it("does nothing without a URL", async () => {
    const { heartbeat, calls } = setup(undefined);
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does nothing for an empty URL", async () => {
    const { heartbeat, calls } = setup("  ");
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(calls).toEqual([]);
  });

  it("logs a failed ping and tries again only at the next interval", async () => {
    const { heartbeat, calls, errors, failWith } = setup(PING_URL);
    failWith(async () => new Response("down", { status: 502 }));
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("502");
    failWith(async () => Promise.reject(new Error("connection refused")));
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(calls).toHaveLength(2);
    expect(errors).toHaveLength(2);
    heartbeat.stop();
  });

  it("stops pinging after stop", async () => {
    const { heartbeat, calls } = setup(PING_URL);
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(0);
    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(calls).toHaveLength(1);
  });
});
