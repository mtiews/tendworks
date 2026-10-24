import type { ControlPlane } from "@tendworks/shared";

type Schemas = ControlPlane.components["schemas"];
export type ApprovalRequest = Schemas["approvalRequest"];
export type ApprovalStatus = Schemas["approvalStatus"];
/** What a workflow's human step asks (`POST /approval-requests`). */
export type AskApproval = Schemas["AskApprovalRequest"];
/** The policies' decision, and with `ask` the step's approval request. */
export type ApprovalOutcome = Schemas["ApprovalOutcome"];
/** Why a human step cannot ask: an invalid question, an unknown run or one that is not running. */
export type AskRefusal = { refused: { reason: "invalid" | "unknown-run" | "not-running"; detail: string } };
export type DecisionOutcome = { decided: ApprovalRequest } | { conflict: ApprovalRequest } | { unknownAnswer: ApprovalRequest };

/**
 * Port to human interaction, which owns approval requests and decides human steps by the
 * policies. The control plane keeps none.
 *
 * @port
 */
export interface ApprovalsPort {
  /** Decides a human step by the policies of the run's workflow; with `ask` records the step's request. */
  ask(question: AskApproval): Promise<ApprovalOutcome | AskRefusal>;
  /** Requests, newest first. */
  list(options?: { status?: ApprovalStatus }): Promise<ApprovalRequest[]>;
  /** `undefined` for an unknown request. */
  get(id: string): Promise<ApprovalRequest | undefined>;
  /**
   * Decides a request with the answer labelled `answer`. `undefined` for an unknown
   * request; `unknownAnswer` when the request offers no such answer; `conflict` when it
   * was decided with another answer before.
   */
  decide(id: string, answer: string): Promise<DecisionOutcome | undefined>;
}

/**
 * Approval requests in memory, for tests; `requests` newest first. Its human steps always
 * ask, as when no policy applies, and it knows no runs: a request names its run's id as
 * workflow.
 */
export function createInMemoryApprovals(requests: ApprovalRequest[] = []): ApprovalsPort {
  const known = structuredClone(requests);
  const clone = <T>(value: T): T => structuredClone(value);
  return {
    async ask(question) {
      const existing = known.find((request) => request.runId === question.run && request.step === question.step);
      if (existing) return { decision: "ask", approvalRequest: clone(existing) };
      const request: ApprovalRequest = {
        id: `approval-${known.length + 1}`,
        runId: question.run,
        workflow: question.run,
        step: question.step,
        action: question.action,
        question: question.question,
        links: question.links ?? [],
        answers: question.answers,
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      known.unshift(request);
      return { decision: "ask", approvalRequest: clone(request) };
    },
    async list({ status } = {}) {
      return clone(known.filter((request) => status === undefined || request.status === status));
    },
    async get(id) {
      const request = known.find((candidate) => candidate.id === id);
      return request && clone(request);
    },
    async decide(id, answer) {
      const request = known.find((candidate) => candidate.id === id);
      if (!request) return undefined;
      if (!request.answers.some((offered) => offered.label === answer)) return { unknownAnswer: clone(request) };
      if (request.status === "decided") return request.answer === answer ? { decided: clone(request) } : { conflict: clone(request) };
      Object.assign(request, { status: "decided", answer, decidedAt: new Date().toISOString() });
      return { decided: clone(request) };
    },
  };
}
