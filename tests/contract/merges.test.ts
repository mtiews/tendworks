import { createAgentRuntime } from "@tendworks/agent-runtime";
import { createControlPlaneApi, createOrchestrationClient, loadConfiguration } from "@tendworks/control-plane";
import {
  createApprovals,
  createFakePullRequests,
  createInMemoryApprovalStore,
  createMergeGate,
  toGatedRun,
  type FakePullRequest,
} from "@tendworks/human-interaction";
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
 * The merge step across its seams in one process: orchestration's `call: http` reaches
 * the control plane's public API, whose merge gate (human interaction) decides by
 * orchestration's record of the run and the example policies and merges in a fake pull
 * request integration. The fake agent reports the pull request. Approval events reach
 * the waiting run as the worker's event bus subscription would hand them over.
 */

const contracts = guardedContracts("orchestration", "control-plane");
const API_TOKEN = "contract-test-token";

type Run = ControlPlane.components["schemas"]["run"];
const PR = "https://git.example/example/playground/pull/1"; // tests/fixtures/config/agents/fake-pr-developer.md

function platform({ pullRequests = [{ url: PR, headBranch: "tendworks/fake", state: "open" }] }: { pullRequests?: FakePullRequest[] } = {}) {
  const configuration = loadConfiguration(fixtureConfiguration());
  const repository = createFakePullRequests(pullRequests);
  const agents = createAgentRuntime({ profiles: configuration.agentProfiles, sleep: async () => {} });
  const store = createInMemoryRunStore();
  const http = createFetchHttpExecutor({ allowedOrigin: "http://tend.test", apiToken: API_TOKEN, fetch: contracts["control-plane"].guard((request) => controlPlane.fetch(request)) });
  const engine = createInProcessRunEngine(createRunActivities({ store, agents, http }));
  const orchestration = createOrchestrationApi({ store, engine, runtime: { name: "tendworks", metadata: { controlPlaneUrl: "http://tend.test" } } });
  const runs = createOrchestrationClient({ baseUrl: "http://worker.test", fetch: contracts["orchestration"].guard((request) => orchestration.fetch(request)) });
  const approvalStore = createInMemoryApprovalStore();
  const controlPlane = createControlPlaneApi({
    probes: [],
    configuration,
    runs,
    merges: createMergeGate({
      policies: configuration.policies,
      runs: async (runId) => {
        const run = await runs.get(runId);
        return run && toGatedRun(run);
      },
      pullRequests: () => repository,
      approvals: approvalStore,
    }),
    approvals: createApprovals({ store: approvalStore }),
    apiToken: API_TOKEN,
  });
  const client = createClient<ControlPlane.paths>({ baseUrl: "http://tend.test", headers: { authorization: `Bearer ${API_TOKEN}` }, fetch: contracts["control-plane"].guard((request) => controlPlane.fetch(request)) });
  const forwarder = createRunEventForwarder(engine);
  let forwarded = 0;

  async function waitFor<T>(probe: () => Promise<T | undefined>): Promise<T> {
    for (let attempt = 0; attempt < 300; attempt++) {
      // The event bus: hand new approval events to the runs.
      for (const event of approvalStore.published.slice(forwarded)) await forwarder.handle(event);
      forwarded = approvalStore.published.length;
      const value = await probe();
      if (value !== undefined) return value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("did not happen in time");
  }
  const start = async (workflow: string) =>
    (await client.POST("/runs", { body: { workflow, input: { issue: { number: 1, title: "Say hello" } } } })).data!.id;
  const finished = (runId: string) =>
    waitFor(async () => {
      const { data } = await client.GET("/runs/{runId}", { params: { path: { runId } } });
      return data?.status === "completed" || data?.status === "failed" ? data : undefined;
    });
  const pendingApproval = (runId: string) =>
    waitFor(async () => (await client.GET("/approval-requests", { params: { query: { status: "pending" } } })).data?.items.find((item) => item.runId === runId));
  const run = async (workflow: string): Promise<Run> => finished(await start(workflow));

  return { client, run, start, finished, pendingApproval, merged: () => repository.merged() };
}

describe("merge step through the control plane's merge gate", () => {
  it("merges the pull request the agent opened under merge: auto and completes the run", async () => {
    const { run, merged } = platform();

    const done = await run("fake-develop-and-merge");

    expect(done).toMatchObject({
      status: "completed",
      steps: [{ name: "implement", status: "completed" }, { name: "merge", status: "completed" }, { name: "merged", status: "completed" }],
      output: { pullRequest: PR, merged: true, decision: "allow" },
    });
    expect(merged()).toEqual([PR]);
  });

  it("fails the merge step with the reason when the agent reported no pull request", async () => {
    const { run, merged } = platform();

    const done = await run("fake-develop-without-pull-request");

    expect(done).toMatchObject({
      status: "failed",
      error: {
        instance: "/do/1/merge",
        status: 400,
        title: "No pull request to merge",
        detail: "`pullRequest` is null: the step before reported no pull request (did the agent open and report one?)",
      },
      steps: [{ name: "implement", status: "completed" }, { name: "merge", status: "failed" }],
    });
    expect(merged()).toEqual([]);
  });

  it("fails the merge step with the repository's reason when the merge is refused", async () => {
    const { run } = platform({ pullRequests: [{ url: PR, headBranch: "tendworks/fake", state: "open", mergeable: false }] });

    const done = await run("fake-develop-and-merge");

    expect(done).toMatchObject({
      status: "failed",
      error: { instance: "/do/1/merge", status: 409, title: "Pull request cannot be merged", detail: `pull request ${PR} is not mergeable: it has conflicts` },
    });
  });

  it("waits for an approval when the policy asks, and merges once it is approved", async () => {
    const { client, start, finished, pendingApproval, merged } = platform();
    const runId = await start("fake-develop-and-ask");

    const approval = await pendingApproval(runId);
    expect(approval).toMatchObject({ action: "merge", pullRequest: PR, policy: "ask-before-merge-fakes", status: "pending" });
    expect(merged()).toEqual([]);
    const { response } = await client.POST("/approval-requests/{approvalRequestId}/decision", {
      params: { path: { approvalRequestId: approval.id } },
      body: { decision: "approve" },
    });
    expect(response.status).toBe(200);

    expect(await finished(runId)).toMatchObject({
      status: "completed",
      output: { pullRequest: PR, merged: true, decision: "ask", approvalRequest: approval.id, approval: "approve" },
    });
    expect(merged()).toEqual([PR]);
  });

  it("ends the run without merging when the approval request is rejected", async () => {
    const { client, start, finished, pendingApproval, merged } = platform();
    const runId = await start("fake-develop-and-ask");
    const approval = await pendingApproval(runId);

    await client.POST("/approval-requests/{approvalRequestId}/decision", { params: { path: { approvalRequestId: approval.id } }, body: { decision: "reject" } });

    expect(await finished(runId)).toMatchObject({ status: "completed", output: { merged: false, approval: "reject" } });
    expect(merged()).toEqual([]);
  });

  it("does not let a caller merge past the gate by naming a run's pull request", async () => {
    const { client, start, pendingApproval, merged } = platform();
    const runId = await start("fake-develop-and-ask");
    await pendingApproval(runId);

    // E.g. an agent that reaches the API: the gate still asks, whatever the caller sends.
    const { response, data } = await client.POST("/pull-requests/merge", { body: { run: runId, pullRequest: PR } });
    const other = await client.POST("/pull-requests/merge", { body: { run: "no-such-run", pullRequest: PR } });

    expect(response.status).toBe(202);
    expect(data).toMatchObject({ merged: false, decision: "ask" });
    expect(other.response.status).toBe(400);
    expect(merged()).toEqual([]);
  });
});
