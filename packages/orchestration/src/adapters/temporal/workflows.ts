// Workflow code: bundled and run inside the execution engine's deterministic sandbox.
// Import only deterministic modules (the interpreter) and types; activities as types only.
import { ActivityFailure, defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";
import { executeRun, type RunActivities, type RunExecution } from "../../runs/execute-run.js";
import { EventQueue, type ReceivedEvent } from "../../workflow/event-inbox.js";

/** Delivers an event to the run; the engine keeps it in the run's history, so it survives restarts. */
const eventSignal = defineSignal<[ReceivedEvent]>("event");

const recording = proxyActivities<Pick<RunActivities, "runStarted" | "recordStep" | "runFinished">>({
  startToCloseTimeout: "1 minute",
  retry: { maximumInterval: "30 seconds" },
});

const agents = proxyActivities<Pick<RunActivities, "sendMessage">>({
  startToCloseTimeout: "2 hours",
  // The activity heartbeats while the agent works, so a dead worker is noticed quickly
  // and the task is retried; the deterministic message id lets the agent recognise it.
  heartbeatTimeout: "30 seconds",
  retry: { maximumAttempts: 3, maximumInterval: "30 seconds" },
});

const endpoints = proxyActivities<Pick<RunActivities, "httpRequest">>({
  startToCloseTimeout: "2 minutes",
  // Only a missing response fails the activity (any status is a result), so a retry
  // repeats a request that may have arrived; endpoints called from workflows must be
  // idempotent (e.g. merging an already merged pull request succeeds).
  retry: { maximumAttempts: 3, maximumInterval: "30 seconds" },
});

/** One run = one workflow execution; the workflow id is the run id. */
export async function executeRunWorkflow(execution: RunExecution): Promise<void> {
  // Registered before the first await, so no event signalled at start is missed.
  const inbox = new EventQueue();
  setHandler(eventSignal, (event) => inbox.deliver(event));
  // Activity proxies are Proxy objects without own keys, so they cannot be spread.
  await executeRun(execution, {
    runStarted: recording.runStarted,
    recordStep: recording.recordStep,
    runFinished: recording.runFinished,
    async sendMessage(agent, request) {
      try {
        return await agents.sendMessage(agent, request);
      } catch (error) {
        // Report why the agent could not be reached, not the engine's wrapper message.
        if (error instanceof ActivityFailure && error.cause) throw new Error(error.cause.message, { cause: error });
        throw error;
      }
    },
    async httpRequest(request) {
      try {
        return await endpoints.httpRequest(request);
      } catch (error) {
        if (error instanceof ActivityFailure && error.cause) throw new Error(error.cause.message, { cause: error });
        throw error;
      }
    },
  }, inbox);
}
