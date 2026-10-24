import type { ApprovalEvents, ApprovalRequest as ApprovalRequestSchema } from "@tendworks/shared";

export type ApprovalRequest = ApprovalRequestSchema.ApprovalRequest;
export type ApprovalStatus = ApprovalRequestSchema.ApprovalStatus;
export type ApprovalEvent = ApprovalEvents.ApprovalRequestedEvent | ApprovalEvents.ApprovalDecidedEvent;

/**
 * Port through which human interaction emits its events. `tx` is the transaction that
 * writes the approval request, so state and event commit together (outbox).
 *
 * @port
 */
export interface ApprovalEventPublisher<Tx> {
  publish(tx: Tx, event: ApprovalEvent): Promise<void>;
}

export type DecideOutcome = { decided: ApprovalRequest } | { conflict: ApprovalRequest };

/**
 * Human interaction's record of approval requests.
 *
 * @port
 */
export interface ApprovalStore {
  /**
   * Records a pending approval request and publishes `event(request)` with it. When the
   * run already has a request from the same step, returns that one (pending or decided)
   * and publishes nothing.
   */
  open(request: ApprovalRequest, event: (request: ApprovalRequest) => ApprovalEvent): Promise<ApprovalRequest>;
  /**
   * Decides a pending request with the answer labelled `answer` (the caller checks that it
   * is one of the request's) and publishes `event(decided)` with it. Deciding it again
   * with the same answer returns it unchanged without an event; another answer is a
   * `conflict`. Resolves `undefined` for an unknown id.
   */
  decide(
    id: string,
    answer: string,
    decidedAt: string,
    event: (request: ApprovalRequest) => ApprovalEvent,
  ): Promise<DecideOutcome | undefined>;
  get(id: string): Promise<ApprovalRequest | undefined>;
  /** Requests, newest first. */
  list(options?: { status?: ApprovalStatus; limit?: number }): Promise<ApprovalRequest[]>;
}

/** Approval store in memory, for tests; `published` holds the events of its writes. */
export function createInMemoryApprovalStore(): ApprovalStore & { published: ApprovalEvent[] } {
  const requests: ApprovalRequest[] = [];
  const published: ApprovalEvent[] = [];
  const clone = <T>(value: T): T => structuredClone(value);

  return {
    published,
    async open(request, event) {
      const existing = requests.find((known) => known.runId === request.runId && known.step === request.step);
      if (existing) return clone(existing);
      requests.push(clone(request));
      published.push(clone(event(request)));
      return clone(request);
    },
    async decide(id, answer, decidedAt, event) {
      const request = requests.find((known) => known.id === id);
      if (!request) return undefined;
      if (request.status === "pending") {
        Object.assign(request, { status: "decided", answer, decidedAt });
        published.push(clone(event(request)));
        return { decided: clone(request) };
      }
      return request.answer === answer ?{ decided: clone(request) } : { conflict: clone(request) };
    },
    async get(id) {
      const request = requests.find((known) => known.id === id);
      return request && clone(request);
    },
    async list({ status, limit = 100 } = {}) {
      return [...requests]
        .reverse()
        .filter((request) => status === undefined || request.status === status)
        .slice(0, limit)
        .map(clone);
    },
  };
}
