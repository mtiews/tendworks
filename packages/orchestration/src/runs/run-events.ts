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

function envelope(run: RunContext, id: string, time: string) {
  return {
    specversion: "1.0" as const,
    // Deterministic ids make a repeated write (retried activity) recognisable.
    id,
    source: RUN_EVENT_SOURCE,
    subject: `runs/${run.runId}`,
    time,
    datacontenttype: "application/json" as const,
    runid: run.runId,
    traceparent: run.traceparent,
  };
}

export function runStarted(run: RunContext, time: string): RunEvents.RunStartedEvent {
  return { ...envelope(run, `${run.runId}:run.started`, time), type: "dev.tendworks.run.started", data: { workflow: run.workflow } };
}

export function runFinished(
  run: RunContext,
  result: { status: "completed" } | { status: "failed"; error: RunEvents.WorkflowError },
  time: string,
): RunEvents.RunCompletedEvent | RunEvents.RunFailedEvent {
  if (result.status === "completed") {
    return { ...envelope(run, `${run.runId}:run.completed`, time), type: "dev.tendworks.run.completed", data: { workflow: run.workflow } };
  }
  return {
    ...envelope(run, `${run.runId}:run.failed`, time),
    type: "dev.tendworks.run.failed",
    data: { workflow: run.workflow, error: result.error },
  };
}

export function stepChanged(
  run: RunContext,
  step: Step,
  time: string,
): RunEvents.StepStartedEvent | RunEvents.StepCompletedEvent | RunEvents.StepFailedEvent {
  const base = { ...envelope(run, `${run.runId}${step.reference}:step.${step.status === "running" ? "started" : step.status}`, time), stepid: step.reference };
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

/** A W3C traceparent with a fresh trace id, for a new run. */
export function newTraceparent(): string {
  const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `00-${hex(16)}-${hex(8)}-01`;
}
