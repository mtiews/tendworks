import type { A2A, AgentProfile } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { describeAgentTasks } from "./agent-tasks.suite.js";
import { createFakeHarness } from "./fake-agent.js";
import { describeHarness } from "./harness.suite.js";
import { createAgentRuntime, createInMemoryTranscriptStore } from "./index.js";

const profile = (name: string, fake: AgentProfile.FakeAgent = {}): AgentProfile.AgentProfile => ({
  apiVersion: "tendworks.dev/v1",
  kind: "AgentProfile",
  metadata: { name },
  spec: { harness: "fake", fake },
});

describeHarness("fake agent", () => ({
  harness: createFakeHarness({ sleep: async () => {} }),
  profile: profile("echo", { message: "Hello" }),
  reply: "Hello",
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
});
