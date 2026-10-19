import { createInMemoryTaskStore } from "./task-store.js";
import { describeTaskStore } from "./task-store.suite.js";

describeTaskStore("in memory", () => {
  const store = createInMemoryTaskStore();
  return { store, published: async () => store.published };
});
