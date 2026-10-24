import { createAgentRuntime, createAgentRuntimeApi } from "@tendworks/agent-runtime";
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
  approvalRequested,
  createApprovals,
  createInMemoryApprovalStore,
  createInMemoryNotificationChannel,
  createInMemoryNotificationStore,
  createNotifier,
} from "@tendworks/human-interaction";
import { createInMemoryRunStore, createInProcessRunEngine, createOrchestrationApi, createRunActivities, InMemoryHttpExecutor, type RunEngine } from "@tendworks/orchestration";
import { readServerSentEvents } from "@tendworks/platform";
import type { ControlPlane } from "@tendworks/shared";
import { createControlPlaneRunStarter, createInMemoryFiringStore, createTriggerGateway, createTriggerGatewayApi } from "@tendworks/trigger-gateway";
import createClient from "openapi-fetch";
import { afterAll, describe, expect, it } from "vitest";
import { readContract } from "./support/contracts.js";
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
  const agents = createAgentRuntime({ profiles: configuration.agentProfiles, sleep });
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
    ["GET", "/triggers", read],
    ["GET", "/notifications", read],
    ["GET", "/approval-requests", read],
    ["POST", "/approval-requests/a-1/decision", json({ decision: "approve" })],
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

describe("control plane: transcripts of run steps, through orchestration and the agent runtime", () => {
  async function finishedRun(client: ReturnType<typeof controlPlane>) {
    const { data: started } = await client.POST("/runs", { body: { workflow: "hello-agent", input: { issue: { number: 1, title: "Say hello" } } } });
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

  it("starts a chat with a repository as its workspace, and refuses a repository with credentials in its URL", async () => {
    const { client } = chatting();

    const started = await client.POST("/chats", { body: { agent: "fake-assistant", text: "Hello", repository: "https://git.example/acme/app.git" } });
    const refused = await client.POST("/chats", { body: { agent: "fake-assistant", text: "Hello", repository: "https://user:token@git.example/acme/app.git" } });

    expect(started.response.status).toBe(201);
    expect(started.data).toMatchObject({ repository: "https://git.example/acme/app.git" });
    expect(refused.response.status).toBe(400);
    expect(refused.error).toMatchObject({ title: "Invalid repository" });
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
    const decided = await client.POST("/approval-requests/{approvalRequestId}/decision", { params: { path: { approvalRequestId: "a-1" } }, body: { decision: "approve" } });
    const chatted = await client.POST("/chats", { body: { agent: "fake-assistant", text: "Hello" } });
    const sent = await client.POST("/chats/{chatId}/messages", { params: { path: { chatId: "c-1" } }, body: { text: "Hi" } });
    const cancelled = await client.POST("/chats/{chatId}/cancel", { params: { path: { chatId: "c-1" } } });
    const ended = await client.POST("/chats/{chatId}/end", { params: { path: { chatId: "c-1" } } });

    expect([started, decided, chatted, sent, cancelled, ended].map(({ response }) => response.status)).toEqual([401, 401, 401, 401, 401, 401]);
  });

  it("refuses operations that change state with the read-only token", async () => {
    const client = controlPlane({}, { token: READ_TOKEN });

    const started = await client.POST("/runs", { body: { workflow: "hello-agent" } });
    const decided = await client.POST("/approval-requests/{approvalRequestId}/decision", { params: { path: { approvalRequestId: "a-1" } }, body: { decision: "approve" } });
    const chatted = await client.POST("/chats", { body: { agent: "fake-assistant", text: "Hello" } });
    const sent = await client.POST("/chats/{chatId}/messages", { params: { path: { chatId: "c-1" } }, body: { text: "Hi" } });
    const cancelled = await client.POST("/chats/{chatId}/cancel", { params: { path: { chatId: "c-1" } } });
    const ended = await client.POST("/chats/{chatId}/end", { params: { path: { chatId: "c-1" } } });

    expect([started, decided, chatted, sent, cancelled, ended].map(({ response }) => response.status)).toEqual([403, 403, 403, 403, 403, 403]);
  });

  it("refuses reading without a token, except the platform status", async () => {
    const client = controlPlane({}, { token: null });

    const answers = await Promise.all([
      client.GET("/runs"),
      client.GET("/runs/{runId}", { params: { path: { runId: "r-1" } } }),
      client.GET("/runs/{runId}/tasks/{taskId}/transcript", { params: { path: { runId: "r-1", taskId: "t-1" } } }),
      client.GET("/runs/{runId}/tasks/{taskId}/transcript/stream", { params: { path: { runId: "r-1", taskId: "t-1" } } }),
      client.GET("/agents"),
      client.GET("/triggers"),
      client.GET("/notifications"),
      client.GET("/approval-requests"),
      client.GET("/chats"),
      client.GET("/chats/{chatId}", { params: { path: { chatId: "c-1" } } }),
      client.GET("/chats/{chatId}/transcript", { params: { path: { chatId: "c-1" } } }),
      client.GET("/chats/{chatId}/transcript/stream", { params: { path: { chatId: "c-1" } } }),
      client.GET("/access"),
      client.GET("/status"),
    ]);

    expect(answers.map(({ response }) => response.status)).toEqual([401, 401, 401, 401, 401, 401, 401, 401, 401, 401, 401, 401, 401, 200]);
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

    expect(data?.items.map((trigger) => trigger.name)).toEqual(["fake-issue-to-pull-request", "issue-ready-for-agent", "playground-ready-for-agent"]);
    expect(data?.items.find((trigger) => trigger.name === "playground-ready-for-agent")?.suspended).toBe(true);
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

describe("control plane: approval requests", () => {
  async function withPendingRequest() {
    const store = createInMemoryApprovalStore();
    const request = {
      id: "a-1",
      runId: "r-1",
      workflow: "release-app",
      action: "deploy",
      policy: "careful",
      question: "Deploy release 1.4 for run r-1 of release-app?",
      status: "pending" as const,
      createdAt: "2026-10-19T10:00:00.000Z",
    };
    await store.open(request, (opened) => approvalRequested(opened, opened.createdAt));
    return controlPlane({ approvals: createApprovals({ store }) });
  }
  const decide = (client: ReturnType<typeof controlPlane>, id: string, decision: "approve" | "reject") =>
    client.POST("/approval-requests/{approvalRequestId}/decision", { params: { path: { approvalRequestId: id } }, body: { decision } });

  it("lists the pending approval request and decides it", async () => {
    const client = await withPendingRequest();

    const pending = await client.GET("/approval-requests", { params: { query: { status: "pending" } } });
    const approved = await decide(client, "a-1", "approve");

    expect(pending.data?.items.map((item) => item.id)).toEqual(["a-1"]);
    expect(approved.data?.status).toBe("approved");
  });

  it("refuses a decision the other way once the approval request is decided", async () => {
    const client = await withPendingRequest();
    await decide(client, "a-1", "reject");

    expect((await decide(client, "a-1", "approve")).response.status).toBe(409);
  });

  it("refuses an invalid decision and an unknown approval request", async () => {
    const client = await withPendingRequest();

    const invalid = await client.POST("/approval-requests/{approvalRequestId}/decision", {
      params: { path: { approvalRequestId: "a-1" } },
      body: { decision: "maybe" as "approve" },
    });

    expect(invalid.response.status).toBe(400);
    expect((await decide(client, "missing", "approve")).response.status).toBe(404);
  });

  it("refuses a status filter that is not an approval status", async () => {
    const { response } = await (await withPendingRequest()).GET("/approval-requests", { params: { query: { status: "maybe" as "pending" } } });

    expect(response.status).toBe(400);
  });

  it("answers 503 without approval requests", async () => {
    const client = controlPlane();

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
