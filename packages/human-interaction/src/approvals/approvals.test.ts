import { describe, expect, it } from "vitest";
import type { Policy } from "../policy.js";
import { createInMemoryApprovalStore } from "./approval-store.js";
import { createApprovals, type AskedRun, type AskApproval } from "./approvals.js";

const TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
const RUN: AskedRun = { id: "run-1", workflow: "release-app", status: "running", traceparent: TRACEPARENT };

const question: AskApproval = {
  run: "run-1",
  step: "/do/1/confirm",
  action: "deploy",
  question: "Deploy release 1.4?",
  links: [{ title: "Release notes", url: "https://git.example/acme/app/releases/1.4" }],
  answers: [
    { label: "Deploy", outcome: "continue" },
    { label: "Cancel", outcome: "stop" },
  ],
};

const policy = (name: string, actions: Policy["spec"]["actions"], workflows?: NonNullable<Policy["spec"]["workflows"]>): Policy => ({
  apiVersion: "tendworks.dev/v1",
  kind: "Policy",
  metadata: { name },
  spec: workflows ? { actions, workflows } : { actions },
});

function setup({ policies = [], runs = [RUN] }: { policies?: Policy[]; runs?: AskedRun[] } = {}) {
  const store = createInMemoryApprovalStore();
  let ids = 0;
  const approvals = createApprovals({
    store,
    policies,
    runs: async (id) => runs.find((run) => run.id === id),
    now: () => new Date("2026-10-19T10:00:00.000Z"),
    newId: () => `approval-${++ids}`,
  });
  return { store, approvals };
}

const asked = async (approvals: ReturnType<typeof setup>["approvals"]) => {
  const outcome = await approvals.ask(question);
  if (!("approvalRequest" in outcome) || !outcome.approvalRequest) throw new Error(`expected a request, got ${JSON.stringify(outcome)}`);
  return outcome.approvalRequest;
};

describe("approvals: asking", () => {
  it("records a pending request with the step's question and tells the human, when no policy applies", async () => {
    const { store, approvals } = setup();

    const outcome = await approvals.ask(question);

    const request = {
      id: "approval-1",
      runId: "run-1",
      workflow: "release-app",
      step: "/do/1/confirm",
      action: "deploy",
      question: "Deploy release 1.4?",
      links: [{ title: "Release notes", url: "https://git.example/acme/app/releases/1.4" }],
      answers: [
        { label: "Deploy", outcome: "continue" },
        { label: "Cancel", outcome: "stop" },
      ],
      status: "pending",
      traceparent: TRACEPARENT,
      createdAt: "2026-10-19T10:00:00.000Z",
    };
    expect(outcome).toEqual({ decision: "ask", approvalRequest: request });
    expect(store.published).toEqual([
      expect.objectContaining({ type: "dev.tendworks.approval.requested", runid: "run-1", traceparent: TRACEPARENT, data: request }),
    ]);
  });

  it("names the policy that asks", async () => {
    const { approvals } = setup({ policies: [policy("careful", { deploy: "ask" })] });

    expect(await approvals.ask(question)).toMatchObject({ decision: "ask", policy: "careful", approvalRequest: { policy: "careful" } });
  });

  it("lets the step proceed without a request when a policy of the workflow allows the action", async () => {
    const { store, approvals } = setup({ policies: [policy("trusted", { deploy: "allow" }, ["release-app"])] });

    expect(await approvals.ask(question)).toEqual({ decision: "allow", policy: "trusted" });
    expect(await store.list()).toEqual([]);
    expect(store.published).toEqual([]);
  });

  it("returns the step's request again when the step asks again, decided or not", async () => {
    const { store, approvals } = setup();
    const first = await asked(approvals);

    expect(await approvals.ask(question)).toEqual({ decision: "ask", approvalRequest: first });
    await approvals.decide(first.id, "Deploy");
    expect(await approvals.ask(question)).toMatchObject({ approvalRequest: { id: first.id, status: "decided", answer: "Deploy" } });
    expect(store.published.filter((event) => event.type === "dev.tendworks.approval.requested")).toHaveLength(1);
  });

  it("refuses to ask for an unknown run or one that is not running", async () => {
    const { approvals } = setup({ runs: [{ ...RUN, id: "run-2", status: "completed" }] });

    expect(await approvals.ask(question)).toMatchObject({ refused: { reason: "unknown-run" } });
    expect(await approvals.ask({ ...question, run: "run-2" })).toMatchObject({ refused: { reason: "not-running" } });
  });

  it("refuses a question whose answers cannot be told apart", async () => {
    const { approvals } = setup();

    const outcome = await approvals.ask({ ...question, answers: [{ label: "Deploy", outcome: "continue" }, { label: "Deploy", outcome: "stop" }] });

    expect(outcome).toMatchObject({ refused: { reason: "invalid", detail: expect.stringContaining("Deploy") } });
  });
});

describe("approvals: deciding", () => {
  it("decides a pending request with one of its answers and tells the waiting run the answer's outcome", async () => {
    const { store, approvals } = setup();
    const request = await asked(approvals);

    const outcome = await approvals.decide(request.id, "Cancel");

    expect(outcome).toEqual({ decided: { ...request, status: "decided", answer: "Cancel", decidedAt: "2026-10-19T10:00:00.000Z" } });
    expect(store.published.at(-1)).toMatchObject({
      type: "dev.tendworks.approval.decided",
      source: "/tendworks/human-interaction",
      runid: "run-1",
      data: { approvalRequest: request.id, action: "deploy", answer: "Cancel", outcome: "stop" },
    });
  });

  it("refuses an answer the request does not offer", async () => {
    const { approvals } = setup();
    const request = await asked(approvals);

    expect(await approvals.decide(request.id, "Maybe")).toEqual({ unknownAnswer: request });
  });

  it("does not change a decided request and says so for another answer", async () => {
    const { approvals } = setup();
    const request = await asked(approvals);
    await approvals.decide(request.id, "Deploy");

    expect(await approvals.decide(request.id, "Deploy")).toMatchObject({ decided: { answer: "Deploy" } });
    expect(await approvals.decide(request.id, "Cancel")).toMatchObject({ conflict: { answer: "Deploy" } });
  });

  it("knows no unknown request", async () => {
    const { approvals } = setup();

    expect(await approvals.decide("nope", "Deploy")).toBeUndefined();
  });

  it("lists requests, also only the pending ones", async () => {
    const { approvals } = setup();
    const request = await asked(approvals);

    expect(await approvals.list({ status: "pending" })).toEqual([request]);
    await approvals.decide(request.id, "Cancel");
    expect(await approvals.list({ status: "pending" })).toEqual([]);
    expect(await approvals.list()).toHaveLength(1);
  });
});
