import type { TriggerFiredEvent } from "../trigger-events.js";

/** One issue matched by one binding; the unit of deduplication. */
export interface FiringKey {
  binding: string;
  /** Identifies the issue across checks, e.g. `acme/playground#7`. */
  item: string;
}

/**
 * The trigger gateway's own record of fired triggers. It guarantees that an issue
 * starts at most one run per binding, also across restarts and several instances.
 *
 * A firing is claimed before its run is started and recorded with the run id after;
 * the record and its `trigger.fired` event commit together (outbox).
 */
export interface FiringStore {
  /** Reserves the key before its run is started; false if it was already reserved or fired. */
  claim(key: FiringKey): Promise<boolean>;
  /** Gives a claim up again because its run could not be started, so a later check retries. */
  release(key: FiringKey): Promise<void>;
  /** Records the run a claimed key started, together with its event. Idempotent. */
  fired(key: FiringKey, runId: string, event: TriggerFiredEvent): Promise<void>;
}
