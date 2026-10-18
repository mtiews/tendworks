import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { AgentTaskExecutor } from "../workflow/agent-task-executor.js";
import { InMemoryAgentTaskExecutor } from "../workflow/in-memory-agent-task-executor.js";
import { validateWorkflow } from "../workflow/validate.js";
import type { RunActivities } from "./execute-run.js";
import { createInMemoryRunStore } from "./in-memory-run-store.js";
import { createRunActivities } from "./run-activities.js";
import type { RunEngine } from "./run-engine.js";
import type { Run } from "./run-store.js";

export interface RunEngineSuiteContext {
  engine: RunEngine;
  stop?: () => Promise<void>;
}

/**
 * The behaviour every execution engine must show: it executes a handed-over run with
 * the given activities to its end. Runs against the durable engine and the in-process
 * fake.
 */
export function describeRunEngine(
  name: string,
  setup: (activities: RunActivities) => Promise<RunEngineSuiteContext> | RunEngineSuiteContext,
) {
  describe(`run engine: ${name}`, () => {
    const stops: (() => Promise<void>)[] = [];
    afterAll(async () => {
      await Promise.all(stops.map((stop) => stop()));
    });

    const definition = validateWorkflow(
      parse(`
document: { dsl: '1.0.3', namespace: test, name: two-steps, version: '0.1.0' }
do:
  - plan:
      call: a2a
      with:
        method: message/send
        agentCard: { endpoint: agent://planner }
        parameters:
          message:
            parts: [{ kind: text, text: '\${ .goal }' }]
  - build:
      call: a2a
      with:
        method: message/send
        agentCard: { endpoint: agent://developer }
        parameters:
          message:
            parts: [{ kind: text, text: build }]
`),
    );

    async function execute(agents: AgentTaskExecutor): Promise<Run> {
      const store = createInMemoryRunStore();
      const { engine, stop } = await setup(createRunActivities({ store, agents }));
      if (stop) stops.push(stop);
      const runId = crypto.randomUUID();
      await store.create({ id: runId, workflow: "two-steps", status: "pending", input: { goal: "ship" }, steps: [], createdAt: new Date().toISOString() });
      await engine.start({
        runId,
        workflow: "two-steps",
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        definition,
        input: { goal: "ship" },
      });
      for (let attempt = 0; attempt < 300; attempt++) {
        const run = (await store.get(runId))!;
        if (run.status === "completed" || run.status === "failed") return run;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("run did not finish in time");
    }

    it("executes every step of a run and completes it", async () => {
      const agents = new InMemoryAgentTaskExecutor();

      const run = await execute(agents);

      expect(run).toMatchObject({
        status: "completed",
        steps: [
          { name: "plan", status: "completed", taskId: "task-1" },
          { name: "build", status: "completed", taskId: "task-2" },
        ],
      });
      expect(agents.parts).toEqual([[{ text: "ship" }], [{ text: "build" }]]);
    });

    it("fails the run when an agent task cannot be delivered", async () => {
      const agents = new InMemoryAgentTaskExecutor().agent("developer", () => {
        throw new Error("no such agent profile: developer");
      });

      const run = await execute(agents);

      expect(run).toMatchObject({
        status: "failed",
        error: { instance: "/do/1/build", title: "Agent task could not be delivered" },
        steps: [{ name: "plan", status: "completed" }, { name: "build", status: "failed" }],
      });
      expect(run.error?.detail).toContain("no such agent profile: developer");
    });
  });
}
