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
      key = { binding: `binding-${crypto.randomUUID()}`, workspace: "app", item: "acme/playground#7" };
    });

    const event = (runId: string, firing = key) =>
      triggerFired({
        ...firing,
        workflow: "implement-issue",
        runId,
        item: { key: firing.item, title: "Fix the login", url: "https://issues.example/7" },
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

    it("keeps keys of different workspaces apart, and a binding without workspaces apart from both", async () => {
      await context.store.claim(key);

      const { workspace: _workspace, ...withoutWorkspace } = key;
      expect(await context.store.claim({ ...key, workspace: "web" })).toBe(true);
      expect(await context.store.claim(withoutWorkspace)).toBe(true);
      expect(await context.store.claim(withoutWorkspace)).toBe(false);
    });

    it("releases and records a key without a workspace like any other", async () => {
      const { workspace: _workspace, ...withoutWorkspace } = key;
      await context.store.claim(withoutWorkspace);
      await context.store.release(withoutWorkspace);
      expect(await context.store.claim(withoutWorkspace)).toBe(true);

      await context.store.fired(withoutWorkspace, "run-1", event("run-1", withoutWorkspace));
      await context.store.release(withoutWorkspace);

      expect(await context.store.claim(withoutWorkspace)).toBe(false);
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

    it("keeps the last evaluation of each binding", async () => {
      const other = `binding-${crypto.randomUUID()}`;
      await context.store.recordEvaluation(key.binding, { at: "2026-10-18T10:00:00.000Z", status: "succeeded", startedRuns: 2 });
      await context.store.recordEvaluation(other, { at: "2026-10-18T10:00:00.000Z", status: "succeeded", startedRuns: 0 });
      await context.store.recordEvaluation(key.binding, {
        at: "2026-10-18T10:00:10.000Z",
        status: "failed",
        startedRuns: 0,
        message: "secret TENDWORKS_PLATFORM_GITHUB_TOKEN is not set",
      });

      const evaluations = await context.store.lastEvaluations();

      expect(evaluations.get(key.binding)).toEqual({
        at: "2026-10-18T10:00:10.000Z",
        status: "failed",
        startedRuns: 0,
        message: "secret TENDWORKS_PLATFORM_GITHUB_TOKEN is not set",
      });
      expect(evaluations.get(other)).toEqual({ at: "2026-10-18T10:00:00.000Z", status: "succeeded", startedRuns: 0 });
    });
  });
}
