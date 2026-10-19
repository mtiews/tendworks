import { createInProcessRunEngine } from "./run-engine.js";
import { describeRunEngine } from "./run-engine.suite.js";

describeRunEngine("in process", (activities) => ({ engine: createInProcessRunEngine(activities) }));
