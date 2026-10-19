import type { A2A, Workflow } from "@tendworks/shared";
import type { HttpRequest, HttpResponse } from "../workflow/http-executor.js";
import { runWorkflow, type RunResult, type RuntimeDescriptor, type Step } from "../workflow/interpreter.js";
import type { RunContext } from "./run-events.js";

// Deterministic like the interpreter: this module runs inside the durable execution
// engine. It may only import the interpreter and types.

/** Everything the execution engine needs to execute a run; a snapshot taken at start. */
export interface RunExecution extends RunContext {
  definition: Workflow.Workflow;
  input: unknown;
  /** `$runtime` of the run's expressions, e.g. the control plane URL. */
  runtime?: RuntimeDescriptor;
}

export type RunOutcome = Omit<RunResult, "steps">;

/** The side effects of executing a run. Each must be safe to repeat (retries, restarts). */
export interface RunActivities {
  runStarted(run: RunContext): Promise<void>;
  recordStep(run: RunContext, step: Step): Promise<void>;
  sendMessage(agent: string, request: A2A.SendMessageRequest): Promise<A2A.Task>;
  httpRequest(request: HttpRequest): Promise<HttpResponse>;
  runFinished(run: RunContext, outcome: RunOutcome): Promise<void>;
}

/** Executes a run with the interpreter, recording its progress through the activities. */
export async function executeRun(execution: RunExecution, activities: RunActivities): Promise<void> {
  const run: RunContext = { runId: execution.runId, workflow: execution.workflow, traceparent: execution.traceparent };
  await activities.runStarted(run);
  const { steps: _steps, ...outcome } = await runWorkflow(execution.definition, {
    runId: execution.runId,
    input: execution.input,
    executor: { sendMessage: (agent, request) => activities.sendMessage(agent, request) },
    http: { request: (request) => activities.httpRequest(request) },
    ...(execution.runtime ? { runtime: execution.runtime } : {}),
    recordStep: (step) => activities.recordStep(run, step),
  });
  await activities.runFinished(run, outcome);
}
