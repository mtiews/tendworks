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
const PULL_REQUEST = "https://git.example/example/playground/pull/1"; // tests/fixtures/config/agents/fake-pr-developer.md

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined); // the API may be restarting
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen in time`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function start(number: number): Promise<string> {
  const { data, response } = await client.POST("/runs", { body: { workflow: "wait-for-merge", input: { issue: { number, title: "Wait for the merge" } } } });
  expect(response.status).toBe(201);
  return data!.id;
}

const getRun = async (runId: string): Promise<Run | undefined> => (await client.GET("/runs/{runId}", { params: { path: { runId } } })).data;
const pendingRequest = (runId: string) =>
  waitFor<ApprovalRequest>(`approval request for run ${runId}`, async () =>
    (await client.GET("/approval-requests", { params: { query: { status: "pending" } } })).data?.items.find((item) => item.runId === runId),
  );
const ended = (runId: string) =>
  waitFor<Run>(`end of run ${runId}`, async () => {
    const run = await getRun(runId);
    return run?.status === "completed" || run?.status === "failed" ? run : undefined;
  });
const answer = (approvalRequestId: string, label: string) =>
  client.POST("/approval-requests/{approvalRequestId}/decision", { params: { path: { approvalRequestId } }, body: { answer: label } });

// Fakes only: wait-for-merge's human step asks (policy ask-before-merge-fakes) before its
// follow-up step; the fake agent reports a pull request on the reserved git.example host.
describe("the human step on the compose stack", () => {
  it("waits on its approval request across a platform restart and continues after the answer", { timeout: 240_000 }, async () => {
    const runId = await start(15);

    const request = await pendingRequest(runId);
    expect(request).toMatchObject({
      workflow: "wait-for-merge",
      action: "merge-pull-request",
      policy: "ask-before-merge-fakes",
      links: [{ title: "Pull request", url: PULL_REQUEST }],
      answers: [
        { label: "Merged – continue", outcome: "continue" },
        { label: "Cancel", outcome: "stop" },
      ],
    });
    const notification = await waitFor("notification about the approval request", async () =>
      (await client.GET("/notifications")).data?.items.find((item) => item.runId === runId && item.kind === "approval.requested"),
    );
    expect(notification.title).toContain(PULL_REQUEST);
    expect((await client.GET("/status")).data?.pendingApprovals).toBeGreaterThanOrEqual(1);

    await compose("restart", "server", "worker");
    await compose("up", "-d", "--wait", "server", "worker");

    expect(await waitFor("run after the restart", () => getRun(runId))).toMatchObject({ status: "running" });
    const { response } = await waitFor("decision", async () => {
      const decided = await answer(request.id, "Merged – continue");
      return decided.response.status === 200 ? decided : undefined;
    });
    expect(response.status).toBe(200);

    const run = await ended(runId);
    expect(run).toMatchObject({ status: "completed", output: { pullRequest: PULL_REQUEST, answer: "Merged – continue", followedUp: true } });
    expect(run.steps.map((step) => step.name)).toEqual(["implement", "confirmMerge", "followUp"]);
    const shown = await client.GET("/approval-requests/{approvalRequestId}", { params: { path: { approvalRequestId: request.id } } });
    expect(shown.data).toMatchObject({ status: "decided", answer: "Merged – continue" });
  });

  it("stops the run with an answer that stops", { timeout: 90_000 }, async () => {
    const runId = await start(16);
    const request = await pendingRequest(runId);

    expect((await answer(request.id, "Cancel")).response.status).toBe(200);

    const run = await ended(runId);
    expect(run).toMatchObject({ status: "completed", output: { pullRequest: PULL_REQUEST, answer: "Cancel" } });
    expect(run.steps.map((step) => step.name)).toEqual(["implement", "confirmMerge"]);
  });
});
