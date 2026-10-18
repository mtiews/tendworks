import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runWorkflow, validateWorkflow } from "../index.js";
import { InMemoryAgentTaskExecutor } from "./in-memory-agent-task-executor.js";

const header = `document: { dsl: '1.0.3', namespace: test, name: wf, version: '0.1.0' }\n`;

function workflow(tasks: string) {
  return validateWorkflow(parse(header + tasks));
}

describe("runWorkflow", () => {
  it("hands each call task to its agent profile in declaration order", async () => {
    const executor = new InMemoryAgentTaskExecutor();
    const definition = workflow(`
do:
  - plan:
      call: a2a
      with:
        method: message/send
        agentCard: { endpoint: agent://planner }
        parameters:
          message:
            parts: [{ kind: text, text: make a plan }]
  - implement:
      call: a2a
      with:
        method: message/send
        agentCard: { endpoint: agent://developer }
        parameters:
          message:
            parts: [{ kind: text, text: build it }]
`);

    const run = await runWorkflow(definition, { runId: "run-1", input: {}, executor });

    expect(executor.requests).toEqual([
      {
        agent: "planner",
        request: {
          message: { messageId: "run-1/do/0/plan", role: "ROLE_USER", parts: [{ text: "make a plan" }] },
          metadata: { "dev.tendworks/runId": "run-1", "dev.tendworks/stepReference": "/do/0/plan" },
        },
      },
      {
        agent: "developer",
        request: {
          message: { messageId: "run-1/do/1/implement", role: "ROLE_USER", parts: [{ text: "build it" }] },
          metadata: { "dev.tendworks/runId": "run-1", "dev.tendworks/stepReference": "/do/1/implement" },
        },
      },
    ]);
    expect(run).toEqual({
      status: "completed",
      output: { id: "task-2", status: { state: "TASK_STATE_COMPLETED" } },
      steps: [
        { name: "plan", reference: "/do/0/plan", status: "completed", taskId: "task-1" },
        { name: "implement", reference: "/do/1/implement", status: "completed", taskId: "task-2" },
      ],
    });
  });

  it("passes the workflow input and each call's transformed output on to the next task", async () => {
    const executor = new InMemoryAgentTaskExecutor()
      .agent("planner", () => ({
        id: "t-plan",
        status: { state: "TASK_STATE_COMPLETED" },
        artifacts: [{ artifactId: "a1", parts: [{ data: { steps: ["write test", "make it pass"] } }] }],
      }));
    const definition = workflow(`
do:
  - plan:
      call: a2a
      with:
        method: message/send
        agentCard: { endpoint: agent://planner }
        parameters:
          message:
            parts:
              - kind: text
                text: '\${ "Plan issue #\\(.issue.number): \\(.issue.title)" }'
              - kind: data
                data: \${ .issue }
      output:
        as: '\${ { plan: .artifacts[0].parts[0].data.steps } }'
  - implement:
      call: a2a
      with:
        method: message/send
        agentCard: { endpoint: agent://developer }
        parameters:
          message:
            parts: [{ kind: data, data: '\${ { todo: .plan } }' }]
`);

    await runWorkflow(definition, {
      runId: "run-2",
      input: { issue: { number: 7, title: "Add login" } },
      executor,
    });

    expect(executor.parts).toEqual([
      [{ text: "Plan issue #7: Add login" }, { data: { number: 7, title: "Add login" } }],
      [{ data: { todo: ["write test", "make it pass"] } }],
    ]);
  });

  it("transforms the workflow input first and then each task's input", async () => {
    const executor = new InMemoryAgentTaskExecutor();
    const definition = workflow(`
input:
  from: .issue
do:
  - implement:
      input:
        from: '\${ { title: .title, raw: $workflow.input.issue.number } }'
      call: a2a
      with:
        method: message/send
        agentCard: { endpoint: agent://developer }
        parameters:
          message:
            parts: [{ kind: data, data: '\${ { task: ., input: $input } }' }]
`);

    await runWorkflow(definition, { runId: "r", input: { issue: { number: 7, title: "Add login" } }, executor });

    const task = { title: "Add login", raw: 7 };
    expect(executor.parts[0]).toEqual([{ data: { task, input: task } }]);
  });

  it("exports task output into the context and shapes the run output", async () => {
    const executor = new InMemoryAgentTaskExecutor()
      .agent("planner", () => ({ id: "t-plan", status: { state: "TASK_STATE_COMPLETED" } }))
      .agent("developer", () => ({ id: "t-dev", status: { state: "TASK_STATE_COMPLETED" } }));
    const definition = workflow(`
do:
  - plan:
      call: a2a
      with:
        method: message/send
        agentCard: { endpoint: agent://planner }
        parameters:
          message:
            parts: [{ kind: text, text: plan }]
      export:
        as: '\${ { planTask: .id } }'
  - implement:
      call: a2a
      with:
        method: message/send
        agentCard: { endpoint: agent://developer }
        parameters:
          message:
            parts: [{ kind: text, text: '\${ "follow plan " + $context.planTask }' }]
output:
  as: '\${ { plan: $context.planTask, implementation: .id } }'
`);

    const run = await runWorkflow(definition, { runId: "r", input: {}, executor });

    expect(executor.parts[1]).toEqual([{ text: "follow plan t-plan" }]);
    expect(run.output).toEqual({ plan: "t-plan", implementation: "t-dev" });
  });

  it("runs a nested do task in sequence and records it as a step around its subtasks", async () => {
    const executor = new InMemoryAgentTaskExecutor();
    const call = (agent: string) => `
            call: a2a
            with:
              method: message/send
              agentCard: { endpoint: agent://${agent} }
              parameters:
                message:
                  parts: [{ kind: text, text: '\${ "after " + (.id // "start") }' }]`;
    const definition = workflow(`
do:
  - build:
      do:
        - implement:${call("developer")}
        - review:${call("reviewer")}
      output:
        as: '\${ { reviewed: .id } }'
  - release:${call("releaser")}
`);

    const run = await runWorkflow(definition, { runId: "r", input: {}, executor });

    expect(executor.requests.map((r) => [r.agent, r.request.message.messageId, r.request.message.parts])).toEqual([
      ["developer", "r/do/0/build/do/0/implement", [{ text: "after start" }]],
      ["reviewer", "r/do/0/build/do/1/review", [{ text: "after task-1" }]],
      ["releaser", "r/do/1/release", [{ text: "after start" }]],
    ]);
    expect(run.steps).toEqual([
      { name: "build", reference: "/do/0/build", status: "completed" },
      { name: "implement", reference: "/do/0/build/do/0/implement", status: "completed", taskId: "task-1" },
      { name: "review", reference: "/do/0/build/do/1/review", status: "completed", taskId: "task-2" },
      { name: "release", reference: "/do/1/release", status: "completed", taskId: "task-3" },
    ]);
  });

  it("records each step when it starts and when it ends", async () => {
    const recorded: unknown[] = [];
    const executor = new InMemoryAgentTaskExecutor().agent("developer", () => {
      recorded.push("agent works");
      return { id: "t-dev", status: { state: "TASK_STATE_COMPLETED" } };
    });
    const definition = workflow(`
do:
  - build:
      do:
        - implement:
            call: a2a
            with:
              method: message/send
              agentCard: { endpoint: agent://developer }
              parameters:
                message:
                  parts: [{ kind: text, text: build it }]
`);

    await runWorkflow(definition, {
      runId: "r",
      input: {},
      executor,
      recordStep: async (step) => void recorded.push(structuredClone(step)),
    });

    expect(recorded).toEqual([
      { name: "build", reference: "/do/0/build", status: "running" },
      { name: "implement", reference: "/do/0/build/do/0/implement", status: "running" },
      "agent works",
      { name: "implement", reference: "/do/0/build/do/0/implement", status: "completed", taskId: "t-dev" },
      { name: "build", reference: "/do/0/build", status: "completed" },
    ]);
  });

  describe("when a call fails", () => {
    const definition = () =>
      workflow(`
do:
  - build:
      do:
        - implement:
            call: a2a
            with:
              method: message/send
              agentCard: { endpoint: agent://developer }
              parameters:
                message:
                  parts: [{ kind: text, text: build it }]
  - release:
      call: a2a
      with:
        method: message/send
        agentCard: { endpoint: agent://releaser }
        parameters:
          message:
            parts: [{ kind: text, text: ship it }]
`);

    it("marks the step, its parents and the run as failed and stops when the agent fails the task", async () => {
      const executor = new InMemoryAgentTaskExecutor().agent("developer", () => ({
        id: "t-dev",
        status: {
          state: "TASK_STATE_FAILED",
          message: { messageId: "m", role: "ROLE_AGENT", parts: [{ text: "tests do not pass" }] },
        },
      }));

      const run = await runWorkflow(definition(), { runId: "r", input: {}, executor });

      const error = {
        type: "https://serverlessworkflow.io/spec/1.0.0/errors/runtime",
        status: 500,
        instance: "/do/0/build/do/0/implement",
        title: "Agent task ended in state TASK_STATE_FAILED",
        detail: "tests do not pass",
      };
      expect(executor.requests.map((r) => r.agent)).toEqual(["developer"]);
      expect(run).toEqual({
        status: "failed",
        error,
        steps: [
          { name: "build", reference: "/do/0/build", status: "failed", error },
          { name: "implement", reference: "/do/0/build/do/0/implement", status: "failed", taskId: "t-dev", error },
        ],
      });
    });

    it("fails the run when the agent cannot be reached", async () => {
      const executor = new InMemoryAgentTaskExecutor().agent("developer", () => {
        throw new Error("agent runtime unavailable");
      });

      const run = await runWorkflow(definition(), { runId: "r", input: {}, executor });

      expect(run.status).toBe("failed");
      expect(run.error).toEqual({
        type: "https://serverlessworkflow.io/spec/1.0.0/errors/communication",
        status: 503,
        instance: "/do/0/build/do/0/implement",
        title: "Agent task could not be delivered",
        detail: "agent runtime unavailable",
      });
      expect(run.steps.map((s) => s.status)).toEqual(["failed", "failed"]);
    });
  });

  it.each([
    ["yields several values", "${ .items[] }", "must yield exactly one value, got 2"],
    ["cannot be evaluated", '${ .items + "x" }', ""],
  ])("fails the step with an expression error when an expression %s", async (_, expression, detail) => {
    const executor = new InMemoryAgentTaskExecutor();
    const definition = workflow(`
do:
  - implement:
      call: a2a
      with:
        method: message/send
        agentCard: { endpoint: agent://developer }
        parameters:
          message:
            parts: [{ kind: text, text: '${expression}' }]
`);

    const run = await runWorkflow(definition, { runId: "r", input: { items: ["a", "b"] }, executor });

    expect(executor.requests).toEqual([]);
    expect(run).toMatchObject({
      status: "failed",
      error: {
        type: "https://serverlessworkflow.io/spec/1.0.0/errors/expression",
        status: 400,
        instance: "/do/0/implement",
        title: "Runtime expression failed",
        detail: expect.stringContaining(detail),
      },
      steps: [{ name: "implement", status: "failed" }],
    });
  });

  it("fails the run with an expression error when the workflow output cannot be built", async () => {
    const definition = workflow(`
do:
  - implement:
      call: a2a
      with:
        method: message/send
        agentCard: { endpoint: agent://developer }
        parameters:
          message:
            parts: [{ kind: text, text: build it }]
output:
  as: '\${ .id + 1 }'
`);

    const run = await runWorkflow(definition, { runId: "r", input: {}, executor: new InMemoryAgentTaskExecutor() });

    expect(run).toMatchObject({
      status: "failed",
      error: { type: "https://serverlessworkflow.io/spec/1.0.0/errors/expression", instance: "/output/as" },
      steps: [{ name: "implement", status: "completed" }],
    });
  });
});
