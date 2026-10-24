import type { RunEvents } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { approvalRequested } from "./approvals/approval-events.js";
import type { ApprovalRequest } from "./approvals/approval-store.js";
import { createFakeNotificationDelivery, type Notification, type NotificationDelivery } from "./notification-delivery.js";
import { createInMemoryNotificationStore } from "./notification-store.js";
import { createNotifier, type NotifierChannel } from "./notifier.js";

const envelope = {
  specversion: "1.0" as const,
  source: "/tendworks/orchestration",
  subject: "runs/run-1",
  time: "2026-10-18T10:00:02.000Z",
  datacontenttype: "application/json" as const,
  runid: "run-1",
  traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
};

const PULL_REQUEST = { name: "pull-request", url: "https://git.example/acme/app/pull/7", description: "Add the login screen" };

const completed: RunEvents.RunCompletedEvent = {
  ...envelope,
  id: "run-1:run.completed",
  type: "dev.tendworks.run.completed",
  data: { workflow: "develop-issue", artifacts: [PULL_REQUEST] },
};

const failed: RunEvents.RunFailedEvent = {
  ...envelope,
  id: "run-1:run.failed",
  type: "dev.tendworks.run.failed",
  data: {
    workflow: "develop-issue",
    error: {
      type: "https://serverlessworkflow.io/spec/1.0.0/errors/runtime",
      status: 500,
      instance: "/do/0/implement",
      title: "Agent task ended in state TASK_STATE_FAILED",
      detail: "not today",
    },
    artifacts: [],
  },
};

const request: ApprovalRequest = {
  id: "approval-1",
  runId: "run-1",
  workflow: "release-app",
  step: "/do/1/confirm",
  action: "deploy",
  policy: "careful",
  question: "Deploy release 1.4 for run run-1 of release-app?",
  links: [],
  answers: [
    { label: "Deploy", outcome: "continue" },
    { label: "Cancel", outcome: "stop" },
  ],
  status: "pending",
  createdAt: "2026-10-18T10:00:02.000Z",
};

const EVERYTHING = ["approval.requested", "run.failed", "run.completed"] as const;
const quiet = (options: { refuse?: boolean } = {}) => createFakeNotificationDelivery({ ...options, log: () => {} });

function setup(channels: NotifierChannel[] = [{ name: "log", events: EVERYTHING, delivery: quiet() }]) {
  const store = createInMemoryNotificationStore();
  const notifier = createNotifier({ store, channels, now: () => new Date("2026-10-18T10:00:03.000Z") });
  return { store, notifier };
}

const delivered = (channel: string) => ({ channel, status: "delivered", attemptedAt: "2026-10-18T10:00:03.000Z" });

