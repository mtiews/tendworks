import type { A2A, AgentProfile } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { describeAgentTasks } from "./agent-tasks.suite.js";
import { createFakeHarness } from "./fake-agent.js";
import { describeHarness } from "./harness.suite.js";
import { createAgentRuntime, createInMemoryTaskStore, createInMemoryTranscriptStore, type Harness, type HarnessSession, type HarnessTask, type Workspace } from "./index.js";

const profile = (name: string, fake: AgentProfile.FakeAgent = {}): AgentProfile.AgentProfile => ({
  apiVersion: "tendworks.dev/v1",
  kind: "AgentProfile",
  metadata: { name },
  spec: { harness: "fake", fake },
});

describeHarness("fake agent", () => ({
  harness: createFakeHarness({ sleep: async () => {} }),
  profile: profile("echo", { message: "Hello", artifacts: [{ name: "pull-request", url: "https://git.example/acme/app/pull/1" }] }),
  reply: "Hello",
  reported: { name: "pull-request", url: "https://git.example/acme/app/pull/1" },
}));

describeAgentTasks("fake agent", () => {
  const transcripts = createInMemoryTranscriptStore();
  return { agents: createAgentRuntime({ profiles: [profile("echo")], transcripts }), agent: "echo", transcripts };
});

const request = (parts: A2A.Part[]): A2A.SendMessageRequest => ({
  message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts },
});

