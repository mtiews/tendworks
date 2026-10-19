import { describeFiringStore } from "./firing-store.suite.js";
import { createInMemoryFiringStore } from "./in-memory-firing-store.js";

describeFiringStore("in memory", () => {
  const store = createInMemoryFiringStore();
  return { store, events: () => store.publisher.events() };
});
