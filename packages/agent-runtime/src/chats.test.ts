import { readFileSync } from "node:fs";
import type { A2A, AgentProfile } from "@tendworks/shared";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { scriptedSandboxes, scriptedTemplate, type AgentScript } from "./claude-code/scripted-acp-agent.stub.js";
import {
  ChatBusyError,
  ChatEndedError,
  ChatNotAllowedError,
  createAgentRuntime,
  createClaudeCodeHarness,
  createInMemoryTaskStore,
  type AgentRuntime,
  type Chat,
} from "./index.js";

const assistant: AgentProfile.AgentProfile = {
  apiVersion: "tendworks.dev/v1",
  kind: "AgentProfile",
  metadata: { name: "assistant" },
  spec: { harness: "claude-code", sandbox: scriptedTemplate.metadata.name, chat: {} },
};
const developer: AgentProfile.AgentProfile = { ...assistant, metadata: { name: "developer" }, spec: { harness: "claude-code", sandbox: scriptedTemplate.metadata.name } };

const say = (text: string): A2A.Message => ({ messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }] });

const contract = (file: string) => parse(readFileSync(new URL(`../../../contracts/${file}`, import.meta.url), "utf8")) as { $id: string };
const ajv = new Ajv2020({ strict: false, validateFormats: false }).addSchema(
  ["schemas/a2a.schema.yaml", "schemas/run.schema.yaml", "schemas/transcript-entry.schema.yaml", "schemas/chat.schema.yaml", "events/cloudevent.schema.yaml", "events/chat-events.schema.yaml"].map(contract),
);
const isChat = ajv.getSchema("https://tendworks.dev/schemas/v1/schemas/chat.schema.yaml#/$defs/chat")!;
const isTranscriptEntry = ajv.getSchema("https://tendworks.dev/schemas/v1/schemas/transcript-entry.schema.yaml")!;
const isEvent = (type: "chatStarted" | "chatEnded") => ajv.getSchema(`https://tendworks.dev/schemas/v1/events/chat-events.schema.yaml#/$defs/${type}`)!;

function setup(script: AgentScript = { recall: true }) {
  const sandboxes = scriptedSandboxes(script);
  const store = createInMemoryTaskStore();
  const harness = createClaudeCodeHarness({
    sandboxes: sandboxes.api,
    templates: (name) => (name === scriptedTemplate.metadata.name ? scriptedTemplate : undefined),
    credential: { kind: "api-key", value: "test-key" },
  });
  const runtime = createAgentRuntime({ profiles: [assistant, developer], harnesses: { "claude-code": harness }, store });
  return { runtime, sandboxes, store };
}

/** Resolves once the chat's turn ended and it waits for the next message. */
async function waiting(runtime: AgentRuntime, chatId: string): Promise<Chat> {
  let chat: Chat | undefined;
  await vi.waitFor(async () => {
    chat = await runtime.getChat(chatId);
    expect(chat?.status).not.toBe("working");
  });
  return chat!;
}

