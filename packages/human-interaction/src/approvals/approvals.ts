import type { ControlPlane } from "@tendworks/shared";
import { decideFor, type Policy, type PolicyDecision } from "../policy.js";
import { approvalDecided, approvalRequested } from "./approval-events.js";
import type { ApprovalRequest, ApprovalStatus, ApprovalStore, DecideOutcome } from "./approval-store.js";

type Schemas = ControlPlane.components["schemas"];

/** What a human step asks (contracts/openapi/control-plane.yaml, `AskApprovalRequest`). */
export type AskApproval = Schemas["AskApprovalRequest"];

/** What human interaction needs to know about the run that asks, from orchestration's record of it. */
export interface AskedRun {
  id: string;
  workflow: string;
  status: Schemas["runStatus"];
  /** W3C trace context of the run; the events of its approval requests carry it. */
  traceparent?: string;
}

/**
 * The answer to a human step: `allow` without a request, or `ask` with the step's
 * request; `refused` when the step cannot ask (unknown or finished run, invalid question).
 */
export type AskOutcome =
  | { decision: PolicyDecision; policy?: string; approvalRequest?: ApprovalRequest }
  | { refused: { reason: "invalid" | "unknown-run" | "not-running"; detail: string } };

export interface ApprovalsOptions {
  store: ApprovalStore;
  /** The configured policies. */
  policies?: Policy[];
  /** Orchestration's record of a run; the authority on its workflow and status. */
  runs?: (runId: string) => Promise<AskedRun | undefined>;
  now?: () => Date;
  newId?: () => string;
}

/** Approval requests: the human steps of runs ask, the human decides. */
export interface Approvals {
  /**
   * Decides a human step by the policies of the run's workflow (never by what the caller
   * claims) and, when they ask, records the step's approval request and emits
   * `approval.requested`. Asking again from the same step returns its request.
   */
  ask(question: AskApproval): Promise<AskOutcome>;
  /** Requests, newest first. */
  list(options?: { status?: ApprovalStatus }): Promise<ApprovalRequest[]>;
  /** `undefined` for an unknown request. */
  get(id: string): Promise<ApprovalRequest | undefined>;
  /**
   * Records the chosen answer and emits `approval.decided` with it, which the waiting run
   * receives. `undefined` for an unknown request; `unknownAnswer` when the request offers
   * no such answer; `conflict` when it was decided with another answer before.
   */
  decide(id: string, answer: string): Promise<DecideOutcome | { unknownAnswer: ApprovalRequest } | undefined>;
}

export function createApprovals({
  store,
  policies = [],
  runs = async () => undefined,
  now = () => new Date(),
  newId = () => crypto.randomUUID(),
}: ApprovalsOptions): Approvals {
  return {
    async ask(question) {
      const labels = question.answers.map((answer) => answer.label);
      const repeated = labels.find((label, index) => labels.indexOf(label) !== index);
      if (repeated !== undefined) return { refused: { reason: "invalid", detail: `the answer '${repeated}' is given twice; answer labels must be unique` } };
      const run = await runs(question.run);
      if (!run) return { refused: { reason: "unknown-run", detail: `no run '${question.run}' exists` } };
      if (run.status !== "running") {
        return { refused: { reason: "not-running", detail: `run ${run.id} is ${run.status}; only a running run can ask` } };
      }

      const verdict = decideFor(policies, { action: question.action, workflow: run.workflow });
      if (verdict.decision === "allow") return verdict;
      const time = now().toISOString();
      const approvalRequest = await store.open(
        {
          id: newId(),
          runId: run.id,
          workflow: run.workflow,
          step: question.step,
          action: question.action,
          ...(verdict.policy === undefined ? {} : { policy: verdict.policy }),
          question: question.question,
          links: question.links ?? [],
          // The API checked that there is at least one.
          answers: question.answers as ApprovalRequest["answers"],
          status: "pending",
          ...(run.traceparent === undefined ? {} : { traceparent: run.traceparent }),
          createdAt: time,
        },
        (request) => approvalRequested(request, time),
      );
      return { ...verdict, approvalRequest };
    },
    list: (options) => store.list(options),
    get: (id) => store.get(id),
    async decide(id, answer) {
      const request = await store.get(id);
      if (!request) return undefined;
      // Answers never change after the request is recorded, so checking first is safe.
      if (!request.answers.some((offered) => offered.label === answer)) return { unknownAnswer: request };
      const time = now().toISOString();
      return store.decide(id, answer, time, (decided) => approvalDecided(decided, time));
    },
  };
}
