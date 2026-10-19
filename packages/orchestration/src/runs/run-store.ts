import type { Orchestration } from "@tendworks/shared";
import type { RunEvent } from "./run-events.js";

export type Run = Orchestration.components["schemas"]["run"];
export type RunStatus = Orchestration.components["schemas"]["runStatus"];
export type StepRecord = Orchestration.components["schemas"]["step"];

/** Changes to a run's own fields; absent fields stay as they are. */
export type RunPatch = Partial<Pick<Run, "status" | "output" | "error" | "startedAt" | "finishedAt">>;

/**
 * Orchestration's own record of runs and steps. It outlives the execution engine's
 * history, so runs stay readable after the engine has forgotten them.
 *
 * Every write takes the events that describe it; a store hands them to its
 * {@link EventPublisher} inside the transaction that writes the state (outbox), so no
 * event is lost or emitted for a change that did not happen.
 * Writes are idempotent: repeating one (e.g. a retried activity) changes nothing and
 * emits no duplicate events, because events are keyed by their id.
 *
 * @port
 */
export interface RunStore {
  /** Records a new run. */
  create(run: Run): Promise<void>;
  updateRun(runId: string, patch: RunPatch, events: RunEvent[]): Promise<void>;
  /** Inserts or updates the step with the same reference; `startedAt` of an existing step is kept. */
  saveStep(runId: string, step: StepRecord, events: RunEvent[]): Promise<void>;
  get(runId: string): Promise<Run | undefined>;
  /** Runs, newest first. */
  list(options?: { limit?: number }): Promise<Run[]>;
}
