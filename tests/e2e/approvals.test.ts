import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ControlPlane } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { client } from "./support/control-plane.js";

type Run = ControlPlane.components["schemas"]["run"];
type ApprovalRequest = ControlPlane.components["schemas"]["approvalRequest"];

const compose = (...args: string[]) =>
  promisify(execFile)("docker", ["compose", "-f", fileURLToPath(new URL("../../deploy/compose.yaml", import.meta.url)), ...args], {
    timeout: 120_000,
  });
const PR = "https://git.example/example/playground/pull/1"; // examples/config/agents/fake-pr-developer.md

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined); // the API may be restarting
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen in time`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function start(): Promise<string> {
  const { data, response } = await client.POST("/runs", { body: { workflow: "fake-develop-and-ask", input: { issue: { number: 15, title: "Ask first" } } } });
  expect(response.status).toBe(201);
  return data!.id;
}

const getRun = async (runId: string): Promise<Run | undefined> => (await client.GET("/runs/{runId}", { params: { path: { runId } } })).data;
const pendingApproval = (runId: string) =>
  waitFor<ApprovalRequest>(`approval request for run ${runId}`, async () =>
    (await client.GET("/approval-requests", { params: { query: { status: "pending" } } })).data?.items.find((item) => item.runId === runId),
  );
const ended = (runId: string) =>
  waitFor<Run>(`end of run ${runId}`, async () => {
    const run = await getRun(runId);
    return run?.status === "completed" || run?.status === "failed" ? run : undefined;
  });
const decide = (approvalRequestId: string, decision: "approve" | "reject") =>
  client.POST("/approval-requests/{approvalRequestId}/decision", { params: { path: { approvalRequestId } }, body: { decision } });

// Fakes only: the policy ask-before-merge asks before merging fake-develop-and-ask's pull
// request, which the server merges in its fake integration once approved.
describe("approval requests on the compose stack", () => {
  it("asks before merging, keeps waiting across a platform restart, and merges once approved", { timeout: 240_000 }, async () => {
    const runId = await start();

    const approval = await pendingApproval(runId);
    expect(approval).toMatchObject({ action: "merge", pullRequest: PR, policy: "ask-before-merge", workflow: "fake-develop-and-ask" });
    const notification = await waitFor("notification about the approval request", async () =>
      (await client.GET("/notifications")).data?.items.find((item) => item.runId === runId && item.kind === "approval.requested"),
    );
    expect(notification.title).toContain(PR);
    const status = (await client.GET("/status")).data;
    expect(status?.pendingApprovals).toBeGreaterThanOrEqual(1);

    await compose("restart", "server", "worker");
    await compose("up", "-d", "--wait", "server", "worker");

    expect(await waitFor("run after the restart", () => getRun(runId))).toMatchObject({ status: "running" });
    const { response } = await waitFor("decision", async () => {
      const answer = await decide(approval.id, "approve");
      return answer.response.status === 200 ? answer : undefined;
    });
    expect(response.status).toBe(200);

    expect(await ended(runId)).toMatchObject({
      status: "completed",
      output: { pullRequest: PR, merged: true, decision: "ask", approvalRequest: approval.id, approval: "approve" },
    });
  });

  it("ends the run without merging when the approval request is rejected", { timeout: 90_000 }, async () => {
    const runId = await start();
    const approval = await pendingApproval(runId);

    const { response } = await decide(approval.id, "reject");

    expect(response.status).toBe(200);
    const run = await ended(runId);
    expect(run).toMatchObject({ status: "completed", output: { pullRequest: PR, merged: false, decision: "ask", approval: "reject" } });
    expect(run.steps.map((step) => step.name)).not.toContain("mergeApproved");
  });
});
