import { describe, expect, it } from "vitest";
import { createControlPlaneApi, createInMemoryApprovals, createInMemoryRuns, type ApprovalRequest, type ApprovalsPort, type HealthProbe } from "./index.js";

const pending: ApprovalRequest = {
  id: "approval-1",
  runId: "run-1",
  workflow: "develop-issue",
  action: "merge",
  pullRequest: "https://git.example/acme/app/pull/7",
  policy: "careful",
  question: "Merge https://git.example/acme/app/pull/7 for run run-1 of develop-issue?",
  status: "pending",
  createdAt: "2026-10-19T10:00:00.000Z",
};

function api(approvals?: ApprovalsPort, probes: HealthProbe[] = []) {
  return createControlPlaneApi({
    probes,
    configuration: { workflowNames: [], workflow: () => undefined, agentProfiles: [], triggerBindings: [], policies: [], pullRequestIntegrations: [] },
    apiToken: "test-token",
    runs: createInMemoryRuns(),
    ...(approvals ? { approvals } : {}),
  });
}

async function call(approvals: ApprovalsPort | undefined, path: string, init?: { method: string; body: unknown }) {
  const response = await api(approvals).fetch(
    new Request(`http://tend.test${path}`, init ? { method: init.method, body: JSON.stringify(init.body), headers: { "content-type": "application/json", authorization: "Bearer test-token" } } : {}),
  );
  return { status: response.status, body: await response.json() };
}

function recording(decide: ApprovalsPort["decide"] = async () => ({ decided: { ...pending, status: "approved" } })) {
  const calls: unknown[] = [];
  const port: ApprovalsPort = {
    async list(options) {
      calls.push(["list", options]);
      return [pending];
    },
    async decide(id, decision) {
      calls.push(["decide", id, decision]);
      return decide(id, decision);
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

  it("rejects an unknown status filter", async () => {
    const { status } = await call(recording().port, "/approval-requests?status=maybe");

    expect(status).toBe(400);
  });

  it("records a decision and answers with the decided request", async () => {
    const { port, calls } = recording();

    const { status, body } = await call(port, "/approval-requests/approval-1/decision", { method: "POST", body: { decision: "approve" } });

    expect(status).toBe(200);
    expect(body).toMatchObject({ id: "approval-1", status: "approved" });
    expect(calls).toEqual([["decide", "approval-1", "approve"]]);
  });

  it("rejects a decision that is neither approve nor reject", async () => {
    const { port, calls } = recording();

    const { status } = await call(port, "/approval-requests/approval-1/decision", { method: "POST", body: { decision: "maybe" } });

    expect(status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("answers 404 for an unknown approval request", async () => {
    const { status, body } = await call(createInMemoryApprovals(), "/approval-requests/nope/decision", { method: "POST", body: { decision: "reject" } });

    expect(status).toBe(404);
    expect(body).toMatchObject({ title: "Approval request not found" });
  });

  it("answers 409 when the request was decided the other way", async () => {
    const { status, body } = await call(
      createInMemoryApprovals([{ ...pending, status: "rejected" }]),
      "/approval-requests/approval-1/decision",
      { method: "POST", body: { decision: "approve" } },
    );

    expect(status).toBe(409);
    expect(body).toMatchObject({ title: "Approval request already decided", detail: "approval request approval-1 was already rejected" });
  });

  it("answers 503 when no approval requests are wired", async () => {
    expect((await call(undefined, "/approval-requests")).status).toBe(503);
  });

  it("reports the number of pending approval requests in the platform status", async () => {
    const response = await api(createInMemoryApprovals([pending])).fetch(new Request("http://tend.test/status"));

    expect(await response.json()).toMatchObject({ status: "healthy", pendingApprovals: 1 });
  });

  it("leaves the number out of the platform status when approval requests cannot be read", async () => {
    const response = await api({ list: () => Promise.reject(new Error("down")), decide: async () => undefined }).fetch(new Request("http://tend.test/status"));

    expect(await response.json()).not.toHaveProperty("pendingApprovals");
  });
});
