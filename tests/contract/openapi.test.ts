import { fileURLToPath } from "node:url";
import { createAgentRuntime } from "@tendworks/agent-runtime";
import { createControlPlaneApi, createOrchestrationClient, createTriggerGatewayClient, loadConfiguration, type ControlPlaneApiOptions } from "@tendworks/control-plane";
import { createHealthApi, createStaticHealthProbe } from "@tendworks/health";
import {
  createApprovals,
  createFakePullRequests,
  createInMemoryApprovalStore,
  createInMemoryNotificationChannel,
  createInMemoryNotificationStore,
  createMergeGate,
  createNotifier,
  type GatedRun,
  type PullRequests,
} from "@tendworks/human-interaction";
import { createInMemoryRunStore, createInProcessRunEngine, createOrchestrationApi, createRunActivities, InMemoryHttpExecutor, type RunEngine } from "@tendworks/orchestration";
import type { ControlPlane } from "@tendworks/shared";
import { createControlPlaneRunStarter, createInMemoryFiringStore, createTriggerGateway, createTriggerGatewayApi } from "@tendworks/trigger-gateway";
import createClient from "openapi-fetch";
import { afterAll, describe, expect, it } from "vitest";
import { openApiContract } from "./support/openapi-contract.js";

/*
 * Each HTTP API against its OpenAPI contract, in process: the control plane (public),
 * orchestration, the trigger gateway and the runtime health API (internal). Every
 * exchange goes through a guard that validates request and response against the
 * contract, on both sides of each internal API. Together the tests must produce every
 * response the contracts document; a documented response no test produces fails the
 * suite, so the contracts cannot promise what the implementation does not do. The
 * sandbox API has no HTTP binding yet; its shared port suite checks it against the
 * contract's schemas instead.
 */

const contracts = {
  controlPlane: openApiContract("control-plane"),
  orchestration: openApiContract("orchestration"),
  triggerGateway: openApiContract("trigger-gateway"),
  health: openApiContract("health"),
};

// Run the whole file: a filtered run leaves documented responses unproduced and fails here.
afterAll(() => {
  for (const [name, contract] of Object.entries(contracts)) {
    expect(contract.violations(), `${name}: contract violations`).toEqual([]);
    expect(contract.unexercised(), `${name}: documented responses no test produced`).toEqual([]);
  }
});

const configuration = loadConfiguration(fileURLToPath(new URL("../../examples/config", import.meta.url)));
const PR = "https://git.example/example/playground/pull/1";
const API_TOKEN = "contract-test-token";
const healthy = createStaticHealthProbe("store", { status: "healthy" });
const unhealthy = createStaticHealthProbe("execution-engine", { status: "unhealthy", message: "no answer" });
const unreachable = async (): Promise<Response> => {
  throw new TypeError("fetch failed");
};

function orchestration(engine?: (real: RunEngine) => RunEngine) {
  const agents = createAgentRuntime({ profiles: configuration.agentProfiles, sleep: async () => {} });
  const store = createInMemoryRunStore();
  const real = createInProcessRunEngine(createRunActivities({ store, agents, http: new InMemoryHttpExecutor() }));
  const api = createOrchestrationApi({ store, engine: engine ? engine(real) : real });
  return contracts.orchestration.guard((request) => api.fetch(request));
}

function controlPlane(options: Partial<ControlPlaneApiOptions> = {}, { token = API_TOKEN }: { token?: string } = {}) {
  const api = createControlPlaneApi({
    probes: [healthy],
    configuration,
    runs: createOrchestrationClient({ baseUrl: "http://worker.test", fetch: orchestration() }),
    apiToken: API_TOKEN,
    ...options,
  });
  return createClient<ControlPlane.paths>({ baseUrl: "http://tend.test", headers: { authorization: `Bearer ${token}` }, fetch: contracts.controlPlane.guard((request) => api.fetch(request)) });
}

const unreachableOrchestration = () => createOrchestrationClient({ baseUrl: "http://worker.test", fetch: unreachable });

describe("control plane: status", () => {
  it("reports a healthy platform with the worker's health and the pending approvals", async () => {
    const worker = createHealthApi({ probes: [healthy] });
    const client = controlPlane({
      bundles: [{ name: "worker", baseUrl: "http://worker.test", fetch: contracts.health.guard((request) => worker.fetch(request)) }],
      approvals: createApprovals({ store: createInMemoryApprovalStore() }),
    });

    const { data, response } = await client.GET("/status");

    expect(response.status).toBe(200);
    expect(data).toMatchObject({ status: "healthy", pendingApprovals: 0 });
  });

  it("reports an unhealthy platform when the worker's components are unhealthy", async () => {
    const worker = createHealthApi({ probes: [healthy, unhealthy] });
    const client = controlPlane({ bundles: [{ name: "worker", baseUrl: "http://worker.test", fetch: contracts.health.guard((request) => worker.fetch(request)) }] });

    const { error, response } = await client.GET("/status");

    expect(response.status).toBe(503);
    expect(error).toMatchObject({ status: "unhealthy" });
  });
});

