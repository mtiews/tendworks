/** A CloudEvent as a run receives it (contracts/events/cloudevent.schema.yaml). */
export interface ReceivedEvent {
  id: string;
  source: string;
  type: string;
  data?: unknown;
  [attribute: string]: unknown;
}

/**
 * How `listen` tasks receive the events delivered to their run. Events delivered before
 * anyone listens wait in the inbox; each event is handed out once, and an event
 * delivered again (same source and id) is ignored. Not a port: no product sits behind
 * it, and both run engines use the one {@link EventQueue}.
 */
export interface EventInbox {
  /** Resolves with the oldest waiting event `accepts` takes, waiting for one if needed, and consumes it. */
  receive(accepts: (event: ReceivedEvent) => boolean): Promise<ReceivedEvent>;
}

/**
 * Keeps delivered events and hands them to waiting receivers. Pure (no I/O, no clock),
 * so the durable engine's workflow code uses it too, fed by its signal handler.
 */
export class EventQueue implements EventInbox {
  readonly #waiting: ReceivedEvent[] = [];
  readonly #seen = new Set<string>();
  readonly #receivers: { accepts: (event: ReceivedEvent) => boolean; resolve: (event: ReceivedEvent) => void }[] = [];

  deliver(event: ReceivedEvent): void {
    const key = `${event.source} ${event.id}`;
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    const receiver = this.#receivers.findIndex(({ accepts }) => accepts(event));
    if (receiver === -1) this.#waiting.push(event);
    else this.#receivers.splice(receiver, 1)[0]!.resolve(event);
  }

  receive(accepts: (event: ReceivedEvent) => boolean): Promise<ReceivedEvent> {
    const index = this.#waiting.findIndex(accepts);
    if (index !== -1) return Promise.resolve(this.#waiting.splice(index, 1)[0]!);
    return new Promise((resolve) => this.#receivers.push({ accepts, resolve }));
  }
}
