import type { ApprovalEvents } from "@tendworks/shared";
import type { ApprovalRequest } from "./approval-store.js";

/** The CloudEvent source of human interaction's events. */
export const HUMAN_INTERACTION_SOURCE = "/tendworks/human-interaction";

// Human interaction does not know the trace of the run it serves yet, so each approval
// request starts its own trace.
function traceparent(): string {
  const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `00-${hex(16)}-${hex(8)}-01`;
}

function envelope(request: ApprovalRequest, kind: "requested" | "decided", time: string) {
  return {
    specversion: "1.0" as const,
    // Deterministic, so a repeated write is recognisable.
    id: `${request.id}:approval.${kind}`,
    source: HUMAN_INTERACTION_SOURCE,
    subject: `approval-requests/${request.id}`,
    time,
    datacontenttype: "application/json" as const,
    runid: request.runId,
    traceparent: traceparent(),
  };
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
