import type { BusEvent, EventBus, EventHandler, RetryOptions, SubscribeOptions } from "./event-bus.js";
import { Pump } from "./pump.js";

/** The fake's transaction: events wait here until the transaction commits. */
export class InMemoryTransaction {
  readonly pending: BusEvent[] = [];
}

/** Storage of the in-memory bus; several bus instances on one log behave like restarts. */
export class InMemoryEventLog {
  private readonly events: { position: number; event: BusEvent }[] = [];
  private readonly positions = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  /** Runs `work` in a transaction; its events become visible only when `work` succeeds. */
  async transaction(work: (tx: InMemoryTransaction) => Promise<void>): Promise<void> {
    const tx = new InMemoryTransaction();
    await work(tx);
    for (const event of tx.pending) {
      if (!this.has(event)) this.events.push({ position: this.events.length + 1, event: structuredClone(event) });
    }
    if (tx.pending.length > 0) for (const listener of this.listeners) listener();
  }

  has(event: BusEvent): boolean {
    return this.events.some(({ event: known }) => known.source === event.source && known.id === event.id);
  }

  /** The first event after the subscription's position that matches `types`. */
  next(subscription: string, types?: string[]): { position: number; event: BusEvent } | undefined {
    const after = this.positions.get(subscription) ?? 0;
    return this.events.find(({ position, event }) => position > after && (!types || types.includes(event.type)));
  }

  acknowledge(subscription: string, position: number): void {
    this.positions.set(subscription, position);
  }

  listen(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export interface InMemoryEventBusOptions extends RetryOptions {
  log?: InMemoryEventLog;
}

/** Event bus in memory, for tests. The transaction handle is an {@link InMemoryTransaction}. */
export function createInMemoryEventBus({ log = new InMemoryEventLog(), ...retry }: InMemoryEventBusOptions = {}): EventBus<InMemoryTransaction> & {
  log: InMemoryEventLog;
} {
  const pumps: Pump[] = [];
  const unlisten: (() => void)[] = [];

  return {
    log,
    async publish(tx, event) {
      const known = (e: BusEvent) => e.source === event.source && e.id === event.id;
      if (!log.has(event) && !tx.pending.some(known)) tx.pending.push(structuredClone(event));
    },
    subscribe<E extends BusEvent>(name: string, handler: EventHandler<E>, options: SubscribeOptions = {}) {
      const pump = new Pump(async () => {
        const next = log.next(name, options.types);
        if (!next) return false;
        await handler(structuredClone(next.event) as E);
        log.acknowledge(name, next.position);
        return true;
      }, retry);
      pumps.push(pump);
      unlisten.push(log.listen(() => pump.wake()));
      pump.wake();
    },
    async close() {
      for (const stop of unlisten.splice(0)) stop();
      await Promise.all(pumps.splice(0).map((pump) => pump.close()));
    },
  };
}
