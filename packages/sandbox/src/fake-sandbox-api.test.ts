import { createFakeSandboxApi, createFakeSandboxBackend } from "./index.js";
import { describeSandboxApi } from "./sandbox-api.suite.js";

describeSandboxApi("fake backend", () => {
  const backend = createFakeSandboxBackend();
  const bindRoot = "/srv/workspaces";
  return {
    api: createFakeSandboxApi({ backend, installation: "tendworks", networks: ["tendworks_gateway"], bindRoots: [bindRoot] }),
    neighbour: createFakeSandboxApi({ backend, installation: "neighbour" }),
    image: "busybox:1.37.0",
    network: "tendworks_gateway",
    bindRoot,
    // The fake keeps host directories in memory: any path names a new, empty one.
    hostDirectory: async () => `${bindRoot}/${crypto.randomUUID()}`,
  };
});
