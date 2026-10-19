import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAgentRuntime } from "@tendworks/agent-runtime";
import { loadConfiguration } from "@tendworks/control-plane";
import { createApprovals, createFakePullRequests, createInMemoryApprovalStore, createMergeGate } from "@tendworks/human-interaction";
import { createInMemoryRunStore, createInProcessRunEngine, createOrchestrationApi, createRunActivities, InMemoryHttpExecutor } from "@tendworks/orchestration";
import { createInMemoryFiringStore, createInMemoryRunStarter, createTriggerGateway } from "@tendworks/trigger-gateway";
import { afterAll, describe, expect, it } from "vitest";
import { contractFiles, contractSchema, describeErrors, readContract } from "./support/contracts.js";

/*
 * Every CloudEvent the platform emits against its JSON Schema (contracts/events). The
 * catalog of emitted types comes from the producers' code (every `type:
 * "dev.tendworks.…"` they write); each must have a schema, and the events the domains
 * really emit in the flows below must match it. Together the flows must emit every
 * type in the catalog, so a new event type cannot go unchecked.
 */

const packages = new URL("../../packages/", import.meta.url);

/** Event types the producers' code emits, from their source (tests and suites excluded). */
function emittedTypes(): string[] {
  const types = new Set<string>();
  for (const file of readdirSync(packages, { recursive: true, encoding: "utf8" })) {
    const path = file.replaceAll("\\", "/");
    if (!/^[^/]+\/src\/.*\.ts$/.test(path) || /\.(test|suite|stub)\.ts$/.test(path)) continue;
    for (const match of readFileSync(new URL(path, packages), "utf8").matchAll(/\btype: "(dev\.tendworks\.[a-z0-9.-]+)"/g)) types.add(match[1]!);
  }
  return [...types].sort();
}

/** The schema of each event type: `$defs` entries of contracts/events whose `type` is a const. */
function eventSchemas(): Map<string, string> {
  const schemas = new Map<string, string>();
  for (const file of contractFiles().filter((file) => file.startsWith("events/"))) {
    const definitions = (readContract(file).$defs ?? {}) as Record<string, { properties?: { type?: { const?: string } } }>;
    for (const [name, definition] of Object.entries(definitions)) {
      const type = definition.properties?.type?.const;
      if (type) schemas.set(type, `${file}#/$defs/${name}`);
    }
  }
  return schemas;
}

const schemas = eventSchemas();
const validated = new Set<string>();

function expectValid(events: { type: string }[]) {
  for (const event of events) {
    const schema = schemas.get(event.type);
    expect(schema, `schema for ${event.type}`).toBeDefined();
    const validate = contractSchema(schema!);
    expect(validate(event), `${event.type}: ${describeErrors(validate.errors)}`).toBe(true);
    validated.add(event.type);
  }
}

afterAll(() => {
  expect([...validated].sort(), "emitted event types no flow produced").toEqual(emittedTypes());
});

describe("the event catalog", () => {
  it("has a schema for every event type the platform emits", () => {
    const types = emittedTypes();

    expect(types.length).toBeGreaterThan(0);
    expect(types.filter((type) => !schemas.has(type))).toEqual([]);
  });
});

const configuration = loadConfiguration(fileURLToPath(new URL("../../examples/config", import.meta.url)));

describe("events the domains emit", () => {
  it("orchestration: run and step events of a completed and a failed run", async () => {
    const agents = createAgentRuntime({ profiles: configuration.agentProfiles, sleep: async () => {} });
    const store = createInMemoryRunStore();
    const engine = createInProcessRunEngine(createRunActivities({ store, agents, http: new InMemoryHttpExecutor() }));
    const api = createOrchestrationApi({ store, engine });
    const start = (workflow: unknown) =>
      api.fetch(new Request("http://worker.test/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflow }) }));
    const failing = {
      document: { dsl: "1.0.3", namespace: "contract", name: "unknown-agent", version: "0.1.0" },
      do: [{ ask: { call: "a2a", with: { method: "message/send", agentCard: { endpoint: "agent://nobody" }, parameters: { message: { parts: [{ kind: "text", text: "hi" }] } } } } }],
    };

    expect((await start(configuration.workflow("hello-agent"))).status).toBe(201);
    expect((await start(failing)).status).toBe(201);
    await engine.idle();

    const types = store.publisher.published.map((event) => event.type);
    expect(types).toEqual(expect.arrayContaining(["dev.tendworks.run.completed", "dev.tendworks.run.failed", "dev.tendworks.step.failed"]));
    expectValid(store.publisher.published);
  });

  it("trigger gateway: trigger.fired for each matching issue", async () => {
    const store = createInMemoryFiringStore();
    const gateway = createTriggerGateway({ bindings: configuration.triggerBindings, store, runs: createInMemoryRunStarter(), log: () => {} });

    await gateway.check("issue-ready-for-agent");

    expect(store.publisher.published.length).toBeGreaterThan(0);
    expectValid(store.publisher.published);
  });

  it("human interaction: approval.requested and approval.decided", async () => {
    const PR = "https://git.example/example/playground/pull/1";
    const approvals = createInMemoryApprovalStore();
    const gate = createMergeGate({
      policies: configuration.policies,
      runs: async (id) => ({ id, workflow: "fake-develop-and-ask", status: "running", artifacts: [{ name: "pull-request", url: PR, workspace: { repository: "https://git.example/example/playground.git", branch: "tendworks/fake" } }] }),
      pullRequests: () => createFakePullRequests([{ url: PR, headBranch: "tendworks/fake", state: "open" }]),
      approvals,
    });

    const asked = await gate.merge({ run: "r-1", pullRequest: PR });
    await createApprovals({ store: approvals }).decide(("pending" in asked ? asked.pending : undefined)!.approvalRequest!.id, "approve");

    expect(approvals.published.map((event) => event.type)).toEqual(["dev.tendworks.approval.requested", "dev.tendworks.approval.decided"]);
    expectValid(approvals.published);
  });
});
