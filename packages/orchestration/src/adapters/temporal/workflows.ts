// Workflow code: bundled and run inside the execution engine's deterministic sandbox.
// Import only deterministic modules (the interpreter) and types; activities as types only.
import { ActivityFailure, proxyActivities } from "@temporalio/workflow";
import { executeRun, type RunActivities, type RunExecution } from "../../runs/execute-run.js";

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

/** One run = one workflow execution; the workflow id is the run id. */
export async function executeRunWorkflow(execution: RunExecution): Promise<void> {
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
        if (error instanceof ActivityFailure && error.cause) throw new Error(error.cause.message);
        throw error;
      }
    },
  });
}
