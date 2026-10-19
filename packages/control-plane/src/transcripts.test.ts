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
