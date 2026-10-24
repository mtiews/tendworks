import { describe, expect, it } from "vitest";
import { createControlPlaneApi, createInMemoryApprovals, createInMemoryRuns, emptyConfiguration, type ApprovalRequest, type ApprovalsPort, type HealthProbe } from "./index.js";

const pending: ApprovalRequest = {
  id: "approval-1",
  runId: "run-1",
  workflow: "release-app",
  step: "/do/1/confirm",
  action: "deploy",
  policy: "careful",
  question: "Deploy release 1.4?",
  links: [{ title: "Release notes", url: "https://git.example/acme/app/releases/1.4" }],
  answers: [
    { label: "Deploy", outcome: "continue" },
    { label: "Cancel", outcome: "stop" },
  ],
  status: "pending",
  createdAt: "2026-10-19T10:00:00.000Z",
};

const question = {
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

function api(approvals?: ApprovalsPort, probes: HealthProbe[] = []) {
  return createControlPlaneApi({
    probes,
    configuration: emptyConfiguration(),
    apiToken: "test-token",
    runs: createInMemoryRuns(),
    ...(approvals ? { approvals } : {}),
  });
}

async function call(approvals: ApprovalsPort | undefined, path: string, init?: { method: string; body: unknown }) {
  const response = await api(approvals).fetch(
    new Request(`http://tend.test${path}`, init ? { method: init.method, body: JSON.stringify(init.body), headers: { "content-type": "application/json", authorization: "Bearer test-token" } } : { headers: { authorization: "Bearer test-token" } }),
  );
  return { status: response.status, body: await response.json() };
}

function recording(overrides: Partial<ApprovalsPort> = {}) {
  const calls: unknown[] = [];
  const port: ApprovalsPort = {
    async ask(asked) {
      calls.push(["ask", asked]);
      return overrides.ask ? overrides.ask(asked) : { decision: "ask", approvalRequest: pending };
    },
    async list(options) {
      calls.push(["list", options]);
      return [pending];
    },
    async get(id) {
      calls.push(["get", id]);
      return id === pending.id ? pending : undefined;
    },
    async decide(id, answer) {
      calls.push(["decide", id, answer]);
      return overrides.decide ? overrides.decide(id, answer) : { decided: { ...pending, status: "decided", answer } };
    },
  };
  return { port, calls };
}

describe("approval requests API", () => {
  it("lists approval requests, filtered by status", async () => {
    const { port, calls } = recording();

    const { status, body } = await call(port, "/approval-requests?status=pending");

    expect(status).toBe(200);
    expect(body).toEqual({ items: [pending] });
    expect(calls).toEqual([["list", { status: "pending" }]]);
  });

  it("shows one approval request, and 404 for an unknown one", async () => {
    const { port } = recording();

    expect(await call(port, "/approval-requests/approval-1")).toEqual({ status: 200, body: pending });
    expect(await call(port, "/approval-requests/nope")).toMatchObject({ status: 404, body: { title: "Approval request not found" } });
  });

  it("rejects an unknown status filter", async () => {
    const { status } = await call(recording().port, "/approval-requests?status=approved");

    expect(status).toBe(400);
  });

  it("decides a request with one of its answers and answers with the decided request", async () => {
    const { port, calls } = recording();

    const { status, body } = await call(port, "/approval-requests/approval-1/decision", { method: "POST", body: { answer: "Cancel" } });

    expect(status).toBe(200);
    expect(body).toMatchObject({ id: "approval-1", status: "decided", answer: "Cancel" });
    expect(calls).toEqual([["decide", "approval-1", "Cancel"]]);
  });

  it("rejects a decision without an answer", async () => {
    const { port, calls } = recording();

    const { status } = await call(port, "/approval-requests/approval-1/decision", { method: "POST", body: { decision: "approve" } });

    expect(status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("rejects an answer the request does not offer, naming the answers it does", async () => {
    const { status, body } = await call(createInMemoryApprovals([pending]), "/approval-requests/approval-1/decision", { method: "POST", body: { answer: "Maybe" } });

    expect(status).toBe(400);
    expect(body).toMatchObject({ title: "Unknown answer", detail: "approval request approval-1 offers no answer 'Maybe' (answers: 'Deploy', 'Cancel')" });
  });

  it("answers 404 for an unknown approval request", async () => {
    const { status, body } = await call(createInMemoryApprovals(), "/approval-requests/nope/decision", { method: "POST", body: { answer: "Cancel" } });

    expect(status).toBe(404);
    expect(body).toMatchObject({ title: "Approval request not found" });
  });

  it("answers 409 when the request was decided with another answer", async () => {
    const { status, body } = await call(
      createInMemoryApprovals([{ ...pending, status: "decided", answer: "Cancel" }]),
      "/approval-requests/approval-1/decision",
      { method: "POST", body: { answer: "Deploy" } },
    );

    expect(status).toBe(409);
    expect(body).toMatchObject({ title: "Approval request already decided", detail: "approval request approval-1 was already decided with 'Cancel'" });
  });

  it("answers 503 when no approval requests are wired", async () => {
    expect((await call(undefined, "/approval-requests")).status).toBe(503);
    expect((await call(undefined, "/approval-requests", { method: "POST", body: question })).status).toBe(503);
  });

  it("reports the number of pending approval requests in the platform status", async () => {
    const response = await api(createInMemoryApprovals([pending])).fetch(new Request("http://tend.test/status"));

    expect(await response.json()).toMatchObject({ status: "healthy", pendingApprovals: 1 });
  });

  it("leaves the number out of the platform status when approval requests cannot be read", async () => {
    const down = () => Promise.reject(new Error("down"));
    const response = await api({ ask: down, list: down, get: down, decide: down }).fetch(new Request("http://tend.test/status"));

    expect(await response.json()).not.toHaveProperty("pendingApprovals");
  });
});

describe("asking on behalf of a human step", () => {
  it("passes the question on and answers with the decision and the step's request", async () => {
    const { port, calls } = recording();

    const { status, body } = await call(port, "/approval-requests", { method: "POST", body: question });

    expect(status).toBe(200);
    expect(body).toEqual({ decision: "ask", approvalRequest: pending });
    expect(calls).toEqual([["ask", question]]);
  });

  it("answers allow without a request when a policy allows the action", async () => {
    const { port } = recording({ ask: async () => ({ decision: "allow", policy: "trusted" }) });

    expect(await call(port, "/approval-requests", { method: "POST", body: question })).toEqual({ status: 200, body: { decision: "allow", policy: "trusted" } });
  });

  it.each([
    ["no answers", { ...question, answers: [] }],
    ["an answer that neither continues nor stops", { ...question, answers: [{ label: "Later", outcome: "retry" }] }],
    ["an action that is no name", { ...question, action: "deploy it" }],
    ["a link that is no http URL", { ...question, links: [{ title: "Notes", url: "file:///etc/passwd" }] }],
    ["a field it does not know", { ...question, policy: "lax" }],
    ["no step", { ...question, step: "" }],
  ])("refuses a question with %s", async (_, body) => {
    const { port, calls } = recording();

    expect((await call(port, "/approval-requests", { method: "POST", body })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it.each([
    ["invalid", 400, "Invalid request"],
    ["unknown-run", 404, "Run not found"],
    ["not-running", 409, "Run is not running"],
  ] as const)("answers a refusal for reason %s with %i", async (reason, expected, title) => {
    const { port } = recording({ ask: async () => ({ refused: { reason, detail: "why" } }) });

    expect(await call(port, "/approval-requests", { method: "POST", body: question })).toEqual({ status: expected, body: { status: expected, title, detail: "why" } });
  });

  it("refuses the read-only token", async () => {
    const response = await createControlPlaneApi({
      probes: [],
      configuration: emptyConfiguration(),
      apiToken: "test-token",
      readToken: "read-only-token-0123",
      runs: createInMemoryRuns(),
      approvals: recording().port,
    }).fetch(new Request("http://tend.test/approval-requests", { method: "POST", body: JSON.stringify(question), headers: { authorization: "Bearer read-only-token-0123" } }));

    expect(response.status).toBe(403);
  });
});
