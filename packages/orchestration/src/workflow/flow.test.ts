import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runWorkflow, validateWorkflow, type Step } from "../index.js";
import { EventQueue } from "./event-inbox.js";
import { InMemoryAgentTaskExecutor } from "./in-memory-agent-task-executor.js";

// Flow control of the interpreter: `switch`, the `then` flow directive and `listen`.

const header = `document: { dsl: '1.0.3', namespace: test, name: wf, version: '0.1.0' }\n`;
const workflow = (tasks: string) => validateWorkflow(parse(header + tasks));
const agentCall = (name: string, agent: string, extra = "") => `
  - ${name}:
      call: a2a
      with:
        method: message/send
        agentCard: { endpoint: agent://${agent} }
        parameters:
          message:
            parts: [{ kind: text, text: go }]${extra}`;

describe("switch", () => {
  const definition = () =>
    workflow(`
do:
  - route:
      switch:
        - big: { when: '\${ .size > 10 }', then: large }
        - otherwise: { then: small }
${agentCall("small", "small-agent", "\n      then: end")}
${agentCall("large", "large-agent")}
`);

  it("goes on with the task the first matching case names", async () => {
    const executor = new InMemoryAgentTaskExecutor();

    const run = await runWorkflow(definition(), { runId: "r", input: { size: 20 }, executor });

    expect(executor.requests.map((request) => request.agent)).toEqual(["large-agent"]);
    expect(run.steps.map((step) => [step.reference, step.status])).toEqual([
      ["/do/0/route", "completed"],
      ["/do/2/large", "completed"],
    ]);
  });

  it("takes the case without a condition when no other case matches, and passes its input through", async () => {
    const executor = new InMemoryAgentTaskExecutor();

    const run = await runWorkflow(
      workflow(`
do:
  - route:
      switch:
        - big: { when: '\${ .size > 10 }', then: exit }
        - otherwise: { then: continue }
      output:
        as: '\${ .size }'
`),
      { runId: "r", input: { size: 3 }, executor },
    );

    expect(run).toMatchObject({ status: "completed", output: 3 });
  });

  it("continues with the next task when no case matches", async () => {
    const executor = new InMemoryAgentTaskExecutor();

    const run = await runWorkflow(
      workflow(`
do:
  - route:
      switch:
        - big: { when: '\${ .size > 10 }', then: end }
${agentCall("next", "next-agent")}
`),
      { runId: "r", input: { size: 3 }, executor },
    );

    expect(executor.requests.map((request) => request.agent)).toEqual(["next-agent"]);
    expect(run.status).toBe("completed");
  });

  it("ends the workflow with the switch's input as output when the case says end", async () => {
    const executor = new InMemoryAgentTaskExecutor();

    const run = await runWorkflow(
      workflow(`
do:
  - route:
      switch:
        - done: { when: '\${ .merged }', then: end }
${agentCall("next", "next-agent")}
output:
  as: '\${ { merged: .merged } }'
`),
      { runId: "r", input: { merged: true }, executor },
    );

    expect(executor.requests).toEqual([]);
    expect(run).toEqual({ status: "completed", output: { merged: true }, steps: [{ name: "route", reference: "/do/0/route", status: "completed" }] });
  });
});

