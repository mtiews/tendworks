import { describe, expect, it } from "vitest";
import { approvalDecided } from "./approvals/approval-events.js";
import { createInMemoryApprovalStore } from "./approvals/approval-store.js";
import { createMergeGate, type GatedRun } from "./merge-gate.js";
import type { Policy } from "./policy.js";
import { createFakePullRequests, type PullRequests } from "./pull-requests/pull-requests.js";

const policy = (name: string, merge: "auto" | "ask", workflows?: [string, ...string[]]): Policy => ({
  apiVersion: "tendworks.dev/v1",
  kind: "Policy",
  metadata: { name },
  spec: workflows ? { merge, workflows } : { merge },
});
const PR = "https://git.example/acme/app/pull/7";
const NOW = "2026-10-19T10:00:00.000Z";

const running = (overrides: Partial<GatedRun> = {}): GatedRun => ({
  id: "run-1",
  workflow: "develop-issue",
  status: "running",
  artifacts: [{ name: "pull-request", url: PR }],
  ...overrides,
});

function setup({
  policies = [policy("merge-gate", "auto", ["develop-issue"]), policy("careful", "ask", ["careful-issue"])],
  runs = [running(), running({ id: "run-2", workflow: "careful-issue" })],
  pullRequests = createFakePullRequests([{ url: PR, state: "open" }]),
}: { policies?: Policy[]; runs?: GatedRun[]; pullRequests?: PullRequests & { merged?(): string[] } } = {}) {
  const approvals = createInMemoryApprovalStore();
  const gate = createMergeGate({
    policies,
    runs: async (runId) => runs.find((run) => run.id === runId),
    pullRequests: (url) => (new URL(url).hostname.endsWith(".example") ? pullRequests : undefined),
    approvals,
    now: () => new Date(NOW),
    newId: () => "approval-1",
  });
  return { gate, approvals, merged: () => pullRequests.merged?.() ?? [] };
}

