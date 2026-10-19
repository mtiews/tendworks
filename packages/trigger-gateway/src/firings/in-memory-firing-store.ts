import type { EventPublisher, TriggerFiredEvent } from "../trigger-events.js";
import type { FiringKey, FiringStore } from "./firing-store.js";

/** Event publisher that keeps events in memory; the fake's transaction is a list of pending events. */
export class InMemoryEventPublisher implements EventPublisher<TriggerFiredEvent[]> {
  readonly published: TriggerFiredEvent[] = [];

  async publish(tx: TriggerFiredEvent[], event: TriggerFiredEvent): Promise<void> {
    if (!this.published.some((known) => known.id === event.id) && !tx.some((known) => known.id === event.id)) tx.push(event);
  }

  /** Makes the events of a transaction visible. */
  commit(tx: TriggerFiredEvent[]): void {
    this.published.push(...tx);
  }

  /** Published events, oldest first. */
  async events(): Promise<TriggerFiredEvent[]> {
    return structuredClone(this.published);
  }
}

/** Firing store in memory, for tests. */
export function createInMemoryFiringStore(publisher = new InMemoryEventPublisher()): FiringStore & { publisher: InMemoryEventPublisher } {
  const firings = new Map<string, { runId?: string }>();
  const id = ({ binding, item }: FiringKey) => JSON.stringify([binding, item]);
  return {
    publisher,
    async claim(key) {
      if (firings.has(id(key))) return false;
      firings.set(id(key), {});
      return true;
    },
    async release(key) {
      if (firings.get(id(key))?.runId === undefined) firings.delete(id(key));
    },
    async fired(key, runId, event) {
      const firing = firings.get(id(key));
      if (firing?.runId !== undefined) return;
      const tx: TriggerFiredEvent[] = [];
      await publisher.publish(tx, event);
      firings.set(id(key), { runId });
      publisher.commit(tx);
    },
  };
}
