import { readServerSentEvents, type ServerSentEvent } from "@tendworks/platform";
import type { A2A, AgentProfile, AgentRuntime } from "@tendworks/shared";
import { describe, expect, it, vi } from "vitest";
import { createAgentRuntimeApi } from "./api.js";
import { dyingWorker, scriptedSandboxes, scriptedTemplate, type AgentScript } from "./claude-code/scripted-acp-agent.stub.js";
import { createAgentRuntime, createClaudeCodeHarness, createInMemoryTaskStore, createInMemoryTranscriptStore, type TranscriptEntry } from "./index.js";
import type { Sandboxes } from "./sandboxes.js";

type TranscriptEntryList = AgentRuntime.components["schemas"]["TranscriptEntryList"];

const slow: AgentProfile.AgentProfile = {
  apiVersion: "tendworks.dev/v1",
  kind: "AgentProfile",
  metadata: { name: "slow" },
  spec: { harness: "fake", fake: { delaySeconds: 1, message: "done" } },
};

const developer: AgentProfile.AgentProfile = {
  apiVersion: "tendworks.dev/v1",
  kind: "AgentProfile",
  metadata: { name: "developer" },
  spec: { harness: "claude-code", sandbox: scriptedTemplate.metadata.name },
};

const request = (): A2A.SendMessageRequest => ({ message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text: "work" }] } });

