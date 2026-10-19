import { describe, expect, it } from "vitest";
import { createMergeGate } from "./merge-gate.js";
import type { Policy } from "./policy.js";
import { createFakePullRequests, type PullRequests } from "./pull-requests/pull-requests.js";

const policy = (name: string, merge: "auto" | "ask"): Policy => ({
  apiVersion: "tendworks.dev/v1",
  kind: "Policy",
  metadata: { name },
  spec: { merge },
});
const PR = "https://git.example/acme/app/pull/7";

function setup(pullRequests: PullRequests & { merged?(): string[] } = createFakePullRequests([{ url: PR, state: "open" }])) {
  const gate = createMergeGate({
    policies: [policy("merge-gate", "auto"), policy("careful", "ask")],
    pullRequests: (url) => (new URL(url).hostname.endsWith(".example") ? pullRequests : undefined),
  });
  return { gate, merged: () => pullRequests.merged?.() ?? [] };
}

describe("merge gate", () => {
  it("merges the pull request right away when the policy says merge: auto", async () => {
    const { gate, merged } = setup();

    const outcome = await gate.merge({ pullRequest: PR, policy: "merge-gate" });

    expect(outcome).toEqual({
      merged: { pullRequest: PR, policy: "merge-gate", decision: "allow", merged: true, commit: expect.stringMatching(/^[0-9a-f]{40}$/) },
    });
    expect(merged()).toEqual([PR]);
  });

  it("refuses to merge when the policy asks for an approval first, and merges nothing", async () => {
    const { gate, merged } = setup();

    const outcome = await gate.merge({ pullRequest: PR, policy: "careful" });

    expect(outcome).toEqual({
      refused: {
        reason: "not-allowed",
        title: "Merge needs an approval",
        detail: "policy 'careful' says merge: ask, which needs an approval request before the merge; approval requests are not supported yet",
      },
    });
    expect(merged()).toEqual([]);
  });

  it("says so when there is no pull request to merge", async () => {
    const { gate } = setup();

    const outcome = await gate.merge({ pullRequest: null, policy: "merge-gate" });

    expect(outcome).toEqual({
      refused: {
        reason: "invalid",
        title: "No pull request to merge",
        detail: "`pullRequest` is null: the step before reported no pull request (did the agent open and report one?)",
      },
    });
  });

  it("names the configured policies when the policy is unknown", async () => {
    const { gate } = setup();

    const outcome = await gate.merge({ pullRequest: PR, policy: "nope" });

    expect(outcome).toEqual({
      refused: { reason: "invalid", title: "Unknown policy", detail: "no policy 'nope' is configured (configured: careful, merge-gate)" },
    });
  });

  it("refuses a pull request on a host no integration serves", async () => {
    const { gate } = setup();

    const outcome = await gate.merge({ pullRequest: "https://forge.test/acme/app/pull/1", policy: "merge-gate" });

    expect(outcome).toEqual({
      refused: { reason: "invalid", title: "No integration for this pull request", detail: "no integration merges pull requests on forge.test" },
    });
  });

  it("passes on why the repository refused the merge", async () => {
    const { gate } = setup(createFakePullRequests([{ url: PR, state: "open", mergeable: false }]));

    const outcome = await gate.merge({ pullRequest: PR, policy: "merge-gate" });

    expect(outcome).toEqual({
      refused: { reason: "refused", title: "Pull request cannot be merged", detail: `pull request ${PR} is not mergeable: it has conflicts` },
    });
  });

  it("reports an integration that cannot be asked as unavailable", async () => {
    const { gate } = setup({
      merge: async () => {
        throw new Error("secret TENDWORKS_PLATFORM_GITHUB_TOKEN is not set");
      },
    });

    const outcome = await gate.merge({ pullRequest: PR, policy: "merge-gate" });

    expect(outcome).toEqual({
      refused: { reason: "unavailable", title: "Repository unavailable", detail: "secret TENDWORKS_PLATFORM_GITHUB_TOKEN is not set" },
    });
  });
});