describe("notifier", () => {
  it("subscribes to run.completed, run.failed and approval.requested", () => {
    expect(setup().notifier.types).toEqual(["dev.tendworks.run.completed", "dev.tendworks.run.failed", "dev.tendworks.approval.requested"]);
  });

  it("records a completed run's notification with the artifacts its steps reported, and delivers it", async () => {
    const delivery = quiet();
    const { store, notifier } = setup([{ name: "log", events: ["run.completed"], delivery }]);

    await notifier.handle(completed);

    const [notification] = await store.list();
    expect(notification).toMatchObject({
      kind: "run.completed",
      runId: "run-1",
      title: "Run run-1 of develop-issue completed",
      artifacts: [PULL_REQUEST],
      createdAt: "2026-10-18T10:00:03.000Z",
      deliveries: [delivered("log")],
    });
    expect(delivery.delivered).toEqual([{ ...notification, deliveries: [{ channel: "log", status: "pending" }] }]);
  });

  it("says why a run failed, with the artifacts reported before it failed", async () => {
    const { store, notifier } = setup();

    await notifier.handle({ ...failed, data: { ...failed.data, artifacts: [PULL_REQUEST] } });

    expect(await store.list()).toEqual([
      expect.objectContaining({
        kind: "run.failed",
        title: "Run run-1 of develop-issue failed",
        detail: "/do/0/implement: Agent task ended in state TASK_STATE_FAILED: not today",
        artifacts: [PULL_REQUEST],
        deliveries: [delivered("log")],
      }),
    ]);
  });

  it("tells the human that an approval request waits for an answer", async () => {
    const { store, notifier } = setup();

    await notifier.handle(approvalRequested(request, request.createdAt));

    const [notification] = await store.list();
    expect(notification).toMatchObject({
      kind: "approval.requested",
      runId: "run-1",
      title: "Approval needed: Deploy release 1.4 for run run-1 of release-app?",
      detail: 'Answers: "Deploy", "Cancel". Answer with: tend approval answer approval-1 "<answer>"',
      deliveries: [delivered("log")],
    });
    expect(notification).not.toHaveProperty("artifacts");
  });

  it("links an approval request's links in its notification, so a channel's tap opens the first", async () => {
    const { store, notifier } = setup();
    const links = [
      { title: "Pull request", url: "https://git.example/acme/app/pull/7" },
      { title: "Release notes", url: "https://git.example/acme/app/releases/1.4" },
    ];

    await notifier.handle(approvalRequested({ ...request, links }, request.createdAt));

    const [notification] = await store.list();
    expect(notification?.artifacts).toEqual([
      { name: "Pull request", url: "https://git.example/acme/app/pull/7" },
      { name: "Release notes", url: "https://git.example/acme/app/releases/1.4" },
    ]);
  });

  it("delivers to every channel that selects the notification's kind, and only to those", async () => {
    const phone = quiet();
    const pager = quiet();
    const log = quiet();
    const { store, notifier } = setup([
      { name: "phone", events: ["run.failed", "approval.requested"], delivery: phone },
      { name: "pager", events: ["run.failed"], delivery: pager },
      { name: "log", events: ["run.completed"], delivery: log },
    ]);

    await notifier.handle(failed);
    await notifier.handle(approvalRequested(request, request.createdAt));

    const [approval, failure] = await store.list();
    expect(failure?.deliveries).toEqual([delivered("pager"), delivered("phone")]);
    expect(approval?.deliveries).toEqual([delivered("phone")]);
    expect([phone.delivered.length, pager.delivered.length, log.delivered.length]).toEqual([2, 1, 0]);
  });

  it("records a notification no channel selects, with no deliveries", async () => {
    const { store, notifier } = setup([{ name: "log", events: ["run.failed"], delivery: quiet() }]);

    await notifier.handle(completed);

    expect(await store.list()).toEqual([expect.objectContaining({ kind: "run.completed", deliveries: [] })]);
  });

  it("records the notification before it attempts delivery", async () => {
    const store = createInMemoryNotificationStore();
    let storedAtDelivery: Notification[] = [];
    const delivery: NotificationDelivery = { deliver: async () => void (storedAtDelivery = await store.list()) };

    await createNotifier({ store, channels: [{ name: "log", events: EVERYTHING, delivery }] }).handle(completed);

    expect(storedAtDelivery).toEqual([expect.objectContaining({ runId: "run-1", deliveries: [{ channel: "log", status: "pending" }] })]);
  });

  it("records a failed delivery on its channel, and still delivers to the others", async () => {
    const working = quiet();
    const { store, notifier } = setup([
      { name: "broken", events: EVERYTHING, delivery: quiet({ refuse: true }) },
      { name: "working", events: EVERYTHING, delivery: working },
    ]);

    await notifier.handle(completed);

    expect((await store.list())[0]?.deliveries).toEqual([
      { channel: "broken", status: "failed", attemptedAt: "2026-10-18T10:00:03.000Z", error: "the fake channel refuses every notification" },
      delivered("working"),
    ]);
    expect(working.delivered).toHaveLength(1);
  });

  it("records and delivers a notification once when the event arrives again", async () => {
    const delivery = quiet();
    const { store, notifier } = setup([{ name: "log", events: EVERYTHING, delivery }]);

    await notifier.handle(completed);
    await notifier.handle(completed);

    expect(await store.list()).toHaveLength(1);
    expect(delivery.delivered).toHaveLength(1);
  });

  it("delivers on a redelivered event to the channels still pending, e.g. after a crash mid-delivery", async () => {
    const store = createInMemoryNotificationStore();
    const channels = (a: NotificationDelivery, b: NotificationDelivery): NotifierChannel[] => [
      { name: "a", events: EVERYTHING, delivery: a },
      { name: "b", events: EVERYTHING, delivery: b },
    ];
    await createNotifier({ store, channels: channels(quiet(), quiet()) }).handle(completed);
    // As if the process had died after delivering to a, before b's outcome was stored.
    await store.updateDelivery((await store.list())[0]!.id, { channel: "b", status: "pending" });

    const a = quiet();
    const b = quiet();
    await createNotifier({ store, channels: channels(a, b) }).handle(completed);

    expect([a.delivered.length, b.delivered.length]).toEqual([0, 1]);
    expect((await store.list())[0]?.deliveries.map(({ status }) => status)).toEqual(["delivered", "delivered"]);
  });
});