describe("agent runtime API", () => {
  function setup() {
    let finish!: () => void;
    const runtime = createAgentRuntime({ profiles: [slow], sleep: () => new Promise<void>((resolve) => (finish = resolve)) });
    const api = createAgentRuntimeApi({ runtime });
    const get = (path: string) => api.fetch(new Request(`http://worker.test${path}`));
    return { runtime, get, finish: () => finish() };
  }

  it("serves the transcript of a task while its agent still works, and all of it once the task ended", async () => {
    const { runtime, get, finish } = setup();
    let taskId!: string;
    const done = runtime.sendMessage("slow", request(), { onTask: (task) => void (taskId = task.id) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const working = await get(`/tasks/${taskId}/transcript`);
    finish();
    await done;
    const ended = await get(`/tasks/${taskId}/transcript`);

    expect(working.status).toBe(200);
    expect(((await working.json()) as TranscriptEntryList).items).toEqual([
      { position: 0, time: expect.any(String), type: "task-started", agent: "slow", message: expect.objectContaining({ parts: [{ text: "work" }] }) },
    ]);
    expect(((await ended.json()) as TranscriptEntryList).items.map(({ position, type }) => [position, type])).toEqual([
      [0, "task-started"],
      [1, "message-chunk"],
      [2, "turn-ended"],
      [3, "task-ended"],
    ]);
  });

  it("lists the active agent sessions while the agent works, and none once its task ended", async () => {
    const { runtime, get, finish } = setup();
    const done = runtime.sendMessage("slow", {
      message: { messageId: "run-1/do/0/work", role: "ROLE_USER", parts: [{ text: "work" }] },
      metadata: { "dev.tendworks/runId": "run-1", "dev.tendworks/stepReference": "/do/0/work" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const working = await get("/sessions");
    finish();
    await done;
    const ended = await get("/sessions");

    expect(working.status).toBe(200);
    expect(await working.json()).toEqual({
      items: [{ kind: "run-step", agent: "slow", taskId: expect.any(String), status: "working", startedAt: expect.any(String), run: "run-1", step: "/do/0/work" }],
    });
    expect(await ended.json()).toEqual({ items: [] });
  });

  it("answers 404 for a task it does not know", async () => {
    const response = await setup().get("/tasks/unknown/transcript");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ title: "Task not found" });
  });
});

describe("agent runtime API: following a transcript live (scripted ACP agent)", () => {
  function setup(script: AgentScript = { delayMs: 300 }, sandboxes: Sandboxes = scriptedSandboxes(script).api, stores = { store: createInMemoryTaskStore(), transcripts: createInMemoryTranscriptStore() }) {
    const harness = createClaudeCodeHarness({
      sandboxes,
      templates: (name) => (name === scriptedTemplate.metadata.name ? scriptedTemplate : undefined),
      credential: { kind: "api-key", value: "test-key" },
    });
    const runtime = createAgentRuntime({ profiles: [developer], harnesses: { "claude-code": harness }, ...stores });
    const api = createAgentRuntimeApi({ runtime });
    const stream = (taskId: string, lastEventId?: string) =>
      api.fetch(new Request(`http://worker.test/tasks/${taskId}/transcript/stream`, { headers: lastEventId === undefined ? {} : { "last-event-id": lastEventId } }));
    /** Starts a task and answers its id as soon as the runtime created it. */
    const start = async (message = request()) => {
      let created!: (taskId: string) => void;
      const taskId = new Promise<string>((resolve) => (created = resolve));
      const done = runtime.sendMessage("developer", message, { onTask: (task) => created(task.id) });
      return { taskId: await taskId, done };
    };
    return { runtime, stream, start, stores };
  }

  const entriesOf = (events: ServerSentEvent[]) => events.filter((event) => event.event === "entry").map((event) => JSON.parse(event.data) as TranscriptEntry);
  async function readAll(response: Response): Promise<ServerSentEvent[]> {
    const events: ServerSentEvent[] = [];
    for await (const event of readServerSentEvents(response.body!)) events.push(event);
    return events;
  }

  it("streams each entry while the agent works, then ends the stream when the task ended", async () => {
    const { stream, start, runtime } = setup();
    const { taskId, done } = await start();
    let settled = false;
    void done.then(() => (settled = true));

    const response = await stream(taskId);
    const events = readServerSentEvents(response.body!);
    const seen: ServerSentEvent[] = [];
    let settledAtToolCall: boolean | undefined;
    for await (const event of events) {
      seen.push(event);
      if (event.event === "entry" && (JSON.parse(event.data) as TranscriptEntry).type === "tool-call") settledAtToolCall = settled;
    }

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(settledAtToolCall).toBe(false);
    expect(seen.at(-1)).toEqual({ event: "end", data: "{}" });
    expect(seen.slice(0, -1).map((event) => event.id)).toEqual(seen.slice(0, -1).map((_, position) => String(position)));
    expect(entriesOf(seen)).toEqual(await runtime.transcript(taskId));
  });

  it("continues after the Last-Event-ID of a client that reconnects, without gaps or duplicates", async () => {
    const { stream, start, runtime } = setup();
    const { taskId, done } = await start();

    const first = await stream(taskId);
    const before: ServerSentEvent[] = [];
    for await (const event of readServerSentEvents(first.body!)) {
      before.push(event);
      if (before.length === 2) break;
    }
    const after = await readAll(await stream(taskId, before.at(-1)!.id));
    await done;

    expect([...entriesOf(before), ...entriesOf(after)]).toEqual(await runtime.transcript(taskId));
    expect(after[0]!.id).toBe("2");
  });

  it("serves a task that already ended whole, from the start or after a position", async () => {
    const { stream, start, runtime } = setup({});
    const { taskId, done } = await start();
    await done;
    const transcript = (await runtime.transcript(taskId))!;

    expect(entriesOf(await readAll(await stream(taskId)))).toEqual(transcript);
    expect(entriesOf(await readAll(await stream(taskId, "1")))).toEqual(transcript.slice(2));
    expect(await readAll(await stream(taskId, String(transcript.length - 1)))).toEqual([{ event: "end", data: "{}" }]);
  });

  it("keeps the stream of a task interrupted by a restart open until the task is resumed and ends", async () => {
    const sandboxes = scriptedSandboxes({ hang: "first" });
    const before = dyingWorker(sandboxes.api);
    const first = setup({}, before.api);
    const message = request();
    const { taskId } = await first.start(message);
    await vi.waitFor(() => expect(sandboxes.observed.prompts).toHaveLength(1));
    const seen = (await first.runtime.transcript(taskId))!;
    before.die();

    // A new worker on the same stores; the client reconnects to it before the task resumes.
    const second = setup({}, sandboxes.api, first.stores);
    const response = await second.stream(taskId, String(seen.at(-1)!.position));
    const resumed = second.runtime.sendMessage("developer", message);
    const after = await readAll(response);
    await resumed;

    expect([...seen, ...entriesOf(after)]).toEqual(await second.runtime.transcript(taskId));
    expect(entriesOf(after)[0]).toMatchObject({ position: seen.length, type: "task-resumed" });
    expect(after.at(-1)).toEqual({ event: "end", data: "{}" });
  });

  it("stops following when the client goes away", async () => {
    const { stream, start } = setup({ hang: true });
    const { taskId } = await start();

    const response = await stream(taskId);
    const reader = response.body!.getReader();
    await reader.read();

    await expect(reader.cancel()).resolves.toBeUndefined();
  });

  it("answers 404 for a task it does not know and 400 for a Last-Event-ID that is no position", async () => {
    const { stream, start } = setup({});
    const { taskId, done } = await start();
    await done;

    const unknown = await stream("unknown");
    const invalid = await stream(taskId, "soon");

    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ title: "Task not found" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ title: "Invalid Last-Event-ID" });
  });
});

describe("agent runtime API: chats", () => {
  type Chat = AgentRuntime.components["schemas"]["chat"];
  const assistant: AgentProfile.AgentProfile = {
    apiVersion: "tendworks.dev/v1",
    kind: "AgentProfile",
    metadata: { name: "assistant" },
    spec: { harness: "fake", fake: { message: "Hi", delaySeconds: 1 }, chat: {} },
  };

  function setup() {
    const turns: (() => void)[] = [];
    const runtime = createAgentRuntime({ profiles: [assistant, slow], sleep: () => new Promise<void>((resolve) => turns.push(resolve)) });
    const api = createAgentRuntimeApi({ runtime });
    const call = (method: string, path: string, body?: unknown) =>
      api.fetch(
        new Request(`http://worker.test${path}`, {
          method,
          ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
        }),
      );
    /** Lets the running turn end and waits until the chat waits for the next message. */
    const finishTurn = async (chatId: string) => {
      await vi.waitFor(() => expect(turns.length).toBeGreaterThan(0));
      turns.shift()!();
      await vi.waitFor(async () => expect(((await (await call("GET", `/chats/${chatId}`)).json()) as Chat).status).toBe("input-required"));
    };
    return { call, finishTurn };
  }

  it("starts a chat, takes the next message after the turn, refuses one during a turn, and ends it", async () => {
    const { call, finishTurn } = setup();

    const started = await call("POST", "/chats", { agent: "assistant", text: "Hello" });
    const chat = (await started.json()) as Chat;
    const during = await call("POST", `/chats/${chat.id}/messages`, { text: "Still there?" });
    await finishTurn(chat.id);
    const next = await call("POST", `/chats/${chat.id}/messages`, { text: "Again" });
    const ended = await call("POST", `/chats/${chat.id}/end`);
    const after = await call("POST", `/chats/${chat.id}/messages`, { text: "Hello?" });

    expect(started.status).toBe(201);
    expect(chat).toMatchObject({ agent: "assistant", status: "working" });
    expect(during.status).toBe(409);
    expect(await during.json()).toMatchObject({ title: "Turn in progress" });
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({ id: chat.id, status: "working" });
    expect(ended.status).toBe(200);
    expect(await ended.json()).toMatchObject({ id: chat.id, status: "ended" });
    expect(after.status).toBe(409);
    expect(await after.json()).toMatchObject({ title: "Chat ended" });
  });

  it("lists and gets chats, and serves their transcripts by chat id", async () => {
    const { call, finishTurn } = setup();
    const chat = (await (await call("POST", "/chats", { agent: "assistant", text: "Hello" })).json()) as Chat;
    await finishTurn(chat.id);

    const list = (await (await call("GET", "/chats")).json()) as { items: Chat[] };
    const transcript = (await (await call("GET", `/tasks/${chat.id}/transcript`)).json()) as TranscriptEntryList;

    expect(list.items).toEqual([expect.objectContaining({ id: chat.id, status: "input-required", message: "Hi" })]);
    expect(transcript.items.map((entry) => entry.type)).toContain("input-required");
  });

  it("refuses a chat with an unknown profile, with a profile that does not allow chats, and an invalid body", async () => {
    const { call } = setup();

    const unknown = await call("POST", "/chats", { agent: "nobody", text: "Hello" });
    const notAllowed = await call("POST", "/chats", { agent: "slow", text: "Hello" });
    const invalid = await call("POST", "/chats", { agent: "assistant" });

    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ detail: "no such agent profile: nobody" });
    expect(notAllowed.status).toBe(400);
    expect(await notAllowed.json()).toMatchObject({ title: "Chat not allowed", detail: expect.stringContaining("spec.chat") });
    expect(invalid.status).toBe(400);
  });

  it("answers 404 for a chat it does not know, and 400 for a message without text", async () => {
    const { call } = setup();
    const chat = (await (await call("POST", "/chats", { agent: "assistant", text: "Hello" })).json()) as Chat;

    expect((await call("GET", "/chats/unknown")).status).toBe(404);
    expect((await call("POST", "/chats/unknown/messages", { text: "Hi" })).status).toBe(404);
    expect((await call("POST", "/chats/unknown/end")).status).toBe(404);
    expect((await call("POST", `/chats/${chat.id}/messages`, { text: "" })).status).toBe(400);
  });
});
