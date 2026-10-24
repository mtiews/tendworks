import { createAgentRuntime } from "@tendworks/agent-runtime";
import { createControlPlaneApi, createOrchestrationClient, loadConfiguration } from "@tendworks/control-plane";
import { createApprovals, createInMemoryApprovalStore, type ApprovalEvent, type ApprovalRequest as StoredRequest, type ApprovalStore, type Policy } from "@tendworks/human-interaction";
import {
  createFetchHttpExecutor,
  createInMemoryRunStore,
  createInProcessRunEngine,
  createOrchestrationApi,
  createRunActivities,
  createRunEventForwarder,
} from "@tendworks/orchestration";
import type { ControlPlane } from "@tendworks/shared";
import createClient from "openapi-fetch";
import { describe, expect, it } from "vitest";
import { guardedContracts } from "./support/guarded-contracts.js";
import { fixtureConfiguration } from "../fixtures/fixture-configuration.js";

/*
 * The human step end to end in one process: a run of the fixture workflow wait-for-merge
 * asks the control plane through its `call: approval` step (over the public API, with the
 * API token the worker's executor adds), human interaction decides by the policies and
 * records the request, and its approval.decided reaches the waiting run through
 * orchestration's event forwarder, as the event bus hands it over in the bundles.
 */

const contracts = guardedContracts("orchestration", "control-plane");

type Run = ControlPlane.components["schemas"]["run"];
type ApprovalRequest = ControlPlane.components["schemas"]["approvalRequest"];

const API_TOKEN = "contract-test-token";
const PULL_REQUEST = "https://git.example/example/playground/pull/1"; // tests/fixtures/config/agents/fake-pr-developer.md

function platform({ policies }: { policies?: Policy[] } = {}) {
  const configuration = loadConfiguration(fixtureConfiguration());
  const agents = createAgentRuntime({ profiles: configuration.agentProfiles, sleep: async () => {} });
  const store = createInMemoryRunStore();
  // The run's `call: http` and `call: approval` reach the control plane as in the worker.
  const http = createFetchHttpExecutor({ allowedOrigin: "http://tend.test", apiToken: API_TOKEN, fetch: (request) => controlPlane.fetch(request) });
  const engine = createInProcessRunEngine(createRunActivities({ store, agents, http }));
  const runtime = { name: "tendworks", metadata: { controlPlaneUrl: "http://tend.test" } };
  const orchestration = createOrchestrationApi({ store, engine, runtime });
  const runs = createOrchestrationClient({ baseUrl: "http://worker.test", fetch: contracts["orchestration"].guard((request) => orchestration.fetch(request)) });

  // The event bus between human interaction and orchestration: each approval event the
  // store writes goes on to the run it names.
  const forwarder = createRunEventForwarder(engine);
  const forwarding = (inner: ApprovalStore): ApprovalStore => {
    const handOver = (event: (request: StoredRequest) => ApprovalEvent) => (request: StoredRequest) => {
      const written = event(request);
      setTimeout(() => void forwarder.handle(structuredClone(written)), 0);
      return written;
    };
    return { ...inner, open: (request, event) => inner.open(request, handOver(event)), decide: (id, answer, at, event) => inner.decide(id, answer, at, handOver(event)) };
  };
  const approvals = createApprovals({
    store: forwarding(createInMemoryApprovalStore()),
    policies: policies ?? configuration.policies,
    runs: (runId) => runs.get(runId),
  });
  const controlPlane = createControlPlaneApi({ probes: [], configuration, runs, approvals, apiToken: API_TOKEN });
  const guarded = contracts["control-plane"].guard((request) => controlPlane.fetch(request));
  return createClient<ControlPlane.paths>({ baseUrl: "http://tend.test", headers: { authorization: `Bearer ${API_TOKEN}` }, fetch: guarded });
}

type Client = ReturnType<typeof platform>;

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${what} did not happen`);
}

async function start(client: Client): Promise<string> {
  const { data, response } = await client.POST("/runs", { body: { workflow: "wait-for-merge", input: { issue: { number: 7, title: "Wait for me" } } } });
  expect(response.status).toBe(201);
  return data!.id;
}

const getRun = async (client: Client, runId: string) => (await client.GET("/runs/{runId}", { params: { path: { runId } } })).data;
const ended = (client: Client, runId: string) =>
  waitFor<Run>(`end of run ${runId}`, async () => {
    const run = await getRun(client, runId);
    return run?.status === "completed" || run?.status === "failed" ? run : undefined;
  });
const pendingRequest = (client: Client, runId: string) =>
  waitFor<ApprovalRequest>(`approval request of run ${runId}`, async () =>
    (await client.GET("/approval-requests", { params: { query: { status: "pending" } } })).data?.items.find((request) => request.runId === runId),
  );
const answer = (client: Client, id: string, label: string) =>
  client.POST("/approval-requests/{approvalRequestId}/decision", { params: { path: { approvalRequestId: id } }, body: { answer: label } });

describe("the human step through the control plane, human interaction and orchestration", () => {
  it("asks with the question, links and answers when the policy says ask, and the run waits", async () => {
    const client = platform();
    const runId = await start(client);

    const request = await pendingRequest(client, runId);

    expect(request).toMatchObject({
      workflow: "wait-for-merge",
      step: "/do/1/confirmMerge",
      action: "merge-pull-request",
      policy: "ask-before-merge-fakes",
      question: `Merge ${PULL_REQUEST} in the forge, then continue?`,
      links: [{ title: "Pull request", url: PULL_REQUEST }],
      answers: [
        { label: "Merged – continue", outcome: "continue" },
        { label: "Cancel", outcome: "stop" },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const run = await getRun(client, runId);
    expect(run?.status).toBe("running");
    expect(run?.steps.map((step) => [step.name, step.status])).toEqual([
      ["implement", "completed"],
      ["confirmMerge", "running"],
    ]);
  });

  it("continues the run with an answer that continues", async () => {
    const client = platform();
    const runId = await start(client);
    const request = await pendingRequest(client, runId);

    expect((await answer(client, request.id, "Merged – continue")).response.status).toBe(200);

    const run = await ended(client, runId);
    expect(run).toMatchObject({ status: "completed", output: { pullRequest: PULL_REQUEST, answer: "Merged – continue", followedUp: true } });
    expect(run.steps.map((step) => step.name)).toEqual(["implement", "confirmMerge", "followUp"]);
  });

  it("stops the run with an answer that stops, without the steps after it", async () => {
    const client = platform();
    const runId = await start(client);
    const request = await pendingRequest(client, runId);

    await answer(client, request.id, "Cancel");

    const run = await ended(client, runId);
    expect(run).toMatchObject({ status: "completed", output: { pullRequest: PULL_REQUEST, answer: "Cancel" } });
    expect(run.steps.map((step) => step.name)).toEqual(["implement", "confirmMerge"]);
  });

  it("proceeds without a request when a policy allows the action", async () => {
    const client = platform({
      policies: [{ apiVersion: "tendworks.dev/v1", kind: "Policy", metadata: { name: "trusted" }, spec: { workflows: ["wait-for-merge"], actions: { "merge-pull-request": "allow" } } }],
    });
    const runId = await start(client);

    const run = await ended(client, runId);

    expect(run).toMatchObject({ status: "completed", output: { followedUp: true } });
    expect(run.steps.map((step) => step.name)).toEqual(["implement", "confirmMerge", "followUp"]);
    expect((await client.GET("/approval-requests")).data?.items).toEqual([]);
  });
});
