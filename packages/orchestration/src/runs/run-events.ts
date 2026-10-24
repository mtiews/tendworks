import { eventEnvelope } from "@tendworks/platform";
import type { RunEvents } from "@tendworks/shared";
import type { Step } from "../workflow/interpreter.js";

export type RunEvent =
  | RunEvents.RunStartedEvent
  | RunEvents.RunCompletedEvent
  | RunEvents.RunFailedEvent
  | RunEvents.StepStartedEvent
  | RunEvents.StepCompletedEvent
  | RunEvents.StepFailedEvent;

/**
 * Port through which orchestration emits its events. `tx` is the transaction that
 * writes the state the event describes, so state and event commit together (outbox).
 * Publishing an event whose id is already known is a no-op.
 *
 * @port
 */
export interface EventPublisher<Tx> {
  publish(tx: Tx, event: RunEvent): Promise<void>;
}

/** What every event of a run carries. */
export interface RunContext {
  runId: string;
  workflow: string;
  /** W3C trace context of the run. */
  traceparent: string;
}

/** The CloudEvent source of run and step events. */
export const RUN_EVENT_SOURCE = "/tendworks/orchestration";

// Deterministic ids make a repeated write (retried activity) recognisable.
const envelope = (run: RunContext, id: string, time: string, stepId?: string) =>
  eventEnvelope({ id, source: RUN_EVENT_SOURCE, subject: `runs/${run.runId}`, time, runId: run.runId, traceparent: run.traceparent, ...(stepId === undefined ? {} : { stepId }) });

export function runStarted(run: RunContext, time: string): RunEvents.RunStartedEvent {
  return { ...envelope(run, `${run.runId}:run.started`, time), type: "dev.tendworks.run.started", data: { workflow: run.workflow } };
}

/** A link a step's agent reported as a result of its task. */
export type RunArtifact = RunEvents.RunCompletedEventData["artifacts"][number];

/** The end of a run, with the artifacts its steps reported (in step order), so consumers need not read the run. */
export function runFinished(
  run: RunContext,
  result: { status: "completed" } | { status: "failed"; error: RunEvents.WorkflowError },
  artifacts: RunArtifact[],
  time: string,
): RunEvents.RunCompletedEvent | RunEvents.RunFailedEvent {
  if (result.status === "completed") {
    return { ...envelope(run, `${run.runId}:run.completed`, time), type: "dev.tendworks.run.completed", data: { workflow: run.workflow, artifacts } };
  }
  return {
    ...envelope(run, `${run.runId}:run.failed`, time),
    type: "dev.tendworks.run.failed",
    data: { workflow: run.workflow, error: result.error, artifacts },
  };
}

export function stepChanged(
  run: RunContext,
  step: Step,
  time: string,
): RunEvents.StepStartedEvent | RunEvents.StepCompletedEvent | RunEvents.StepFailedEvent {
  const base = envelope(run, `${run.runId}${step.reference}:step.${step.status === "running" ? "started" : step.status}`, time, step.reference);
  const data = { name: step.name, reference: step.reference, ...(step.taskId === undefined ? {} : { taskId: step.taskId }) };
  switch (step.status) {
    case "running":
      return { ...base, type: "dev.tendworks.step.started", data };
    case "completed":
      return { ...base, type: "dev.tendworks.step.completed", data };
    case "failed":
      return { ...base, type: "dev.tendworks.step.failed", data: { ...data, error: step.error! } };
  }
}
