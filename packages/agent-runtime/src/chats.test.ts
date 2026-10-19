import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { A2A, AgentProfile } from "@tendworks/shared";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { dyingWorker, scriptedSandboxes, scriptedTemplate, type AgentScript } from "./claude-code/scripted-acp-agent.stub.js";
import {
  ChatBusyError,
  ChatEndedError,
  ChatNotAllowedError,
  createAgentRuntime,
  createClaudeCodeHarness,
  createInMemoryTaskStore,
  createInMemoryTranscriptStore,
  InvalidRepositoryError,
  type AgentRuntime,
  type Chat,
  type Sandboxes,
  type TranscriptStore,
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

/** The chats' idle time, passing only when a test says so. */
function idleClock() {
  const waiting: { ms: number; resolve: () => void }[] = [];
  return {
    sleep: (ms: number) => new Promise<void>((resolve) => waiting.push({ ms, resolve })),
    /** Lets every idle time waited for so far pass. */
    pass() {
      for (const { resolve } of waiting.splice(0)) resolve();
    },
    waiting,
  };
}

/**
 * An agent runtime on the scripted agent; `platform` shares the store, transcripts and
 * sandboxes of an earlier process, `cancelGraceMs` is how long a cancelled turn gets to stop.
 */
function setup(
  script: AgentScript = { recall: true },
  platform: {
    exec?: Parameters<typeof scriptedSandboxes>[1];
    store?: ReturnType<typeof createInMemoryTaskStore>;
    transcripts?: TranscriptStore;
    sandboxes?: ReturnType<typeof scriptedSandboxes>;
    api?: Sandboxes;
    cancelGraceMs?: number;
  } = {},
) {
  const { store = createInMemoryTaskStore(), transcripts = createInMemoryTranscriptStore(), sandboxes = scriptedSandboxes(script, platform.exec), api = sandboxes.api } = platform;
  const idle = idleClock();
  const harness = createClaudeCodeHarness({
    ...(platform.cancelGraceMs === undefined ? {} : { cancelGraceMs: platform.cancelGraceMs }),
    sandboxes: api,
    templates: (name) => (name === scriptedTemplate.metadata.name ? scriptedTemplate : undefined),
    credential: { kind: "api-key", value: "test-key" },
  });
  const runtime = createAgentRuntime({ profiles: [assistant, developer], harnesses: { "claude-code": harness }, store, transcripts, idle: idle.sleep });
  return { runtime, sandboxes, store, transcripts, idle };
}

/** Resolves once the chat's turn ended and it waits for the next message. */
async function waiting(runtime: AgentRuntime, chatId: string, timeout = 1_000): Promise<Chat> {
  let chat: Chat | undefined;
  await vi.waitFor(
    async () => {
      chat = await runtime.getChat(chatId);
      expect(chat?.status).not.toBe("working");
    },
    { timeout },
  );
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

  it("removes the chat's sandbox after the profile's idle time and keeps its volumes", async () => {
    const { runtime, sandboxes, idle } = setup();
    const { id } = await runtime.startChat("assistant", say("Hello"));
    await waiting(runtime, id);

    await vi.waitFor(() => expect(idle.waiting.map(({ ms }) => ms)).toContain(5 * 60_000));
    idle.pass();

    await vi.waitFor(() => expect(sandboxes.sandboxes.size).toBe(0));
    expect([...sandboxes.volumes.keys()].sort()).toEqual([`${id}-session`, `${id}-workspace`]);
    expect(await runtime.getChat(id)).toMatchObject({ status: "input-required" });
  });

  it("resumes the same agent session in a new sandbox with the next message after the idle time, and records the resume", async () => {
    const { runtime, sandboxes, idle } = setup();
    const { id } = await runtime.startChat("assistant", say("My name is Ada."));
    await waiting(runtime, id);
    await vi.waitFor(() => expect(idle.waiting).not.toHaveLength(0));
    idle.pass();
    await vi.waitFor(() => expect(sandboxes.sandboxes.size).toBe(0));

    await runtime.sendChatMessage(id, say("What is my name?"));
    const chat = await waiting(runtime, id);

    expect(chat).toMatchObject({ status: "input-required", message: "I remember: My name is Ada. | What is my name?" });
    expect(sandboxes.created.map((created) => created.volumes)).toEqual([sandboxes.created[0]!.volumes, sandboxes.created[0]!.volumes]);
    expect(sandboxes.observed.resumed).toMatchObject([{ sessionId: "session-1" }]);
    expect(sandboxes.observed.prompts.at(-1)).toMatchObject({ sessionId: "session-1", prompt: [{ type: "text", text: "What is my name?" }] });
    const entries = (await runtime.transcript(id)) ?? [];
    for (const entry of entries) expect(isTranscriptEntry(entry), `${JSON.stringify(entry)}: ${JSON.stringify(isTranscriptEntry.errors)}`).toBe(true);
    expect(entries.filter((entry) => entry.type.startsWith("session-"))).toMatchObject([
      { type: "session-started", sessionId: "session-1" },
      { type: "session-resumed", sessionId: "session-1" },
    ]);
  });

  it("keeps the sandbox while the chat is answered within the idle time", async () => {
    const { runtime, sandboxes, idle } = setup();
    const { id } = await runtime.startChat("assistant", say("One"));
    await waiting(runtime, id);
    await vi.waitFor(() => expect(idle.waiting).not.toHaveLength(0));
    await runtime.sendChatMessage(id, say("Two"));
    await waiting(runtime, id);
    await vi.waitFor(() => expect(idle.waiting).toHaveLength(2));

    // The idle time of the first wait passes, the second has just begun.
    idle.waiting.shift()!.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sandboxes.sandboxes.size).toBe(1);
    expect(sandboxes.created).toHaveLength(1);
  });

  it("continues a turn a restart interrupted in the same agent session in a new sandbox; a follower misses no entry", async () => {
    // The first process starts the chat and dies while the agent works on its first turn.
    const sandboxes = scriptedSandboxes({ hang: "first", reply: ["Finished."] });
    const worker = dyingWorker(sandboxes.api);
    const before = setup({}, { sandboxes, api: worker.api });
    const { id } = await before.runtime.startChat("assistant", say("Write hello.txt"));
    await vi.waitFor(() => expect(sandboxes.observed.prompts).toHaveLength(1));
    const seen = (await before.runtime.transcript(id)) ?? [];
    worker.die();

    const after = setup({}, { sandboxes, store: before.store, transcripts: before.transcripts });
    const following = (await after.runtime.follow(id, { after: seen.at(-1)!.position }))!;
    await after.runtime.resumeChats();
    const chat = await waiting(after.runtime, id);
    const followed = [];
    for await (const entry of following) {
      followed.push(entry);
      if (entry.type === "input-required") break;
    }

    expect(chat).toMatchObject({ status: "input-required", message: "Finished." });
    expect(sandboxes.destroyed[0]).toBe("sandbox1");
    expect(sandboxes.created.map((created) => created.volumes)).toEqual([sandboxes.created[0]!.volumes, sandboxes.created[0]!.volumes]);
    expect(sandboxes.observed.prompts.at(-1)).toMatchObject({ sessionId: "session-1", prompt: [{ type: "text", text: expect.stringMatching(/continue/i) }] });
    const entries = (await after.runtime.transcript(id)) ?? [];
    expect(entries.map((entry) => entry.position)).toEqual(entries.map((_, index) => index));
    expect(followed).toEqual(entries.slice(seen.length));
    expect(entries.slice(seen.length).map((entry) => entry.type)).toEqual(expect.arrayContaining(["task-resumed", "session-resumed", "input-required"]));
    for (const entry of entries) expect(isTranscriptEntry(entry), `${JSON.stringify(entry)}: ${JSON.stringify(isTranscriptEntry.errors)}`).toBe(true);
  });

  it("removes the sandbox of a chat that waited during a restart once its idle time is over", async () => {
    const sandboxes = scriptedSandboxes({ recall: true });
    const worker = dyingWorker(sandboxes.api);
    const before = setup({}, { sandboxes, api: worker.api });
    const { id } = await before.runtime.startChat("assistant", say("Hello"));
    await waiting(before.runtime, id);
    worker.die();

    const after = setup({}, { sandboxes, store: before.store, transcripts: before.transcripts });
    await after.runtime.resumeChats();
    await vi.waitFor(() => expect(after.idle.waiting).toHaveLength(1));
    expect(after.idle.waiting[0]!.ms).toBeLessThanOrEqual(5 * 60_000);
    after.idle.pass();

    await vi.waitFor(() => expect(sandboxes.sandboxes.size).toBe(0));
    expect(sandboxes.volumes.size).toBe(2);
    await after.runtime.sendChatMessage(id, say("Still there?"));
    expect(await waiting(after.runtime, id)).toMatchObject({ message: "I remember: Hello | Still there?" });
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

  it("cancels a running turn: the agent stops, the chat stays open in the same session and takes the next message", async () => {
    const { runtime, sandboxes } = setup({ hang: "first", reply: ["Back again."] });
    const { id } = await runtime.startChat("assistant", say("Work forever"));
    await vi.waitFor(() => expect(sandboxes.observed.prompts).toHaveLength(1));

    const cancelled = await runtime.cancelChatTurn(id);
    await runtime.sendChatMessage(id, say("Something quick instead"));
    const next = await waiting(runtime, id);

    expect(sandboxes.observed.cancelled).toBe(true);
    expect(cancelled).toMatchObject({ id, status: "input-required" });
    expect(isChat(cancelled), JSON.stringify(isChat.errors)).toBe(true);
    expect(next).toMatchObject({ status: "input-required", message: "Back again." });
    expect(sandboxes.created).toHaveLength(1);
    expect(sandboxes.observed.prompts.map((prompt) => prompt.sessionId)).toEqual(["session-1", "session-1"]);
    const entries = (await runtime.transcript(id)) ?? [];
    expect(entries.filter((entry) => ["turn-ended", "input-required", "message-received"].includes(entry.type))).toMatchObject([
      { type: "turn-ended", reason: "cancelled" },
      { type: "input-required" },
      { type: "message-received" },
      { type: "turn-ended", reason: "completed" },
      { type: "input-required", message: "Back again." },
    ]);
  });

  it("gives up an agent that does not stop when cancelled; the next turn resumes the session in a new sandbox", async () => {
    const { runtime, sandboxes } = setup({ hang: "first", ignoreCancel: true, reply: ["Back again."] }, { cancelGraceMs: 10 });
    const { id } = await runtime.startChat("assistant", say("Work forever"));
    await vi.waitFor(() => expect(sandboxes.observed.prompts).toHaveLength(1));

    const cancelled = await runtime.cancelChatTurn(id);
    await runtime.sendChatMessage(id, say("Something quick instead"));
    const next = await waiting(runtime, id);

    expect(cancelled).toMatchObject({ status: "input-required" });
    expect(next).toMatchObject({ status: "input-required", message: "Back again." });
    expect(sandboxes.created).toHaveLength(2);
    expect(sandboxes.destroyed).toEqual(["sandbox1"]);
    expect(sandboxes.observed.resumed.map((resumed) => resumed.sessionId)).toEqual(["session-1"]);
  });

  it("changes nothing when cancelling while no turn runs, and refuses to cancel in an ended chat", async () => {
    const { runtime } = setup({ reply: ["Hi."] });
    const { id } = await runtime.startChat("assistant", say("Hello"));
    const idle = await waiting(runtime, id);

    expect(await runtime.cancelChatTurn(id)).toEqual(idle);
    await runtime.endChat(id);
    await expect(runtime.cancelChatTurn(id)).rejects.toBeInstanceOf(ChatEndedError);
    expect(await runtime.cancelChatTurn("unknown")).toBeUndefined();
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

/** A local bare repository with one commit on `main`, standing in for a public remote. */
function localRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "tend-chat-repository-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  mkdirSync(seed);
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity } });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  };
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(seed, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(seed, "README.md"), "hello\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "initial");
  git(seed, "push", "--quiet", origin, "main");
  return origin;
}

const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" };

/**
 * Runs the checkout command on the test host with `remote` standing in for the public URL,
 * then copies the checked-out files into the sandbox's workspace, where the agent sees them.
 */
function checkoutFrom(url: string, remote: string): Parameters<typeof scriptedSandboxes>[1] {
  return (request, sandbox) => {
    const workspace = mkdtempSync(join(tmpdir(), "tend-chat-workspace-"));
    const [command, ...args] = request.command.map((arg) => (arg === url ? remote : arg));
    const result = spawnSync(command!, args, { cwd: workspace, encoding: "utf8", env: { ...process.env, ...request.env } });
    for (const entry of readdirSync(workspace, { recursive: true, withFileTypes: true })) {
      const path = relative(workspace, join(entry.parentPath, entry.name)).replaceAll("\\", "/");
      if (entry.isFile() && !path.startsWith(".git/")) sandbox.write(`${request.workingDirectory}/${path}`, readFileSync(join(workspace, path)));
    }
    return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  };
}

const withRepository = (text: string, repository: string): A2A.Message => ({ ...say(text), metadata: { "dev.tendworks/workspace": { repository } } });

// The checkout runs git synchronously; on Windows, inside the parallel unit suite, that can take a while.
describe("chats with a repository as workspace", { timeout: 20_000 }, () => {
  const url = "https://git.example/acme/app.git";

  it("finds the public repository checked out in its workspace when the first turn starts, without any credential", async () => {
    const { runtime, sandboxes } = setup({ reply: ["Read it."] }, { exec: checkoutFrom(url, localRepository()) });

    const started = await runtime.startChat("assistant", withRepository("What is in the README?", url));
    const chat = await waiting(runtime, started.id, 15_000);

    expect(chat).toMatchObject({ status: "input-required", repository: url });
    expect(isChat(chat), JSON.stringify(isChat.errors)).toBe(true);
    expect(sandboxes.attached[0]?.files.get("/workspace/README.md")?.trim()).toBe("hello");
    expect(sandboxes.execs).toHaveLength(1);
    expect(sandboxes.execs[0]?.request).toMatchObject({ workingDirectory: "/workspace", env: {} });
  });

  it("has an empty workspace without a repository", async () => {
    const { runtime, sandboxes } = setup({ reply: ["Hi"] });

    const started = await runtime.startChat("assistant", say("Hello"));
    const chat = await waiting(runtime, started.id);

    expect(chat.repository).toBeUndefined();
    expect(sandboxes.execs).toEqual([]);
    expect([...sandboxes.attached[0]!.files.keys()].filter((path) => path.startsWith("/workspace/"))).toEqual([]);
  });

  it.each([
    ["not a URL", "acme/app"],
    ["an option", "--upload-pack=touch /tmp/x"],
    ["another scheme", "ssh://git.example/acme/app.git"],
    ["a local path", "file:///etc"],
    ["credentials in the URL", "https://user:token@git.example/acme/app.git"],
  ])("refuses %s as repository with the reason, before anything starts", async (_, repository) => {
    const { runtime, sandboxes } = setup();

    await expect(runtime.startChat("assistant", withRepository("Hello", repository))).rejects.toThrow(InvalidRepositoryError);
    await expect(runtime.startChat("assistant", withRepository("Hello", repository))).rejects.toThrow(/repository .*https/);
    expect(sandboxes.created).toEqual([]);
    expect(await runtime.listChats()).toEqual([]);
  });

  it("fails the chat with git's reason when the repository cannot be checked out", async () => {
    const { runtime, sandboxes } = setup({ reply: ["Hi"] }, { exec: checkoutFrom(url, join(tmpdir(), "tend-no-such-repository.git")) });

    const started = await runtime.startChat("assistant", withRepository("Hello", url));
    const chat = await waiting(runtime, started.id, 15_000);

    expect(chat).toMatchObject({ status: "failed", message: expect.stringMatching(/cannot check out https:\/\/git\.example\/acme\/app\.git/) });
    expect(sandboxes.attached).toEqual([]);
    expect(sandboxes.volumes.size).toBe(0);
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
