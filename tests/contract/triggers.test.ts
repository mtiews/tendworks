import { createAgentRuntime } from "@tendworks/agent-runtime";
import { createControlPlaneApi, createOrchestrationClient, createTriggerGatewayClient, loadConfiguration } from "@tendworks/control-plane";
import { createInMemoryRunStore, createInProcessRunEngine, createOrchestrationApi, createRunActivities, InMemoryHttpExecutor } from "@tendworks/orchestration";
import { createSecretResolver } from "@tendworks/platform";
import type { ControlPlane } from "@tendworks/shared";
import {
  createControlPlaneRunStarter,
  createInMemoryFiringStore,
  createInMemoryRunStarter,
  createTriggerGateway,
  createTriggerGatewayApi,
} from "@tendworks/trigger-gateway";
import { createGithubIssuesSource } from "@tendworks/trigger-source-github-issues";
import { stubGithubApi } from "@tendworks/trigger-source-github-issues/stub";
import createClient from "openapi-fetch";
import { describe, expect, it } from "vitest";
import { guardedContracts } from "./support/guarded-contracts.js";
import { TRIGGER_SOURCES } from "./support/trigger-sources.js";
import { fixtureConfiguration } from "../fixtures/fixture-configuration.js";

/*
 * Both sides of the trigger APIs in one process: the trigger gateway starts runs through
 * the public control plane API, and the control plane lists triggers through the trigger
 * gateway's internal API. Bindings come from the example configuration.
 */

const contracts = guardedContracts("orchestration", "control-plane", "trigger-gateway");

const API_TOKEN = "contract-test-token";
const READ_TOKEN = "contract-test-read-token";

function platform() {
  const configuration = loadConfiguration(fixtureConfiguration());
  const agents = createAgentRuntime({ profiles: configuration.agentProfiles, sleep: async () => {} });
  const store = createInMemoryRunStore();
  const orchestration = createOrchestrationApi({ store, engine: createInProcessRunEngine(createRunActivities({ store, agents, http: new InMemoryHttpExecutor() })) });
  const gateway = createTriggerGateway({
    bindings: configuration.triggerBindings,
    workspaces: configuration.workspaces,
    sources: TRIGGER_SOURCES,
    store: createInMemoryFiringStore(),
    runs: createControlPlaneRunStarter({ baseUrl: "http://tend.test", apiToken: API_TOKEN, fetch: contracts["control-plane"].guard((request) => controlPlane.fetch(request)) }),
    now: () => new Date("2026-10-18T10:00:05.000Z"),
  });
  const gatewayApi = createTriggerGatewayApi(gateway);
  const controlPlane = createControlPlaneApi({
    probes: [],
    configuration,
    runs: createOrchestrationClient({ baseUrl: "http://worker.test", fetch: contracts["orchestration"].guard((request) => orchestration.fetch(request)) }),
    triggers: createTriggerGatewayClient({ baseUrl: "http://trigger-gateway.test", fetch: contracts["trigger-gateway"].guard((request) => gatewayApi.fetch(request)) }),
    apiToken: API_TOKEN,
    readToken: READ_TOKEN,
  });
  // Reads like the platform MCP server would: with the read-only token.
  return { gateway, client: createClient<ControlPlane.paths>({ baseUrl: "http://tend.test", headers: { authorization: `Bearer ${READ_TOKEN}` }, fetch: contracts["control-plane"].guard((request) => controlPlane.fetch(request)) }) };
}

describe("triggers through the control plane and the trigger gateway", () => {
  it("lists the example trigger binding with its next execution", async () => {
    const { client } = platform();

    const { data } = await client.GET("/triggers");

    expect(data?.items.find((trigger) => trigger.name === "issue-ready-for-agent")).toEqual({
      name: "issue-ready-for-agent",
      workflow: "hello-agent",
      kind: "fake",
      workspaces: [],
      schedule: { every: { seconds: 10 } },
      nextExecutionAt: "2026-10-18T10:00:10.000Z",
    });
  });

  it("starts runs of the bound workflow through the public API, once per item", async () => {
    const { gateway, client } = platform();

    const first = await gateway.check("issue-ready-for-agent");
    const second = await gateway.check("issue-ready-for-agent");

    expect(first.failed).toEqual([]);
    expect(first.fired.map((fired) => fired.item)).toEqual(["example/playground#101", "example/playground#102"]);
    expect(second).toEqual({ fired: [], failed: [] });
    const runs = (await client.GET("/runs")).data?.items ?? [];
    expect(runs.map((run) => [run.id, run.workflow, run.input]).sort()).toEqual(
      [
        [first.fired[0]!.runId, "hello-agent", { item: { key: "example/playground#101", title: "Add a greeting", url: "https://issues.example/example/playground/101", number: 101 } }],
        [first.fired[1]!.runId, "hello-agent", { item: { key: "example/playground#102", title: "Fix the typo", url: "https://issues.example/example/playground/102", number: 102 } }],
      ].sort(),
    );
    const run = runs.find((candidate) => candidate.id === first.fired[0]!.runId);
    expect(run?.startedBy).toEqual({
      kind: "trigger",
      binding: "issue-ready-for-agent",
      item: { key: "example/playground#101", title: "Add a greeting", url: "https://issues.example/example/playground/101" },
    });
  });

  it("starts one run per workspace at a tick of a schedule, each in its workspace", async () => {
    const { gateway, client } = platform();

    const { fired, failed } = await gateway.check("schedule-over-two-workspaces");

    expect(failed).toEqual([]);
    const runs = (await client.GET("/runs")).data?.items ?? [];
    const tick = { key: "2026-10-18T10:00:00.000Z", title: "Scheduled at 2026-10-18T10:00:00.000Z", at: "2026-10-18T10:00:00.000Z" };
    expect(fired.map(({ runId }) => runs.find((run) => run.id === runId)).map((run) => [run?.workflow, run?.input, run?.startedBy])).toEqual([
      ["scheduled-noop", { workspace: "fake-playground", item: tick }, { kind: "trigger", binding: "schedule-over-two-workspaces", workspace: "fake-playground", item: { key: tick.key, title: tick.title } }],
      ["scheduled-noop", { workspace: "scripted-playground", item: tick }, { kind: "trigger", binding: "schedule-over-two-workspaces", workspace: "scripted-playground", item: { key: tick.key, title: tick.title } }],
    ]);
  });
});

