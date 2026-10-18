import { readFileSync } from "node:fs";
import type { A2A } from "@tendworks/shared";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { AgentTasks } from "./agent-tasks.js";

export interface AgentTasksSuiteContext {
  agents: AgentTasks;
  /** An agent profile that completes a simple task. */
  agent: string;
}

const schema = parse(readFileSync(new URL("../../../contracts/schemas/a2a.schema.yaml", import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: false }).addSchema(schema);
const isTask = ajv.getSchema(`${schema.$id}#/$defs/task`)!;

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
