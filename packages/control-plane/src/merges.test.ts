import { describe, expect, it } from "vitest";
import { createControlPlaneApi, createInMemoryRuns, type MergeOutcome, type MergesPort } from "./index.js";

const PR = "https://git.example/acme/app/pull/7";

async function merge(body: unknown, merges?: MergesPort) {
  const api = createControlPlaneApi({
    probes: [],
    configuration: { workflowNames: [], workflow: () => undefined, agentProfiles: [], triggerBindings: [], policies: [] },
    runs: createInMemoryRuns(),
    ...(merges ? { merges } : {}),
  });
  const response = await api.fetch(
    new Request("http://tend.test/pull-requests/merge", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  );
  return { status: response.status, body: await response.json() };
}

const answering = (outcome: MergeOutcome): MergesPort & { requests: unknown[] } => {
  const requests: unknown[] = [];
  return {
    requests,
    async merge(request) {
      requests.push(request);
      return outcome;
    },
  };
};

describe("pull request merge API", () => {
  it("merges through the gate and answers with the merge", async () => {
    const merges = answering({ merged: { pullRequest: PR, policy: "merge-gate", decision: "allow", merged: true, commit: "abc" } });

    const { status, body } = await merge({ pullRequest: PR, policy: "merge-gate" }, merges);

    expect(status).toBe(200);
    expect(body).toEqual({ pullRequest: PR, policy: "merge-gate", decision: "allow", merged: true, commit: "abc" });
    expect(merges.requests).toEqual([{ pullRequest: PR, policy: "merge-gate" }]);
  });

  it.each([
    ["invalid", 400],
    ["not-allowed", 403],
    ["refused", 409],
    ["unavailable", 502],
  ] as const)("answers a merge refused as %s with %i and the reason", async (reason, expected) => {
    const merges = answering({ refused: { reason, title: "Pull request cannot be merged", detail: "it has conflicts" } });

    const { status, body } = await merge({ pullRequest: PR, policy: "merge-gate" }, merges);

    expect(status).toBe(expected);
    expect(body).toEqual({ title: "Pull request cannot be merged", status: expected, detail: "it has conflicts" });
  });

  it("passes a missing pull request (null) on to the gate, which explains it", async () => {
    const merges = answering({ refused: { reason: "invalid", title: "No pull request to merge", detail: "`pullRequest` is null" } });

    const { status } = await merge({ pullRequest: null, policy: "merge-gate" }, merges);

    expect(status).toBe(400);
    expect(merges.requests).toEqual([{ pullRequest: null, policy: "merge-gate" }]);
  });

  it("rejects a malformed request with 400 without asking the gate", async () => {
    const merges = answering({ refused: { reason: "invalid", title: "x", detail: "x" } });

    const { status, body } = await merge({ pullRequest: 7 }, merges);

    expect(status).toBe(400);
    expect(body).toMatchObject({ title: "Invalid request", detail: "`pullRequest` must be a URL or null and `policy` the name of a configured policy" });
    expect(merges.requests).toEqual([]);
  });

  it("answers 503 when no merge gate is wired", async () => {
    const { status, body } = await merge({ pullRequest: PR, policy: "merge-gate" });

    expect(status).toBe(503);
    expect(body).toMatchObject({ title: "Merging unavailable" });
  });
});
