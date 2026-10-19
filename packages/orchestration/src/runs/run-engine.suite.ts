import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { AgentTaskExecutor } from "../workflow/agent-task-executor.js";
import { InMemoryAgentTaskExecutor } from "../workflow/in-memory-agent-task-executor.js";
import { InMemoryHttpExecutor } from "../workflow/in-memory-http-executor.js";
import type { RuntimeDescriptor } from "../workflow/interpreter.js";
import type { Workflow } from "@tendworks/shared";
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

    async function execute(
      agents: AgentTaskExecutor,
      {
        workflow = definition,
        http = new InMemoryHttpExecutor(),
        runtime,
      }: { workflow?: Workflow.Workflow; http?: InMemoryHttpExecutor; runtime?: RuntimeDescriptor } = {},
    ): Promise<Run> {
      const store = createInMemoryRunStore();
      const { engine, stop } = await setup(createRunActivities({ store, agents, http }));
      if (stop) stops.push(stop);
      const runId = crypto.randomUUID();
      await store.create({ id: runId, workflow: "two-steps", status: "pending", input: { goal: "ship" }, steps: [], createdAt: new Date().toISOString() });
      await engine.start({
        runId,
        workflow: "two-steps",
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        definition: workflow,
        input: { goal: "ship" },
        ...(runtime ? { runtime } : {}),
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

    it("makes the http calls of a run, with the runtime the run was started with", async () => {
      const http = new InMemoryHttpExecutor().respond(() => ({ status: 200, content: { merged: true } }));
      const workflow = validateWorkflow(
        parse(`
document: { dsl: '1.0.3', namespace: test, name: two-steps, version: '0.1.0' }
do:
  - merge:
      call: http
      with:
        method: post
        endpoint: '\${ $runtime.metadata.controlPlaneUrl + "/pull-requests/merge" }'
        body: { goal: '\${ .goal }' }
`),
      );

      const run = await execute(new InMemoryAgentTaskExecutor(), {
        workflow,
        http,
        runtime: { name: "tendworks", metadata: { controlPlaneUrl: "http://control-plane.test" } },
      });

      expect(run).toMatchObject({ status: "completed", output: { merged: true }, steps: [{ name: "merge", status: "completed" }] });
      expect(http.requests).toEqual([
        { method: "POST", endpoint: "http://control-plane.test/pull-requests/merge", headers: {}, body: { goal: "ship" } },
      ]);
    });
  });
}