describe("fake agent", () => {
  it("completes the task with an artifact echoing the message", async () => {
    const runtime = createAgentRuntime({ profiles: [profile("echo", { message: "done" })] });
    const parts: A2A.Part[] = [{ text: "Implement issue #7" }, { data: { issue: { number: 7 } } }];

    const task = await runtime.sendMessage("echo", request(parts));

    expect(task).toMatchObject({
      status: { state: "TASK_STATE_COMPLETED", message: { role: "ROLE_AGENT", parts: [{ text: "done" }] } },
      artifacts: [{ name: "echo", parts }],
    });
  });

  it("fails the task with the configured message", async () => {
    const runtime = createAgentRuntime({ profiles: [profile("grumpy", { outcome: "failed", message: "not today" })] });

    const task = await runtime.sendMessage("grumpy", request([{ text: "work" }]));

    expect(task.status).toMatchObject({ state: "TASK_STATE_FAILED", message: { parts: [{ text: "not today" }] } });
    expect(task.artifacts).toBeUndefined();
  });

  it("shows the task as working while the agent works", async () => {
    let finish!: () => void;
    const opened: string[] = [];
    const store = createInMemoryTranscriptStore();
    const runtime = createAgentRuntime({
      profiles: [profile("slow", { delaySeconds: 1 })],
      sleep: () => new Promise<void>((resolve) => (finish = resolve)),
      transcripts: { open: (taskId) => (opened.push(taskId), store.open(taskId)), read: (ref) => store.read(ref) },
    });

    const done = runtime.sendMessage("slow", request([{ text: "work" }]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const working = await runtime.getTask(opened[0]!);

    expect(working?.status.state).toBe("TASK_STATE_WORKING");
    finish();
    expect((await done).status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("fails the task when the profile's harness is not available in this runtime", async () => {
    const runtime = createAgentRuntime({
      profiles: [{ ...profile("developer"), spec: { harness: "claude-code", sandbox: "claude-code" } }],
    });

    const task = await runtime.sendMessage("developer", request([{ text: "work" }]));

    expect(task.status).toMatchObject({ state: "TASK_STATE_FAILED", message: { parts: [{ text: expect.stringContaining("claude-code") }] } });
  });

  it("works for the configured time before it answers", async () => {
    const waited: number[] = [];
    const runtime = createAgentRuntime({
      profiles: [profile("slow", { delaySeconds: 2.5 })],
      sleep: async (ms) => void waited.push(ms),
    });

    await runtime.sendMessage("slow", request([{ text: "work" }]));

    expect(waited).toEqual([2_500]);
  });

  it("resumes a task interrupted by a restart instead of starting it again", async () => {
    const store = createInMemoryTaskStore();
    const slow = [profile("slow", { delaySeconds: 10 })];
    const message = request([{ text: "work" }]);
    let clock = Date.parse("2026-10-18T10:00:00Z");
    const now = () => new Date(clock);

    // The first runtime starts the task and dies while the agent works.
    const before = createAgentRuntime({ profiles: slow, store, now, sleep: () => new Promise(() => {}) });
    void before.sendMessage("slow", message);
    await new Promise((resolve) => setTimeout(resolve, 0));

    clock += 3_000;
    const waited: number[] = [];
    const after = createAgentRuntime({ profiles: slow, store, now, sleep: async (ms) => void waited.push(ms) });
    const task = await after.sendMessage("slow", message);

    expect(waited).toEqual([7_000]);
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(task.history).toEqual([message.message]);
    expect(task.metadata).toMatchObject({ "dev.tendworks/resumed": 1, "dev.tendworks/transcript": expect.any(String) });
    expect(await before.getTask(task.id)).toEqual(task);
  });

  it("hands a resumed task's harness the session it kept before the interruption", async () => {
    const store = createInMemoryTaskStore();
    const developer: AgentProfile.AgentProfile = { ...profile("developer"), spec: { harness: "claude-code", sandbox: "claude-code" } };
    const message = request([{ text: "work" }]);
    const sessions: (HarnessSession | undefined)[] = [];

    // The first runtime's harness keeps its session and dies while the agent works.
    const dying: Harness = {
      async run(task, observer) {
        sessions.push(task.session);
        await observer.saveSession({ sessionId: "session-1" });
        return new Promise(() => {});
      },
    };
    void createAgentRuntime({ profiles: [developer], store, harnesses: { "claude-code": dying } }).sendMessage("developer", message);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const resuming: Harness = {
      async run(task) {
        sessions.push(task.session);
        return { state: "TASK_STATE_COMPLETED", message: "continued" };
      },
    };
    const task = await createAgentRuntime({ profiles: [developer], store, harnesses: { "claude-code": resuming } }).sendMessage("developer", message);

    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(sessions).toEqual([undefined, { sessionId: "session-1" }]);
  });
});

describe("agent runtime: workspaces", () => {
  const app: Workspace = { prepare: async () => ({ problem: "not used here" }) };
  const workspaces = (name: string) => (name === "app" ? app : undefined);
  const inWorkspace = (value: unknown): A2A.SendMessageRequest => ({
    message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text: "work" }], metadata: { "dev.tendworks/workspace": value } },
  });
  function recording() {
    const tasks: HarnessTask[] = [];
    const harness: Harness = {
      async run(task) {
        tasks.push(task);
        return { state: "TASK_STATE_COMPLETED", message: "done" };
      },
    };
    return { tasks, runtime: createAgentRuntime({ profiles: [profile("developer")], harnesses: { fake: harness }, workspaces }) };
  }

  it("hands the harness the configured workspace the message names, with the branch to work on", async () => {
    const { tasks, runtime } = recording();

    await runtime.sendMessage("developer", inWorkspace({ name: "app", branch: "tendworks/run-1" }));
    await runtime.sendMessage("developer", inWorkspace({ name: "app" }));
    await runtime.sendMessage("developer", request([{ text: "no workspace" }]));

    expect(tasks.map(({ workspace, branch }) => [workspace, branch])).toEqual([
      [app, "tendworks/run-1"],
      [app, undefined],
      [undefined, undefined],
    ]);
  });

  it("hands the harness a read-only workspace when the message asks for it with write: false", async () => {
    const { tasks, runtime } = recording();

    await runtime.sendMessage("developer", inWorkspace({ name: "app", write: false }));
    await runtime.sendMessage("developer", inWorkspace({ name: "app", write: true }));

    expect(tasks.map(({ workspace, readOnlyWorkspace }) => [workspace, readOnlyWorkspace])).toEqual([
      [app, true],
      [app, undefined],
    ]);
  });

  it("refuses a workspace that is not configured, or a malformed one, without starting the agent", async () => {
    const { tasks, runtime } = recording();

    const unknown = await runtime.sendMessage("developer", inWorkspace({ name: "ghost", branch: "tendworks/run-1" }));
    const malformed = await runtime.sendMessage("developer", inWorkspace({ repository: "https://git.example/acme/app.git" }));

    expect(unknown.status).toMatchObject({ state: "TASK_STATE_FAILED", message: { parts: [{ text: "no workspace 'ghost' is configured" }] } });
    expect(malformed.status).toMatchObject({ state: "TASK_STATE_FAILED", message: { parts: [{ text: expect.stringContaining("dev.tendworks/workspace") }] } });
    expect(tasks).toEqual([]);
  });
});
