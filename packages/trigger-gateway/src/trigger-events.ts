import { eventEnvelope } from "@tendworks/platform";
import type { TriggerEvents } from "@tendworks/shared";

export type TriggerFiredEvent = TriggerEvents.TriggerFiredEvent;

/**
 * Port through which the trigger gateway emits its events. `tx` is the transaction that
 * records the firing, so the firing and its event commit together (outbox). Publishing
 * an event whose id is already known is a no-op. The server bundle passes the event
 * bus, which has the same shape (ADR 0005).
 *
 * @port
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
  /** The trace the firing starts; the run it started belongs to it too. */
  traceparent: string;
}): TriggerFiredEvent {
  return {
    ...eventEnvelope({
      // Deterministic: one binding fires once per issue.
      id: `${firing.binding}/${firing.item}:trigger.fired`,
      source: SOURCE,
      subject: `triggers/${firing.binding}`,
      time: firing.time,
      runId: firing.runId,
      traceparent: firing.traceparent,
    }),
    type: "dev.tendworks.trigger.fired",
    data: { binding: firing.binding, workflow: firing.workflow, issue: firing.issue },
  };
}
