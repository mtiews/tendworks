import type { EventPublisher, RunEvent } from "./run-events.js";
import type { Run, RunPatch, RunStore, StepRecord } from "./run-store.js";

/** Event publisher that keeps events in memory; the fake's transaction is a list of pending events. */
export class InMemoryEventPublisher implements EventPublisher<RunEvent[]> {
  readonly published: RunEvent[] = [];

  async publish(tx: RunEvent[], event: RunEvent): Promise<void> {
    if (!this.published.some((known) => known.id === event.id) && !tx.some((known) => known.id === event.id)) tx.push(event);
  }

  /** Makes the events of a transaction visible. */
  commit(tx: RunEvent[]): void {
    this.published.push(...tx);
  }

  async events(runId: string): Promise<RunEvent[]> {
    return this.published.filter((event) => event.runid === runId);
  }
}

/** Run store in memory, for tests and the in-process engine. */
export function createInMemoryRunStore(publisher = new InMemoryEventPublisher()): RunStore & { publisher: InMemoryEventPublisher } {
  const runs = new Map<string, Run>();
  const clone = <T>(value: T): T => structuredClone(value);

  const transaction = async (write: () => void, events: RunEvent[]) => {
    const tx: RunEvent[] = [];
    for (const event of events) await publisher.publish(tx, event);
    write();
    publisher.commit(tx);
  };

  const existing = (runId: string) => {
    const run = runs.get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    return run;
  };

  return {
    publisher,
    async create(run) {
      if (runs.has(run.id)) throw new Error(`run ${run.id} already exists`);
      runs.set(run.id, clone(run));
    },
    async updateRun(runId: string, patch: RunPatch, events) {
      const run = existing(runId);
      await transaction(() => Object.assign(run, clone(patch)), events);
    },
    async saveStep(runId: string, step: StepRecord, events) {
      const run = existing(runId);
      await transaction(() => {
        const index = run.steps.findIndex((known) => known.reference === step.reference);
        if (index === -1) run.steps.push(clone(step));
        else run.steps[index] = { ...clone(step), startedAt: run.steps[index]!.startedAt };
      }, events);
    },
    async get(runId) {
      const run = runs.get(runId);
      return run && clone(run);
    },
    async list({ limit = 100 } = {}) {
      return [...runs.values()].reverse().slice(0, limit).map(clone);
    },
  };
}
