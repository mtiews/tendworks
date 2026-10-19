import { beforeEach, describe, expect, it } from "vitest";
import { triggerFired, type TriggerFiredEvent } from "../trigger-events.js";
import type { FiringKey, FiringStore } from "./firing-store.js";

export interface FiringStoreSuiteContext {
  store: FiringStore;
  /** Events the store's publisher committed, oldest first. */
  events(): Promise<TriggerFiredEvent[]>;
}

/**
 * The behaviour every firing store must show. Runs against the real adapter and the
 * fake, so the fake stays a faithful stand-in.
 */
export function describeFiringStore(name: string, setup: () => Promise<FiringStoreSuiteContext> | FiringStoreSuiteContext) {
  describe(`firing store: ${name}`, () => {
    let context: FiringStoreSuiteContext;
    let key: FiringKey;

    beforeEach(async () => {
      context = await setup();
      // Unique per test, so a shared database needs no cleanup.
      key = { binding: `binding-${crypto.randomUUID()}`, item: "acme/playground#7" };
    });

    const event = (runId: string, firing = key) =>
      triggerFired({
        ...firing,
        workflow: "implement-issue",
        runId,
        issue: { repository: "acme/playground", number: 7, url: "https://issues.example/7" },
        time: "2026-10-18T10:00:00.000Z",
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      });

    it("lets a key be claimed once", async () => {
      expect(await context.store.claim(key)).toBe(true);
      expect(await context.store.claim(key)).toBe(false);
    });

    it("lets exactly one of several concurrent claims win", async () => {
      const claims = await Promise.all(Array.from({ length: 5 }, () => context.store.claim(key)));

      expect(claims.filter(Boolean)).toHaveLength(1);
    });

    it("keeps keys of different bindings apart", async () => {
      await context.store.claim(key);

      expect(await context.store.claim({ ...key, binding: `${key.binding}-other` })).toBe(true);
    });

    it("makes a released claim claimable again", async () => {
      await context.store.claim(key);
      await context.store.release(key);

      expect(await context.store.claim(key)).toBe(true);
    });

    it("records a fired key with its event, and keeps it claimed for good", async () => {
      await context.store.claim(key);
      const fired = event("run-1");

      await context.store.fired(key, "run-1", fired);
      await context.store.release(key);

      expect(await context.store.claim(key)).toBe(false);
      expect((await context.events()).filter((known) => known.data.binding === key.binding)).toEqual([fired]);
    });

    it("records a firing once, however often it is repeated", async () => {
      await context.store.claim(key);
      const fired = event("run-1");

      await context.store.fired(key, "run-1", fired);
      await context.store.fired(key, "run-1", fired);

      expect((await context.events()).filter((known) => known.data.binding === key.binding)).toEqual([fired]);
    });
  });
}
