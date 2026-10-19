import type { ControlPlane } from "@tendworks/shared";

type Schemas = ControlPlane.components["schemas"];
export type ApprovalRequest = Schemas["approvalRequest"];
export type ApprovalStatus = Schemas["approvalStatus"];
export type ApprovalDecision = Schemas["approvalDecision"];

/** Port to human interaction, which owns approval requests. The control plane keeps none. */
export interface ApprovalsPort {
  /** Requests, newest first. */
  list(options?: { status?: ApprovalStatus }): Promise<ApprovalRequest[]>;
  /** `undefined` for an unknown request; `conflict` when it was decided the other way before. */
  decide(id: string, decision: ApprovalDecision): Promise<{ decided: ApprovalRequest } | { conflict: ApprovalRequest } | undefined>;
}