/*
 * The starter's github-issues binding (examples/config/triggers/playground-ready-for-agent.yaml)
 * against a stub of the GitHub REST API: the server's source registry, with the stub as
 * the source's only way out.
 */
describe("the github-issues trigger source with the starter configuration", () => {
  const PLATFORM_TOKEN = "stub-platform-token-0123456789"; // betterleaks:allow dummy token the stub accepts
  const BINDING = "playground-ready-for-agent";

  function gatewayWithStub(bindings?: (configuration: ReturnType<typeof loadConfiguration>) => ReturnType<typeof loadConfiguration>["triggerBindings"]) {
    const configuration = loadConfiguration(fixtureConfiguration());
    const methods: string[] = [];
    const stub = stubGithubApi({
      token: PLATFORM_TOKEN,
      repositories: {
        "mtiews/tendworks-playground": [
          { number: 3, title: "Add a greeting", state: "open", labels: ["ready-for-agent"], body: "Print hello." },
          { number: 4, title: "A pull request", state: "open", labels: ["ready-for-agent"], pullRequest: true },
          { number: 5, title: "Not ready", state: "open", labels: [] },
        ],
      },
    });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      methods.push(request.method);
      return stub(request);
    };
    const runs = createInMemoryRunStarter();
    const gateway = createTriggerGateway({
      bindings: bindings ? bindings(configuration) : configuration.triggerBindings,
      workspaces: configuration.workspaces,
      sources: { ...TRIGGER_SOURCES, "github-issues": (settings, context) => createGithubIssuesSource(settings, context, { fetch }) },
      store: createInMemoryFiringStore(),
      runs,
      secrets: createSecretResolver("platform", { TENDWORKS_PLATFORM_GITHUB_TOKEN: PLATFORM_TOKEN }),
      now: () => new Date("2026-10-18T10:00:05.000Z"),
      log: () => {},
    });
    return { gateway, runs, methods };
  }

  it("starts develop-issue once per new issue, in the workspace whose repository has it, reading only", async () => {
    const { gateway, runs, methods } = gatewayWithStub();

    const first = await gateway.check(BINDING);
    const second = await gateway.check(BINDING);

    expect(first.failed).toEqual([]);
    expect(first.fired).toEqual([{ workspace: "playground", item: "mtiews/tendworks-playground#3", runId: "run-1" }]);
    expect(second).toEqual({ fired: [], failed: [] });
    expect(runs.started).toHaveLength(1);
    expect(runs.started[0]).toMatchObject({
      workflow: "develop-issue",
      input: {
        workspace: "playground",
        item: {
          key: "mtiews/tendworks-playground#3",
          title: "Add a greeting",
          url: "https://github.com/mtiews/tendworks-playground/issues/3",
          number: 3,
          body: "Print hello.",
        },
      },
      startedBy: { kind: "trigger", binding: BINDING, workspace: "playground", item: { key: "mtiews/tendworks-playground#3", title: "Add a greeting" } },
    });
    expect(methods.length).toBeGreaterThan(0);
    expect(new Set(methods)).toEqual(new Set(["GET"]));
  });

  it("refuses the binding when it names a workspace that is not on github.com", () => {
    expect(() =>
      gatewayWithStub((configuration) =>
        configuration.triggerBindings.map((binding) => (binding.metadata.name === BINDING ? { ...binding, spec: { ...binding.spec, workspaces: ["playground", "fake-playground"] } } : binding)),
      ),
    ).toThrow(
      "trigger binding 'playground-ready-for-agent': workspace 'fake-playground' is not a repository on github.com (https://git.example/example/playground.git); github-issues reads issues on github.com only",
    );
  });
});
