import type { A2A, AgentProfile } from "@tendworks/shared";
import { describe, expect, it, vi } from "vitest";
import { scriptedSandboxes, scriptedTemplate, type AgentScript } from "./claude-code/scripted-acp-agent.stub.js";
import { createAgentRuntime, createClaudeCodeHarness, type AgentRuntime, type ClaudeCodeHarnessOptions } from "./index.js";

/*
 * The platform MCP server (ADR 0016) reaches only sessions whose profile lists it: the
 * runtime passes its address and the read-only token to the harness of those, and of no
 * other session, chat or workflow task alike.
 */

const READ_TOKEN = "read-token-for-the-mcp-server"; // betterleaks:allow test value
const MCP_URL = "http://platform.test:8080/mcp";
const MCP_NETWORK = "tendworks_platform-mcp";

const profile = (name: string, spec: Partial<AgentProfile.AgentProfile["spec"]> = {}): AgentProfile.AgentProfile => ({
  apiVersion: "tendworks.dev/v1",
  kind: "AgentProfile",
  metadata: { name },
  spec: { harness: "claude-code", sandbox: scriptedTemplate.metadata.name, ...spec },
});
const assistant = profile("assistant", { chat: {}, mcp: ["tendworks"] });
const chatter = profile("chatter", { chat: {} });
const developer = profile("developer");
const reader = profile("reader", { mcp: ["tendworks"] });

const say = (text: string): A2A.Message => ({ messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }] });

const platformMcpServer = { type: "http", name: "tendworks", url: MCP_URL, headers: [{ name: "Authorization", value: `Bearer ${READ_TOKEN}` }] };

function setup(script: AgentScript = {}, options: Partial<ClaudeCodeHarnessOptions> = { platformMcp: { url: MCP_URL, token: READ_TOKEN } }) {
  const sandboxes = scriptedSandboxes(script);
  const harness = createClaudeCodeHarness({
    sandboxes: sandboxes.api,
    templates: (name) => (name === scriptedTemplate.metadata.name ? scriptedTemplate : undefined),
    credential: { kind: "api-key", value: "test-key" },
    ...options,
  });
  const runtime = createAgentRuntime({ profiles: [assistant, chatter, developer, reader], harnesses: { "claude-code": harness }, idle: () => new Promise(() => {}) });
  return { runtime, sandboxes };
}

async function chatTurn(runtime: AgentRuntime, agent: string) {
  const { id } = await runtime.startChat(agent, say("Is an agent running right now?"));
  let chat;
  await vi.waitFor(async () => {
    chat = await runtime.getChat(id);
    expect(chat?.status).not.toBe("working");
  });
  return { id, chat: chat! };
}

describe("the platform MCP server in agent sessions", () => {
  it("is configured for a chat of a profile that lists it, with its address and the read-only token", async () => {
    const { runtime, sandboxes } = setup();

    const { chat } = await chatTurn(runtime, "assistant");

    expect(chat).toMatchObject({ status: "input-required" });
    expect(sandboxes.observed.newSession?.mcpServers).toEqual([platformMcpServer]);
  });

  it("is configured again when the chat's session resumes in a new sandbox", async () => {
    const { runtime, sandboxes } = setup();
    const { id } = await chatTurn(runtime, "assistant");
    for (const sandbox of sandboxes.sandboxes.values()) sandbox.kill(); // the adapter ends between turns

    await runtime.sendChatMessage(id, say("And now?"));
    await vi.waitFor(async () => expect((await runtime.getChat(id))?.status).toBe("input-required"));

    expect(sandboxes.created).toHaveLength(2);
    expect(sandboxes.observed.resumed.map((resumed) => resumed.mcpServers)).toEqual([[platformMcpServer]]);
  });

  it("is configured for a workflow task of a profile that lists it", async () => {
    const { runtime, sandboxes } = setup();

    const task = await runtime.sendMessage("reader", { message: say("Summarize the last runs") });

    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(sandboxes.observed.newSession?.mcpServers).toEqual([platformMcpServer]);
  });

  it.each([
    ["a chat", "chatter"],
    ["a workflow task", "developer"],
  ])("reaches %s of a profile that does not list it with neither its address nor the token", async (kind, agent) => {
    const { runtime, sandboxes } = setup();

    if (kind === "a chat") await chatTurn(runtime, agent);
    else await runtime.sendMessage(agent, { message: say("Implement the issue") });

    expect(sandboxes.observed.newSession?.mcpServers).toEqual([]);
    const everything = JSON.stringify({ attached: sandboxes.attached.map(({ request, files }) => ({ request, files: [...files] })), observed: sandboxes.observed, execs: sandboxes.execs });
    expect(everything).not.toContain(READ_TOKEN);
    expect(everything).not.toContain(MCP_URL);
  });

  it("puts the sandbox of a profile that lists it on the platform MCP server's network, and no other sandbox", async () => {
    const { runtime, sandboxes } = setup({}, { platformMcp: { url: MCP_URL, token: READ_TOKEN, network: MCP_NETWORK } });

    await chatTurn(runtime, "assistant");
    await runtime.sendMessage("reader", { message: say("Summarize the last runs") });
    await chatTurn(runtime, "chatter");
    await runtime.sendMessage("developer", { message: say("Implement the issue") });

    expect(sandboxes.created.map(({ networks }) => networks)).toEqual([[MCP_NETWORK], [MCP_NETWORK], [], []]);
  });

  it("never puts the read-only token into a sandbox's environment, not even for a profile that lists the server", async () => {
    const { runtime, sandboxes } = setup();

    await chatTurn(runtime, "assistant");

    expect(JSON.stringify(sandboxes.attached.map(({ request }) => request.env))).not.toContain(READ_TOKEN);
  });

  it("fails a session of a profile that lists it when the platform has none configured, naming what to set", async () => {
    const { runtime, sandboxes } = setup({}, {});

    const task = await runtime.sendMessage("reader", { message: say("Summarize the last runs") });

    expect(task.status.state).toBe("TASK_STATE_FAILED");
    expect(JSON.stringify(task.status.message)).toMatch(/TEND_PLATFORM_MCP_URL and TEND_API_READ_TOKEN/);
    expect(sandboxes.created).toEqual([]);
  });

  it("fails a session of a profile that lists it when the harness cannot connect to MCP servers over HTTP", async () => {
    const { runtime } = setup({ noMcp: true });

    const task = await runtime.sendMessage("reader", { message: say("Summarize the last runs") });

    expect(task.status.state).toBe("TASK_STATE_FAILED");
    expect(JSON.stringify(task.status.message)).toMatch(/cannot connect to MCP servers over HTTP/);
  });

  it("redacts the read-only token from what the harness reports", async () => {
    const { runtime } = setup({ reply: [`my token is ${READ_TOKEN}`], updates: [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: READ_TOKEN } }] });
    const { id } = await chatTurn(runtime, "assistant");

    const transcript = await runtime.transcript(id);

    expect(JSON.stringify(transcript)).not.toContain(READ_TOKEN);
  });
});
