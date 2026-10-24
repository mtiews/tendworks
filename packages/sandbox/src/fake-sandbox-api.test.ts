import { createFakeSandboxApi, createFakeSandboxBackend } from "./index.js";
import { describeSandboxApi } from "./sandbox-api.suite.js";

describeSandboxApi("fake backend", () => {
  const backend = createFakeSandboxBackend();
  return {
    api: createFakeSandboxApi({ backend, installation: "tendworks", networks: ["tendworks_gateway"] }),
    neighbour: createFakeSandboxApi({ backend, installation: "neighbour" }),
    image: "busybox:1.37.0",
    network: "tendworks_gateway",
  };
});
