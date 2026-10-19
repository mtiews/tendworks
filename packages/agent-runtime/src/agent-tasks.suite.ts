import { readFileSync } from "node:fs";
import type { A2A } from "@tendworks/shared";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { COST, TRANSCRIPT, type AgentTasks } from "./agent-tasks.js";
import type { TranscriptStore } from "./transcripts/transcript-store.js";

export interface AgentTasksSuiteContext {
  agents: AgentTasks;
  /** An agent profile that completes a simple task. */
  agent: string;
  /** Where the agent runtime keeps transcripts. */
  transcripts: TranscriptStore;
}

const contract = (file: string) => parse(readFileSync(new URL(`../../../contracts/schemas/${file}`, import.meta.url), "utf8")) as { $id: string };
const schema = contract("a2a.schema.yaml");
const ajv = new Ajv2020({ strict: false, validateFormats: false }).addSchema([schema, contract("run.schema.yaml"), contract("transcript-entry.schema.yaml")]);
const isTask = ajv.getSchema(`${schema.$id}#/$defs/task`)!;
const isTranscriptEntry = ajv.getSchema("https://tendworks.dev/schemas/v1/schemas/transcript-entry.schema.yaml")!;

/**
 * The A2A boundary every agent runtime must keep, the fake and the real one alike,
 * so orchestration can rely on it without knowing which answers.
 */
export function describeAgentTasks(name: string, setup: () => Promise<AgentTasksSuiteContext> | AgentTasksSuiteContext) {
  describe(`A2A agent tasks: ${name}`, () => {
    const request = (messageId = crypto.randomUUID()): A2A.SendMessageRequest => ({
      message: { messageId, role: "ROLE_USER", parts: [{ text: "Say hello" }] },
      metadata: { "dev.tendworks/runId": "run-1", "dev.tendworks/stepReference": "/do/0/hello" },
    });

    it("answers a message with a task in a terminal state, in the A2A wire form", async () => {
      const { agents, agent } = await setup();

      const task = await agents.sendMessage(agent, request());

      expect(isTask(task), JSON.stringify(isTask.errors)).toBe(true);
      expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    });

    it("reports where the transcript of the agent session is kept and what the session cost", async () => {
      const { agents, agent, transcripts } = await setup();

      const task = await agents.sendMessage(agent, request());

      const ref = task.metadata?.[TRANSCRIPT];
      expect(ref).toEqual(expect.any(String));
      expect(task.metadata?.[COST]).toEqual({ amount: expect.any(Number), currency: "USD" });
      const entries = await transcripts.read(ref as string);
      expect(entries?.[0]).toMatchObject({ position: 0, type: "task-started", agent, message: { parts: [{ text: "Say hello" }] } });
      expect(entries?.at(-1)).toMatchObject({ type: "task-ended", state: "TASK_STATE_COMPLETED", cost: task.metadata?.[COST] });
    });

    it("records the transcript in the product-neutral entry schema, numbered by position", async () => {
      const { agents, agent, transcripts } = await setup();

      const task = await agents.sendMessage(agent, request());

      const entries = (await transcripts.read(task.metadata?.[TRANSCRIPT] as string)) ?? [];
      for (const entry of entries) expect(isTranscriptEntry(entry), `${JSON.stringify(entry)}: ${JSON.stringify(isTranscriptEntry.errors)}`).toBe(true);
      expect(entries.map((entry) => entry.position)).toEqual(entries.map((_, index) => index));
      expect(entries.map((entry) => entry.type)).toContain("message-chunk");
    });

    it("names the task and its transcript to the sender as soon as it exists, while the agent works", async () => {
      const { agents, agent, transcripts } = await setup();
      const created: { state: string; transcript: string | undefined; entries: number }[] = [];

      const task = await agents.sendMessage(agent, request(), {
        onTask: async (working) => {
          const transcript = working.metadata?.[TRANSCRIPT] as string | undefined;
          const entries = transcript === undefined ? [] : ((await transcripts.read(transcript)) ?? []);
          created.push({ state: working.status.state, transcript, entries: entries.length });
          expect(working.id).toEqual(expect.any(String));
        },
      });

      expect(created).toEqual([{ state: "TASK_STATE_WORKING", transcript: task.metadata?.[TRANSCRIPT], entries: expect.any(Number) }]);
    });

    it("delivers the task even when the sender fails to take note of it", async () => {
      const { agents, agent } = await setup();

      const task = await agents.sendMessage(agent, request(), { onTask: () => Promise.reject(new Error("store unavailable")) });

      expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    });

    it("returns the existing task when the same message is sent again", async () => {
      const { agents, agent } = await setup();
      const message = request();

      const [first, second] = await Promise.all([agents.sendMessage(agent, message), agents.sendMessage(agent, message)]);
      const third = await agents.sendMessage(agent, message);

      expect(second.id).toBe(first.id);
      expect(third.id).toBe(first.id);
    });

    it("finds a task by its id", async () => {
      const { agents, agent } = await setup();

      const task = await agents.sendMessage(agent, request());

      expect(await agents.getTask(task.id)).toEqual(task);
      expect(await agents.getTask("unknown-task")).toBeUndefined();
    });

    it("rejects a message to an agent profile that does not exist", async () => {
      const { agents } = await setup();

      await expect(agents.sendMessage("nobody", request())).rejects.toThrow("no such agent profile: nobody");
    });
  });
}
