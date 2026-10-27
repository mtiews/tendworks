import { createAgentRuntime, createAgentRuntimeApi, createWorkspaces, workspaceAssistants } from "@tendworks/agent-runtime";
import {
  createAgentRuntimeClient,
  createControlPlaneApi,
  createOrchestrationClient,
  createStoppedControlPlaneApi,
  createTriggerGatewayClient,
  loadConfiguration,
  type ControlPlaneApiOptions,
} from "@tendworks/control-plane";
import { createHealthApi, createStaticHealthProbe, createStoppedBundleApi } from "@tendworks/health";
import {
  createApprovals,
  createInMemoryApprovalStore,
  createFakeNotificationDelivery,
  createInMemoryNotificationStore,
  createNotifier,
  type Policy,
} from "@tendworks/human-interaction";
import { createInMemoryRunStore, createInProcessRunEngine, createOrchestrationApi, createRunActivities, InMemoryHttpExecutor, type RunEngine } from "@tendworks/orchestration";
import { createSecretResolver, readServerSentEvents } from "@tendworks/platform";
import type { ControlPlane } from "@tendworks/shared";
import { createControlPlaneRunStarter, createInMemoryFiringStore, createInMemoryRunStarter, createTriggerGateway, createTriggerGatewayApi } from "@tendworks/trigger-gateway";
import createClient from "openapi-fetch";
import { afterAll, describe, expect, it } from "vitest";
import { readContract } from "./support/contracts.js";
import { TRIGGER_SOURCES, withFakeBindings } from "./support/trigger-sources.js";
import { openApiContract } from "./support/openapi-contract.js";
import { fixtureConfiguration } from "../fixtures/fixture-configuration.js";

/*
 * Each HTTP API against its OpenAPI contract, in process: the control plane (public),
 * orchestration, the agent runtime, the trigger gateway and the runtime health API (internal). Every
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
  agentRuntime: openApiContract("agent-runtime"),
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

const configuration = loadConfiguration(fixtureConfiguration());
const API_TOKEN = "contract-test-token";
const READ_TOKEN = "contract-test-read-token";
const healthy = createStaticHealthProbe("store", { status: "healthy" });
const unhealthy = createStaticHealthProbe("execution-engine", { status: "unhealthy", message: "no answer" });
const unreachable = async (): Promise<Response> => {
  throw new TypeError("fetch failed");
};

/** The worker's internal APIs: orchestration and the agent runtime it hands tasks to. */
function worker(engine?: (real: RunEngine) => RunEngine, sleep: (ms: number) => Promise<void> = async () => {}) {
  const agents = createAgentRuntime({
    profiles: configuration.agentProfiles,
    sleep,
    workspaces: createWorkspaces(configuration.workspaces, { secrets: createSecretResolver("agent", {}) }),
    assistants: workspaceAssistants(configuration.workspaces),
  });
  const store = createInMemoryRunStore();
  const real = createInProcessRunEngine(createRunActivities({ store, agents, http: new InMemoryHttpExecutor() }));
  const orchestration = createOrchestrationApi({ store, engine: engine ? engine(real) : real });
  const agentRuntime = createAgentRuntimeApi({ runtime: agents });
  return {
    orchestration: contracts.orchestration.guard((request) => orchestration.fetch(request)),
    agentRuntime: contracts.agentRuntime.guard((request) => agentRuntime.fetch(request)),
  };
}

const orchestration = (engine?: (real: RunEngine) => RunEngine) => worker(engine).orchestration;

function controlPlane(
  options: Partial<ControlPlaneApiOptions> = {},
  { token = API_TOKEN, sleep }: { token?: string | null; sleep?: (ms: number) => Promise<void> } = {},
) {
  const internal = worker(undefined, sleep);
  const api = createControlPlaneApi({
    probes: [healthy],
    configuration,
    runs: createOrchestrationClient({ baseUrl: "http://worker.test", fetch: internal.orchestration }),
    agentRuntime: createAgentRuntimeClient({ baseUrl: "http://worker.test", fetch: internal.agentRuntime }),
    apiToken: API_TOKEN,
    readToken: READ_TOKEN,
    ...options,
  });
  return createClient<ControlPlane.paths>({
    baseUrl: "http://tend.test",
    ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }),
    fetch: contracts.controlPlane.guard((request) => api.fetch(request)),
  });
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

describe("control plane: a stopped platform", () => {
  const failed = createStaticHealthProbe("orchestration-schema", { status: "unhealthy", message: "migration 2 (add-index) failed" });
  const stopped = createStoppedControlPlaneApi({ probes: [healthy, failed] });
  const fetchStopped = contracts.controlPlane.guard((request) => stopped.fetch(request));
  const json = (body: unknown) => ({ body: JSON.stringify(body), headers: { authorization: `Bearer ${API_TOKEN}`, "content-type": "application/json" } });
  const read = { headers: { authorization: `Bearer ${API_TOKEN}` } };
  // One valid request per operation but GET /status.
  const requests: [string, string, RequestInit][] = [
    ["GET", "/access", read],
    ["POST", "/runs", json({ workflow: "hello-agent" })],
    ["POST", "/runs/r-1/retry", read],
    ["GET", "/runs", read],
    ["GET", "/runs/r-1", read],
    ["GET", "/runs/r-1/tasks/t-1/transcript", read],
    ["GET", "/runs/r-1/tasks/t-1/transcript/stream", read],
    ["POST", "/chats", json({ agent: "fake-assistant", text: "Hello" })],
    ["GET", "/chats", read],
    ["GET", "/chats/c-1", read],
    ["POST", "/chats/c-1/messages", json({ text: "Hello?" })],
    ["POST", "/chats/c-1/cancel", read],
    ["POST", "/chats/c-1/end", read],
    ["GET", "/chats/c-1/transcript", read],
    ["GET", "/chats/c-1/transcript/stream", read],
    ["GET", "/agents", read],
    ["GET", "/workspaces", read],
    ["GET", "/subscriptions", read],
    ["GET", "/triggers", read],
    ["GET", "/notifications", read],
    ["GET", "/approval-requests", read],
    ["GET", "/approval-requests/a-1", read],
    ["POST", "/approval-requests", json({ run: "r-1", step: "/do/0/confirm", action: "deploy", question: "Deploy?", answers: [{ label: "Deploy", outcome: "continue" }] })],
    ["POST", "/approval-requests/a-1/decision", json({ answer: "Deploy" })],
  ];

  it("still reports its status, naming the failed component", async () => {
    const response = await fetchStopped(new Request("http://tend.test/status"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "unhealthy", components: expect.arrayContaining([expect.objectContaining({ name: "orchestration-schema" })]) });
  });

  it.each(requests)("refuses %s %s with 503 Platform stopped", async (method, path, init) => {
    const response = await fetchStopped(new Request(`http://tend.test${path}`, { method, ...init }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ title: "Platform stopped", status: 503 });
  });
});

