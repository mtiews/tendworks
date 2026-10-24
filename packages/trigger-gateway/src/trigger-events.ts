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
  /** Absent for a binding without workspaces. */
  workspace?: string;
  workflow: string;
  runId: string;
  item: TriggerEvents.ItemReference;
  time: string;
  /** The trace the firing starts; the run it started belongs to it too. */
  traceparent: string;
}): TriggerFiredEvent {
  const { binding, workspace, workflow, item } = firing;
  return {
    ...eventEnvelope({
      // Deterministic: one binding fires once per workspace and item. Workspace names hold no `/`.
      id: `${binding}/${workspace ?? ""}/${item.key}:trigger.fired`,
      source: SOURCE,
      subject: `triggers/${binding}`,
      time: firing.time,
      runId: firing.runId,
      traceparent: firing.traceparent,
    }),
    type: "dev.tendworks.trigger.fired",
    data: { binding, workflow, ...(workspace === undefined ? {} : { workspace }), item },
  };
}
