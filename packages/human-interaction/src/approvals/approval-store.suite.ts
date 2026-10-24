import { beforeEach, describe, expect, it } from "vitest";
import type { ApprovalEvent, ApprovalRequest, ApprovalStore } from "./approval-store.js";

export interface ApprovalStoreSuiteContext {
  store: ApprovalStore;
  /** Events the store published in committed transactions, oldest first. */
  published(): Promise<ApprovalEvent[]>;
}

/**
 * The behaviour every approval request store must show. Runs against the real adapter
 * and the fake, so the fake stays a faithful stand-in.
 */
export function describeApprovalStore(name: string, setup: () => Promise<ApprovalStoreSuiteContext> | ApprovalStoreSuiteContext) {
  describe(`approval store: ${name}`, () => {
    let context: ApprovalStoreSuiteContext;

    beforeEach(async () => {
      context = await setup();
    });

    const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
      id: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      workflow: "release-app",
      step: "/do/1/confirm",
      action: "deploy",
      policy: "careful",
      question: "Deploy it?",
      links: [{ title: "Release notes", url: "https://git.example/acme/app/releases/1.4" }],
      answers: [
        { label: "Deploy", outcome: "continue" },
        { label: "Cancel", outcome: "stop" },
      ],
      status: "pending",
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      createdAt: "2026-10-19T10:00:00.000Z",
      ...overrides,
    });
    const event = (type: string, subject: ApprovalRequest) =>
      ({
        specversion: "1.0",
        id: `${subject.id}:${type}`,
        source: "/tendworks/test",
        type,
        time: "2026-10-19T10:00:00.000Z",
        datacontenttype: "application/json",
        runid: subject.runId,
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        data: {},
      }) as unknown as ApprovalEvent;
    const requested = (subject: ApprovalRequest) => event("dev.tendworks.approval.requested", subject);
    const decided = (subject: ApprovalRequest) => event("dev.tendworks.approval.decided", subject);
    const ofRun = async (runId: string) => (await context.published()).filter((known) => known.runid === runId).map((known) => known.type);

    it("records a new approval request and publishes its event with it", async () => {
      const first = request();

      const opened = await context.store.open(first, requested);

      expect(opened).toEqual(first);
      expect(await context.store.get(first.id)).toEqual(first);
      expect(await ofRun(first.runId)).toEqual(["dev.tendworks.approval.requested"]);
    });

    it("returns the existing request for the same run and step, without a second event", async () => {
      const first = request();
      await context.store.open(first, requested);

      const again = await context.store.open({ ...first, id: crypto.randomUUID(), question: "again" }, requested);

      expect(again).toEqual(first);
      expect(await ofRun(first.runId)).toEqual(["dev.tendworks.approval.requested"]);
    });

    it("keeps one request per step, also for the same action", async () => {
      const first = request();
      const second = request({ runId: first.runId, step: "/do/3/confirmAgain" });
      await context.store.open(first, requested);

      expect(await context.store.open(second, requested)).toEqual(second);
      expect(await ofRun(first.runId)).toEqual(["dev.tendworks.approval.requested", "dev.tendworks.approval.requested"]);
    });

    it("keeps a request without links and policy as it is", async () => {
      const { policy: _policy, ...bare } = request({ links: [] });

      await context.store.open(bare, requested);

      expect(await context.store.get(bare.id)).toEqual(bare);
    });

    it("decides a pending request once and publishes the decision with it", async () => {
      const first = request();
      await context.store.open(first, requested);

      const outcome = await context.store.decide(first.id, "Deploy", "2026-10-19T10:05:00.000Z", decided);
      const repeated = await context.store.decide(first.id, "Deploy", "2026-10-19T10:06:00.000Z", decided);

      const deployed = { ...first, status: "decided", answer: "Deploy", decidedAt: "2026-10-19T10:05:00.000Z" };
      expect(outcome).toEqual({ decided: deployed });
      expect(repeated).toEqual({ decided: deployed });
      expect(await ofRun(first.runId)).toEqual(["dev.tendworks.approval.requested", "dev.tendworks.approval.decided"]);
    });

    it("refuses to decide a decided request with another answer", async () => {
      const first = request();
      await context.store.open(first, requested);
      await context.store.decide(first.id, "Cancel", "2026-10-19T10:05:00.000Z", decided);

      const outcome = await context.store.decide(first.id, "Deploy", "2026-10-19T10:06:00.000Z", decided);

      expect(outcome).toEqual({ conflict: { ...first, status: "decided", answer: "Cancel", decidedAt: "2026-10-19T10:05:00.000Z" } });
    });

    it("knows no decision for an unknown request", async () => {
      expect(await context.store.decide(crypto.randomUUID(), "Deploy", "2026-10-19T10:05:00.000Z", decided)).toBeUndefined();
      expect(await context.store.get(crypto.randomUUID())).toBeUndefined();
    });

    it("lists requests newest first, optionally only those with a status", async () => {
      const older = request();
      const newer = request();
      await context.store.open(older, requested);
      await context.store.open(newer, requested);
      await context.store.decide(newer.id, "Deploy", "2026-10-19T10:05:00.000Z", decided);

      const ids = (list: ApprovalRequest[]) => list.map((known) => known.id).filter((id) => id === older.id || id === newer.id);
      expect(ids(await context.store.list())).toEqual([newer.id, older.id]);
      expect(ids(await context.store.list({ status: "pending" }))).toEqual([older.id]);
    });
  });
}
