import type { ControlPlane } from "@tendworks/shared";

type Schemas = ControlPlane.components["schemas"];
export type MergeRequest = Schemas["MergePullRequestRequest"];
export type PullRequestMerge = Schemas["PullRequestMerge"];

/** Why the gate did not merge; see `POST /pull-requests/merge` for the status each maps to. */
export interface MergeRefusal {
  reason: "invalid" | "not-allowed" | "refused" | "unavailable";
  title: string;
  detail: string;
}

export type MergeOutcome = { merged: PullRequestMerge } | { refused: MergeRefusal };

/**
 * Port to human interaction's merge gate, which decides by policy and merges with the
 * platform's credentials. The control plane keeps no merge state.
 */
export interface MergesPort {
  merge(request: MergeRequest): Promise<MergeOutcome>;
}

export const REFUSAL_STATUS = { invalid: 400, "not-allowed": 403, refused: 409, unavailable: 502 } as const satisfies Record<MergeRefusal["reason"], number>;