describe("control plane: runs, through orchestration", () => {
  it("starts, lists and reads a run of a configured workflow", async () => {
    const client = controlPlane();

    const started = await client.POST("/runs", { body: { workflow: "hello-agent", input: { issue: { number: 1, title: "Say hello" } } } });
    const listed = await client.GET("/runs");
    const read = await client.GET("/runs/{runId}", { params: { path: { runId: started.data!.id } } });

    expect(started.response.status).toBe(201);
    expect(listed.data?.items.map((run) => run.id)).toEqual([started.data!.id]);
    expect(read.data?.workflow).toBe("hello-agent");
  });

  it("refuses a workflow that is not configured, and an unknown run", async () => {
    const client = controlPlane();

    expect((await client.POST("/runs", { body: { workflow: "no-such-workflow" } })).response.status).toBe(400);
    expect((await client.GET("/runs/{runId}", { params: { path: { runId: "missing" } } })).response.status).toBe(404);
  });

  it("answers 503 when orchestration cannot be reached", async () => {
    const client = controlPlane({ runs: unreachableOrchestration() });

    expect((await client.POST("/runs", { body: { workflow: "hello-agent" } })).response.status).toBe(503);
    expect((await client.GET("/runs")).response.status).toBe(503);
    expect((await client.GET("/runs/{runId}", { params: { path: { runId: "r-1" } } })).response.status).toBe(503);
  });
});

describe("control plane: agents", () => {
  it("lists the agent profiles of the example configuration", async () => {
    const { data, response } = await controlPlane().GET("/agents");

    expect(response.status).toBe(200);
    expect(data?.items.map((agent) => agent.name)).toEqual(configuration.agentProfiles.map((profile) => profile.metadata.name).sort());
    expect(data?.items.find((agent) => agent.name === "developer")).toMatchObject({ harness: "claude-code", secrets: ["TENDWORKS_AGENT_GITHUB_TOKEN"] });
  });
});

describe("control plane: the API token", () => {
  it("refuses operations that change state without the API token", async () => {
    const client = controlPlane({}, { token: "wrong-token" });

    const started = await client.POST("/runs", { body: { workflow: "hello-agent" } });
    const merged = await client.POST("/pull-requests/merge", { body: { run: "r-1", pullRequest: PR } });
    const decided = await client.POST("/approval-requests/{approvalRequestId}/decision", { params: { path: { approvalRequestId: "a-1" } }, body: { decision: "approve" } });

    expect([started, merged, decided].map(({ response }) => response.status)).toEqual([401, 401, 401]);
  });
});

describe("control plane: triggers, through the trigger gateway", () => {
  it("lists the configured trigger bindings", async () => {
    const gateway = createTriggerGateway({
      bindings: configuration.triggerBindings,
      store: createInMemoryFiringStore(),
      runs: createControlPlaneRunStarter({ baseUrl: "http://tend.test", apiToken: API_TOKEN, fetch: unreachable }),
      now: () => new Date("2026-10-19T10:00:00.000Z"),
    });
    const api = createTriggerGatewayApi(gateway);
    const client = controlPlane({
      triggers: createTriggerGatewayClient({ baseUrl: "http://trigger-gateway.test", fetch: contracts.triggerGateway.guard((request) => api.fetch(request)) }),
    });

    const { data } = await client.GET("/triggers");

    expect(data?.items.map((trigger) => trigger.name)).toEqual(["issue-ready-for-agent"]);
  });

  it("answers 503 when the trigger gateway cannot be reached", async () => {
    const client = controlPlane({ triggers: createTriggerGatewayClient({ baseUrl: "http://trigger-gateway.test", fetch: unreachable }) });

    expect((await client.GET("/triggers")).response.status).toBe(503);
  });
});

describe("control plane: notifications", () => {
  it("lists the notifications human interaction recorded", async () => {
    const store = createInMemoryNotificationStore();
    await createNotifier({ store, channel: createInMemoryNotificationChannel() }).handle({
      specversion: "1.0",
      id: "r-1:run.completed",
      source: "/tendworks/orchestration",
      type: "dev.tendworks.run.completed",
      time: "2026-10-19T10:00:00.000Z",
      datacontenttype: "application/json",
      runid: "r-1",
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      data: { workflow: "hello-agent" },
    });
    const client = controlPlane({ notifications: store });

    const { data } = await client.GET("/notifications");

    expect(data?.items).toHaveLength(1);
  });

  it("answers 503 without a notification store", async () => {
    expect((await controlPlane().GET("/notifications")).response.status).toBe(503);
  });
});

