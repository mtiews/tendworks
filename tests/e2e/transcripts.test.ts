import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ControlPlane } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { baseUrl, client, READ_TOKEN } from "./support/control-plane.js";

const composeFile = fileURLToPath(new URL("../../deploy/compose.yaml", import.meta.url));

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

/** The events of a transcript stream; reading stops once `until` is true for the events so far. */
async function streamEvents(response: Response, until: (events: StreamEvent[]) => boolean = () => false): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      buffer += chunk.value;
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop()!;
      for (const block of blocks) {
        const fields = Object.fromEntries(block.split("\n").filter((line) => !line.startsWith(":")).map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]));
        if (fields.data === undefined) continue;
        events.push({ ...(fields.id === undefined ? {} : { id: fields.id }), event: fields.event!, data: JSON.parse(fields.data) as unknown });
        if (until(events)) return events;
      }
    }
    return events;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
interface StreamEvent {
  id?: string;
  event: string;
  data: unknown;
}

const stream = (runId: string, taskId: string, lastEventId?: string) =>
  fetch(`${baseUrl}/runs/${runId}/tasks/${taskId}/transcript/stream`, {
    headers: { authorization: `Bearer ${READ_TOKEN}`, ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }) },
  });

describe("following running steps live on the compose stack", () => {
  it("streams a running fake agent step with the read-only token and resumes after Last-Event-ID", { timeout: 120_000 }, async () => {
    const { runId, taskId } = await runningStep("slow-agent");

    const first = await stream(runId, taskId);
    const started = await streamEvents(first, (events) => events.length === 1);
    const stillRunning = (await getRun(runId)).status;
    const rest = await streamEvents(await stream(runId, taskId, started[0]!.id));

    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(started).toEqual([{ id: "0", event: "entry", data: expect.objectContaining({ position: 0, type: "task-started" }) }]);
    expect(stillRunning).toBe("running");
    expect(rest.map((event) => event.id ?? event.event)).toEqual(["1", "2", "3", "end"]);
    expect(rest.map((event) => (event.data as { type?: string }).type)).toEqual(["message-chunk", "turn-ended", "task-ended", undefined]);
  });

  it("refuses to stream without a token", async () => {
    expect((await fetch(`${baseUrl}/runs/r-1/tasks/t-1/transcript/stream`)).status).toBe(401);
  });

  it.skipIf(!credentialSelected())(
    "tend run logs --follow shows what the scripted ACP agent does before its step finishes, and stops when the run ends",
    { timeout: 300_000 },
    async () => {
      const { runId } = await runningStep("restart-scripted");
      // The tend CLI as the server image ships it, against the stack's own API.
      const tend = spawn("docker", ["compose", "-f", composeFile, "exec", "-T", "server", "node", "apps/cli/dist/main.js", "--url", "http://localhost:8080", "--token", READ_TOKEN, "run", "logs", runId, "--follow"]);
      let stdout = "";
      let stderr = "";
      tend.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      tend.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const exited = new Promise<number | null>((resolve) => tend.on("close", resolve));

      await until("the agent's first tool call in the followed logs", 120_000, async () => (stdout.includes("Write before.txt") ? true : undefined));
      const whileFollowing = await getRun(runId);
      const exitCode = await exited;

      expect(whileFollowing.steps[0]?.status).toBe("running");
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(stdout).toMatch(/^== \/do\/0\/\S+ \(\S+\)\n\d\d:\d\d:\d\d {2}task {7}scripted-developer: /);
      expect(stdout).toMatch(/tool {7}Write before\.txt\n(.*\n)*.*tool {7}Write after\.txt\n/);
      expect(stdout.trimEnd().split("\n").at(-1)).toMatch(/ended {6}TASK_STATE_COMPLETED: /);
      expect((await getRun(runId)).status).toBe("completed");
    },
  );
});
