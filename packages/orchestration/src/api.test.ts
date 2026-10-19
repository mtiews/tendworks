import type { Orchestration } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  createInProcessRunEngine,
  createInMemoryRunStore,
  createOrchestrationApi,
  createRunActivities,
  InMemoryHttpExecutor,
  type AgentTaskExecutor,
  type RuntimeDescriptor,
} from "./index.js";
import { InMemoryAgentTaskExecutor } from "./workflow/in-memory-agent-task-executor.js";

type Run = Orchestration.components["schemas"]["run"];

const workflow = parse(`
document: { dsl: '1.0.3', namespace: test, name: hello, version: '0.1.0' }
do:
  - greet:
      call: a2a
      with:
        method: message/send
        agentCard: { endpoint: agent://greeter }
        parameters:
          message:
            parts: [{ kind: text, text: '\${ "Hello \\(.name)" }' }]
`);

function setup(
  agents: AgentTaskExecutor = new InMemoryAgentTaskExecutor(),
  { http = new InMemoryHttpExecutor(), runtime }: { http?: InMemoryHttpExecutor; runtime?: RuntimeDescriptor } = {},
) {
  const store = createInMemoryRunStore();
  const engine = createInProcessRunEngine(createRunActivities({ store, agents, http }));
  const api = createOrchestrationApi({ store, engine, ...(runtime ? { runtime } : {}) });
  const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await api.fetch(
      new Request(`http://orchestration.test${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as never };
  };
  return { store, request };
}

async function until(get: () => Promise<Run>, done: (run: Run) => boolean): Promise<Run> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const run = await get();
    if (done(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("run did not finish");
}

const finished = (run: Run) => run.status === "completed" || run.status === "failed";

describe("orchestration API", () => {
  it("starts a run, executes its steps and reports it as completed", async () => {
    const { request } = setup();

    const started = await request("POST", "/runs", { workflow, input: { name: "Ada" } });
    expect(started.status).toBe(201);
    const run = started.body as Run;
    expect(run).toMatchObject({ workflow: "hello", input: { name: "Ada" } });

    const done = await until(async () => (await request("GET", `/runs/${run.id}`)).body, finished);
    expect(done).toMatchObject({
      id: run.id,
      status: "completed",
      steps: [{ name: "greet", reference: "/do/0/greet", status: "completed", taskId: "task-1" }],
      output: { id: "task-1", status: { state: "TASK_STATE_COMPLETED" } },
    });
    expect(Date.parse(done.finishedAt!)).toBeGreaterThanOrEqual(Date.parse(done.startedAt!));
  });

  it("reports a failed run with the step that failed and why", async () => {
    const agents = new InMemoryAgentTaskExecutor().agent("greeter", () => ({
      id: "t-1",
      status: { state: "TASK_STATE_FAILED", message: { messageId: "m", role: "ROLE_AGENT", parts: [{ text: "no greeting today" }] } },
    }));
    const { request } = setup(agents);

    const run = (await request("POST", "/runs", { workflow, input: {} })).body as Run;
    const done = await until(async () => (await request("GET", `/runs/${run.id}`)).body, finished);

    const error = {
      type: "https://serverlessworkflow.io/spec/1.0.0/errors/runtime",
      status: 500,
      instance: "/do/0/greet",
      title: "Agent task ended in state TASK_STATE_FAILED",
      detail: "no greeting today",
    };
    expect(done).toMatchObject({ status: "failed", error, steps: [{ name: "greet", status: "failed", taskId: "t-1", error }] });
  });

  it("emits run and step events that carry run id, step id and trace context", async () => {
    const { request, store } = setup();

    const run = (await request("POST", "/runs", { workflow })).body as Run;
    await until(async () => (await request("GET", `/runs/${run.id}`)).body, finished);

    const events = await store.publisher.events(run.id);
    expect(events.map((event) => [event.type, event.stepid])).toEqual([
      ["dev.tendworks.run.started", undefined],
      ["dev.tendworks.step.started", "/do/0/greet"],
      ["dev.tendworks.step.completed", "/do/0/greet"],
      ["dev.tendworks.run.completed", undefined],
    ]);
    const [first] = events;
    expect(first).toMatchObject({ specversion: "1.0", source: "/tendworks/orchestration", runid: run.id, data: { workflow: "hello" } });
    expect(first!.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(new Set(events.map((event) => event.traceparent)).size).toBe(1);
    expect(new Set(events.map((event) => event.id)).size).toBe(4);
    expect(events[2]).toMatchObject({ data: { name: "greet", reference: "/do/0/greet", taskId: "task-1" } });
  });

  it("runs in the caller's trace when the caller passes its traceparent", async () => {
    const { request, store } = setup();
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

    const run = (await request("POST", "/runs", { workflow }, { traceparent })).body as Run;
    await until(async () => (await request("GET", `/runs/${run.id}`)).body, finished);

    expect(run.traceparent).toBe(traceparent);
    expect(new Set((await store.publisher.events(run.id)).map((event) => event.traceparent))).toEqual(new Set([traceparent]));
  });

  it("starts a new trace for a run without a caller's traceparent and records it", async () => {
    const { request, store } = setup();

    const run = (await request("POST", "/runs", { workflow })).body as Run;
    await until(async () => (await request("GET", `/runs/${run.id}`)).body, finished);

    expect(run.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect((await store.publisher.events(run.id))[0]!.traceparent).toBe(run.traceparent);
  });

  it("refuses a malformed traceparent", async () => {
    const { request } = setup();

    const { status, body } = await request("POST", "/runs", { workflow }, { traceparent: "not-a-trace" });

    expect(status).toBe(400);
    expect(body).toMatchObject({ title: "Invalid request" });
  });

  it("lists runs newest first", async () => {
    const { request } = setup();
    const first = (await request("POST", "/runs", { workflow })).body as Run;
    const second = (await request("POST", "/runs", { workflow })).body as Run;

    const { status, body } = await request("GET", "/runs");

    expect(status).toBe(200);
    expect((body as { items: Run[] }).items.map((run) => run.id)).toEqual([second.id, first.id]);
  });

  it("rejects a workflow it cannot run with 400 and the validation issues", async () => {
    const { request } = setup();

    const { status, body } = await request("POST", "/runs", {
      workflow: { ...workflow, do: [{ wait: { wait: { seconds: 1 } } }] },
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({ status: 400, detail: expect.stringContaining("/do/0/wait: unsupported task type 'wait'") });
  });

  it("answers 404 for an unknown run", async () => {
    const { request } = setup();

    const { status, body } = await request("GET", "/runs/nope");

    expect(status).toBe(404);
    expect(body).toMatchObject({ status: 404, title: "Run not found" });
  });

  it("starts runs with the runtime it describes, so workflows can reach the control plane", async () => {
    const http = new InMemoryHttpExecutor().respond(() => ({ status: 200, content: { merged: true } }));
    const { request } = setup(new InMemoryAgentTaskExecutor(), {
      http,
      runtime: { name: "tendworks", metadata: { controlPlaneUrl: "http://control-plane.test" } },
    });
    const merge = parse(`
document: { dsl: '1.0.3', namespace: test, name: merge, version: '0.1.0' }
do:
  - merge:
      call: http
      with: { method: post, endpoint: '\${ $runtime.metadata.controlPlaneUrl + "/pull-requests/merge" }' }
`);

    const run = (await request("POST", "/runs", { workflow: merge })).body as Run;

    const done = await until(async () => (await request("GET", `/runs/${run.id}`)).body, finished);
    expect(done).toMatchObject({ status: "completed", output: { merged: true } });
    expect(http.requests.map((r) => r.endpoint)).toEqual(["http://control-plane.test/pull-requests/merge"]);
  });
});
