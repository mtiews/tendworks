import type { ControlPlane } from "@tendworks/shared";

type Schemas = ControlPlane.components["schemas"];
export type ApprovalRequest = Schemas["approvalRequest"];
export type ApprovalStatus = Schemas["approvalStatus"];
export type ApprovalDecision = Schemas["approvalDecision"];

/**
 * Port to human interaction, which owns approval requests. The control plane keeps none.
 *
 * @port
 */
export interface ApprovalsPort {
  /** Requests, newest first. */
  list(options?: { status?: ApprovalStatus }): Promise<ApprovalRequest[]>;
  /** `undefined` for an unknown request; `conflict` when it was decided the other way before. */
  decide(id: string, decision: ApprovalDecision): Promise<{ decided: ApprovalRequest } | { conflict: ApprovalRequest } | undefined>;
}

/** Approval requests in memory, for tests; `requests` newest first. */
export function createInMemoryApprovals(requests: ApprovalRequest[] = []): ApprovalsPort {
  const known = structuredClone(requests);
  return {
    async list({ status } = {}) {
      return structuredClone(known.filter((request) => status === undefined || request.status === status));
    },
    async decide(id, decision) {
      const request = known.find((candidate) => candidate.id === id);
      if (!request) return undefined;
      const status = decision === "approve" ? "approved" : "rejected";
      if (request.status !== "pending" && request.status !== status) return { conflict: structuredClone(request) };
      request.status = status;
      return { decided: structuredClone(request) };
    },
  };
}