describe("a stopped worker, called by the control plane", () => {
  const failed = createStaticHealthProbe("orchestration-schema", { status: "unhealthy", message: "schema orchestration: migration 2 (add-index) failed" });
  const stopped = createStoppedBundleApi({ title: "Worker stopped", probes: [failed] });
  const json = (body: unknown) => ({ body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  // One valid request per operation of the worker's internal APIs.
  const requests: ["orchestration" | "agentRuntime", string, string, RequestInit][] = [
    ["orchestration", "POST", "/runs", json({ workflow: { document: { dsl: "1.0.0", namespace: "test", name: "hello", version: "0.1.0" }, do: [] } })],
    ["orchestration", "GET", "/runs", {}],
    ["orchestration", "GET", "/runs/r-1", {}],
    ["agentRuntime", "POST", "/chats", json({ agent: "fake-assistant", text: "Hello" })],
    ["agentRuntime", "GET", "/chats", {}],
    ["agentRuntime", "GET", "/chats/c-1", {}],
    ["agentRuntime", "POST", "/chats/c-1/messages", json({ text: "Hello?" })],
    ["agentRuntime", "POST", "/chats/c-1/cancel", {}],
    ["agentRuntime", "POST", "/chats/c-1/end", {}],
    ["agentRuntime", "GET", "/sessions", {}],
    ["agentRuntime", "GET", "/tasks/t-1/transcript", {}],
    ["agentRuntime", "GET", "/tasks/t-1/transcript/stream", {}],
  ];

  it("still reports its health, naming the failed component", async () => {
    const response = await contracts.health.guard((request) => stopped.fetch(request))(new Request("http://worker.test/health"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "unhealthy", components: [expect.objectContaining({ name: "orchestration-schema" })] });
  });

  it.each(requests)("%s: refuses %s %s with 503 Worker stopped, without the reason", async (api, method, path, init) => {
    const response = await contracts[api].guard((request) => stopped.fetch(request))(new Request(`http://worker.test${path}`, { method, ...init }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({ title: "Worker stopped", status: 503 });
    expect(JSON.stringify(body)).not.toContain("add-index");
  });
});

describe("control plane: runs, through orchestration", () => {
  it("starts, lists and reads a run of a configured workflow", async () => {
    const client = controlPlane();

    const started = await client.POST("/runs", { body: { workflow: "hello-agent", input: { item: { key: "hello", title: "Say hello", number: 1 } } } });
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

  it("retries a finished run, failed or completed, and refuses an unknown run and one still at work", async () => {
    const client = controlPlane();
    // Its slow agent never finishes, so its run stays at work.
    const busy = controlPlane({}, { sleep: () => new Promise<void>(() => {}) });
    const settled = async (runId: string) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const { data: run } = await client.GET("/runs/{runId}", { params: { path: { runId } } });
        if (run?.status === "completed" || run?.status === "failed") return run;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("the run did not finish");
    };
    const input = { item: { key: "hello", title: "Say hello", number: 1 } };
    const { data: failing } = await client.POST("/runs", { body: { workflow: "requires-pull-request", input } });
    const { data: completing } = await client.POST("/runs", { body: { workflow: "hello-agent", input } });
    const { data: working } = await busy.POST("/runs", { body: { workflow: "slow-agent" } });
    await settled(failing!.id);
    await settled(completing!.id);

    const retried = await client.POST("/runs/{runId}/retry", { params: { path: { runId: failing!.id } } });

    expect(retried.response.status).toBe(201);
    expect(retried.data?.startedBy).toEqual({ kind: "manual", retryOf: failing!.id });
    expect((await client.POST("/runs/{runId}/retry", { params: { path: { runId: completing!.id } } })).response.status).toBe(201);
    expect((await busy.POST("/runs/{runId}/retry", { params: { path: { runId: working!.id } } })).response.status).toBe(409);
    expect((await client.POST("/runs/{runId}/retry", { params: { path: { runId: "missing" } } })).response.status).toBe(404);
  });

  it("answers 503 when orchestration cannot be reached", async () => {
    const client = controlPlane({ runs: unreachableOrchestration() });

    expect((await client.POST("/runs", { body: { workflow: "hello-agent" } })).response.status).toBe(503);
    expect((await client.GET("/runs")).response.status).toBe(503);
    expect((await client.GET("/runs/{runId}", { params: { path: { runId: "r-1" } } })).response.status).toBe(503);
    expect((await client.POST("/runs/{runId}/retry", { params: { path: { runId: "r-1" } } })).response.status).toBe(503);
  });
});

describe("control plane: transcripts of run steps, through orchestration and the agent runtime", () => {
  async function finishedRun(client: ReturnType<typeof controlPlane>) {
    const { data: started } = await client.POST("/runs", { body: { workflow: "hello-agent", input: { item: { key: "hello", title: "Say hello", number: 1 } } } });
    for (let attempt = 0; attempt < 100; attempt++) {
      const { data: run } = await client.GET("/runs/{runId}", { params: { path: { runId: started!.id } } });
      if (run?.status === "completed" || run?.status === "failed") return run;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("the run did not finish");
  }
  const transcript = (client: ReturnType<typeof controlPlane>, runId: string, taskId: string) =>
    client.GET("/runs/{runId}/tasks/{taskId}/transcript", { params: { path: { runId, taskId } } });

  it("reads the transcript of a step's agent session", async () => {
    const client = controlPlane();
    const run = await finishedRun(client);

    const { data, response } = await transcript(client, run.id, run.steps[0]!.taskId!);

    expect(response.status).toBe(200);
    expect(data?.items.map((entry) => entry.type)).toEqual(["task-started", "message-chunk", "turn-ended", "task-ended"]);
  });

  it("refuses an unknown run and a task that is no step of the run", async () => {
    const client = controlPlane();
    const run = await finishedRun(client);

    expect((await transcript(client, "missing", "task-1")).response.status).toBe(404);
    expect((await transcript(client, run.id, "not-a-step-task")).response.status).toBe(404);
  });

  it("answers 503 when the agent runtime cannot be reached", async () => {
    const client = controlPlane({ agentRuntime: createAgentRuntimeClient({ baseUrl: "http://worker.test", fetch: unreachable }) });
    const run = await finishedRun(client);

    expect((await transcript(client, run.id, run.steps[0]!.taskId!)).response.status).toBe(503);
  });

  const stream = (client: ReturnType<typeof controlPlane>, runId: string, taskId: string, lastEventId?: string) =>
    client.GET("/runs/{runId}/tasks/{taskId}/transcript/stream", {
      params: { path: { runId, taskId }, header: lastEventId === undefined ? {} : { "Last-Event-ID": lastEventId } },
      parseAs: "stream",
    });
  async function events(body: ReadableStream<Uint8Array> | null | undefined) {
    const all: { id?: string; event?: string; data: string }[] = [];
    for await (const event of readServerSentEvents(body!)) all.push(event);
    return all;
  }

  it("streams the entries of a step's agent session, each event as the contract describes it, after Last-Event-ID", async () => {
    const client = controlPlane();
    const run = await finishedRun(client);

    const whole = await stream(client, run.id, run.steps[0]!.taskId!);
    const resumed = await stream(client, run.id, run.steps[0]!.taskId!, "1");

    expect(whole.response.status).toBe(200);
    expect((await events(whole.data)).map((event) => event.event)).toEqual(["entry", "entry", "entry", "entry", "end"]);
    expect((await events(resumed.data)).map((event) => event.id)).toEqual(["2", "3", undefined]);
  });

  it("refuses a Last-Event-ID that is no position, an unknown run and a task that is no step of the run", async () => {
    const client = controlPlane();
    const run = await finishedRun(client);
    const taskId = run.steps[0]!.taskId!;
    const refusedId = await client.GET("/runs/{runId}/tasks/{taskId}/transcript/stream", {
      params: { path: { runId: run.id, taskId } },
      headers: { "last-event-id": "latest" },
    });

    expect(refusedId.response.status).toBe(400);
    expect((await stream(client, "missing", taskId)).response.status).toBe(404);
    expect((await stream(client, run.id, "not-a-step-task")).response.status).toBe(404);
  });

  it("answers 503 for a stream when the agent runtime cannot be reached", async () => {
    const client = controlPlane({ agentRuntime: createAgentRuntimeClient({ baseUrl: "http://worker.test", fetch: unreachable }) });
    const run = await finishedRun(client);

    expect((await stream(client, run.id, run.steps[0]!.taskId!)).response.status).toBe(503);
  });
});

describe("control plane: chats, through the agent runtime", () => {
  /** A control plane whose fake agents work on a turn until the test lets them answer. */
  function chatting() {
    const turns: (() => void)[] = [];
    const client = controlPlane({}, { sleep: () => new Promise<void>((resolve) => turns.push(resolve)) });
    const of = (id: string) => ({ params: { path: { chatId: id } } });
    /** Lets the running turn end and waits until the chat waits for the next message. */
    async function answer(id: string) {
      for (let attempt = 0; attempt < 100 && turns.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
      turns.shift()?.();
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await client.GET("/chats/{chatId}", of(id))).data?.status === "input-required") return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("the turn did not end");
    }
    /** Forgets the wait of a turn that was cancelled, so `answer` lets the next turn end. */
    const forget = () => void turns.splice(0);
    return { client, of, answer, forget };
  }
  async function events(body: ReadableStream<Uint8Array> | null | undefined) {
    const all: { id?: string; event?: string; data: string }[] = [];
    for await (const event of readServerSentEvents(body!)) all.push(event);
    return all;
  }

  it("starts a chat, refuses a message during a turn, takes the next one, ends it and keeps the transcript", async () => {
    const { client, of, answer } = chatting();

    const started = await client.POST("/chats", { body: { agent: "fake-assistant", text: "Hello" } });
    const id = started.data!.id;
    const during = await client.POST("/chats/{chatId}/messages", { ...of(id), body: { text: "Still there?" } });
    await answer(id);
    const next = await client.POST("/chats/{chatId}/messages", { ...of(id), body: { text: "Again" } });
    await answer(id);
    const listed = await client.GET("/chats");
    const ended = await client.POST("/chats/{chatId}/end", of(id));
    const after = await client.POST("/chats/{chatId}/messages", { ...of(id), body: { text: "Hello?" } });
    const transcript = await client.GET("/chats/{chatId}/transcript", of(id));
    const stream = await client.GET("/chats/{chatId}/transcript/stream", { params: { path: { chatId: id }, header: { "Last-Event-ID": "1" } }, parseAs: "stream" });

    expect(started.response.status).toBe(201);
    expect([during.response.status, next.response.status, ended.response.status, after.response.status]).toEqual([409, 200, 200, 409]);
    expect(listed.data?.items.map((chat) => chat.id)).toEqual([id]);
    expect(ended.data).toMatchObject({ status: "ended", cost: { amount: 0, currency: "USD" } });
    expect(transcript.data?.items.map((entry) => entry.type)).toEqual([
      "task-started",
      "message-chunk",
      "turn-ended",
      "input-required",
      "message-received",
      "message-chunk",
      "turn-ended",
      "input-required",
      "task-ended",
    ]);
    expect((await events(stream.data)).map((event) => event.id ?? event.event)).toEqual(["2", "3", "4", "5", "6", "7", "8", "end"]);
  });

  it("cancels a running turn, takes the next message, and refuses to cancel once the chat ended", async () => {
    const { client, of, answer, forget } = chatting();
    const { data: chat } = await client.POST("/chats", { body: { agent: "fake-assistant", text: "Work forever" } });
    const id = chat!.id;

    const cancelled = await client.POST("/chats/{chatId}/cancel", of(id));
    forget();
    const idle = await client.POST("/chats/{chatId}/cancel", of(id));
    const next = await client.POST("/chats/{chatId}/messages", { ...of(id), body: { text: "Something quick instead" } });
    await answer(id);
    await client.POST("/chats/{chatId}/end", of(id));
    const afterEnd = await client.POST("/chats/{chatId}/cancel", of(id));
    const transcript = await client.GET("/chats/{chatId}/transcript", of(id));

    expect(cancelled.data).toMatchObject({ id, status: "input-required" });
    expect(idle.data).toMatchObject({ id, status: "input-required" });
    expect(next.response.status).toBe(200);
    expect(afterEnd.response.status).toBe(409);
    expect(transcript.data?.items.map((entry) => entry.type)).toEqual([
      "task-started",
      "turn-ended",
      "input-required",
      "message-received",
      "message-chunk",
      "turn-ended",
      "input-required",
      "task-ended",
    ]);
  });

  it("starts a chat with a workspace's assistant by the workspace's name, and refuses a workspace without one or not configured", async () => {
    const { client } = chatting();

    const started = await client.POST("/chats", { body: { workspace: "fake-playground", text: "Hello" } });
    const withoutAssistant = await client.POST("/chats", { body: { workspace: "playground-without-assistant", text: "Hello" } });
    const unknown = await client.POST("/chats", { body: { workspace: "ghost", text: "Hello" } });

    expect(started.response.status).toBe(201);
    expect(started.data).toMatchObject({ agent: "fake-assistant", workspace: "fake-playground", write: false });
    expect(withoutAssistant.response.status).toBe(400);
    expect(withoutAssistant.error).toMatchObject({ title: "Chat not allowed" });
    expect(unknown.error).toMatchObject({ title: "Unknown workspace" });
  });

  it("lists the workspaces with their assistants", async () => {
    const { data, response } = await controlPlane({}, { token: READ_TOKEN }).GET("/workspaces");

    expect(response.status).toBe(200);
    expect(data?.items.map(({ name, assistant }) => [name, assistant?.profile])).toEqual([
      ["fake-playground", "fake-assistant"],
      ["playground", "workspace-assistant"],
      ["playground-without-assistant", undefined],
      ["scripted-playground", "scripted-assistant"],
    ]);
  });

  it("lists the subscriptions of the configuration with their scope, events, channels and priority", async () => {
    const { data, response } = await controlPlane({}, { token: READ_TOKEN }).GET("/subscriptions");

    expect(response.status).toBe(200);
    expect(data?.items).toEqual([
      { name: "fake-playground-log", scope: { workspace: "fake-playground" }, events: ["run.started", "run.completed", "run.failed", "approval.requested"], channels: ["fake-log", "fake-refusing"] },
      { name: "platform-log", scope: { platform: {} }, events: ["run.started", "run.completed", "run.failed", "approval.requested", "platform.degraded", "platform.recovered"], channels: ["fake-log"], priority: 1 },
      { name: "platform-refusing", scope: { platform: {} }, events: ["run.completed"], channels: ["fake-refusing"] },
    ]);
  });

  it("refuses an invalid request, a profile that does not allow chats and an unknown chat", async () => {
    const { client, of } = chatting();
    const { data: chat } = await client.POST("/chats", { body: { agent: "fake-assistant", text: "Hello" } });

    expect((await client.POST("/chats", { body: { agent: "fake-assistant", text: "" } })).response.status).toBe(400);
    expect((await client.POST("/chats", { body: { agent: "fake-developer", text: "Push it" } })).response.status).toBe(400);
    expect((await client.POST("/chats/{chatId}/messages", { ...of(chat!.id), body: { text: "" } })).response.status).toBe(400);
    const refusedId = await client.GET("/chats/{chatId}/transcript/stream", { ...of(chat!.id), headers: { "last-event-id": "latest" } });
    expect(refusedId.response.status).toBe(400);
    expect((await client.GET("/chats/{chatId}", of("missing"))).response.status).toBe(404);
    expect((await client.POST("/chats/{chatId}/messages", { ...of("missing"), body: { text: "Hi" } })).response.status).toBe(404);
    expect((await client.POST("/chats/{chatId}/cancel", of("missing"))).response.status).toBe(404);
    expect((await client.POST("/chats/{chatId}/end", of("missing"))).response.status).toBe(404);
    expect((await client.GET("/chats/{chatId}/transcript", of("missing"))).response.status).toBe(404);
    expect((await client.GET("/chats/{chatId}/transcript/stream", { ...of("missing"), parseAs: "stream" })).response.status).toBe(404);
  });

  it("answers 503 when the agent runtime cannot be reached", async () => {
    const client = controlPlane({ agentRuntime: createAgentRuntimeClient({ baseUrl: "http://worker.test", fetch: unreachable }) });
    const of = { params: { path: { chatId: "c-1" } } };

    const answers = await Promise.all([
      client.POST("/chats", { body: { agent: "fake-assistant", text: "Hello" } }),
      client.GET("/chats"),
      client.GET("/chats/{chatId}", of),
      client.POST("/chats/{chatId}/messages", { ...of, body: { text: "Hi" } }),
      client.POST("/chats/{chatId}/cancel", of),
      client.POST("/chats/{chatId}/end", of),
      client.GET("/chats/{chatId}/transcript", of),
      client.GET("/chats/{chatId}/transcript/stream", { ...of, parseAs: "stream" }),
    ]);

    expect(answers.map(({ response }) => response.status)).toEqual([503, 503, 503, 503, 503, 503, 503, 503]);
  });
});

describe("agent runtime, called directly", () => {
  it("refuses a chat message without text", async () => {
    const { agentRuntime } = worker();
    const started = await agentRuntime(new Request("http://worker.test/chats", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "fake-assistant", text: "Hello" }) }));
    const { id } = (await started.json()) as { id: string };

    const refused = await agentRuntime(new Request(`http://worker.test/chats/${id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "" }) }));

    expect(refused.status).toBe(400);
  });

  it("refuses a task it does not know", async () => {
    const response = await worker().agentRuntime(new Request("http://worker.test/tasks/unknown/transcript"));

    expect(response.status).toBe(404);
  });

  it("refuses to stream a task it does not know or after a Last-Event-ID that is no position", async () => {
    const { agentRuntime } = worker();

    const unknown = await agentRuntime(new Request("http://worker.test/tasks/unknown/transcript/stream"));
    const invalid = await agentRuntime(new Request("http://worker.test/tasks/unknown/transcript/stream", { headers: { "last-event-id": "-1" } }));

    expect([unknown.status, invalid.status]).toEqual([404, 400]);
  });
});

describe("control plane: agents", () => {
  it("lists the agent profiles of the example configuration", async () => {
    const { data, response } = await controlPlane().GET("/agents");

    expect(response.status).toBe(200);
    expect(data?.items.map((agent) => agent.name)).toEqual(configuration.agentProfiles.map((profile) => profile.metadata.name).sort());
    // No repository token in a profile: workspaces bring their own credentials (ADR 0022).
    expect(data?.items.find((agent) => agent.name === "developer")).toMatchObject({ harness: "claude-code", sessions: [] });
    expect(data?.items.find((agent) => agent.name === "developer")).not.toHaveProperty("secrets");
    expect(data?.items.find((agent) => agent.name === "scripted-secret-assistant")).toMatchObject({ secrets: ["TENDWORKS_AGENT_E2E_SECRET"] });
    expect(data?.items.find((agent) => agent.name === "developer")).not.toHaveProperty("chat");
    expect(data?.items.find((agent) => agent.name === "assistant")).toMatchObject({ chat: { idleMinutes: 5 }, mcp: ["tendworks"] });
  });

  it("shows the active agent sessions of a run's step and of a chat under their profiles, and leaves out finished ones", async () => {
    const working: (() => void)[] = [];
    const client = controlPlane({}, { sleep: () => new Promise<void>((resolve) => working.push(resolve)) });
    const { data: run } = await client.POST("/runs", { body: { workflow: "slow-agent" } });
    const { data: chat } = await client.POST("/chats", { body: { agent: "fake-assistant", text: "Hello" } });
    for (let attempt = 0; attempt < 200 && working.length < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    const sessionsOf = async (name: string) => (await client.GET("/agents")).data?.items.find((agent) => agent.name === name)?.sessions;

    const step = await sessionsOf("fake-slow-developer");
    const chatting = await sessionsOf("fake-assistant");
    working.splice(0).forEach((resolve) => resolve());
    await client.POST("/chats/{chatId}/end", { params: { path: { chatId: chat!.id } } });
    for (let attempt = 0; attempt < 200 && (await client.GET("/runs/{runId}", { params: { path: { runId: run!.id } } })).data?.status === "running"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(step).toEqual([
      { kind: "run-step", agent: "fake-slow-developer", taskId: expect.any(String), status: "working", startedAt: expect.any(String), run: run!.id, step: "/do/0/implement" },
    ]);
    expect(chatting).toEqual([{ kind: "chat", agent: "fake-assistant", taskId: chat!.id, status: "working", startedAt: chat!.startedAt, chat: chat!.id }]);
    expect([await sessionsOf("fake-slow-developer"), await sessionsOf("fake-assistant")]).toEqual([[], []]);
  });

  it("lists the agent profiles without sessions when the agent runtime cannot be reached", async () => {
    const client = controlPlane({ agentRuntime: createAgentRuntimeClient({ baseUrl: "http://worker.test", fetch: unreachable }) });

    const { data, response } = await client.GET("/agents");

    expect(response.status).toBe(200);
    expect(data?.items.find((agent) => agent.name === "developer")).toEqual(expect.objectContaining({ name: "developer", harness: "claude-code" }));
    expect(data?.items.some((agent) => "sessions" in agent)).toBe(false);
  });
});

describe("control plane: the API token", () => {
  it("refuses operations that change state without the API token", async () => {
    const client = controlPlane({}, { token: "wrong-token" });

    const started = await client.POST("/runs", { body: { workflow: "hello-agent" } });
    const decided = await client.POST("/approval-requests/{approvalRequestId}/decision", { params: { path: { approvalRequestId: "a-1" } }, body: { answer: "Deploy" } });
    const asked = await client.POST("/approval-requests", {
      body: { run: "r-1", step: "/do/0/confirm", action: "deploy", question: "Deploy?", answers: [{ label: "Deploy", outcome: "continue" }] },
    });
    const chatted = await client.POST("/chats", { body: { agent: "fake-assistant", text: "Hello" } });
    const sent = await client.POST("/chats/{chatId}/messages", { params: { path: { chatId: "c-1" } }, body: { text: "Hi" } });
    const cancelled = await client.POST("/chats/{chatId}/cancel", { params: { path: { chatId: "c-1" } } });
    const ended = await client.POST("/chats/{chatId}/end", { params: { path: { chatId: "c-1" } } });
    const retried = await client.POST("/runs/{runId}/retry", { params: { path: { runId: "r-1" } } });

    expect([started, decided, asked, chatted, sent, cancelled, ended, retried].map(({ response }) => response.status)).toEqual([401, 401, 401, 401, 401, 401, 401, 401]);
  });

  it("refuses operations that change state with the read-only token", async () => {
    const client = controlPlane({}, { token: READ_TOKEN });

    const started = await client.POST("/runs", { body: { workflow: "hello-agent" } });
    const decided = await client.POST("/approval-requests/{approvalRequestId}/decision", { params: { path: { approvalRequestId: "a-1" } }, body: { answer: "Deploy" } });
    const asked = await client.POST("/approval-requests", {
      body: { run: "r-1", step: "/do/0/confirm", action: "deploy", question: "Deploy?", answers: [{ label: "Deploy", outcome: "continue" }] },
    });
    const chatted = await client.POST("/chats", { body: { agent: "fake-assistant", text: "Hello" } });
    const sent = await client.POST("/chats/{chatId}/messages", { params: { path: { chatId: "c-1" } }, body: { text: "Hi" } });
    const cancelled = await client.POST("/chats/{chatId}/cancel", { params: { path: { chatId: "c-1" } } });
    const ended = await client.POST("/chats/{chatId}/end", { params: { path: { chatId: "c-1" } } });
    const retried = await client.POST("/runs/{runId}/retry", { params: { path: { runId: "r-1" } } });

    expect([started, decided, asked, chatted, sent, cancelled, ended, retried].map(({ response }) => response.status)).toEqual([403, 403, 403, 403, 403, 403, 403, 403]);
  });

  it("refuses reading without a token, except the platform status", async () => {
    const client = controlPlane({}, { token: null });

    const answers = await Promise.all([
      client.GET("/runs"),
      client.GET("/runs/{runId}", { params: { path: { runId: "r-1" } } }),
      client.GET("/runs/{runId}/tasks/{taskId}/transcript", { params: { path: { runId: "r-1", taskId: "t-1" } } }),
      client.GET("/runs/{runId}/tasks/{taskId}/transcript/stream", { params: { path: { runId: "r-1", taskId: "t-1" } } }),
      client.GET("/agents"),
      client.GET("/workspaces"),
      client.GET("/subscriptions"),
      client.GET("/triggers"),
      client.GET("/notifications"),
      client.GET("/approval-requests"),
      client.GET("/approval-requests/{approvalRequestId}", { params: { path: { approvalRequestId: "a-1" } } }),
      client.GET("/chats"),
      client.GET("/chats/{chatId}", { params: { path: { chatId: "c-1" } } }),
      client.GET("/chats/{chatId}/transcript", { params: { path: { chatId: "c-1" } } }),
      client.GET("/chats/{chatId}/transcript/stream", { params: { path: { chatId: "c-1" } } }),
      client.GET("/access"),
      client.GET("/status"),
    ]);

    expect(answers.map(({ response }) => response.status)).toEqual([401, 401, 401, 401, 401, 401, 401, 401, 401, 401, 401, 401, 401, 401, 401, 401, 200]);
  });

  it("serves reading with the read-only token", async () => {
    const client = controlPlane({ notifications: createInMemoryNotificationStore(), approvals: createApprovals({ store: createInMemoryApprovalStore() }) }, { token: READ_TOKEN });

    const answers = await Promise.all([client.GET("/runs"), client.GET("/agents"), client.GET("/triggers"), client.GET("/notifications"), client.GET("/approval-requests")]);

    expect(answers.map(({ response }) => response.status)).toEqual([200, 200, 200, 200, 200]);
  });

  it("tells the full access of the API token and the read access of the read-only token", async () => {
    const full = await controlPlane({}, { token: API_TOKEN }).GET("/access");
    const read = await controlPlane({}, { token: READ_TOKEN }).GET("/access");

    expect([full.data, read.data]).toEqual([{ scope: "full" }, { scope: "read" }]);
  });

  it("reserves paths under /ui/ for the web UI", () => {
    const document = readContract("openapi/control-plane.yaml") as { paths: Record<string, unknown> };

    expect(Object.keys(document.paths).filter((path) => path === "/" || path === "/ui" || path.startsWith("/ui/"))).toEqual([]);
  });

  it("declares the API token for every operation but the status, and the read-only token for reading only", () => {
    const document = readContract("openapi/control-plane.yaml") as {
      security?: Record<string, string[]>[];
      paths: Record<string, Record<string, { security?: Record<string, string[]>[]; responses: Record<string, unknown> }>>;
    };
    const declared = Object.entries(document.paths).flatMap(([path, item]) =>
      Object.entries(item).map(([method, operation]) => ({
        operation: `${method.toUpperCase()} ${path}`,
        schemes: (operation.security ?? document.security ?? []).flatMap((requirement) => Object.keys(requirement)).sort(),
        refusals: ["401", "403"].filter((status) => status in operation.responses),
      })),
    );

    for (const { operation, schemes, refusals } of declared) {
      if (operation === "GET /status") expect({ operation, schemes, refusals }).toEqual({ operation, schemes: [], refusals: [] });
      else if (operation.startsWith("GET ")) expect({ operation, schemes, refusals }).toEqual({ operation, schemes: ["apiToken", "readToken"], refusals: ["401"] });
      else expect({ operation, schemes, refusals }).toEqual({ operation, schemes: ["apiToken"], refusals: ["401", "403"] });
    }
  });
});

describe("control plane: triggers, through the trigger gateway", () => {
  it("lists the configured trigger bindings", async () => {
    const gateway = createTriggerGateway({
      bindings: withFakeBindings(configuration.triggerBindings),
      workspaces: configuration.workspaces,
      sources: TRIGGER_SOURCES,
      store: createInMemoryFiringStore(),
      runs: createControlPlaneRunStarter({ baseUrl: "http://tend.test", apiToken: API_TOKEN, fetch: unreachable }),
      now: () => new Date("2026-10-19T10:00:00.000Z"),
    });
    const api = createTriggerGatewayApi(gateway);
    const client = controlPlane({
      triggers: createTriggerGatewayClient({ baseUrl: "http://trigger-gateway.test", fetch: contracts.triggerGateway.guard((request) => api.fetch(request)) }),
    });

    const { data } = await client.GET("/triggers");

    expect(data?.items.map((trigger) => trigger.name)).toEqual(["fake-issue-to-pull-request", "issue-ready-for-agent", "manual-over-two-workspaces", "playground-nightly-check", "playground-ready-for-agent", "schedule-over-two-workspaces", "schedule-to-pull-request"]);
    expect(data?.items.find((trigger) => trigger.name === "playground-ready-for-agent")?.suspended).toBe(true);
  });

  it("answers 503 when the trigger gateway cannot be reached", async () => {
    const client = controlPlane({ triggers: createTriggerGatewayClient({ baseUrl: "http://trigger-gateway.test", fetch: unreachable }) });

    expect((await client.GET("/triggers")).response.status).toBe(503);
  });

  it("fires a manual binding, and refuses what cannot be fired", async () => {
    // Runs start in memory here; tests/contract/triggers.test.ts starts them through the public API.
    const gateway = createTriggerGateway({
      bindings: withFakeBindings(configuration.triggerBindings),
      workspaces: configuration.workspaces,
      sources: TRIGGER_SOURCES,
      store: createInMemoryFiringStore(),
      runs: createInMemoryRunStarter(),
      now: () => new Date("2026-10-19T10:00:00.000Z"),
      log: () => {},
    });
    const api = createTriggerGatewayApi(gateway);
    const triggers = createTriggerGatewayClient({ baseUrl: "http://trigger-gateway.test", fetch: contracts.triggerGateway.guard((request) => api.fetch(request)) });
    const fire = (client: ReturnType<typeof controlPlane>, name: string, body?: { workspace: string }) =>
      client.POST("/triggers/{name}/fire", { params: { path: { name } }, ...(body ? { body } : {}) }).then(({ response }) => response.status);
    const operator = controlPlane({ triggers });

    expect(await fire(operator, "manual-over-two-workspaces")).toBe(201);
    expect(await fire(operator, "manual-over-two-workspaces", { workspace: "playground" })).toBe(400);
    expect(await fire(operator, "no-such-binding")).toBe(404);
    expect(await fire(operator, "schedule-over-two-workspaces")).toBe(409);
    expect(await fire(controlPlane({ triggers }, { token: null }), "manual-over-two-workspaces")).toBe(401);
    expect(await fire(controlPlane({ triggers }, { token: READ_TOKEN }), "manual-over-two-workspaces")).toBe(403);
    expect(await fire(controlPlane({ triggers: createTriggerGatewayClient({ baseUrl: "http://trigger-gateway.test", fetch: unreachable }) }), "manual-over-two-workspaces")).toBe(503);
  });

  it("the trigger gateway refuses a malformed firing with 400", async () => {
    const gateway = createTriggerGateway({ bindings: [], sources: TRIGGER_SOURCES, store: createInMemoryFiringStore(), runs: createInMemoryRunStarter() });
    const fetch = contracts.triggerGateway.guard((request) => createTriggerGatewayApi(gateway).fetch(request));

    const response = await fetch(new Request("http://trigger-gateway.test/triggers/any/fire", { method: "POST", headers: { "content-type": "application/json" }, body: "[]" }));

    expect(response.status).toBe(400);
  });
});

describe("control plane: notifications", () => {
  it("lists the notifications human interaction recorded, with the run's artifacts and the delivery status of each channel a subscription names", async () => {
    const store = createInMemoryNotificationStore();
    const fake = (refuse = false) => createFakeNotificationDelivery({ refuse, log: () => {} });
    const channels = [
      { name: "phone", delivery: fake(true) },
      { name: "log", delivery: fake() },
      { name: "pager", delivery: fake() },
    ];
    const subscriptions = [
      { scope: { platform: {} }, events: ["run.completed", "run.failed"] as ["run.completed", "run.failed"], channels: ["phone"] as [string] },
      { scope: { workspace: "app" }, events: ["run.completed"] as ["run.completed"], channels: ["pager"] as [string] },
      { scope: { platform: {} }, events: ["run.completed"] as ["run.completed"], channels: ["log"] as [string] },
    ];
    await createNotifier({ store, channels, subscriptions, now: () => new Date("2026-10-19T10:00:01.000Z") }).handle({
      specversion: "1.0",
      id: "r-1:run.completed",
      source: "/tendworks/orchestration",
      type: "dev.tendworks.run.completed",
      time: "2026-10-19T10:00:00.000Z",
      datacontenttype: "application/json",
      runid: "r-1",
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      data: { workflow: "develop-issue", artifacts: [{ name: "pull-request", url: "https://git.example/acme/app/pull/7" }] },
    });
    const client = controlPlane({ notifications: store });

    const { data } = await client.GET("/notifications");

    expect(data?.items).toEqual([
      expect.objectContaining({
        kind: "run.completed",
        artifacts: [{ name: "pull-request", url: "https://git.example/acme/app/pull/7" }],
        deliveries: [
          { channel: "log", status: "delivered", attemptedAt: "2026-10-19T10:00:01.000Z" },
          { channel: "phone", status: "failed", attemptedAt: "2026-10-19T10:00:01.000Z", error: "the fake channel refuses every notification" },
        ],
      }),
    ]);
  });

  it("answers 503 without a notification store", async () => {
    expect((await controlPlane().GET("/notifications")).response.status).toBe(503);
  });
});

describe("control plane: approval requests", () => {
  const TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  const question = {
    run: "r-1",
    step: "/do/1/confirm",
    action: "deploy",
    question: "Deploy release 1.4 for run r-1 of release-app?",
    links: [{ title: "Release notes", url: "https://git.example/acme/app/releases/1.4" }],
    answers: [
      { label: "Deploy", outcome: "continue" as const },
      { label: "Cancel", outcome: "stop" as const },
    ],
  };
  const runs = [
    { id: "r-1", workflow: "release-app", status: "running" as const, traceparent: TRACEPARENT },
    { id: "r-done", workflow: "release-app", status: "completed" as const },
  ];
  function platform(policies: Policy[] = []) {
    return controlPlane({ approvals: createApprovals({ store: createInMemoryApprovalStore(), policies, runs: async (id) => runs.find((run) => run.id === id) }) });
  }
  async function withPendingRequest() {
    const client = platform();
    const { data } = await client.POST("/approval-requests", { body: question });
    return { client, id: data!.approvalRequest!.id };
  }
  const decide = (client: ReturnType<typeof controlPlane>, id: string, answer: string) =>
    client.POST("/approval-requests/{approvalRequestId}/decision", { params: { path: { approvalRequestId: id } }, body: { answer } });

  it("asks on behalf of a human step: records the request with its question, links and answers", async () => {
    const client = platform();

    const { data, response } = await client.POST("/approval-requests", { body: question });

    expect(response.status).toBe(200);
    expect(data).toMatchObject({
      decision: "ask",
      approvalRequest: { runId: "r-1", workflow: "release-app", step: "/do/1/confirm", action: "deploy", links: question.links, answers: question.answers, status: "pending" },
    });
    const shown = await client.GET("/approval-requests/{approvalRequestId}", { params: { path: { approvalRequestId: data!.approvalRequest!.id } } });
    expect(shown.data).toEqual(data!.approvalRequest);
  });

  it("lets a human step proceed without a request when a policy allows its action", async () => {
    const client = platform([{ apiVersion: "tendworks.dev/v1", kind: "Policy", metadata: { name: "trusted" }, spec: { actions: { deploy: "allow" } } }]);

    const { data } = await client.POST("/approval-requests", { body: question });

    expect(data).toEqual({ decision: "allow", policy: "trusted" });
    expect((await client.GET("/approval-requests")).data?.items).toEqual([]);
  });

  it("refuses to ask for an unknown run, a run that is not running, and an invalid question", async () => {
    const client = platform();

    const unknown = await client.POST("/approval-requests", { body: { ...question, run: "nope" } });
    const finished = await client.POST("/approval-requests", { body: { ...question, run: "r-done" } });
    const invalid = await client.POST("/approval-requests", { body: { ...question, answers: [] } });
    const twice = await client.POST("/approval-requests", { body: { ...question, answers: [{ label: "Deploy", outcome: "continue" }, { label: "Deploy", outcome: "stop" }] } });

    expect([unknown, finished, invalid, twice].map(({ response }) => response.status)).toEqual([404, 409, 400, 400]);
  });

  it("lists the pending approval request and decides it with one of its answers", async () => {
    const { client, id } = await withPendingRequest();

    const pending = await client.GET("/approval-requests", { params: { query: { status: "pending" } } });
    const decided = await decide(client, id, "Cancel");

    expect(pending.data?.items.map((item) => item.id)).toEqual([id]);
    expect(decided.data).toMatchObject({ status: "decided", answer: "Cancel" });
  });

  it("refuses another answer once the approval request is decided", async () => {
    const { client, id } = await withPendingRequest();
    await decide(client, id, "Cancel");

    expect((await decide(client, id, "Deploy")).response.status).toBe(409);
  });

  it("refuses an answer the request does not offer, no answer and an unknown approval request", async () => {
    const { client, id } = await withPendingRequest();

    const notOffered = await decide(client, id, "Maybe");
    const invalid = await client.POST("/approval-requests/{approvalRequestId}/decision", {
      params: { path: { approvalRequestId: id } },
      body: { decision: "approve" } as unknown as { answer: string },
    });

    expect(notOffered.response.status).toBe(400);
    expect(invalid.response.status).toBe(400);
    expect((await decide(client, "missing", "Cancel")).response.status).toBe(404);
    expect((await client.GET("/approval-requests/{approvalRequestId}", { params: { path: { approvalRequestId: "missing" } } })).response.status).toBe(404);
  });

  it("refuses a status filter that is not an approval status", async () => {
    const { client } = await withPendingRequest();
    const { response } = await client.GET("/approval-requests", { params: { query: { status: "approved" as "pending" } } });

    expect(response.status).toBe(400);
  });

  it("answers 503 without approval requests", async () => {
    const client = controlPlane();

    expect((await client.GET("/approval-requests")).response.status).toBe(503);
    expect((await client.GET("/approval-requests/{approvalRequestId}", { params: { path: { approvalRequestId: "a-1" } } })).response.status).toBe(503);
    expect((await client.POST("/approval-requests", { body: question })).response.status).toBe(503);
    expect((await decide(client, "a-1", "Cancel")).response.status).toBe(503);
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
