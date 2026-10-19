import type { A2A, AgentProfile, AgentRuntime } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { createAgentRuntimeApi } from "./api.js";
import { createAgentRuntime } from "./index.js";

type TranscriptEntryList = AgentRuntime.components["schemas"]["TranscriptEntryList"];

const slow: AgentProfile.AgentProfile = {
  apiVersion: "tendworks.dev/v1",
  kind: "AgentProfile",
  metadata: { name: "slow" },
  spec: { harness: "fake", fake: { delaySeconds: 1, message: "done" } },
};

const request = (): A2A.SendMessageRequest => ({ message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text: "work" }] } });

describe("agent runtime API", () => {
  function setup() {
    let finish!: () => void;
    const runtime = createAgentRuntime({ profiles: [slow], sleep: () => new Promise<void>((resolve) => (finish = resolve)) });
    const api = createAgentRuntimeApi({ runtime });
    const get = (path: string) => api.fetch(new Request(`http://worker.test${path}`));
    return { runtime, get, finish: () => finish() };
  }

  it("serves the transcript of a task while its agent still works, and all of it once the task ended", async () => {
    const { runtime, get, finish } = setup();
    let taskId!: string;
    const done = runtime.sendMessage("slow", request(), { onTask: (task) => void (taskId = task.id) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const working = await get(`/tasks/${taskId}/transcript`);
    finish();
    await done;
    const ended = await get(`/tasks/${taskId}/transcript`);

    expect(working.status).toBe(200);
    expect(((await working.json()) as TranscriptEntryList).items).toEqual([
      { position: 0, time: expect.any(String), type: "task-started", agent: "slow", message: expect.objectContaining({ parts: [{ text: "work" }] }) },
    ]);
    expect(((await ended.json()) as TranscriptEntryList).items.map(({ position, type }) => [position, type])).toEqual([
      [0, "task-started"],
      [1, "message-chunk"],
      [2, "turn-ended"],
      [3, "task-ended"],
    ]);
  });

  it("answers 404 for a task it does not know", async () => {
    const response = await setup().get("/tasks/unknown/transcript");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ title: "Task not found" });
  });
});
