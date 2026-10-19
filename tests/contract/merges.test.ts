import { fileURLToPath } from "node:url";
import { createAgentRuntime } from "@tendworks/agent-runtime";
import { createControlPlaneApi, createOrchestrationClient, loadConfiguration } from "@tendworks/control-plane";
import { createFakePullRequests, createMergeGate, type FakePullRequest } from "@tendworks/human-interaction";
import {
  createFetchHttpExecutor,
  createInMemoryRunStore,
  createInProcessRunEngine,
  createOrchestrationApi,
  createRunActivities,
} from "@tendworks/orchestration";
import type { ControlPlane } from "@tendworks/shared";
import createClient from "openapi-fetch";
import { describe, expect, it } from "vitest";

/*
 * The merge step across its seams in one process: orchestration's `call: http` reaches
 * the control plane's public API, whose merge gate (human interaction) decides by the
 * example policy and merges in a fake pull request integration. The fake agent reports
 * the pull request.
 */

type Run = ControlPlane.components["schemas"]["run"];
const PR = "https://git.example/example/playground/pull/1"; // examples/config/agents/fake-pr-developer.md

function platform({ pullRequests = [{ url: PR, state: "open" }], merge }: { pullRequests?: FakePullRequest[]; merge?: "auto" | "ask" } = {}) {
  const configuration = loadConfiguration(fileURLToPath(new URL("../../examples/config", import.meta.url)));
  const policies = merge ? configuration.policies.map((policy) => ({ ...policy, spec: { merge } })) : configuration.policies;
  const repository = createFakePullRequests(pullRequests);
  const agents = createAgentRuntime({ profiles: configuration.agentProfiles, sleep: async () => {} });
  const store = createInMemoryRunStore();
  const http = createFetchHttpExecutor({ allowedOrigin: "http://tend.test", fetch: (request) => controlPlane.fetch(request) });
  const orchestration = createOrchestrationApi({
    store,
    engine: createInProcessRunEngine(createRunActivities({ store, agents, http })),
    runtime: { name: "tendworks", metadata: { controlPlaneUrl: "http://tend.test" } },
  });
  const controlPlane = createControlPlaneApi({
    probes: [],
    configuration,
    runs: createOrchestrationClient({ baseUrl: "http://worker.test", fetch: (request) => orchestration.fetch(request) }),
    merges: createMergeGate({ policies, pullRequests: () => repository }),
  });
  const client = createClient<ControlPlane.paths>({ baseUrl: "http://tend.test", fetch: (request) => controlPlane.fetch(request) });

  async function run(workflow: string): Promise<Run> {
    const { data: started } = await client.POST("/runs", { body: { workflow, input: { issue: { number: 1, title: "Say hello" } } } });
    for (let attempt = 0; attempt < 200; attempt++) {
      const { data } = await client.GET("/runs/{runId}", { params: { path: { runId: started!.id } } });
      if (data?.status === "completed" || data?.status === "failed") return data;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("run did not finish");
  }
  return { run, merged: () => repository.merged() };
}

describe("merge step through the control plane's merge gate", () => {
  it("merges the pull request the agent opened under merge: auto and completes the run", async () => {
    const { run, merged } = platform();

    const done = await run("fake-develop-and-merge");

    expect(done).toMatchObject({
      status: "completed",
      steps: [{ name: "implement", status: "completed" }, { name: "merge", status: "completed" }],
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
    const { run } = platform({ pullRequests: [{ url: PR, state: "open", mergeable: false }] });

    const done = await run("fake-develop-and-merge");

    expect(done).toMatchObject({
      status: "failed",
      error: { instance: "/do/1/merge", status: 409, title: "Pull request cannot be merged", detail: `pull request ${PR} is not mergeable: it has conflicts` },
    });
  });

  it("merges nothing while the policy asks for an approval", async () => {
    const { run, merged } = platform({ merge: "ask" });

    const done = await run("fake-develop-and-merge");

    expect(done).toMatchObject({ status: "failed", error: { instance: "/do/1/merge", status: 403, title: "Merge needs an approval" } });
    expect(merged()).toEqual([]);
  });
});
