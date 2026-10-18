import { createInMemoryRunStore } from "./in-memory-run-store.js";
import { describeRunStore } from "./run-store.suite.js";

describeRunStore("in memory", () => {
  const store = createInMemoryRunStore();
  return { store, events: (runId) => store.publisher.events(runId) };
});
