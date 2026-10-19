import { fileURLToPath } from "node:url";
import { createAgentRuntime } from "@tendworks/agent-runtime";
import { createControlPlaneApi, createOrchestrationClient, loadConfiguration } from "@tendworks/control-plane";
import {
  createInMemoryRunStore,
  createInProcessRunEngine,
  createOrchestrationApi,
  createRunActivities,
  InMemoryHttpExecutor,
} from "@tendworks/orchestration";
import type { ControlPlane } from "@tendworks/shared";
import createClient from "openapi-fetch";
import { describe, expect, it } from "vitest";
import { guardedContracts } from "./support/guarded-contracts.js";

/*
 * Both sides of the internal orchestration API in one process: the control plane's
 * client against orchestration's real API, with the agent runtime's fake agent behind
 * the A2A boundary. The durable engine is replaced by the in-process one.
 */

const contracts = guardedContracts("orchestration", "control-plane");

type Run = ControlPlane.components["schemas"]["run"];

const API_TOKEN = "contract-test-token";

function platform() {
  const configuration = loadConfiguration(fileURLToPath(new URL("../../examples/config", import.meta.url)));
  const agents = createAgentRuntime({ profiles: configuration.agentProfiles, sleep: async () => {} });
  const store = createInMemoryRunStore();
  const orchestration = createOrchestrationApi({ store, engine: createInProcessRunEngine(createRunActivities({ store, agents, http: new InMemoryHttpExecutor() })) });
  const controlPlane = createControlPlaneApi({
    probes: [],
    configuration,
    runs: createOrchestrationClient({ baseUrl: "http://worker.test", fetch: contracts["orchestration"].guard((request) => orchestration.fetch(request)) }),
    apiToken: API_TOKEN,
  });
  return createClient<ControlPlane.paths>({ baseUrl: "http://tend.test", headers: { authorization: `Bearer ${API_TOKEN}` }, fetch: contracts["control-plane"].guard((request) => controlPlane.fetch(request)) });
}

describe("runs through the control plane, orchestration and the fake agent", () => {
  it("runs the example workflow to completion", async () => {
    const client = platform();

    const { data: started, response } = await client.POST("/runs", {
      body: { workflow: "hello-agent", input: { issue: { number: 1, title: "Say hello" } } },
    });
    expect(response.status).toBe(201);

    let run: Run | undefined;
    for (let attempt = 0; attempt < 100 && !["completed", "failed"].includes(run?.status ?? ""); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      run = (await client.GET("/runs/{runId}", { params: { path: { runId: started!.id } } })).data;
    }

    expect(run).toMatchObject({
      status: "completed",
      steps: [{ name: "implement", status: "completed" }],
      output: { state: "TASK_STATE_COMPLETED", reply: "Pretended to implement the issue." },
    });
    expect((await client.GET("/runs")).data?.items.map((item) => item.id)).toEqual([started!.id]);
  });

  it("passes orchestration's refusal on as 404 for an unknown run", async () => {
    const { response, error } = await platform().GET("/runs/{runId}", { params: { path: { runId: "missing" } } });

    expect(response.status).toBe(404);
    expect(error).toMatchObject({ title: "Run not found" });
  });
});
