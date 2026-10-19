import { EventQueue, type ReceivedEvent } from "../workflow/event-inbox.js";
import { executeRun, type RunActivities, type RunExecution } from "./execute-run.js";

/** Port to the durable execution engine that executes runs. */
export interface RunEngine {
  /**
   * Hands a run to the engine and returns once the engine accepted it; the run then
   * executes in the background. Starting the same run id twice is rejected.
   */
  start(execution: RunExecution): Promise<void>;
  /**
   * Hands an event to the run `runId`, whose `listen` tasks receive it. Events wait for
   * a run that does not listen yet; an event for a run that ended or is unknown is
   * dropped. Delivering the same event (source and id) again changes nothing.
   */
  deliver(runId: string, event: ReceivedEvent): Promise<void>;
}

/**
 * Executes runs in this process, without durability: a run is lost when the process
 * ends. For tests and for developing without the execution engine.
 */
export function createInProcessRunEngine(activities: RunActivities): RunEngine & { idle(): Promise<void> } {
  const running = new Map<string, Promise<void>>();
  const inboxes = new Map<string, EventQueue>();
  return {
    async start(execution) {
      if (running.has(execution.runId)) throw new Error(`run ${execution.runId} was already started`);
      const inbox = new EventQueue();
      inboxes.set(execution.runId, inbox);
      const run = executeRun(execution, activities, inbox)
        .catch((error: unknown) => {
          console.error(`run ${execution.runId} stopped:`, error);
        })
        .finally(() => inboxes.delete(execution.runId));
      running.set(execution.runId, run);
    },
    async deliver(runId, event) {
      inboxes.get(runId)?.deliver(structuredClone(event));
    },
    /** Resolves when every started run has ended. */
    async idle() {
      await Promise.all(running.values());
    },
  };
}
