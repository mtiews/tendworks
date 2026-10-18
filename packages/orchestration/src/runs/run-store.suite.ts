import { beforeEach, describe, expect, it } from "vitest";
import { runStarted, stepChanged, type RunContext, type RunEvent } from "./run-events.js";
import type { Run, RunStore } from "./run-store.js";

export interface RunStoreSuiteContext {
  store: RunStore;
  /** Events the store's publisher committed for a run, in order. */
  events(runId: string): Promise<RunEvent[]>;
}

/**
 * The behaviour every run store must show. Runs against the real adapter and the
 * fake, so the fake stays a faithful stand-in.
 */
export function describeRunStore(name: string, setup: () => Promise<RunStoreSuiteContext> | RunStoreSuiteContext) {
  describe(`run store: ${name}`, () => {
    let context: RunStoreSuiteContext;

    beforeEach(async () => {
      context = await setup();
    });

    const newRun = (overrides: Partial<Run> = {}): Run => ({
      id: crypto.randomUUID(),
      workflow: "hello",
      status: "pending",
      input: { issue: { number: 7 } },
      steps: [],
      createdAt: "2026-10-18T10:00:00.000Z",
      ...overrides,
    });
    const contextOf = (run: Run): RunContext => ({
      runId: run.id,
      workflow: run.workflow,
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });

    it("returns a created run as it was recorded", async () => {
      const run = newRun();
      await context.store.create(run);

      expect(await context.store.get(run.id)).toEqual(run);
    });

    it("returns nothing for an unknown run", async () => {
      expect(await context.store.get(crypto.randomUUID())).toBeUndefined();
    });

    it("rejects a second run with the same id", async () => {
      const run = newRun();
      await context.store.create(run);

      await expect(context.store.create(run)).rejects.toThrow();
    });

    it("updates a run and publishes the events with it", async () => {
      const run = newRun();
      await context.store.create(run);
      const event = runStarted(contextOf(run), "2026-10-18T10:00:01.000Z");

      await context.store.updateRun(run.id, { status: "running", startedAt: "2026-10-18T10:00:01.000Z" }, [event]);

      expect(await context.store.get(run.id)).toEqual({ ...run, status: "running", startedAt: "2026-10-18T10:00:01.000Z" });
      expect(await context.events(run.id)).toEqual([event]);
    });

    it("records output and error of a finished run", async () => {
      const completed = newRun();
      const failed = newRun();
      await context.store.create(completed);
      await context.store.create(failed);
      const error = { type: "https://serverlessworkflow.io/spec/1.0.0/errors/runtime", status: 500, instance: "/do/0/x", title: "boom" };

      await context.store.updateRun(completed.id, { status: "completed", output: { id: "t", n: [1, 2] }, finishedAt: "2026-10-18T10:00:02.000Z" }, []);
      await context.store.updateRun(failed.id, { status: "failed", error, finishedAt: "2026-10-18T10:00:02.000Z" }, []);

      expect(await context.store.get(completed.id)).toMatchObject({ status: "completed", output: { id: "t", n: [1, 2] } });
      expect(await context.store.get(failed.id)).toMatchObject({ status: "failed", error });
    });

    it("adds steps in the order they started and updates them by reference, keeping the start time", async () => {
      const run = newRun();
      await context.store.create(run);
      const plan = { name: "plan", reference: "/do/0/plan", status: "running" as const, startedAt: "2026-10-18T10:00:01.000Z" };
      const build = { name: "build", reference: "/do/1/build", status: "running" as const, startedAt: "2026-10-18T10:00:03.000Z" };

      await context.store.saveStep(run.id, plan, []);
      await context.store.saveStep(run.id, { ...plan, status: "completed", taskId: "t-1", startedAt: "2026-10-18T10:00:02.000Z", finishedAt: "2026-10-18T10:00:02.000Z" }, []);
      await context.store.saveStep(run.id, build, []);

      expect((await context.store.get(run.id))?.steps).toEqual([
        { ...plan, status: "completed", taskId: "t-1", finishedAt: "2026-10-18T10:00:02.000Z" },
        build,
      ]);
    });

    it("publishes an event only once when a write is repeated", async () => {
      const run = newRun();
      await context.store.create(run);
      const step = { name: "plan", reference: "/do/0/plan", status: "running" as const };
      const event = stepChanged(contextOf(run), step, "2026-10-18T10:00:01.000Z");

      await context.store.saveStep(run.id, { ...step, startedAt: "2026-10-18T10:00:01.000Z" }, [event]);
      await context.store.saveStep(run.id, { ...step, startedAt: "2026-10-18T10:00:01.000Z" }, [event]);

      expect(await context.events(run.id)).toEqual([event]);
      expect((await context.store.get(run.id))?.steps).toHaveLength(1);
    });

    it("lists runs newest first", async () => {
      const first = newRun();
      const second = newRun();
      await context.store.create(first);
      await context.store.create(second);

      const ids = (await context.store.list()).map((run) => run.id);

      expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
      expect(ids.indexOf(first.id)).toBeGreaterThanOrEqual(0);
    });
  });
}
