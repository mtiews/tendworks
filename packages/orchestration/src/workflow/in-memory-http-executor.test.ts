import { describeHttpExecutor } from "./http-executor.suite.js";
import { fromResponse, toRequest } from "./http-response.js";
import { InMemoryHttpExecutor } from "./in-memory-http-executor.js";

describeHttpExecutor("in memory", (endpoint) => ({
  executor: new InMemoryHttpExecutor().respond(async (request) => fromResponse(await endpoint(toRequest(request)))),
  url: "http://control-plane.test",
}));
