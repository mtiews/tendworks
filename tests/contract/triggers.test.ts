import { fileURLToPath } from "node:url";
import { createAgentRuntime } from "@tendworks/agent-runtime";
import { createControlPlaneApi, createOrchestrationClient, createTriggerGatewayClient, loadConfiguration } from "@tendworks/control-plane";
import { createInMemoryRunStore, createInProcessRunEngine, createOrchestrationApi, createRunActivities } from "@tendworks/orchestration";
import type { ControlPlane } from "@tendworks/shared";
import {
  createControlPlaneRunStarter,
  createInMemoryFiringStore,
  createTriggerGateway,
  createTriggerGatewayApi,
} from "@tendworks/trigger-gateway";
import createClient from "openapi-fetch";
import { describe, expect, it } from "vitest";

/*
 * Both sides of the trigger APIs in one process: the trigger gateway starts runs through
 * the public control plane API, and the control plane lists triggers through the trigger
 * gateway's internal API. Bindings come from the example configuration.
 */

function platform() {
  const configuration = loadConfiguration(fileURLToPath(new URL("../../examples/config", import.meta.url)));
  const agents = createAgentRuntime({ profiles: configuration.agentProfiles, sleep: async () => {} });
  const store = createInMemoryRunStore();
  const orchestration = createOrchestrationApi({ store, engine: createInProcessRunEngine(createRunActivities({ store, agents })) });
  const gateway = createTriggerGateway({
    bindings: configuration.triggerBindings,
    store: createInMemoryFiringStore(),
    runs: createControlPlaneRunStarter({ baseUrl: "http://tend.test", fetch: (request) => controlPlane.fetch(request) }),
    now: () => new Date("2026-10-18T10:00:05.000Z"),
  });
  const gatewayApi = createTriggerGatewayApi(gateway);
  const controlPlane = createControlPlaneApi({
    probes: [],
    configuration,
    runs: createOrchestrationClient({ baseUrl: "http://worker.test", fetch: (request) => orchestration.fetch(request) }),
    triggers: createTriggerGatewayClient({ baseUrl: "http://trigger-gateway.test", fetch: (request) => gatewayApi.fetch(request) }),
  });
  return { gateway, client: createClient<ControlPlane.paths>({ baseUrl: "http://tend.test", fetch: (request) => controlPlane.fetch(request) }) };
}

describe("triggers through the control plane and the trigger gateway", () => {
  it("lists the example trigger binding with its next execution", async () => {
    const { client } = platform();

    const { data } = await client.GET("/triggers");

    expect(data).toEqual({
      items: [{ name: "issue-ready-for-agent", workflow: "hello-agent", schedule: { every: { seconds: 10 } }, nextExecutionAt: "2026-10-18T10:00:10.000Z" }],
    });
  });

  it("starts runs of the bound workflow through the public API, once per matching issue", async () => {
    const { gateway, client } = platform();

    const first = await gateway.check("issue-ready-for-agent");
    const second = await gateway.check("issue-ready-for-agent");

    expect(first.failed).toEqual([]);
    expect(first.fired.map((fired) => fired.issue)).toEqual(["example/playground#101", "example/playground#102"]);
    expect(second).toEqual({ fired: [], failed: [] });
    const runs = (await client.GET("/runs")).data?.items ?? [];
    expect(runs.map((run) => [run.id, run.workflow, run.input]).sort()).toEqual(
      [
        [first.fired[0]!.runId, "hello-agent", { issue: { number: 101, title: "Add a greeting", url: "https://issues.example/example/playground/101" } }],
        [first.fired[1]!.runId, "hello-agent", { issue: { number: 102, title: "Fix the typo", url: "https://issues.example/example/playground/102" } }],
      ].sort(),
    );
  });
});
