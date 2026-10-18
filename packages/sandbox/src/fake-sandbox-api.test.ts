import { createFakeSandboxApi } from "./index.js";
import { describeSandboxApi } from "./sandbox-api.suite.js";

describeSandboxApi("fake backend", () => ({ api: createFakeSandboxApi(), image: "busybox:1.37.0" }));