describe("merge gate", () => {
  it("merges the run's pull request right away when the policy of its workflow says merge: auto", async () => {
    const { gate, merged } = setup();

    const outcome = await gate.merge({ run: "run-1", pullRequest: PR });

    expect(outcome).toEqual({
      merged: { pullRequest: PR, policy: "merge-gate", decision: "allow", merged: true, commit: expect.stringMatching(/^[0-9a-f]{40}$/) },
    });
    expect(merged()).toEqual([PR]);
  });

  describe("when the policy asks", () => {
    it("opens an approval request, announces it, and merges nothing", async () => {
      const { gate, approvals, merged } = setup();

      const outcome = await gate.merge({ run: "run-2", pullRequest: PR });

      const approvalRequest = {
        id: "approval-1",
        runId: "run-2",
        workflow: "careful-issue",
        action: "merge",
        pullRequest: PR,
        policy: "careful",
        question: `Merge ${PR} for run run-2 of careful-issue?`,
        status: "pending",
        createdAt: NOW,
      };
      expect(outcome).toEqual({ pending: { pullRequest: PR, policy: "careful", decision: "ask", merged: false, approvalRequest } });
      expect(merged()).toEqual([]);
      expect(approvals.published).toEqual([
        expect.objectContaining({
          specversion: "1.0",
          type: "dev.tendworks.approval.requested",
          source: "/tendworks/human-interaction",
          runid: "run-2",
          subject: "approval-requests/approval-1",
          data: approvalRequest,
        }),
      ]);
    });

    it("answers a repeated request with the same pending approval request", async () => {
      const { gate, approvals } = setup();
      await gate.merge({ run: "run-2", pullRequest: PR });

      const outcome = await gate.merge({ run: "run-2", pullRequest: PR });

      expect(outcome).toMatchObject({ pending: { approvalRequest: { id: "approval-1", status: "pending" } } });
      expect(approvals.published).toHaveLength(1);
    });

    it("merges once the approval request is approved", async () => {
      const { gate, approvals, merged } = setup();
      await gate.merge({ run: "run-2", pullRequest: PR });
      await approvals.decide("approval-1", "approved", NOW, (request) => approvalDecided(request, NOW));

      const outcome = await gate.merge({ run: "run-2", pullRequest: PR });

      expect(outcome).toMatchObject({ merged: { decision: "ask", merged: true, policy: "careful", approvalRequest: { id: "approval-1", status: "approved" } } });
      expect(merged()).toEqual([PR]);
    });

    it("refuses to merge once the approval request is rejected", async () => {
      const { gate, approvals, merged } = setup();
      await gate.merge({ run: "run-2", pullRequest: PR });
      await approvals.decide("approval-1", "rejected", NOW, (request) => approvalDecided(request, NOW));

      const outcome = await gate.merge({ run: "run-2", pullRequest: PR });

      expect(outcome).toEqual({
        refused: { reason: "rejected", title: "Merge rejected", detail: `approval request approval-1 to merge ${PR} was rejected` },
      });
      expect(merged()).toEqual([]);
    });
  });

  it("follows the strictest of the policies that apply to the run's workflow", async () => {
    const { gate, merged } = setup({ policies: [policy("everything", "auto"), policy("careful", "ask", ["develop-issue"])] });

    const outcome = await gate.merge({ run: "run-1", pullRequest: PR });

    expect(outcome).toMatchObject({ pending: { policy: "careful", decision: "ask" } });
    expect(merged()).toEqual([]);
  });

  it("refuses to merge when no policy applies to the run's workflow", async () => {
    const { gate } = setup({ policies: [policy("careful", "ask", ["careful-issue"])] });

    const outcome = await gate.merge({ run: "run-1", pullRequest: PR });

    expect(outcome).toEqual({
      refused: { reason: "invalid", title: "No policy applies", detail: "no policy applies to workflow 'develop-issue' (configured: careful)" },
    });
  });

  it("refuses to merge for an unknown run", async () => {
    const { gate } = setup();

    expect(await gate.merge({ run: "nope", pullRequest: PR })).toEqual({
      refused: { reason: "invalid", title: "Unknown run", detail: "no run 'nope' exists" },
    });
  });

  it("refuses to merge for a run that is not running", async () => {
    const { gate, merged } = setup({ runs: [running({ status: "completed" })] });

    expect(await gate.merge({ run: "run-1", pullRequest: PR })).toEqual({
      refused: { reason: "conflict", title: "Run is not running", detail: "run run-1 is completed; only a running run can merge its pull request" },
    });
    expect(merged()).toEqual([]);
  });

  it("refuses to merge a pull request the run did not report", async () => {
    const other = "https://git.example/acme/app/pull/8";
    const { gate, merged } = setup({ pullRequests: createFakePullRequests([{ url: other, state: "open" }]) });

    expect(await gate.merge({ run: "run-1", pullRequest: other })).toEqual({
      refused: {
        reason: "invalid",
        title: "Pull request not reported by the run",
        detail: `run run-1 reported no pull request ${other} (reported: ${PR})`,
      },
    });
    expect(merged()).toEqual([]);
  });

  it("says so when there is no pull request to merge", async () => {
    const { gate } = setup();

    const outcome = await gate.merge({ run: "run-1", pullRequest: null });

    expect(outcome).toEqual({
      refused: {
        reason: "invalid",
        title: "No pull request to merge",
        detail: "`pullRequest` is null: the step before reported no pull request (did the agent open and report one?)",
      },
    });
  });

  it("refuses a pull request on a host no integration serves", async () => {
    const pr = "https://forge.test/acme/app/pull/1";
    const { gate } = setup({ runs: [running({ artifacts: [{ name: "pull-request", url: pr }] })] });

    const outcome = await gate.merge({ run: "run-1", pullRequest: pr });

    expect(outcome).toEqual({
      refused: { reason: "invalid", title: "No integration for this pull request", detail: "no integration merges pull requests on forge.test" },
    });
  });

  it("passes on why the repository refused the merge", async () => {
    const { gate } = setup({ pullRequests: createFakePullRequests([{ url: PR, state: "open", mergeable: false }]) });

    const outcome = await gate.merge({ run: "run-1", pullRequest: PR });

    expect(outcome).toEqual({
      refused: { reason: "refused", title: "Pull request cannot be merged", detail: `pull request ${PR} is not mergeable: it has conflicts` },
    });
  });

  it("reports an integration that cannot be asked as unavailable", async () => {
    const { gate } = setup({
      pullRequests: {
        merge: async () => {
          throw new Error("secret TENDWORKS_PLATFORM_GITHUB_TOKEN is not set");
        },
      },
    });

    const outcome = await gate.merge({ run: "run-1", pullRequest: PR });

    expect(outcome).toEqual({
      refused: { reason: "unavailable", title: "Repository unavailable", detail: "secret TENDWORKS_PLATFORM_GITHUB_TOKEN is not set" },
    });
  });
});
