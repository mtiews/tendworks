import { readServerSentEvents } from "@tendworks/platform";
import { describe, expect, it } from "vitest";
import { createAgentRuntimeClient, createControlPlaneApi, createInMemoryAgentRuntime, createInMemoryRuns, emptyConfiguration, type AgentRuntimePort, type Chat, type TranscriptEntry } from "./index.js";

function setup(agentRuntime: AgentRuntimePort | "none" = createInMemoryAgentRuntime({ chatAgents: ["assistant"] })) {
  const api = createControlPlaneApi({
    probes: [],
    configuration: emptyConfiguration(),
    runs: createInMemoryRuns(),
    ...(agentRuntime === "none" ? {} : { agentRuntime }),
    apiToken: "test-token",
    readToken: "read-only-test-token",
  });
  const call = async (method: string, path: string, body?: unknown, token = "test-token") => {
    const response = await api.fetch(
      new Request(`http://tend.test${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, headers: response.headers, body: (await response.json()) as Chat & { items?: Chat[] | TranscriptEntry[]; title?: string; detail?: string } };
  };
  return { call, api };
}

describe("chats API", () => {
  it("starts a chat with a profile and serves it while the agent works", async () => {
    const { call } = setup();

    const started = await call("POST", "/chats", { agent: "assistant", text: "Hello" });
    const got = await call("GET", `/chats/${started.body.id}`);

    expect(started).toMatchObject({ status: 201, body: { agent: "assistant", status: "working" } });
    expect(started.headers.get("location")).toBe(`/chats/${started.body.id}`);
    expect(got).toMatchObject({ status: 200, body: { id: started.body.id, status: "working" } });
  });

  it("refuses a chat with a profile that does not allow chats, with the reason", async () => {
    const { call } = setup();

    const refused = await call("POST", "/chats", { agent: "developer", text: "Push to main" });

    expect(refused).toMatchObject({ status: 400, body: { title: "Chat not allowed", detail: expect.stringContaining("spec.chat") } });
  });

  it("starts a chat with a repository as its workspace", async () => {
    const { call } = setup();

    const started = await call("POST", "/chats", { agent: "assistant", text: "Hello", repository: "https://git.example/acme/app.git" });

    expect(started).toMatchObject({ status: 201, body: { repository: "https://git.example/acme/app.git" } });
    expect(await call("GET", `/chats/${started.body.id}`)).toMatchObject({ body: { repository: "https://git.example/acme/app.git" } });
  });

  it("refuses a chat with an invalid repository, with the agent runtime's reason", async () => {
    const { call } = setup();

    const refused = await call("POST", "/chats", { agent: "assistant", text: "Hello", repository: "ssh://git.example/acme/app.git" });
    const malformed = await call("POST", "/chats", { agent: "assistant", text: "Hello", repository: ["https://git.example/acme/app.git"] });

    expect(refused).toMatchObject({ status: 400, body: { title: "Invalid repository", detail: expect.stringContaining("https") } });
    expect(malformed).toMatchObject({ status: 400, body: { title: "Invalid request" } });
  });

  it("refuses a message while a turn runs with 409, and takes it once the turn ended", async () => {
    const agentRuntime = createInMemoryAgentRuntime({ chatAgents: ["assistant"] });
    const { call } = setup(agentRuntime);
    const { body: chat } = await call("POST", "/chats", { agent: "assistant", text: "Hello" });

    const during = await call("POST", `/chats/${chat.id}/messages`, { text: "Are you there?" });
    agentRuntime.finishTurn(chat.id, "Hi!");
    const after = await call("POST", `/chats/${chat.id}/messages`, { text: "What can you do?" });

    expect(during).toMatchObject({ status: 409, body: { title: "Turn in progress" } });
    expect(after).toMatchObject({ status: 200, body: { status: "working" } });
  });

  it("ends a chat; its transcript stays readable and it takes no further message", async () => {
    const agentRuntime = createInMemoryAgentRuntime({ chatAgents: ["assistant"] });
    const { call } = setup(agentRuntime);
    const { body: chat } = await call("POST", "/chats", { agent: "assistant", text: "Hello" });
    agentRuntime.finishTurn(chat.id, "Hi!");

    const ended = await call("POST", `/chats/${chat.id}/end`);
    const transcript = await call("GET", `/chats/${chat.id}/transcript`);
    const message = await call("POST", `/chats/${chat.id}/messages`, { text: "Hello?" });

    expect(ended).toMatchObject({ status: 200, body: { status: "ended" } });
    expect((transcript.body.items as TranscriptEntry[]).map((entry) => entry.type)).toEqual(["task-started", "message-chunk", "input-required", "task-ended"]);
    expect(message).toMatchObject({ status: 409, body: { title: "Chat ended" } });
  });

  it("lists chats with their status and cost", async () => {
    const agentRuntime = createInMemoryAgentRuntime({ chatAgents: ["assistant"] });
    const { call } = setup(agentRuntime);
    const { body: chat } = await call("POST", "/chats", { agent: "assistant", text: "Hello" });
    agentRuntime.finishTurn(chat.id, "Hi!", { amount: 0.02, currency: "USD" });

    const listed = await call("GET", "/chats", undefined, "read-only-test-token");

    expect(listed).toMatchObject({ status: 200, body: { items: [{ id: chat.id, status: "input-required", cost: { amount: 0.02, currency: "USD" } }] } });
  });

  it("streams a chat's transcript across turns until the chat ends, continuing after Last-Event-ID", async () => {
    const agentRuntime = createInMemoryAgentRuntime({ chatAgents: ["assistant"] });
    const { call, api } = setup(agentRuntime);
    const { body: chat } = await call("POST", "/chats", { agent: "assistant", text: "Hello" });
    agentRuntime.finishTurn(chat.id, "Hi!");
    await call("POST", `/chats/${chat.id}/end`);

    const response = await api.fetch(new Request(`http://tend.test/chats/${chat.id}/transcript/stream`, { headers: { authorization: "Bearer test-token", "last-event-id": "1" } }));
    const events = [];
    for await (const event of readServerSentEvents(response.body!)) events.push(event);

    expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(events.map((event) => event.id ?? event.event)).toEqual(["2", "3", "end"]);
  });

  it("cancels the running turn: the chat waits for the next message and takes it", async () => {
    const { call } = setup();
    const { body: chat } = await call("POST", "/chats", { agent: "assistant", text: "Work forever" });

    const cancelled = await call("POST", `/chats/${chat.id}/cancel`);
    const next = await call("POST", `/chats/${chat.id}/messages`, { text: "Something quick instead" });
    const transcript = await call("GET", `/chats/${chat.id}/transcript`);

    expect(cancelled).toMatchObject({ status: 200, body: { id: chat.id, status: "input-required" } });
    expect(next).toMatchObject({ status: 200, body: { status: "working" } });
    expect(transcript.body.items).toMatchObject([{ type: "task-started" }, { type: "turn-ended", reason: "cancelled" }, { type: "input-required" }, { type: "message-received" }]);
  });

  it("changes nothing when cancelling while no turn runs, and refuses to cancel in an ended chat", async () => {
    const agentRuntime = createInMemoryAgentRuntime({ chatAgents: ["assistant"] });
    const { call } = setup(agentRuntime);
    const { body: chat } = await call("POST", "/chats", { agent: "assistant", text: "Hello" });
    agentRuntime.finishTurn(chat.id, "Hi!");
    const idle = await call("GET", `/chats/${chat.id}`);

    expect(await call("POST", `/chats/${chat.id}/cancel`)).toEqual({ ...idle, headers: expect.anything() });
    await call("POST", `/chats/${chat.id}/end`);
    expect(await call("POST", `/chats/${chat.id}/cancel`)).toMatchObject({ status: 409, body: { title: "Chat ended" } });
  });

  it("serves two clients of one chat the same entries live, and takes the next message from either", async () => {
    const agentRuntime = createInMemoryAgentRuntime({ chatAgents: ["assistant"] });
    const { call, api } = setup(agentRuntime);
    const { body: chat } = await call("POST", "/chats", { agent: "assistant", text: "Hello" });
    const follow = async () => {
      const response = await api.fetch(new Request(`http://tend.test/chats/${chat.id}/transcript/stream`, { headers: { authorization: "Bearer read-only-test-token" } }));
      const seen: string[] = [];
      for await (const event of readServerSentEvents(response.body!)) seen.push(event.event === "entry" ? (JSON.parse(event.data) as TranscriptEntry).type : event.event!);
      return seen;
    };
    const first = follow();
    const second = follow();

    agentRuntime.finishTurn(chat.id, "Hi!");
    const fromFirst = await call("POST", `/chats/${chat.id}/messages`, { text: "From the first client" });
    agentRuntime.finishTurn(chat.id, "Hello first.");
    const fromSecond = await call("POST", `/chats/${chat.id}/messages`, { text: "From the second client" });
    agentRuntime.finishTurn(chat.id, "Hello second.");
    await call("POST", `/chats/${chat.id}/end`);

    expect([fromFirst.status, fromSecond.status]).toEqual([200, 200]);
    const expected = ["task-started", ...Array(3).fill(["message-chunk", "input-required", "message-received"]).flat().slice(0, -1), "task-ended", "end"];
    expect(await first).toEqual(expected);
    expect(await second).toEqual(expected);
  });

  it("answers 404 for a chat it does not know", async () => {
    const { call, api } = setup();

    expect(await call("GET", "/chats/unknown")).toMatchObject({ status: 404, body: { title: "Chat not found" } });
    expect(await call("POST", "/chats/unknown/messages", { text: "Hi" })).toMatchObject({ status: 404 });
    expect(await call("POST", "/chats/unknown/cancel")).toMatchObject({ status: 404 });
    expect(await call("POST", "/chats/unknown/end")).toMatchObject({ status: 404 });
    expect(await call("GET", "/chats/unknown/transcript")).toMatchObject({ status: 404 });
    expect((await api.fetch(new Request("http://tend.test/chats/unknown/transcript/stream", { headers: { authorization: "Bearer test-token" } }))).status).toBe(404);
  });

  it("answers 400 for an invalid body or Last-Event-ID", async () => {
    const { call, api } = setup();
    const { body: chat } = await call("POST", "/chats", { agent: "assistant", text: "Hello" });

    expect(await call("POST", "/chats", { agent: "assistant" })).toMatchObject({ status: 400 });
    expect(await call("POST", `/chats/${chat.id}/messages`, { text: "" })).toMatchObject({ status: 400 });
    const stream = await api.fetch(new Request(`http://tend.test/chats/${chat.id}/transcript/stream`, { headers: { authorization: "Bearer test-token", "last-event-id": "x" } }));
    expect(stream.status).toBe(400);
  });

  it("lets the read-only token read chats but not start, continue or end one", async () => {
    const { call } = setup();
    const { body: chat } = await call("POST", "/chats", { agent: "assistant", text: "Hello" });
    const read = "read-only-test-token";

    expect(await call("GET", `/chats/${chat.id}`, undefined, read)).toMatchObject({ status: 200 });
    expect(await call("POST", "/chats", { agent: "assistant", text: "Hello" }, read)).toMatchObject({ status: 403 });
    expect(await call("POST", `/chats/${chat.id}/messages`, { text: "Hi" }, read)).toMatchObject({ status: 403 });
    expect(await call("POST", `/chats/${chat.id}/cancel`, undefined, read)).toMatchObject({ status: 403 });
    expect(await call("POST", `/chats/${chat.id}/end`, undefined, read)).toMatchObject({ status: 403 });
  });

  it("answers 503 when the agent runtime cannot be reached or is not configured", async () => {
    const unreachable = createAgentRuntimeClient({ baseUrl: "http://worker.test", fetch: () => Promise.reject(new TypeError("fetch failed")) });

    for (const { call } of [setup(unreachable), setup("none")]) {
      expect(await call("GET", "/chats")).toMatchObject({ status: 503, body: { title: "Agent runtime unavailable" } });
      expect(await call("POST", "/chats", { agent: "assistant", text: "Hello" })).toMatchObject({ status: 503 });
      expect(await call("GET", "/chats/c-1")).toMatchObject({ status: 503 });
      expect(await call("POST", "/chats/c-1/messages", { text: "Hi" })).toMatchObject({ status: 503 });
      expect(await call("POST", "/chats/c-1/cancel")).toMatchObject({ status: 503 });
      expect(await call("POST", "/chats/c-1/end")).toMatchObject({ status: 503 });
      expect(await call("GET", "/chats/c-1/transcript")).toMatchObject({ status: 503 });
    }
  });
});
