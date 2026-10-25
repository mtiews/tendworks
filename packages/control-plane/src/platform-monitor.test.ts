import type { PlatformEvents } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { createPlatformMonitor, type PlatformStatus } from "./platform-monitor.js";

type Component = PlatformStatus["components"][number];
const healthy = (name: string): Component => ({ name, status: "healthy" });
const unhealthy = (name: string, message: string): Component => ({ name, status: "unhealthy", message });

function setup() {
  let components: Component[] = [healthy("store"), healthy("worker")];
  let time = Date.parse("2026-10-25T10:00:00Z");
  const published: PlatformEvents.PlatformHealthChangedEvent[] = [];
  const monitor = createPlatformMonitor({
    check: async () => ({ status: components.every((c) => c.status === "healthy") ? "healthy" : "unhealthy", components, checkedAt: new Date(time).toISOString() }),
    publisher: { publish: async (event) => void published.push(event) },
    now: () => new Date(time),
  });
  return {
    monitor,
    published,
    /** The platform's components as the next checks see them. */
    set: (next: Component[]) => (components = next),
    /** One check a minute later. */
    async tick() {
      time += 60_000;
      await monitor.tick();
    },
  };
}

describe("the platform monitor", () => {
  it("publishes nothing while the platform stays healthy", async () => {
    const { tick, published } = setup();
    await tick();
    await tick();
    await tick();
    expect(published).toEqual([]);
  });

  it("publishes nothing for a single failed check", async () => {
    const { tick, set, published } = setup();
    set([healthy("store"), unhealthy("worker", "timeout")]);
    await tick();
    set([healthy("store"), healthy("worker")]);
    await tick();
    await tick();
    expect(published).toEqual([]);
  });

  it("publishes degraded after two failed checks in a row, naming the unhealthy components and their messages", async () => {
    const { tick, set, published } = setup();
    set([healthy("store"), unhealthy("worker", "connection refused")]);
    await tick();
    await tick();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      specversion: "1.0",
      type: "dev.tendworks.platform.health-changed",
      source: "/tendworks/control-plane",
      subject: "platform/health",
      data: { status: "unhealthy", components: [{ name: "worker", status: "unhealthy", message: "connection refused" }] },
    });
    expect(published[0]).not.toHaveProperty("runid");
  });

  it("publishes no repeated event while the state stays the same, even when the message changes", async () => {
    const { tick, set, published } = setup();
    set([healthy("store"), unhealthy("worker", "connection refused")]);
    await tick();
    await tick();
    set([healthy("store"), unhealthy("worker", "no answer within 2000 ms")]);
    await tick();
    await tick();
    await tick();
    expect(published).toHaveLength(1);
  });

  it("publishes recovered after two healthy checks in a row, naming the components that recovered", async () => {
    const { tick, set, published } = setup();
    set([healthy("store"), unhealthy("worker", "connection refused")]);
    await tick();
    await tick();
    set([healthy("store"), healthy("worker")]);
    await tick();
    expect(published).toHaveLength(1);
    await tick();
    expect(published).toHaveLength(2);
    expect(published[1]!.data).toEqual({ status: "healthy", components: [{ name: "worker", status: "healthy" }] });
    await tick();
    expect(published).toHaveLength(2);
  });

  it("does not count two different failures as two equal results", async () => {
    const { tick, set, published } = setup();
    set([unhealthy("store", "down"), healthy("worker")]);
    await tick();
    set([healthy("store"), unhealthy("worker", "down")]);
    await tick();
    expect(published).toEqual([]);
  });

  it("publishes again when other components fail while degraded", async () => {
    const { tick, set, published } = setup();
    set([healthy("store"), unhealthy("worker", "down")]);
    await tick();
    await tick();
    set([unhealthy("store", "down"), unhealthy("worker", "down")]);
    await tick();
    await tick();
    expect(published.map((event) => event.data.components.map(({ name }) => name))).toEqual([["worker"], ["store", "worker"]]);
  });

  it("tries again at the next check when publishing failed", async () => {
    let fail = true;
    const published: unknown[] = [];
    const monitor = createPlatformMonitor({
      check: async () => ({ status: "unhealthy", components: [unhealthy("store", "down")], checkedAt: "2026-10-25T10:00:00Z" }),
      publisher: {
        publish: async (event) => {
          if (fail) throw new Error("bus down");
          published.push(event);
        },
      },
    });
    await monitor.tick();
    await expect(monitor.tick()).rejects.toThrow("bus down");
    fail = false;
    await monitor.tick();
    expect(published).toHaveLength(1);
  });
});
