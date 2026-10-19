import type { A2A, AgentProfile } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { describeAgentTasks } from "./agent-tasks.suite.js";
import { createAgentRuntime, createInMemoryTaskStore } from "./index.js";

const profile = (name: string, fake: AgentProfile.FakeAgent = {}): AgentProfile.AgentProfile => ({
  apiVersion: "tendworks.dev/v1",
  kind: "AgentProfile",
  metadata: { name },
  spec: { harness: "fake", fake },
});

describeAgentTasks("fake agent", () => ({ agents: createAgentRuntime({ profiles: [profile("echo")] }), agent: "echo" }));

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
    expect(task.metadata).toEqual({ "dev.tendworks/resumed": 1 });
    expect(await before.getTask(task.id)).toEqual(task);
  });
});
