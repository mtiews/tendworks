import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ControlPlane } from "@tendworks/shared";
import { afterAll, describe, expect, it } from "vitest";
import { anonymous, client } from "./support/control-plane.js";
import { installation } from "./support/installation.js";

// The operator's backup and restore (scripts/backup.sh, scripts/restore.sh) against the stack
// under test: a backup while a run works, a reset with `down -v`, a restore and a start bring
// back runs, chats and transcripts, and the run that was working at backup time continues.

type Run = ControlPlane.components["schemas"]["run"];
type Chat = ControlPlane.components["schemas"]["chat"];

const script = (name: string) => fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url));
const composeFile = fileURLToPath(new URL("../../deploy/compose.yaml", import.meta.url));
const compose = (...args: string[]) => promisify(execFile)("docker", ["compose", "-f", composeFile, ...args], { timeout: 300_000 });
const bash = (name: string, ...args: string[]) =>
  promisify(execFile)("bash", [script(name), ...args], { timeout: 300_000 }).then(
    ({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }),
    (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, output: error.stdout + error.stderr }),
  );

async function until<T>(what: string, timeoutMs: number, check: () => Promise<T | undefined>): Promise<T> {
  for (const deadline = Date.now() + timeoutMs; ; ) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen in time`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const getRun = async (runId: string): Promise<Run | undefined> => (await client.GET("/runs/{runId}", { params: { path: { runId } } })).data;
const getChat = async (chatId: string): Promise<Chat | undefined> => (await client.GET("/chats/{chatId}", { params: { path: { chatId } } })).data;
const healthy = async () => ((await anonymous.GET("/status")).data?.status === "healthy" ? true : undefined);

describe("backing up and restoring the stack", () => {
  const directory = mkdtempSync(join(tmpdir(), "tend-backup-"));
  afterAll(async () => {
    rmSync(directory, { recursive: true, force: true });
    // Whatever happened, leave a running stack for the files after this one.
    await compose("up", "-d", "--wait");
  });

  it("brings back runs, chats and transcripts after a reset, and a run working at backup time continues", { timeout: 900_000 }, async () => {
    const { data: chat } = await client.POST("/chats", { body: { agent: "fake-assistant", text: "Hello" } });
    const chatId = chat!.id;
    await until("the chat's answer", 60_000, async () => ((await getChat(chatId))?.status === "input-required" ? true : undefined));
    await client.POST("/chats/{chatId}/end", { params: { path: { chatId } } });
    const { data: started } = await client.POST("/runs", { body: { workflow: "slow-agent", input: { issue: { number: 61, title: "Survive a restore" } } } });
    const runId = started!.id;
    const taskId = await until("the working step", 60_000, async () => {
      const step = (await getRun(runId))?.steps[0];
      return step?.status === "running" ? step.taskId : undefined;
    });

    // The backup stops the stack briefly and starts it again.
    const backup = await bash("backup.sh", "--output-dir", directory);
    expect(backup, backup.output).toMatchObject({ code: 0 });
    const files = readdirSync(directory);
    expect(files).toEqual([expect.stringMatching(new RegExp(`^${installation}-backup-\\d{8}T\\d{6}Z\\.tar\\.gz$`))]);
    const archive = join(directory, files[0]!);
    if (process.platform !== "win32") expect(statSync(archive).mode & 0o777).toBe(0o600);
    expect(await until("a healthy stack after the backup", 120_000, healthy)).toBe(true);
    // The store, the engine's state and the transcripts; never deploy/.env or session volumes.
    // Through stdin: GNU tar would take the drive letter of a Windows path for a remote host.
    const entries = spawnSync("tar", ["tzf", "-"], { input: readFileSync(archive), encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    expect(entries).toEqual(expect.arrayContaining(["manifest", "store.dump", `transcripts/${taskId}.jsonl`]));
    expect(entries.some((entry) => entry.startsWith("engine/"))).toBe(true);
    expect(entries.filter((entry) => !/^(manifest|store\.dump|engine\/.*|transcripts\/.*)$/.test(entry))).toEqual([]);

    // A restore never goes into a running stack, nor over existing data.
    const intoRunning = await bash("restore.sh", archive);
    expect(intoRunning.code).not.toBe(0);
    expect(intoRunning.output).toContain("is running");
    await compose("stop");
    const overData = await bash("restore.sh", archive);
    expect(overData.code).not.toBe(0);
    expect(overData.output).toContain("down -v");

    await compose("down", "-v");
    const restore = await bash("restore.sh", archive);
    expect(restore, restore.output).toMatchObject({ code: 0 });
    await compose("up", "-d", "--wait");

    expect(await getChat(chatId)).toMatchObject({ status: "ended", agent: "fake-assistant" });
    const { data: chatTranscript } = await client.GET("/chats/{chatId}/transcript", { params: { path: { chatId } } });
    expect(chatTranscript?.items.map((entry) => entry.type)).toEqual(["task-started", "message-chunk", "turn-ended", "input-required", "task-ended"]);
    const run = await until("the end of the restored run", 180_000, async () => {
      const read = await getRun(runId);
      return read?.status === "completed" || read?.status === "failed" ? read : undefined;
    });
    expect(run).toMatchObject({
      status: "completed",
      steps: [{ reference: "/do/0/implement", status: "completed", taskId }],
      // Its task was working at backup time, so the restored stack resumed it once (the
      // resumption after the backup's own restart is not part of the backup).
      output: { state: "TASK_STATE_COMPLETED", messages: 1, resumed: 1 },
    });
    const { data: runTranscript } = await client.GET("/runs/{runId}/tasks/{taskId}/transcript", { params: { path: { runId, taskId } } });
    expect(runTranscript?.items[0]).toMatchObject({ type: "task-started", agent: "fake-slow-developer" });
    expect(runTranscript?.items.at(-1)).toMatchObject({ type: "task-ended" });
  });
});
