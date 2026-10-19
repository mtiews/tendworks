import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ControlPlane } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { client } from "./support/control-plane.js";

type Run = ControlPlane.components["schemas"]["run"];
type TranscriptEntry = ControlPlane.components["schemas"]["TranscriptEntryList"]["items"][number];

const getRun = async (runId: string): Promise<Run> => {
  const { data, response } = await client.GET("/runs/{runId}", { params: { path: { runId } } });
  if (!data) throw new Error(`GET /runs/${runId} answered HTTP ${response.status}`);
  return data;
};

const transcript = async (runId: string, taskId: string): Promise<TranscriptEntry[]> => {
  const { data, response } = await client.GET("/runs/{runId}/tasks/{taskId}/transcript", { params: { path: { runId, taskId } } });
  if (!data) throw new Error(`GET /runs/${runId}/tasks/${taskId}/transcript answered HTTP ${response.status}`);
  return data.items;
};

/** Polls until `check` answers something, or fails after `timeoutMs`. */
async function until<T>(what: string, timeoutMs: number, check: () => Promise<T | undefined>): Promise<T> {
  for (const deadline = Date.now() + timeoutMs; ; ) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen in time`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Starts a run and waits until its first step is running and names its task. */
async function runningStep(workflow: string) {
  const { data: started, response } = await client.POST("/runs", { body: { workflow } });
  expect(response.status).toBe(201);
  const runId = started!.id;
  const step = await until("the step naming its task", 60_000, async () => {
    const run = await getRun(runId);
    expect(run.status).not.toMatch(/completed|failed/);
    return run.steps[0]?.taskId ? run.steps[0] : undefined;
  });
  return { runId, step, taskId: step.taskId! };
}

const ended = (runId: string, timeoutMs: number) =>
  until(`the end of run ${runId}`, timeoutMs, async () => {
    const run = await getRun(runId);
    return run.status === "completed" || run.status === "failed" ? run : undefined;
  });

/** The harness needs some credential selected; the stack gets it from the environment or deploy/.env. */
function credentialSelected(): boolean {
  if (process.env.TEND_CLAUDE_CODE_CREDENTIAL) return true;
  const env = fileURLToPath(new URL("../../deploy/.env", import.meta.url));
  return existsSync(env) && /^TEND_CLAUDE_CODE_CREDENTIAL=(oauth-token|api-key)\s*$/m.test(readFileSync(env, "utf8"));
}

describe("transcripts of running steps on the compose stack", () => {
  it("names the task of a running fake agent step and serves its transcript, then all of it", { timeout: 120_000 }, async () => {
    const { runId, step, taskId } = await runningStep("slow-agent");

    expect(step).toMatchObject({ status: "running", transcript: `file:///var/lib/tendworks/transcripts/${taskId}.jsonl` });
    expect(await transcript(runId, taskId)).toEqual([expect.objectContaining({ position: 0, type: "task-started", agent: "fake-slow-developer" })]);

    expect(await ended(runId, 60_000)).toMatchObject({ status: "completed" });
    expect((await transcript(runId, taskId)).map((entry) => entry.type)).toEqual(["task-started", "message-chunk", "turn-ended", "task-ended"]);
  });

  it.skipIf(!credentialSelected())(
    "serves what the scripted ACP agent did in its sandbox while it still works",
    { timeout: 300_000 },
    async () => {
      const { runId, taskId } = await runningStep("restart-scripted");

      const entries = await until("the agent's first tool call", 120_000, async () => {
        const read = await transcript(runId, taskId);
        return read.some((entry) => entry.type === "tool-call") ? read : undefined;
      });

      expect((await getRun(runId)).steps[0]?.status).toBe("running");
      expect(entries[0]).toMatchObject({ position: 0, type: "task-started", agent: "scripted-developer" });
      expect(entries).toContainEqual(expect.objectContaining({ type: "session-started" }));
      expect(entries).toContainEqual(expect.objectContaining({ type: "tool-call", title: "Write before.txt" }));
      expect(entries.map((entry) => entry.position)).toEqual(entries.map((_, index) => index));
      expect(await ended(runId, 240_000)).toMatchObject({ status: "completed" });
      expect((await transcript(runId, taskId)).at(-1)).toMatchObject({ type: "task-ended", state: "TASK_STATE_COMPLETED" });
    },
  );
});