describe("then", () => {
  it("ends the workflow after a task whose then is end", async () => {
    const executor = new InMemoryAgentTaskExecutor();

    const run = await runWorkflow(workflow(`do:${agentCall("first", "a", "\n      then: end")}${agentCall("second", "b")}`), {
      runId: "r",
      input: {},
      executor,
    });

    expect(executor.requests.map((request) => request.agent)).toEqual(["a"]);
    expect(run.status).toBe("completed");
  });

  it("jumps to the named task of the same list, also backwards", async () => {
    let calls = 0;
    const executor = new InMemoryAgentTaskExecutor().agent("a", () => ({
      id: `t${++calls}`,
      status: { state: "TASK_STATE_COMPLETED" },
      metadata: { again: calls < 2 },
    }));

    const run = await runWorkflow(
      workflow(`
do:${agentCall("first", "a")}
  - again:
      switch:
        - yes: { when: '\${ .metadata.again }', then: first }
${agentCall("last", "b")}
`),
      { runId: "r", input: {}, executor },
    );

    expect(executor.requests.map((request) => request.agent)).toEqual(["a", "a", "b"]);
    expect(run.status).toBe("completed");
  });

  it("leaves the enclosing do task on exit and continues after it", async () => {
    const executor = new InMemoryAgentTaskExecutor();

    const run = await runWorkflow(
      workflow(`
do:
  - inner:
      do:${agentCall("first", "a", "\n      then: exit").replace(/\n/g, "\n      ")}${agentCall("skipped", "b").replace(/\n/g, "\n      ")}
${agentCall("after", "c")}
`),
      { runId: "r", input: {}, executor },
    );

    expect(executor.requests.map((request) => request.agent)).toEqual(["a", "c"]);
    expect(run.status).toBe("completed");
  });

  it("rejects a flow directive that names no task of its list", () => {
    expect(() => workflow(`do:${agentCall("first", "a", "\n      then: nowhere")}`)).toThrow(/\/do\/0\/first: then names no task 'nowhere'/);
  });
});

describe("listen", () => {
  const decided = (id: string, decision: string) => ({
    specversion: "1.0",
    id,
    source: "/tendworks/human-interaction",
    type: "dev.tendworks.approval.decided",
    runid: "r",
    data: { decision },
  });
  const definition = (read = "") =>
    workflow(`
do:
  - wait:
      listen:
        to:
          one:
            with: { type: dev.tendworks.approval.decided }${read}
`);

  it("waits for an event of the type and passes its data on", async () => {
    const events = new EventQueue();
    const steps: Step[] = [];

    const running = runWorkflow(definition(), {
      runId: "r",
      input: {},
      executor: new InMemoryAgentTaskExecutor(),
      events,
      recordStep: async (step) => void steps.push(step),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(steps).toEqual([{ name: "wait", reference: "/do/0/wait", status: "running" }]);
    events.deliver({ ...decided("e0", "approve"), type: "dev.tendworks.approval.requested" });
    events.deliver(decided("e1", "approve"));

    expect(await running).toMatchObject({ status: "completed", output: [{ decision: "approve" }] });
  });

  it("takes an event that arrived before the task listened, and each event only once", async () => {
    const events = new EventQueue();
    events.deliver(decided("e1", "reject"));
    events.deliver(decided("e1", "reject"));
    const twice = workflow(`
do:
  - first:
      listen: { to: { one: { with: { type: dev.tendworks.approval.decided } } } }
  - second:
      listen: { to: { one: { with: { type: dev.tendworks.approval.decided } } } }
`);

    const running = runWorkflow(twice, { runId: "r", input: {}, executor: new InMemoryAgentTaskExecutor(), events });
    let done = false;
    void running.then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(done).toBe(false);
    events.deliver(decided("e2", "approve"));

    expect(await running).toMatchObject({ status: "completed", output: [{ decision: "approve" }] });
  });

  it("passes the whole event on with read: envelope", async () => {
    const events = new EventQueue();
    events.deliver(decided("e1", "approve"));

    const run = await runWorkflow(definition("\n        read: envelope"), { runId: "r", input: {}, executor: new InMemoryAgentTaskExecutor(), events });

    expect(run.output).toEqual([decided("e1", "approve")]);
  });

  it("fails the step when the runtime delivers no events", async () => {
    const run = await runWorkflow(definition(), { runId: "r", input: {}, executor: new InMemoryAgentTaskExecutor() });

    expect(run).toMatchObject({ status: "failed", error: { instance: "/do/0/wait", title: "This runtime delivers no events" } });
  });

  it("rejects listening to more than one event", () => {
    expect(() =>
      workflow(`
do:
  - wait:
      listen: { to: { any: [{ with: { type: x } }] } }
`),
    ).toThrow(/\/do\/0\/wait\/listen\/to/);
  });
});
