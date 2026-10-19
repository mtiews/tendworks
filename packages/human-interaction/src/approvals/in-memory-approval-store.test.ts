import { createInMemoryApprovalStore } from "./approval-store.js";
import { describeApprovalStore } from "./approval-store.suite.js";

describeApprovalStore("in memory", () => {
  const store = createInMemoryApprovalStore();
  return { store, published: async () => store.published };
});
