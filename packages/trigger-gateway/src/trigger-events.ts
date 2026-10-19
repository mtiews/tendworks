import type { TriggerEvents } from "@tendworks/shared";

export type TriggerFiredEvent = TriggerEvents.TriggerFiredEvent;

/**
 * Port through which the trigger gateway emits its events. `tx` is the transaction that
 * records the firing, so the firing and its event commit together (outbox). Publishing
 * an event whose id is already known is a no-op. The event bus later provides a
 * publisher of the same shape, wired in the server bundle.
 */
export interface EventPublisher<Tx> {
  publish(tx: Tx, event: TriggerFiredEvent): Promise<void>;
}

const SOURCE = "/tendworks/trigger-gateway";

export function triggerFired(firing: {
  binding: string;
  item: string;
  workflow: string;
  runId: string;
  issue: TriggerEvents.IssueReference;
  time: string;
}): TriggerFiredEvent {
  return {
    specversion: "1.0",
    // Deterministic: one binding fires once per issue.
    id: `${firing.binding}/${firing.item}:trigger.fired`,
    source: SOURCE,
    type: "dev.tendworks.trigger.fired",
    subject: `triggers/${firing.binding}`,
    time: firing.time,
    datacontenttype: "application/json",
    runid: firing.runId,
    traceparent: newTraceparent(),
    data: { binding: firing.binding, workflow: firing.workflow, issue: firing.issue },
  };
}

/** A W3C traceparent with a fresh trace id. */
function newTraceparent(): string {
  const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `00-${hex(16)}-${hex(8)}-01`;
}
