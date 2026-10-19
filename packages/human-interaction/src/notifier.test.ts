import type { RunEvents } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { approvalRequested } from "./approvals/approval-events.js";
import { createInMemoryNotificationChannel, type Notification } from "./notification-channel.js";
import { createInMemoryNotificationStore } from "./notification-store.js";
import { createNotifier } from "./notifier.js";

const envelope = {
  specversion: "1.0" as const,
  source: "/tendworks/orchestration",
  subject: "runs/run-1",
  time: "2026-10-18T10:00:02.000Z",
  datacontenttype: "application/json" as const,
  runid: "run-1",
  traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
};

const completed: RunEvents.RunCompletedEvent = {
  ...envelope,
  id: "run-1:run.completed",
  type: "dev.tendworks.run.completed",
  data: { workflow: "hello-agent" },
};

const failed: RunEvents.RunFailedEvent = {
  ...envelope,
  id: "run-1:run.failed",
  type: "dev.tendworks.run.failed",
  data: {
    workflow: "hello-agent",
    error: {
      type: "https://serverlessworkflow.io/spec/1.0.0/errors/runtime",
      status: 500,
      instance: "/do/0/implement",
      title: "Agent task ended in state TASK_STATE_FAILED",
      detail: "not today",
    },
  },
};

function setup(options: { failDelivery?: boolean } = {}) {
  const store = createInMemoryNotificationStore();
  const channel = createInMemoryNotificationChannel(options);
  const notifier = createNotifier({ store, channel, now: () => new Date("2026-10-18T10:00:03.000Z") });
  return { store, channel, notifier };
}

describe("notifier", () => {
  it("subscribes to run.completed, run.failed and approval.requested", () => {
    expect(setup().notifier.types).toEqual(["dev.tendworks.run.completed", "dev.tendworks.run.failed", "dev.tendworks.approval.requested"]);
  });

  it("records and delivers a notification when a run completed", async () => {
    const { store, channel, notifier } = setup();

    await notifier.handle(completed);

    const [notification] = await store.list();
    expect(notification).toMatchObject({
      kind: "run.completed",
      runId: "run-1",
      title: "Run run-1 of hello-agent completed",
      createdAt: "2026-10-18T10:00:03.000Z",
      delivery: { status: "delivered", attemptedAt: "2026-10-18T10:00:03.000Z" },
    });
    expect(channel.delivered.map((n) => n.id)).toEqual([notification!.id]);
  });

  it("says why a run failed", async () => {
    const { store, notifier } = setup();

    await notifier.handle(failed);

    expect(await store.list()).toEqual([
      expect.objectContaining({
        kind: "run.failed",
        runId: "run-1",
        title: "Run run-1 of hello-agent failed",
        detail: "/do/0/implement: Agent task ended in state TASK_STATE_FAILED: not today",
        delivery: expect.objectContaining({ status: "delivered" }),
      }),
    ]);
  });

  it("tells the human that an approval request waits for a decision", async () => {
    const { store, channel, notifier } = setup();
    const request = {
      id: "approval-1",
      runId: "run-1",
      workflow: "develop-issue",
      action: "merge" as const,
      pullRequest: "https://git.example/acme/app/pull/7",
      policy: "careful",
      question: "Merge https://git.example/acme/app/pull/7 for run run-1 of develop-issue?",
      status: "pending" as const,
      createdAt: "2026-10-18T10:00:02.000Z",
    };

    await notifier.handle(approvalRequested(request, request.createdAt));

    expect(await store.list()).toEqual([
      expect.objectContaining({
        kind: "approval.requested",
        runId: "run-1",
        title: "Approval needed: Merge https://git.example/acme/app/pull/7 for run run-1 of develop-issue?",
        detail: "Answer with: tend approval approve approval-1 (or reject approval-1)",
        delivery: expect.objectContaining({ status: "delivered" }),
      }),
    ]);
    expect(channel.delivered).toHaveLength(1);
  });

  it("records the notification before it attempts delivery", async () => {
    const { store } = setup();
    let storedAtDelivery: Notification[] = [];
    const channel = { deliver: async () => void (storedAtDelivery = await store.list()) };

    await createNotifier({ store, channel }).handle(completed);

    expect(storedAtDelivery).toEqual([expect.objectContaining({ runId: "run-1", delivery: { status: "pending" } })]);
  });

  it("keeps the notification with a failed status when delivery fails", async () => {
    const { store, notifier } = setup({ failDelivery: true });

    await notifier.handle(completed);

    expect(await store.list()).toEqual([
      expect.objectContaining({
        runId: "run-1",
        delivery: { status: "failed", attemptedAt: "2026-10-18T10:00:03.000Z", error: "delivery channel unavailable" },
      }),
    ]);
  });

  it("records and delivers a notification once when the event arrives again", async () => {
    const { store, channel, notifier } = setup();

    await notifier.handle(completed);
    await notifier.handle(completed);

    expect(await store.list()).toHaveLength(1);
    expect(channel.delivered).toHaveLength(1);
  });
});
