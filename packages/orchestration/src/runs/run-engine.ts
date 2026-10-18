import { executeRun, type RunActivities, type RunExecution } from "./execute-run.js";

/** Port to the durable execution engine that executes runs. */
export interface RunEngine {
  /**
   * Hands a run to the engine and returns once the engine accepted it; the run then
   * executes in the background. Starting the same run id twice is rejected.
   */
  start(execution: RunExecution): Promise<void>;
}

/**
 * Executes runs in this process, without durability: a run is lost when the process
 * ends. For tests and for developing without the execution engine.
 */
export function createInProcessRunEngine(activities: RunActivities): RunEngine & { idle(): Promise<void> } {
  const running = new Map<string, Promise<void>>();
  return {
    async start(execution) {
      if (running.has(execution.runId)) throw new Error(`run ${execution.runId} was already started`);
      const run = executeRun(execution, activities).catch((error: unknown) => {
        console.error(`run ${execution.runId} stopped:`, error);
      });
      running.set(execution.runId, run);
    },
    /** Resolves when every started run has ended. */
    async idle() {
      await Promise.all(running.values());
    },
  };
}
