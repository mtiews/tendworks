import { describe, expect, it } from "vitest";
import { approvalRequested } from "./approval-events.js";
import { createInMemoryApprovalStore, type ApprovalRequest } from "./approval-store.js";
import { createApprovals } from "./approvals.js";

const pending: ApprovalRequest = {
  id: "approval-1",
  runId: "run-1",
  workflow: "release-app",
  action: "deploy",
  policy: "careful",
  question: "Deploy it?",
  status: "pending",
  createdAt: "2026-10-19T10:00:00.000Z",
};

async function setup() {
  const store = createInMemoryApprovalStore();
  await store.open(pending, (request) => approvalRequested(request, request.createdAt));
  const approvals = createApprovals({ store, now: () => new Date("2026-10-19T10:05:00.000Z") });
  return { store, approvals };
}

describe("approvals", () => {
  it("approves a pending request and tells the waiting run", async () => {
    const { store, approvals } = await setup();

    const outcome = await approvals.decide("approval-1", "approve");

    expect(outcome).toEqual({ decided: { ...pending, status: "approved", decidedAt: "2026-10-19T10:05:00.000Z" } });
    expect(store.published.at(-1)).toMatchObject({
      type: "dev.tendworks.approval.decided",
      source: "/tendworks/human-interaction",
      runid: "run-1",
      data: { approvalRequest: "approval-1", decision: "approve", action: "deploy" },
    });
  });

  it("rejects a pending request", async () => {
    const { store, approvals } = await setup();

    expect(await approvals.decide("approval-1", "reject")).toMatchObject({ decided: { status: "rejected" } });
    expect(store.published.at(-1)).toMatchObject({ data: { decision: "reject" } });
  });

  it("does not change a decided request and says so for the other decision", async () => {
    const { approvals } = await setup();
    await approvals.decide("approval-1", "approve");

    expect(await approvals.decide("approval-1", "approve")).toMatchObject({ decided: { status: "approved" } });
    expect(await approvals.decide("approval-1", "reject")).toMatchObject({ conflict: { status: "approved" } });
  });

  it("lists requests, also only the pending ones", async () => {
    const { approvals } = await setup();

    expect(await approvals.list({ status: "pending" })).toEqual([pending]);
    await approvals.decide("approval-1", "reject");
    expect(await approvals.list({ status: "pending" })).toEqual([]);
    expect(await approvals.list()).toHaveLength(1);
  });
});
