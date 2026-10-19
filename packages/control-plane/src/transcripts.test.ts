import { readServerSentEvents, type ServerSentEvent } from "@tendworks/platform";
import { describe, expect, it } from "vitest";
import {
  createAgentRuntimeClient,
  createControlPlaneApi,
  createInMemoryAgentRuntime,
  createInMemoryRuns,
  type AgentRuntimePort,
  type Run,
  type TranscriptEntry,
} from "./index.js";

const time = "2026-10-19T10:00:00.000Z";
const entries: TranscriptEntry[] = [
  { position: 0, time, type: "task-started", agent: "developer", message: { messageId: "m-1", role: "ROLE_USER", parts: [{ text: "build it" }] } },
  { position: 1, time, type: "message-chunk", text: "Working on it" },
];

const running: Run = {
  id: "run-1",
  workflow: "build",
  status: "running",
  input: {},
  steps: [{ name: "implement", reference: "/do/0/implement", status: "running", taskId: "task-1", transcript: "file:///t/task-1.jsonl", startedAt: time }],
  createdAt: time,
};

function setup(agentRuntime?: AgentRuntimePort) {
  const runs = createInMemoryRuns();
  runs.runs.set(running.id, running);
  const api = createControlPlaneApi({
    probes: [],
    configuration: { workflowNames: [], workflow: () => undefined, agentProfiles: [], triggerBindings: [], policies: [], pullRequestIntegrations: [] },
    runs,
    ...(agentRuntime ? { agentRuntime } : {}),
    apiToken: "test-token",
  });
  return async (path: string) => {
    const response = await api.fetch(new Request(`http://tend.test${path}`, { headers: { authorization: "Bearer test-token" } }));
    return { status: response.status, body: (await response.json()) as { items?: TranscriptEntry[]; title?: string } };
  };
}

describe("transcripts API", () => {
  it("serves the transcript of a running step's task through the agent runtime", async () => {
    const agentRuntime = createInMemoryAgentRuntime();
    agentRuntime.transcripts.set("task-1", entries);

    const { status, body } = await setup(agentRuntime)("/runs/run-1/tasks/task-1/transcript");

    expect(status).toBe(200);
    expect(body.items).toEqual(entries);
  });

  it("answers 404 for an unknown run, a task that is no step of the run and a task without a transcript", async () => {
    const get = setup(createInMemoryAgentRuntime());

    expect(await get("/runs/missing/tasks/task-1/transcript")).toMatchObject({ status: 404, body: { title: "Run not found" } });
    expect(await get("/runs/run-1/tasks/task-9/transcript")).toMatchObject({ status: 404, body: { title: "Task not found" } });
    expect(await get("/runs/run-1/tasks/task-1/transcript")).toMatchObject({ status: 404, body: { title: "Transcript not found" } });
  });

  it("answers 503 when the agent runtime cannot be reached or is not configured", async () => {
    const unreachable = createAgentRuntimeClient({ baseUrl: "http://worker.test", fetch: () => Promise.reject(new TypeError("fetch failed")) });

    expect(await setup(unreachable)("/runs/run-1/tasks/task-1/transcript")).toMatchObject({ status: 503, body: { title: "Agent runtime unavailable" } });
    expect(await setup()("/runs/run-1/tasks/task-1/transcript")).toMatchObject({ status: 503, body: { title: "Agent runtime unavailable" } });
  });
});

describe("agent runtime client", () => {
  it("reads a transcript through the agent runtime API and answers undefined for an unknown task", async () => {
    const client = createAgentRuntimeClient({
      baseUrl: "http://worker.test",
      fetch: async (request) =>
        new URL(request.url).pathname === "/tasks/task-1/transcript"
          ? Response.json({ items: entries })
          : Response.json({ title: "Task not found", status: 404 }, { status: 404 }),
    });

    expect(await client.transcript("task-1")).toEqual(entries);
    expect(await client.transcript("task-9")).toBeUndefined();
  });

  it("fails when the agent runtime answers with an error", async () => {
    const client = createAgentRuntimeClient({ baseUrl: "http://worker.test", fetch: async () => Response.json({ title: "Boom", status: 500 }, { status: 500 }) });

    await expect(client.transcript("task-1")).rejects.toThrow("agent runtime answered HTTP 500");
  });
});

