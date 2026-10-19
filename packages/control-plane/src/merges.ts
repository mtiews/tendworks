import type { ControlPlane } from "@tendworks/shared";

type Schemas = ControlPlane.components["schemas"];
export type MergeRequest = Schemas["MergePullRequestRequest"];
export type PullRequestMerge = Schemas["PullRequestMerge"];

/** Why the gate did not merge; see `POST /pull-requests/merge` for the status each maps to. */
export interface MergeRefusal {
  reason: "invalid" | "rejected" | "conflict" | "refused" | "unavailable";
  title: string;
  detail: string;
}

/** `pending`: the merge waits for its approval request; nothing is merged yet. */
export type MergeOutcome = { merged: PullRequestMerge } | { pending: PullRequestMerge } | { refused: MergeRefusal };

/**
 * Port to human interaction's merge gate, which decides by the run's policies and its
 * approval request and merges with the platform's credentials. The control plane keeps
 * no merge state.
 *
 * @port
 */
export interface MergesPort {
  merge(request: MergeRequest): Promise<MergeOutcome>;
}

/** Fake merge gate for tests: answers every request with `outcome` and records the requests. */
export function createFakeMerges(outcome: MergeOutcome): MergesPort & { requests: MergeRequest[] } {
  const requests: MergeRequest[] = [];
  return {
    requests,
    async merge(request) {
      requests.push(structuredClone(request));
      return structuredClone(outcome);
    },
  };
}

export const REFUSAL_STATUS = { invalid: 400, rejected: 403, conflict: 409, refused: 409, unavailable: 502 } as const satisfies Record<
  MergeRefusal["reason"],
  number
>;
