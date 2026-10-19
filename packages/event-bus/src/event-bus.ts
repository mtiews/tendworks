/**
 * The CloudEvent attributes the bus itself relies on. Producers publish complete
 * CloudEvents (contracts/events/); the bus stores and delivers them unchanged.
 */
export interface BusEvent {
  /** Unique per source; the bus ignores a second event with the same source and id. */
  id: string;
  source: string;
  type: string;
}

export type EventHandler<E extends BusEvent = BusEvent> = (event: E) => Promise<void>;

export interface SubscribeOptions {
  /** Only events of these types reach the handler; all events when omitted. */
  types?: string[];
}

/**
 * Port for asynchronous events between domains.
 *
 * - `publish` writes inside the producer's transaction `tx` (outbox): the event becomes
 *   visible to subscribers only when that transaction commits, and never when it rolls back.
 * - Delivery is at least once and in publish order per subscription. A subscription is
 *   identified by its name; its position survives restarts, and a new subscription starts
 *   with the oldest event. When a handler throws, the same event is delivered again later,
 *   so handlers must be idempotent.
 *
 * @port
 */
export interface EventBus<Tx> {
  publish(tx: Tx, event: BusEvent): Promise<void>;
  subscribe<E extends BusEvent = BusEvent>(name: string, handler: EventHandler<E>, options?: SubscribeOptions): void;
  /** Stops delivery; resolves once in-flight deliveries have finished. */
  close(): Promise<void>;
}

export interface RetryOptions {
  /** Delay before a failed event is delivered again; doubles per attempt up to `maxRetryDelayMs`. */
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
}