describe("control plane: merges behind the gate, and approval requests", () => {
  function gated(run: Partial<GatedRun> = {}, pullRequests: PullRequests = createFakePullRequests([{ url: PR, headBranch: "tendworks/fake", state: "open" }])) {
    const store = createInMemoryApprovalStore();
    const runs = async (runId: string): Promise<GatedRun | undefined> =>
      runId === "r-1" ? { id: "r-1", workflow: "fake-develop-and-ask", status: "running", artifacts: [{ name: "pull-request", url: PR, workspace: { repository: "https://git.example/example/playground.git", branch: "tendworks/fake" } }], ...run } : undefined;
    return controlPlane({
      merges: createMergeGate({ policies: configuration.policies, runs, pullRequests: () => pullRequests, approvals: store }),
      approvals: createApprovals({ store }),
    });
  }
  const merge = (client: ReturnType<typeof controlPlane>, pullRequest: string | null = PR) => client.POST("/pull-requests/merge", { body: { run: "r-1", pullRequest } });
  const decide = (client: ReturnType<typeof controlPlane>, id: string, decision: "approve" | "reject") =>
    client.POST("/approval-requests/{approvalRequestId}/decision", { params: { path: { approvalRequestId: id } }, body: { decision } });

  it("merges right away when the policy allows it", async () => {
    const { data, response } = await merge(gated({ workflow: "fake-develop-and-merge" }));

    expect(response.status).toBe(200);
    expect(data).toMatchObject({ merged: true, decision: "allow" });
  });

  it("asks first, lists the pending approval request and merges once it is approved", async () => {
    const client = gated();

    const asked = await merge(client);
    const pending = await client.GET("/approval-requests", { params: { query: { status: "pending" } } });
    const approved = await decide(client, asked.data!.approvalRequest!.id, "approve");
    const merged = await merge(client);

    expect(asked.response.status).toBe(202);
    expect(pending.data?.items.map((item) => item.id)).toEqual([asked.data!.approvalRequest!.id]);
    expect(approved.data?.status).toBe("approved");
    expect(merged.response.status).toBe(200);
  });

  it("refuses the merge once the approval request is rejected, and a decision the other way", async () => {
    const client = gated();
    const id = (await merge(client)).data!.approvalRequest!.id;
    await decide(client, id, "reject");

    expect((await merge(client)).response.status).toBe(403);
    expect((await decide(client, id, "approve")).response.status).toBe(409);
  });

  it("refuses an invalid merge request, a run that is not running and a repository that cannot be reached", async () => {
    const unreachableRepository: PullRequests = {
      merge: async () => Promise.reject(new Error("connection refused")),
      describe: async () => Promise.reject(new Error("connection refused")),
    };

    expect((await merge(gated(), null)).response.status).toBe(400);
    expect((await merge(gated({ status: "completed" }))).response.status).toBe(409);
    expect((await merge(gated({ workflow: "fake-develop-and-merge" }, unreachableRepository))).response.status).toBe(502);
  });

  it("refuses an invalid decision and an unknown approval request", async () => {
    const client = gated();

    const invalid = await client.POST("/approval-requests/{approvalRequestId}/decision", {
      params: { path: { approvalRequestId: "a-1" } },
      body: { decision: "maybe" as "approve" },
    });

    expect(invalid.response.status).toBe(400);
    expect((await decide(client, "missing", "approve")).response.status).toBe(404);
  });

  it("refuses a status filter that is not an approval status", async () => {
    const { response } = await gated().GET("/approval-requests", { params: { query: { status: "maybe" as "pending" } } });

    expect(response.status).toBe(400);
  });

  it("answers 503 without a merge gate and without approval requests", async () => {
    const client = controlPlane();

    expect((await merge(client)).response.status).toBe(503);
    expect((await client.GET("/approval-requests")).response.status).toBe(503);
    expect((await decide(client, "a-1", "approve")).response.status).toBe(503);
  });
});

describe("orchestration, called directly", () => {
  const start = (fetch: (request: Request) => Promise<Response>, workflow: unknown) =>
    fetch(new Request("http://worker.test/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflow }) }));

  it("refuses a definition that is not a workflow it can run", async () => {
    expect((await start(orchestration(), { document: { name: "broken" } })).status).toBe(400);
  });

  it("answers 503 when the execution engine does not accept the run", async () => {
    const refusing = orchestration((real) => ({ ...real, start: async () => Promise.reject(new Error("engine unavailable")) }));

    expect((await start(refusing, configuration.workflow("hello-agent"))).status).toBe(503);
  });
});