describe("transcripts API: following a step live", () => {
  function streamSetup(agentRuntime?: AgentRuntimePort, token = "test-token") {
    const runs = createInMemoryRuns();
    runs.runs.set(running.id, running);
    const api = createControlPlaneApi({
      probes: [],
      configuration: { workflowNames: [], workflow: () => undefined, agentProfiles: [], triggerBindings: [], policies: [], pullRequestIntegrations: [] },
      runs,
      ...(agentRuntime ? { agentRuntime } : {}),
      apiToken: "test-token",
      readToken: "test-read-token",
    });
    return (path: string, lastEventId?: string) =>
      api.fetch(new Request(`http://tend.test${path}`, { headers: { authorization: `Bearer ${token}`, ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }) } }));
  }
  async function readAll(response: Response): Promise<ServerSentEvent[]> {
    const events: ServerSentEvent[] = [];
    for await (const event of readServerSentEvents(response.body!)) events.push(event);
    return events;
  }
  const entryEvent = (entry: TranscriptEntry): ServerSentEvent => ({ id: String(entry.position), event: "entry", data: JSON.stringify(entry) });
  const later: TranscriptEntry = { position: 2, time, type: "turn-ended", reason: "completed" };

  it("passes the agent runtime's stream through: entries so far, live ones, then the end", async () => {
    const agentRuntime = createInMemoryAgentRuntime();
    agentRuntime.transcripts.set("task-1", [...entries]);
    agentRuntime.running.add("task-1");

    const response = await streamSetup(agentRuntime, "test-read-token")("/runs/run-1/tasks/task-1/transcript/stream");
    const events = readAll(response);
    agentRuntime.append("task-1", later);
    agentRuntime.end("task-1");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(await events).toEqual([...entries, later].map(entryEvent).concat({ event: "end", data: "{}" }));
  });

  it("continues after Last-Event-ID", async () => {
    const agentRuntime = createInMemoryAgentRuntime();
    agentRuntime.transcripts.set("task-1", [...entries, later]);

    const events = await readAll(await streamSetup(agentRuntime)("/runs/run-1/tasks/task-1/transcript/stream", "0"));

    expect(events).toEqual([entryEvent(entries[1]!), entryEvent(later), { event: "end", data: "{}" }]);
  });

  it("refuses a Last-Event-ID that is no position, a stranger, an unknown run, task or transcript", async () => {
    const agentRuntime = createInMemoryAgentRuntime();
    const get = streamSetup(agentRuntime);

    const answers = await Promise.all([
      get("/runs/run-1/tasks/task-1/transcript/stream", "-1"),
      streamSetup(agentRuntime, "wrong-token")("/runs/run-1/tasks/task-1/transcript/stream"),
      get("/runs/missing/tasks/task-1/transcript/stream"),
      get("/runs/run-1/tasks/task-9/transcript/stream"),
      get("/runs/run-1/tasks/task-1/transcript/stream"),
    ]);

    expect(await Promise.all(answers.map(async (answer) => [answer.status, ((await answer.json()) as { title: string }).title]))).toEqual([
      [400, "Invalid Last-Event-ID"],
      [401, "Unauthorized"],
      [404, "Run not found"],
      [404, "Task not found"],
      [404, "Transcript not found"],
    ]);
  });

  it("answers 503 when the agent runtime cannot be reached or is not configured", async () => {
    const unreachable = createAgentRuntimeClient({ baseUrl: "http://worker.test", fetch: () => Promise.reject(new TypeError("fetch failed")) });

    expect((await streamSetup(unreachable)("/runs/run-1/tasks/task-1/transcript/stream")).status).toBe(503);
    expect((await streamSetup()("/runs/run-1/tasks/task-1/transcript/stream")).status).toBe(503);
  });
});

describe("agent runtime client: transcript streams", () => {
  it("asks the agent runtime API for the stream after a position and hands its body on", async () => {
    const asked: Request[] = [];
    const client = createAgentRuntimeClient({
      baseUrl: "http://worker.test",
      fetch: async (request) => {
        asked.push(request);
        return new URL(request.url).pathname === "/tasks/task-1/transcript/stream"
          ? new Response("event: end\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } })
          : Response.json({ title: "Task not found", status: 404 }, { status: 404 });
      },
    });

    const stream = await client.streamTranscript("task-1", { after: 4 });

    expect(await new Response(stream).text()).toBe("event: end\ndata: {}\n\n");
    expect(asked[0]!.headers.get("last-event-id")).toBe("4");
    expect(await client.streamTranscript("task-9", {})).toBeUndefined();
  });

  it("fails when the agent runtime answers with an error", async () => {
    const client = createAgentRuntimeClient({ baseUrl: "http://worker.test", fetch: async () => Response.json({ title: "Boom", status: 500 }, { status: 500 }) });

    await expect(client.streamTranscript("task-1", {})).rejects.toThrow("agent runtime answered HTTP 500");
  });
});
