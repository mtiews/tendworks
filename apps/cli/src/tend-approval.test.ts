import { createControlPlaneApi, createInMemoryRuns, emptyConfiguration } from "@tendworks/control-plane";
import { approvalRequested, createApprovals, createInMemoryApprovalStore, type ApprovalRequest } from "@tendworks/human-interaction";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runTend } from "./tend.js";

const pending: ApprovalRequest = {
  id: "5e1f-approval-pending",
  runId: "0b6c4c1e-run",
  workflow: "develop-issue",
  action: "merge",
  policy: "careful",
  question: "Merge https://github.com/acme/playground/pull/13 for run 0b6c4c1e-run of develop-issue?",
  status: "pending",
  createdAt: "2026-10-19T10:00:00.000Z",
};

async function setup() {
  const store = createInMemoryApprovalStore();
  await store.open(pending, (request) => approvalRequested(request, request.createdAt));
  const api = createControlPlaneApi({
    probes: [],
    configuration: emptyConfiguration(),
    apiToken: "test-token",
    readToken: "test-read-token",
    runs: createInMemoryRuns(),
    approvals: createApprovals({ store, now: () => new Date("2026-10-19T10:05:00.000Z") }),
  });
  const tend = async (args: string[]) => {
    let stdout = "";
    let stderr = "";
    const exitCode = await runTend(["--token", "test-token", ...args], {
      fetch: (request) => api.fetch(request),
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
    });
    return { exitCode, stdout, stderr };
  };
  return { tend, store };
}

describe("tend approval", () => {
  it("sends the API token, and says how to set it when the control plane refuses it", async () => {
    const { tend } = await setup();

    const refused = await tend(["--token", "wrong-token", "approval", "approve", pending.id]);
    const approved = await tend(["approval", "approve", pending.id]);

    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toBe("tend: the control plane refused the token (HTTP 401); set TEND_API_TOKEN or pass --token\n");
    expect(approved.exitCode).toBe(0);
  });

  it("says that the read-only token cannot decide", async () => {
    const { tend } = await setup();

    const refused = await tend(["--token", "test-read-token", "approval", "approve", pending.id]);

    expect(refused).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "tend: the control plane refused the operation (HTTP 403): the read-only token cannot change state; this operation needs the platform's API token\n",
    });
  });

  it("lists approval requests with their status and question", async () => {
    const { tend } = await setup();

    const { exitCode, stdout } = await tend(["approval", "list"]);

    expect(exitCode).toBe(0);
    const lines = stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^ID\s+STATUS\s+RUN\s+CREATED\s+QUESTION$/);
    expect(lines[1]).toMatch(/^5e1f-approval-pending\s+pending\s+0b6c4c1e-run\s+2026-10-19T10:00:00.000Z\s+Merge https:\/\/github.com\/acme\/playground\/pull\/13 for run/);
  });

  it("lists only pending requests with --pending, and as documents with -o", async () => {
    const { tend } = await setup();
    await tend(["approval", "approve", pending.id]);

    expect((await tend(["approval", "list", "--pending"])).stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse((await tend(["approval", "list", "-o", "json"])).stdout)).toMatchObject({ items: [{ id: pending.id, status: "approved" }] });
    expect(parse((await tend(["approval", "list", "-o", "yaml"])).stdout)).toMatchObject({ items: [{ id: pending.id }] });
  });

  it("approves a request and the waiting run hears of it", async () => {
    const { tend, store } = await setup();

    const { exitCode, stdout } = await tend(["approval", "approve", pending.id]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe(`approval request ${pending.id} approved\n`);
    expect(store.published.at(-1)).toMatchObject({ type: "dev.tendworks.approval.decided", data: { decision: "approve" } });
  });

  it("rejects a request", async () => {
    const { tend } = await setup();

    const { exitCode, stdout } = await tend(["approval", "reject", pending.id]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe(`approval request ${pending.id} rejected\n`);
  });

  it("fails with the reason for an unknown request or one decided the other way", async () => {
    const { tend } = await setup();
    await tend(["approval", "reject", pending.id]);

    const unknown = await tend(["approval", "approve", "nope"]);
    const conflict = await tend(["approval", "approve", pending.id]);

    expect(unknown).toMatchObject({ exitCode: 1, stderr: "tend: approval request nope not found\n" });
    expect(conflict.exitCode).toBe(1);
    expect(conflict.stderr).toContain(`approval request ${pending.id} was already rejected`);
  });

  it("shows the number of pending approval requests in tend status", async () => {
    const { tend } = await setup();

    const { stdout } = await tend(["status"]);

    expect(stdout).toMatch(/^PENDING APPROVALS\s+1$/m);
  });
});
