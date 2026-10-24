import { createControlPlaneApi, createInMemoryRuns, emptyConfiguration } from "@tendworks/control-plane";
import { approvalRequested, createApprovals, createInMemoryApprovalStore, type ApprovalRequest } from "@tendworks/human-interaction";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runTend } from "./tend.js";

const pending: ApprovalRequest = {
  id: "5e1f-approval-pending",
  runId: "0b6c4c1e-run",
  workflow: "wait-for-merge",
  step: "/do/1/confirmMerge",
  action: "merge-pull-request",
  policy: "careful",
  question: "Merge https://github.com/acme/playground/pull/13, then continue?",
  links: [{ title: "Pull request", url: "https://github.com/acme/playground/pull/13" }],
  answers: [
    { label: "Merged – continue", outcome: "continue" },
    { label: "Cancel", outcome: "stop" },
  ],
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

    const refused = await tend(["--token", "wrong-token", "approval", "answer", pending.id, "Cancel"]);
    const answered = await tend(["approval", "answer", pending.id, "Cancel"]);

    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toBe("tend: the control plane refused the token (HTTP 401); set TEND_API_TOKEN or pass --token\n");
    expect(answered.exitCode).toBe(0);
  });

  it("says that the read-only token cannot decide", async () => {
    const { tend } = await setup();

    const refused = await tend(["--token", "test-read-token", "approval", "answer", pending.id, "Cancel"]);

    expect(refused).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "tend: the control plane refused the operation (HTTP 403): the read-only token cannot change state; this operation needs the platform's API token\n",
    });
  });

  it("lists approval requests with their status, answer and question", async () => {
    const { tend } = await setup();

    const { exitCode, stdout } = await tend(["approval", "list"]);

    expect(exitCode).toBe(0);
    const lines = stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^ID\s+STATUS\s+RUN\s+CREATED\s+ANSWER\s+QUESTION$/);
    expect(lines[1]).toMatch(/^5e1f-approval-pending\s+pending\s+0b6c4c1e-run\s+2026-10-19T10:00:00.000Z\s+-\s+Merge https:\/\/github.com\/acme\/playground\/pull\/13, then continue\?$/);
  });

  it("lists only pending requests with --pending, and as documents with -o", async () => {
    const { tend } = await setup();
    await tend(["approval", "answer", pending.id, "Cancel"]);

    expect((await tend(["approval", "list", "--pending"])).stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse((await tend(["approval", "list", "-o", "json"])).stdout)).toMatchObject({ items: [{ id: pending.id, status: "decided", answer: "Cancel" }] });
    expect(parse((await tend(["approval", "list", "-o", "yaml"])).stdout)).toMatchObject({ items: [{ id: pending.id }] });
  });

  it("shows a request with its question, links and the answers to choose from", async () => {
    const { tend } = await setup();

    const { exitCode, stdout } = await tend(["approval", "get", pending.id]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^QUESTION\s+Merge https:\/\/github.com\/acme\/playground\/pull\/13, then continue\?$/m);
    expect(stdout).toMatch(/^ACTION\s+merge-pull-request$/m);
    expect(stdout).toMatch(/^POLICY\s+careful$/m);
    expect(stdout).toMatch(/^LINK\s+URL$/m);
    expect(stdout).toMatch(/^Pull request\s+https:\/\/github.com\/acme\/playground\/pull\/13$/m);
    expect(stdout).toMatch(/^ANSWER\s+THEN$/m);
    expect(stdout).toMatch(/^Merged – continue\s+continue$/m);
    expect(stdout).toMatch(/^Cancel\s+stop$/m);
    expect(stdout).toContain(`tend approval answer ${pending.id} "<answer>"`);
    expect(JSON.parse((await tend(["approval", "get", pending.id, "-o", "json"])).stdout)).toEqual(pending);
  });

  it("shows the chosen answer of a decided request", async () => {
    const { tend } = await setup();
    await tend(["approval", "answer", pending.id, "Merged – continue"]);

    const { stdout } = await tend(["approval", "get", pending.id]);

    expect(stdout).toMatch(/^STATUS\s+decided$/m);
    expect(stdout).toMatch(/^DECIDED\s+Merged – continue \(2026-10-19T10:05:00.000Z\)$/m);
    expect(stdout).not.toContain("tend approval answer");
  });

  it("answers a request and the waiting run hears what to do", async () => {
    const { tend, store } = await setup();

    const { exitCode, stdout } = await tend(["approval", "answer", pending.id, "Merged – continue"]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe(`approval request ${pending.id} answered "Merged – continue"; the run continues\n`);
    expect(store.published.at(-1)).toMatchObject({ type: "dev.tendworks.approval.decided", data: { answer: "Merged – continue", outcome: "continue" } });
  });

  it("says that an answer that stops ends the run", async () => {
    const { tend } = await setup();

    expect((await tend(["approval", "answer", pending.id, "Cancel"])).stdout).toBe(`approval request ${pending.id} answered "Cancel"; the run stops\n`);
  });

  it("fails with the reason for an unknown request, an answer it does not offer or one decided otherwise", async () => {
    const { tend } = await setup();

    const unknown = await tend(["approval", "answer", "nope", "Cancel"]);
    const notOffered = await tend(["approval", "answer", pending.id, "Maybe"]);
    await tend(["approval", "answer", pending.id, "Cancel"]);
    const conflict = await tend(["approval", "answer", pending.id, "Merged – continue"]);
    const missing = await tend(["approval", "get", "nope"]);

    expect(unknown).toMatchObject({ exitCode: 1, stderr: "tend: approval request nope not found\n" });
    expect(missing).toMatchObject({ exitCode: 1, stderr: "tend: approval request nope not found\n" });
    expect(notOffered.exitCode).toBe(1);
    expect(notOffered.stderr).toContain("offers no answer 'Maybe' (answers: 'Merged – continue', 'Cancel')");
    expect(conflict.exitCode).toBe(1);
    expect(conflict.stderr).toContain(`approval request ${pending.id} was already decided with 'Cancel'`);
  });

  it("shows the number of pending approval requests in tend status", async () => {
    const { tend } = await setup();

    const { stdout } = await tend(["status"]);

    expect(stdout).toMatch(/^PENDING APPROVALS\s+1$/m);
  });
});
