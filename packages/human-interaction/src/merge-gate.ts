import type { ControlPlane } from "@tendworks/shared";
import { decide, type Policy } from "./policy.js";
import { MergeRefusedError, type PullRequests } from "./pull-requests/pull-requests.js";

type Schemas = ControlPlane.components["schemas"];
export type MergeRequest = Schemas["MergePullRequestRequest"];
export type PullRequestMerge = Schemas["PullRequestMerge"];

/**
 * Why a merge did not happen. `invalid`: the request cannot be served (no pull request,
 * unknown policy, unknown host). `not-allowed`: the policy wants an approval first.
 * `refused`: the repository refused. `unavailable`: the repository could not be asked.
 */
export type MergeRefusal = { reason: "invalid" | "not-allowed" | "refused" | "unavailable"; title: string; detail: string };
export type MergeOutcome = { merged: PullRequestMerge } | { refused: MergeRefusal };

export interface MergeGateOptions {
  /** The configured policies. */
  policies: Policy[];
  /** The integration that merges pull requests at this URL, if any. */
  pullRequests: (url: string) => PullRequests | undefined;
}

export interface MergeGate {
  merge(request: MergeRequest): Promise<MergeOutcome>;
}

/**
 * The gate in front of merging a pull request: the named policy decides, and only an
 * `allow` lets the merge through to the integration, which merges with the platform's
 * credentials. With `ask` the merge is refused for now; approval requests (#15) plug in
 * here, so the gate stays the only way to a merge whichever client asks.
 */
export function createMergeGate({ policies, pullRequests }: MergeGateOptions): MergeGate {
  const byName = new Map(policies.map((policy) => [policy.metadata.name, policy]));
  const refused = (reason: MergeRefusal["reason"], title: string, detail: string): MergeOutcome => ({ refused: { reason, title, detail } });

  return {
    async merge({ pullRequest, policy: name }) {
      if (pullRequest === null || pullRequest === "") {
        return refused("invalid", "No pull request to merge", "`pullRequest` is null: the step before reported no pull request (did the agent open and report one?)");
      }
      const policy = byName.get(name);
      if (!policy) {
        return refused("invalid", "Unknown policy", `no policy '${name}' is configured (configured: ${[...byName.keys()].sort().join(", ") || "none"})`);
      }
      let host: string;
      try {
        host = new URL(pullRequest).host;
      } catch {
        return refused("invalid", "No pull request to merge", `'${pullRequest}' is not a URL`);
      }
      const integration = pullRequests(pullRequest);
      if (!integration) return refused("invalid", "No integration for this pull request", `no integration merges pull requests on ${host}`);

      const decision = decide(policy, { action: "merge" });
      if (decision !== "allow") {
        return refused(
          "not-allowed",
          "Merge needs an approval",
          `policy '${name}' says merge: ${policy.spec.merge}, which needs an approval request before the merge; approval requests are not supported yet`,
        );
      }

      try {
        const { commit } = await integration.merge(pullRequest);
        return { merged: { pullRequest, policy: name, decision, merged: true, ...(commit ? { commit } : {}) } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof MergeRefusedError) return refused("refused", "Pull request cannot be merged", message);
        return refused("unavailable", "Repository unavailable", message);
      }
    },
  };
}
