import { describe, expect, it } from "vitest";
import { createAgentRuntimeClient, createControlPlaneApi, createInMemoryAgentRuntime, createInMemoryRuns, emptyConfiguration, type AgentRuntimePort } from "./index.js";

const profile = (name: string) => ({ apiVersion: "tendworks.dev/v1" as const, kind: "AgentProfile" as const, metadata: { name }, spec: { harness: "fake" as const } });

function setup(agentRuntime: AgentRuntimePort | "none" = createInMemoryAgentRuntime({ chatAgents: ["assistant"] })) {
  const api = createControlPlaneApi({
    probes: [],
    configuration: emptyConfiguration({ agentProfiles: [profile("developer"), profile("assistant")] }),
    runs: createInMemoryRuns(),
    ...(agentRuntime === "none" ? {} : { agentRuntime }),
    apiToken: "test-token",
  });
  return async () => {
    const response = await api.fetch(new Request("http://tend.test/agents", { headers: { authorization: "Bearer test-token" } }));
    return { status: response.status, body: (await response.json()) as { items?: { name: string; sessions: unknown[] }[]; title?: string } };
  };
}

describe("agents API: active agent sessions", () => {
  it("shows an active run step and an active chat under their profiles", async () => {
    const runtime = createInMemoryAgentRuntime({ chatAgents: ["assistant"] });
    const agents = setup(runtime);
    const step = runtime.startStep({ agent: "developer", run: "run-1", step: "/do/0/implement" });
    const chat = await runtime.startChat({ agent: "assistant", text: "Hello" });

    const { status, body } = await agents();

    expect(status).toBe(200);
    expect(body.items).toEqual([
      { name: "assistant", harness: "fake", sessions: [{ kind: "chat", agent: "assistant", taskId: chat.id, status: "working", startedAt: chat.startedAt, chat: chat.id }] },
      {
        name: "developer",
        harness: "fake",
        sessions: [{ kind: "run-step", agent: "developer", taskId: step.taskId, status: "working", startedAt: step.startedAt, run: "run-1", step: "/do/0/implement" }],
      },
    ]);
  });

  it("leaves out finished run steps and ended chats", async () => {
    const runtime = createInMemoryAgentRuntime({ chatAgents: ["assistant"] });
    const agents = setup(runtime);
    const step = runtime.startStep({ agent: "developer", run: "run-1", step: "/do/0/implement" });
    const chat = await runtime.startChat({ agent: "assistant", text: "Hello" });
    runtime.finishStep(step.taskId);
    await runtime.endChat(chat.id);

    const { body } = await agents();

    expect(body.items?.map(({ name, sessions }) => [name, sessions])).toEqual([
      ["assistant", []],
      ["developer", []],
    ]);
  });

  it("shows a chat that waits for the next message as active", async () => {
    const runtime = createInMemoryAgentRuntime({ chatAgents: ["assistant"] });
    const agents = setup(runtime);
    const chat = await runtime.startChat({ agent: "assistant", text: "Hello" });
    runtime.finishTurn(chat.id, "Hi");

    const { body } = await agents();

    expect(body.items?.find(({ name }) => name === "assistant")?.sessions).toEqual([expect.objectContaining({ kind: "chat", chat: chat.id, status: "input-required" })]);
  });

  it("lists the profiles without sessions when the agent runtime cannot be reached or is not configured", async () => {
    const unreachable = createAgentRuntimeClient({
      baseUrl: "http://worker.test",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });

    const withoutSessions = {
      status: 200,
      body: {
        items: [
          { name: "assistant", harness: "fake" },
          { name: "developer", harness: "fake" },
        ],
      },
    };
    expect(await setup(unreachable)()).toEqual(withoutSessions);
    expect(await setup("none")()).toEqual(withoutSessions);
  });
});

describe("agents API: chat settings and MCP servers", () => {
  it("shows a profile's chat settings with their defaults and its MCP servers, and leaves them out where the profile has none", async () => {
    const api = createControlPlaneApi({
      probes: [],
      configuration: emptyConfiguration({
        agentProfiles: [
          { apiVersion: "tendworks.dev/v1", kind: "AgentProfile", metadata: { name: "assistant" }, spec: { harness: "fake", chat: { idleMinutes: 10 }, mcp: ["tendworks"] } },
          { apiVersion: "tendworks.dev/v1", kind: "AgentProfile", metadata: { name: "chatty" }, spec: { harness: "fake", chat: {} } },
          profile("developer"),
        ],
      }),
      runs: createInMemoryRuns(),
      apiToken: "test-token",
    });

    const response = await api.fetch(new Request("http://tend.test/agents", { headers: { authorization: "Bearer test-token" } }));

    expect(await response.json()).toEqual({
      items: [
        { name: "assistant", harness: "fake", chat: { idleMinutes: 10 }, mcp: ["tendworks"] },
        { name: "chatty", harness: "fake", chat: { idleMinutes: 5 } },
        { name: "developer", harness: "fake" },
      ],
    });
  });
});
