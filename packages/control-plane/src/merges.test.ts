import { describe, expect, it } from "vitest";
import { createControlPlaneApi, createFakeMerges, createInMemoryRuns, type MergesPort } from "./index.js";

const PR = "https://git.example/acme/app/pull/7";

async function merge(body: unknown, merges?: MergesPort) {
  const api = createControlPlaneApi({
    probes: [],
    configuration: { workflowNames: [], workflow: () => undefined, agentProfiles: [], triggerBindings: [], policies: [], pullRequestIntegrations: [] },
    runs: createInMemoryRuns(),
    ...(merges ? { merges } : {}),
  });
  const response = await api.fetch(
    new Request("http://tend.test/pull-requests/merge", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  );
  return { status: response.status, body: await response.json() };
}

describe("pull request merge API", () => {
  it("merges through the gate and answers with the merge", async () => {
    const merges = createFakeMerges({ merged: { pullRequest: PR, policy: "merge-gate", decision: "allow", merged: true, commit: "abc" } });

    const { status, body } = await merge({ run: "run-1", pullRequest: PR }, merges);

    expect(status).toBe(200);
    expect(body).toEqual({ pullRequest: PR, policy: "merge-gate", decision: "allow", merged: true, commit: "abc" });
    expect(merges.requests).toEqual([{ run: "run-1", pullRequest: PR }]);
  });

  it("answers 202 with the approval request while the merge waits for it", async () => {
    const approvalRequest = {
      id: "approval-1",
      runId: "run-1",
      workflow: "develop-issue",
      action: "merge" as const,
      pullRequest: PR,
      policy: "careful",
      question: "Merge?",
      status: "pending" as const,
      createdAt: "2026-10-19T10:00:00.000Z",
    };
    const merges = createFakeMerges({ pending: { pullRequest: PR, policy: "careful", decision: "ask", merged: false, approvalRequest } });

    const { status, body } = await merge({ run: "run-1", pullRequest: PR }, merges);

    expect(status).toBe(202);
    expect(body).toEqual({ pullRequest: PR, policy: "careful", decision: "ask", merged: false, approvalRequest });
  });

  it.each([
    ["invalid", 400],
    ["rejected", 403],
    ["conflict", 409],
    ["refused", 409],
    ["unavailable", 502],
  ] as const)("answers a merge refused as %s with %i and the reason", async (reason, expected) => {
    const merges = createFakeMerges({ refused: { reason, title: "Pull request cannot be merged", detail: "it has conflicts" } });

    const { status, body } = await merge({ run: "run-1", pullRequest: PR }, merges);

    expect(status).toBe(expected);
    expect(body).toEqual({ title: "Pull request cannot be merged", status: expected, detail: "it has conflicts" });
  });

  it("passes a missing pull request (null) on to the gate, which explains it", async () => {
    const merges = createFakeMerges({ refused: { reason: "invalid", title: "No pull request to merge", detail: "`pullRequest` is null" } });

    const { status } = await merge({ run: "run-1", pullRequest: null }, merges);

    expect(status).toBe(400);
    expect(merges.requests).toEqual([{ run: "run-1", pullRequest: null }]);
  });

  it.each([
    ["a pull request that is no string", { run: "run-1", pullRequest: 7 }],
    ["no run", { pullRequest: PR }],
    ["a policy chosen by the caller", { run: "run-1", pullRequest: PR, policy: "merge-gate" }],
  ])("rejects a request with %s with 400 without asking the gate", async (_, request) => {
    const merges = createFakeMerges({ refused: { reason: "invalid", title: "x", detail: "x" } });

    const { status, body } = await merge(request, merges);

    expect(status).toBe(400);
    expect(body).toMatchObject({
      title: "Invalid request",
      detail: "the body must be { run, pullRequest } with the id of a running run and the URL of its pull request (or null); the policy comes from the platform's configuration",
    });
    expect(merges.requests).toEqual([]);
  });

  it("answers 503 when no merge gate is wired", async () => {
    const { status, body } = await merge({ run: "run-1", pullRequest: PR });

    expect(status).toBe(503);
    expect(body).toMatchObject({ title: "Merging unavailable" });
  });
});
