import type { TriggerGateway as Contract } from "@tendworks/shared";
import type { TriggerFiredEvent } from "../trigger-events.js";

/** How a binding's last check went (contracts/schemas/trigger.schema.yaml#/$defs/evaluation). */
export type Evaluation = Contract.components["schemas"]["evaluation"];

/** One item a binding fired for in one workspace; the unit of deduplication. */
export interface FiringKey {
  binding: string;
  /** Name of the workspace; absent for a binding without workspaces. */
  workspace?: string;
  /** The item's stable key, e.g. `acme/playground#7`. */
  item: string;
}

/**
 * The trigger gateway's own record of fired triggers. It guarantees that an item
 * starts at most one run per binding and workspace, also across restarts and several instances.
 *
 * A firing is claimed before its run is started and recorded with the run id after;
 * the record and its `trigger.fired` event commit together (outbox).
 *
 * @port
 */
export interface FiringStore {
  /** Reserves the key before its run is started; false if it was already reserved or fired. */
  claim(key: FiringKey): Promise<boolean>;
  /** Gives a claim up again because its run could not be started, so a later check retries. */
  release(key: FiringKey): Promise<void>;
  /** Records the run a claimed key started, together with its event. Idempotent. */
  fired(key: FiringKey, runId: string, event: TriggerFiredEvent): Promise<void>;
  /** Keeps how the binding's last check went, replacing the one before. */
  recordEvaluation(binding: string, evaluation: Evaluation): Promise<void>;
  /** The last evaluation of every binding that was checked, by binding name. */
  lastEvaluations(): Promise<Map<string, Evaluation>>;
}
