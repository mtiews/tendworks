import { eventEnvelope, newTraceparent } from "@tendworks/platform";
import type { ApprovalEvents } from "@tendworks/shared";
import type { ApprovalRequest } from "./approval-store.js";

/** The CloudEvent source of human interaction's events. */
export const HUMAN_INTERACTION_SOURCE = "/tendworks/human-interaction";

// An approval request belongs to the trace of the run that waits for it; a request
// recorded without one (before runs had a trace) starts its own.
function envelope(request: ApprovalRequest, kind: "requested" | "decided", time: string) {
  return eventEnvelope({
    // Deterministic, so a repeated write is recognisable.
    id: `${request.id}:approval.${kind}`,
    source: HUMAN_INTERACTION_SOURCE,
    subject: `approval-requests/${request.id}`,
    time,
    runId: request.runId,
    traceparent: request.traceparent ?? newTraceparent(),
  });
}

export function approvalRequested(request: ApprovalRequest, time: string): ApprovalEvents.ApprovalRequestedEvent {
  return { ...envelope(request, "requested", time), type: "dev.tendworks.approval.requested", data: { ...request } };
}

export function approvalDecided(request: ApprovalRequest, time: string): ApprovalEvents.ApprovalDecidedEvent {
  return {
    ...envelope(request, "decided", time),
    type: "dev.tendworks.approval.decided",
    data: {
      approvalRequest: request.id,
      decision: request.status === "approved" ? "approve" : "reject",
      action: request.action,
      ...(request.pullRequest === undefined ? {} : { pullRequest: request.pullRequest }),
    },
  };
}
