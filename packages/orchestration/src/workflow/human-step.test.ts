import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runWorkflow, validateWorkflow, type Step } from "../index.js";
import { EventQueue } from "./event-inbox.js";
import { InMemoryAgentTaskExecutor } from "./in-memory-agent-task-executor.js";
import { InMemoryHttpExecutor } from "./in-memory-http-executor.js";
import type { HttpResponse } from "./http-executor.js";

// The human step (`call: approval`, ADR 0024): asks the control plane, then waits for the
// decision of its approval request and continues or stops by the answer's outcome.

const header = `document: { dsl: '1.0.3', namespace: test, name: wf, version: '0.1.0' }\n`;
const definition = () =>
  validateWorkflow(
    parse(`${header}
do:
  - confirm:
      call: approval
      with:
        action: merge-pull-request
        question: '\${ "Merge \\(.pullRequest)?" }'
        links:
          - title: Pull request
            url: '\${ .pullRequest }'
        answers:
          - { label: Merged – continue, outcome: continue }
          - { label: Cancel, outcome: stop }
  - cleanUp:
      call: a2a
      with:
        method: message/send
        agentCard: { endpoint: agent://developer }
        parameters:
          message:
            parts: [{ kind: text, text: clean up }]
`),
  );
const runtime = { name: "tendworks", metadata: { controlPlaneUrl: "http://control-plane:8080" } };
const input = { pullRequest: "https://git.example/acme/app/pull/7" };

const pending = (id = "approval-1") => ({
  decision: "ask",
  approvalRequest: { id, status: "pending", answers: [{ label: "Merged – continue", outcome: "continue" }, { label: "Cancel", outcome: "stop" }] },
});
const decided = (approvalRequest: string, answer: string, outcome: string, id = `${approvalRequest}:approval.decided`) => ({
  specversion: "1.0",
  id,
  source: "/tendworks/human-interaction",
  type: "dev.tendworks.approval.decided",
  runid: "run-1",
  data: { approvalRequest, action: "merge-pull-request", answer, outcome },
});

function start(answer: HttpResponse, events = new EventQueue()) {
  const http = new InMemoryHttpExecutor().respond(() => answer);
  const executor = new InMemoryAgentTaskExecutor();
  const steps: Step[] = [];
  const running = runWorkflow(definition(), { runId: "run-1", input, executor, http, events, runtime, recordStep: async (step) => void steps.push(step) });
  return { http, executor, events, steps, running };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("the human step", () => {
  it("asks the control plane with its question, links and answers for the run's step", async () => {
    const { http, running } = start({ status: 200, content: { decision: "allow", policy: "trusted" } });
    await running;

    expect(http.requests).toEqual([
      {
        method: "POST",
        endpoint: "http://control-plane:8080/approval-requests",
        headers: {},
        body: {
          run: "run-1",
          step: "/do/0/confirm",
          action: "merge-pull-request",
          question: "Merge https://git.example/acme/app/pull/7?",
          links: [{ title: "Pull request", url: "https://git.example/acme/app/pull/7" }],
          answers: [
            { label: "Merged – continue", outcome: "continue" },
            { label: "Cancel", outcome: "stop" },
          ],
        },
      },
    ]);
  });

  it("proceeds at once when a policy allows the action", async () => {
    const { executor, running } = start({ status: 200, content: { decision: "allow", policy: "trusted" } });

    const run = await running;

    expect(run.status).toBe("completed");
    expect(run.steps.map((step) => [step.name, step.status])).toEqual([
      ["confirm", "completed"],
      ["cleanUp", "completed"],
    ]);
    expect(executor.requests).toHaveLength(1);
  });

  it("waits for the decision of its own request and continues with an answer that continues", async () => {
    const { executor, events, steps, running } = start({ status: 200, content: pending() });
    await settle();
    expect(steps.at(-1)).toMatchObject({ name: "confirm", status: "running" });

    events.deliver(decided("approval-other", "Cancel", "stop"));
    await settle();
    expect(steps.at(-1)).toMatchObject({ name: "confirm", status: "running" });
    events.deliver(decided("approval-1", "Merged – continue", "continue"));

    const run = await running;
    expect(run.status).toBe("completed");
    expect(run.steps.map((step) => step.name)).toEqual(["confirm", "cleanUp"]);
    expect(executor.requests).toHaveLength(1);
  });

  it("ends the workflow with an answer that stops, so the run completes without the tasks after it", async () => {
    const { executor, events, running } = start({ status: 200, content: pending() });

    events.deliver(decided("approval-1", "Cancel", "stop"));
    const run = await running;

    expect(run).toMatchObject({
      status: "completed",
      output: { decision: "ask", approvalRequest: "approval-1", answer: "Cancel", outcome: "stop" },
    });
    expect(run.steps.map((step) => step.name)).toEqual(["confirm"]);
    expect(executor.requests).toEqual([]);
  });

  it("goes on without waiting when its request was decided before, e.g. when the step is retried", async () => {
    const answered = { ...pending(), approvalRequest: { ...pending().approvalRequest, status: "decided", answer: "Cancel" } };
    const { running } = start({ status: 200, content: answered });

    expect(await running).toMatchObject({ status: "completed", output: { answer: "Cancel", outcome: "stop" } });
  });

  it("fails the step with the problem the control plane answered", async () => {
    const { running } = start({ status: 409, content: { title: "Run is not running", status: 409, detail: "run run-1 is completed" } });

    expect(await running).toMatchObject({
      status: "failed",
      error: { status: 409, instance: "/do/0/confirm", title: "Run is not running", detail: "run run-1 is completed" },
    });
  });

  it("fails the step when the runtime names no control plane", async () => {
    const run = await runWorkflow(definition(), { runId: "run-1", input, executor: new InMemoryAgentTaskExecutor(), http: new InMemoryHttpExecutor(), events: new EventQueue() });

    expect(run).toMatchObject({ status: "failed", error: { instance: "/do/0/confirm", title: "This runtime names no control plane" } });
  });
});