describe("chats (scripted ACP agent behind the fake sandbox)", () => {
  it("starts a chat that works on the first message, then waits for the next one", async () => {
    const { runtime } = setup({ reply: ["Hi, how can I help?"] });

    const started = await runtime.startChat("assistant", say("Hello"));
    const chat = await waiting(runtime, started.id);

    expect(started).toMatchObject({ agent: "assistant", status: "working" });
    expect(isChat(started), JSON.stringify(isChat.errors)).toBe(true);
    expect(chat).toMatchObject({ id: started.id, status: "input-required", message: "Hi, how can I help?" });
    expect(isChat(chat), JSON.stringify(isChat.errors)).toBe(true);
  });

  it("holds several turns in one agent session in which the agent remembers earlier turns", async () => {
    const { runtime, sandboxes } = setup();
    const { id } = await runtime.startChat("assistant", say("My name is Ada."));
    await waiting(runtime, id);

    await runtime.sendChatMessage(id, say("What is my name?"));
    const chat = await waiting(runtime, id);

    expect(chat).toMatchObject({ status: "input-required", message: "I remember: My name is Ada. | What is my name?" });
    expect(sandboxes.created).toHaveLength(1);
    expect(sandboxes.observed.sessions).toBe(1);
    expect(sandboxes.observed.prompts.map((prompt) => prompt.sessionId)).toEqual(["session-1", "session-1"]);
  });

  it("keeps the sandbox and the volumes between turns", async () => {
    const { runtime, sandboxes } = setup();
    const { id } = await runtime.startChat("assistant", say("Hello"));
    await waiting(runtime, id);

    expect(sandboxes.destroyed).toEqual([]);
    expect(sandboxes.deletedVolumes).toEqual([]);
  });

  it("records each message and the end of each turn in the transcript, in the entry schema", async () => {
    const { runtime } = setup({ reply: ["Done."] });
    const { id } = await runtime.startChat("assistant", say("First"));
    await waiting(runtime, id);
    await runtime.sendChatMessage(id, say("Second"));
    await waiting(runtime, id);

    const entries = (await runtime.transcript(id)) ?? [];

    for (const entry of entries) expect(isTranscriptEntry(entry), `${JSON.stringify(entry)}: ${JSON.stringify(isTranscriptEntry.errors)}`).toBe(true);
    expect(entries.filter((entry) => ["task-started", "message-received", "input-required"].includes(entry.type))).toMatchObject([
      { type: "task-started", agent: "assistant", message: { parts: [{ text: "First" }] } },
      { type: "input-required", message: "Done." },
      { type: "message-received", message: { parts: [{ text: "Second" }] } },
      { type: "input-required", message: "Done." },
    ]);
  });

  it("refuses a message while a turn runs", async () => {
    const { runtime } = setup({ delayMs: 200 });
    const { id } = await runtime.startChat("assistant", say("Take your time"));

    await expect(runtime.sendChatMessage(id, say("Are you done?"))).rejects.toBeInstanceOf(ChatBusyError);
    await waiting(runtime, id);
    await expect(runtime.sendChatMessage(id, say("Now?"))).resolves.toMatchObject({ status: "working" });
  });

  it("refuses the second of two messages sent at the same time", async () => {
    const { runtime } = setup();
    const { id } = await runtime.startChat("assistant", say("Hello"));
    await waiting(runtime, id);

    const results = await Promise.allSettled([runtime.sendChatMessage(id, say("One")), runtime.sendChatMessage(id, say("Two"))]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("adds up the cost of all turns", async () => {
    const { runtime } = setup({ cost: 0.25 });
    const { id } = await runtime.startChat("assistant", say("One"));
    expect((await waiting(runtime, id)).cost).toEqual({ amount: 0.25, currency: "USD" });

    await runtime.sendChatMessage(id, say("Two"));

    expect((await waiting(runtime, id)).cost).toEqual({ amount: 0.5, currency: "USD" });
  });

  it("ends a chat: no sandbox and no volume is left, the transcript stays readable", async () => {
    const { runtime, sandboxes } = setup();
    const { id } = await runtime.startChat("assistant", say("Hello"));
    await waiting(runtime, id);

    const ended = await runtime.endChat(id);

    expect(ended).toMatchObject({ id, status: "ended", endedAt: expect.any(String) });
    expect(isChat(ended), JSON.stringify(isChat.errors)).toBe(true);
    expect(sandboxes.sandboxes.size).toBe(0);
    expect(sandboxes.volumes.size).toBe(0);
    expect(((await runtime.transcript(id)) ?? []).at(-1)).toMatchObject({ type: "task-ended", state: "TASK_STATE_COMPLETED" });
  });

  it("ends a chat while a turn runs", async () => {
    const { runtime, sandboxes } = setup({ hang: true });
    const { id } = await runtime.startChat("assistant", say("Work forever"));
    await vi.waitFor(() => expect(sandboxes.observed.prompts).toHaveLength(1));

    const ended = await runtime.endChat(id);

    expect(ended?.status).toBe("ended");
    expect(sandboxes.sandboxes.size).toBe(0);
    expect(sandboxes.volumes.size).toBe(0);
    expect(await runtime.getChat(id)).toMatchObject({ status: "ended" });
  });

  it("refuses a message to a chat that has ended, and ending it again changes nothing", async () => {
    const { runtime } = setup();
    const { id } = await runtime.startChat("assistant", say("Hello"));
    await waiting(runtime, id);
    const ended = await runtime.endChat(id);

    await expect(runtime.sendChatMessage(id, say("Still there?"))).rejects.toBeInstanceOf(ChatEndedError);
    expect(await runtime.endChat(id)).toEqual(ended);
  });

  it("ends the follow stream of a chat only when the chat ends", async () => {
    const { runtime } = setup();
    const { id } = await runtime.startChat("assistant", say("Hello"));
    const following = (await runtime.follow(id))!;
    const types: string[] = [];
    for await (const entry of following) {
      types.push(entry.type);
      if (entry.type === "input-required" && !types.includes("message-received")) await runtime.sendChatMessage(id, say("Bye"));
      else if (entry.type === "input-required") void runtime.endChat(id);
    }

    expect(types.filter((type) => type === "input-required")).toHaveLength(2);
    expect(types.at(-1)).toBe("task-ended");
  });

  it("fails the chat and cleans up when the agent session fails", async () => {
    const { runtime, sandboxes } = setup({ crash: "fatal: no model" });
    const { id } = await runtime.startChat("assistant", say("Hello"));

    const chat = await waiting(runtime, id);

    expect(chat).toMatchObject({ status: "failed", message: expect.stringContaining("fatal: no model"), endedAt: expect.any(String) });
    expect(sandboxes.sandboxes.size).toBe(0);
    expect(sandboxes.volumes.size).toBe(0);
  });

  it("emits chat.started and chat.ended without any output of the agent", async () => {
    const { runtime, store } = setup({ reply: ["secret plans"] });
    const { id } = await runtime.startChat("assistant", say("Hello"));
    await waiting(runtime, id);
    await runtime.endChat(id);

    expect(store.published.map((event) => event.type)).toEqual(["dev.tendworks.chat.started", "dev.tendworks.chat.ended"]);
    expect(isEvent("chatStarted")(store.published[0]), JSON.stringify(isEvent("chatStarted").errors)).toBe(true);
    expect(isEvent("chatEnded")(store.published[1]), JSON.stringify(isEvent("chatEnded").errors)).toBe(true);
    expect(store.published[1]).toMatchObject({ subject: `chats/${id}`, data: { agent: "assistant", status: "ended" } });
    expect(store.published[0]!.traceparent).toBe(store.published[1]!.traceparent);
    expect(JSON.stringify(store.published)).not.toContain("secret plans");
  });

  it("refuses a chat with a profile that does not allow chats, with the reason", async () => {
    const { runtime, sandboxes } = setup();

    await expect(runtime.startChat("developer", say("Push to main"))).rejects.toThrow(ChatNotAllowedError);
    await expect(runtime.startChat("developer", say("Push to main"))).rejects.toThrow(/developer.*spec\.chat/);
    await expect(runtime.startChat("nobody", say("Hello"))).rejects.toThrow("no such agent profile: nobody");
    expect(sandboxes.created).toEqual([]);
  });

  it("lists chats, the most recently started first, and knows no chat for a task of a run", async () => {
    const { runtime } = setup();
    const first = await runtime.startChat("assistant", say("One"));
    await waiting(runtime, first.id);
    const second = await runtime.startChat("assistant", say("Two"));
    await waiting(runtime, second.id);
    const step = await runtime.sendMessage("developer", { message: say("Work") });

    expect((await runtime.listChats()).map((chat) => chat.id)).toEqual([second.id, first.id]);
    expect(await runtime.getChat(step.id)).toBeUndefined();
    expect(await runtime.sendChatMessage(step.id, say("Hi"))).toBeUndefined();
    expect(await runtime.endChat(step.id)).toBeUndefined();
    expect(await runtime.getChat("unknown")).toBeUndefined();
  });
});

describe("chats with the fake agent", () => {
  const fake: AgentProfile.AgentProfile = { ...assistant, metadata: { name: "echo" }, spec: { harness: "fake", fake: { message: "Hi" }, chat: { idleMinutes: 1 } } };

  it("answers every turn as configured and ends", async () => {
    const runtime = createAgentRuntime({ profiles: [fake] });
    const { id } = await runtime.startChat("echo", say("Hello"));
    expect(await waiting(runtime, id)).toMatchObject({ status: "input-required", message: "Hi" });
    await runtime.sendChatMessage(id, say("Again"));
    expect(await waiting(runtime, id)).toMatchObject({ status: "input-required", message: "Hi", cost: { amount: 0, currency: "USD" } });

    expect(await runtime.endChat(id)).toMatchObject({ status: "ended" });
  });

  it("fails the chat when the fake agent is configured to fail", async () => {
    const runtime = createAgentRuntime({ profiles: [{ ...fake, spec: { ...fake.spec, fake: { outcome: "failed", message: "not today" } } }] });
    const { id } = await runtime.startChat("echo", say("Hello"));

    expect(await waiting(runtime, id)).toMatchObject({ status: "failed", message: "not today" });
  });
});
