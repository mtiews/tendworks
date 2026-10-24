import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlPlane } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { createControlPlaneApi, createInMemoryRuns, loadConfiguration, type RunsPort } from "./index.js";

type Run = ControlPlane.components["schemas"]["run"];

function configuration() {
  const dir = mkdtempSync(join(tmpdir(), "tend-config-"));
  mkdirSync(join(dir, "workflows"));
  mkdirSync(join(dir, "agents"));
  writeFileSync(
    join(dir, "workflows", "build.sw.yaml"),
    `document: { dsl: '1.0.3', namespace: test, name: build, version: '0.1.0' }
do:
  - implement:
      call: a2a
      with:
        method: message/send
        agentCard: { endpoint: agent://developer }
        parameters:
          message:
            parts: [{ kind: text, text: build it }]
`,
  );
  writeFileSync(join(dir, "agents", "developer.md"), "---\napiVersion: tendworks.dev/v1\nkind: AgentProfile\nmetadata:\n  name: developer\nspec:\n  harness: fake\n---\n");
  return loadConfiguration(dir);
}

function setup(runs: RunsPort = createInMemoryRuns()) {
  const api = createControlPlaneApi({ probes: [], configuration: configuration(), runs, apiToken: "test-token" });
  const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await api.fetch(
      new Request(`http://tend.test${path}`, {
        method,
        headers: { authorization: "Bearer test-token", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, headers: response.headers, body: (await response.json()) as never };
  };
  return { runs, request };
}

describe("runs API", () => {
  it("starts a run of a configured workflow with the workflow's definition and the input", async () => {
    const runs = createInMemoryRuns();
    const { request } = setup(runs);

    const { status, headers, body } = await request("POST", "/runs", { workflow: "build", input: { issue: 7 } });

    expect(status).toBe(201);
    const run = body as Run;
    expect(run).toMatchObject({ workflow: "build", status: "pending", input: { issue: 7 } });
    expect(headers.get("location")).toBe(`/runs/${run.id}`);
    expect(runs.started).toEqual([
      { workflow: expect.objectContaining({ document: expect.objectContaining({ name: "build" }) }), input: { issue: 7 }, startedBy: { kind: "manual" } },
    ]);
  });

  it("hands the caller's traceparent to orchestration, so the run joins the caller's trace", async () => {
    const runs = createInMemoryRuns();
    const { request } = setup(runs);
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

    const { status } = await request("POST", "/runs", { workflow: "build" }, { traceparent });

    expect(status).toBe(201);
    expect(runs.started).toEqual([expect.objectContaining({ traceparent })]);
  });

  it("hands what started the run to orchestration, and declares a run without an origin as started by hand", async () => {
    const runs = createInMemoryRuns();
    const { request } = setup(runs);
    const startedBy = { kind: "trigger", binding: "ready", workspace: "app", item: { key: "acme/app#7", title: "Fix the login", url: "https://issues.example/7" } };

    await request("POST", "/runs", { workflow: "build", startedBy });
    await request("POST", "/runs", { workflow: "build" });

    expect(runs.started.map((run) => run.startedBy)).toEqual([startedBy, { kind: "manual" }]);
  });

  it("rejects a malformed traceparent", async () => {
    const runs = createInMemoryRuns();
    const { request } = setup(runs);

    const { status, body } = await request("POST", "/runs", { workflow: "build" }, { traceparent: "00-xyz" });

    expect(status).toBe(400);
    expect(body).toMatchObject({ title: "Invalid request" });
    expect(runs.started).toEqual([]);
  });

  it("rejects a workflow name that is not configured", async () => {
    const { request } = setup();

    const { status, body } = await request("POST", "/runs", { workflow: "deploy" });

    expect(status).toBe(400);
    expect(body).toEqual({ title: "Unknown workflow", status: 400, detail: "no workflow 'deploy' is configured (configured: build)" });
  });

  it("rejects a request without a workflow name", async () => {
    const { request } = setup();

    const { status } = await request("POST", "/runs", { input: {} });

    expect(status).toBe(400);
  });

  it("lists runs and returns one run with its steps", async () => {
    const { request } = setup();
    const run = (await request("POST", "/runs", { workflow: "build" })).body as Run;

    const list = await request("GET", "/runs");
    const one = await request("GET", `/runs/${run.id}`);

    expect(list).toMatchObject({ status: 200, body: { items: [{ id: run.id, workflow: "build" }] } });
    expect(one).toMatchObject({ status: 200, body: { id: run.id, steps: [] } });
  });

  it("answers 404 for an unknown run", async () => {
    const { request } = setup();

    const { status, body } = await request("GET", "/runs/nope");

    expect(status).toBe(404);
    expect(body).toMatchObject({ title: "Run not found", status: 404 });
  });

  it("answers 503 when orchestration cannot be reached", async () => {
    const down: RunsPort = {
      start: () => Promise.reject(new Error("connect ECONNREFUSED")),
      list: () => Promise.reject(new Error("connect ECONNREFUSED")),
      get: () => Promise.reject(new Error("connect ECONNREFUSED")),
    };
    const { request } = setup(down);

    const { status, body } = await request("GET", "/runs");

    expect(status).toBe(503);
    expect(body).toEqual({ title: "Orchestration unavailable", status: 503, detail: "connect ECONNREFUSED" });
  });
});
