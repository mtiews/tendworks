import type { ApprovalRequest as ApprovalRequestSchema } from "@tendworks/shared";
import { approvalDecided } from "./approval-events.js";
import type { ApprovalRequest, ApprovalStatus, ApprovalStore, DecideOutcome } from "./approval-store.js";

export type ApprovalDecision = ApprovalRequestSchema.ApprovalDecision;

export interface ApprovalsOptions {
  store: ApprovalStore;
  now?: () => Date;
}

/** Answering approval requests: the human's side of the gate. */
export interface Approvals {
  /** Requests, newest first. */
  list(options?: { status?: ApprovalStatus }): Promise<ApprovalRequest[]>;
  /**
   * Records the decision and emits `approval.decided` with it, which the waiting run
   * receives. `undefined` for an unknown request; `conflict` when it was decided the
   * other way before.
   */
  decide(id: string, decision: ApprovalDecision): Promise<DecideOutcome | undefined>;
}

export function createApprovals({ store, now = () => new Date() }: ApprovalsOptions): Approvals {
  return {
    list: (options) => store.list(options),
    async decide(id, decision) {
      const time = now().toISOString();
      return store.decide(id, decision === "approve" ? "approved" : "rejected", time, (request) => approvalDecided(request, time));
    },
  };
}
