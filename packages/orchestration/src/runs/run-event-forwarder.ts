import type { ReceivedEvent } from "../workflow/event-inbox.js";
import { RUN_EVENT_SOURCE } from "./run-events.js";
import type { RunEngine } from "./run-engine.js";

/**
 * Consumer of other domains' events: hands every event that names a run (CloudEvent
 * extension `runid`) to that run, where `listen` tasks receive it. Orchestration's own
 * run and step events are not handed back. Safe behind an at-least-once subscription:
 * the run takes each event once.
 */
export function createRunEventForwarder(engine: Pick<RunEngine, "deliver">) {
  return {
    async handle(event: ReceivedEvent): Promise<void> {
      if (event.source === RUN_EVENT_SOURCE || typeof event.runid !== "string") return;
      await engine.deliver(event.runid, event);
    },
  };
}
