import { describeEventBus } from "./event-bus.suite.js";
import { createInMemoryEventBus, InMemoryEventLog } from "./in-memory-event-bus.js";

describeEventBus("in memory", () => {
  const log = new InMemoryEventLog();
  return {
    bus: createInMemoryEventBus({ log, retryDelayMs: 10 }),
    transaction: (work) => log.transaction(work),
    restart: () => createInMemoryEventBus({ log, retryDelayMs: 10 }),
  };
});
