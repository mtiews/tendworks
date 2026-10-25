import type { RunEvents } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { approvalRequested } from "./approvals/approval-events.js";
import type { ApprovalRequest } from "./approvals/approval-store.js";
import { createFakeNotificationDelivery, type Notification, type NotificationDelivery } from "./notification-delivery.js";
import { createInMemoryNotificationStore } from "./notification-store.js";
import { createNotifier, type NotifierChannel, type NotifierRun, type NotifierSubscription } from "./notifier.js";

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

const EVERYTHING: NotifierSubscription["events"] = ["approval.requested", "run.failed", "run.completed"];
const quiet = (options: { refuse?: boolean } = {}) => createFakeNotificationDelivery({ ...options, log: () => {} });

/** A subscription of the platform scope (runs without a workspace) to the given channels. */
const platform = (channels: NotifierSubscription["channels"], events: NotifierSubscription["events"] = EVERYTHING, priority?: number): NotifierSubscription => ({
  scope: { platform: {} },
  events,
  channels,
  ...(priority === undefined ? {} : { priority }),
});
const project = (workspace: string, channels: NotifierSubscription["channels"], events: NotifierSubscription["events"] = EVERYTHING, priority?: number): NotifierSubscription => ({
  scope: { workspace },
  events,
  channels,
  ...(priority === undefined ? {} : { priority }),
});

function setup(
  channels: NotifierChannel[] = [{ name: "log", delivery: quiet() }],
  subscriptions: NotifierSubscription[] = channels.map(({ name }) => platform([name])),
  runOf?: (runId: string) => Promise<NotifierRun>,
) {
  const store = createInMemoryNotificationStore();
  const notifier = createNotifier({ store, channels, subscriptions, ...(runOf ? { runOf } : {}), now: () => new Date("2026-10-18T10:00:03.000Z") });
  return { store, notifier };
}

const delivered = (channel: string) => ({ channel, status: "delivered", attemptedAt: "2026-10-18T10:00:03.000Z" });

describe("notifier", () => {
  it("subscribes to run.started, run.completed, run.failed and approval.requested", () => {
    expect(setup().notifier.types).toEqual(["dev.tendworks.run.started", "dev.tendworks.run.completed", "dev.tendworks.run.failed", "dev.tendworks.approval.requested"]);
  });

  describe("run.started", () => {
    const started: RunEvents.RunStartedEvent = { ...envelope, id: "run-1:run.started", type: "dev.tendworks.run.started", data: { workflow: "develop-issue" } };
    const issue = { kind: "trigger" as const, binding: "ready-issues", workspace: "app", item: { key: "acme/app#7", title: "Fix the login", url: "https://git.example/acme/app/issues/7" } };

    it("names the workflow, the workspace and the origin's title, and links the origin", async () => {
      const delivery = quiet();
      const { store, notifier } = setup([{ name: "log", delivery }], [project("app", ["log"], ["run.started"])], async () => ({ workspace: "app", origin: issue }));

      await notifier.handle(started);

      const [notification] = await store.list();
      expect(notification).toMatchObject({
        kind: "run.started",
        runId: "run-1",
        title: "Run run-1 of develop-issue started",
        detail: "Workspace: app. Started by: Fix the login (acme/app#7)",
        artifacts: [{ name: "acme/app#7", url: "https://git.example/acme/app/issues/7", description: "Fix the login" }],
        deliveries: [delivered("log")],
      });
      expect(delivery.delivered).toHaveLength(1);
    });

    it("says that a manual run was started manually, and links nothing", async () => {
      const { store, notifier } = setup(undefined, undefined, async () => ({ origin: { kind: "manual" } }));

      await notifier.handle(started);

      const [notification] = await store.list();
      expect(notification?.detail).toBe("Started by: manual");
      expect(notification).not.toHaveProperty("artifacts");
    });

    it("links nothing when the origin has no link", async () => {
      const { store, notifier } = setup(undefined, undefined, async () => ({ origin: { ...issue, item: { key: issue.item.key, title: issue.item.title } } }));

      await notifier.handle(started);

      expect((await store.list())[0]).not.toHaveProperty("artifacts");
    });

    it("only lists a start nobody subscribed to", async () => {
      const delivery = quiet();
      const { store, notifier } = setup([{ name: "log", delivery }], [project("app", ["log"], ["run.completed"])], async () => ({ workspace: "app", origin: issue }));

      await notifier.handle(started);

      expect(await store.list()).toEqual([expect.objectContaining({ kind: "run.started", deliveries: [] })]);
      expect(delivery.delivered).toEqual([]);
    });
  });

  it("records a completed run's notification with the artifacts its steps reported, and delivers it", async () => {
    const delivery = quiet();
    const { store, notifier } = setup([{ name: "log", delivery }], [platform(["log"], ["run.completed"])]);

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

  it("delivers to every channel a matching subscription names, and only to those", async () => {
    const phone = quiet();
    const pager = quiet();
    const log = quiet();
    const { store, notifier } = setup(
      [
        { name: "phone", delivery: phone },
        { name: "pager", delivery: pager },
        { name: "log", delivery: log },
      ],
      [platform(["phone"], ["run.failed", "approval.requested"]), platform(["pager"], ["run.failed"]), platform(["log"], ["run.completed"])],
    );

    await notifier.handle(failed);
    await notifier.handle(approvalRequested(request, request.createdAt));

    const [approval, failure] = await store.list();
    expect(failure?.deliveries).toEqual([delivered("pager"), delivered("phone")]);
    expect(approval?.deliveries).toEqual([delivered("phone")]);
    expect([phone.delivered.length, pager.delivered.length, log.delivered.length]).toEqual([2, 1, 0]);
  });

  it("delivers a workspace's events through that workspace's subscriptions only", async () => {
    const mine = quiet();
    const theirs = quiet();
    const health = quiet();
    const { store, notifier } = setup(
      [
        { name: "mine", delivery: mine },
        { name: "theirs", delivery: theirs },
        { name: "health", delivery: health },
      ],
      [project("app", ["mine"]), project("other", ["theirs"]), platform(["health"])],
      async () => ({ workspace: "app" }),
    );

    await notifier.handle(completed);

    expect((await store.list())[0]?.deliveries).toEqual([delivered("mine")]);
    expect([mine.delivered.length, theirs.delivered.length, health.delivered.length]).toEqual([1, 0, 0]);
  });

  it("puts the events of a run without a workspace in the platform scope", async () => {
    const mine = quiet();
    const health = quiet();
    const { store, notifier } = setup(
      [
        { name: "mine", delivery: mine },
        { name: "health", delivery: health },
      ],
      [project("app", ["mine"]), platform(["health"])],
      async () => ({}),
    );

    await notifier.handle(completed);

    expect((await store.list())[0]?.deliveries).toEqual([delivered("health")]);
    expect([mine.delivered.length, health.delivered.length]).toEqual([0, 1]);
  });

  it("asks for the run the event is about", async () => {
    const asked: string[] = [];
    const { notifier } = setup(undefined, undefined, async (runId) => (asked.push(runId), {}));

    await notifier.handle(completed);

    expect(asked).toEqual(["run-1"]);
  });

  it("delivers once per channel when several subscriptions match, with the highest priority", async () => {
    const phone = quiet();
    const calls: (number | undefined)[] = [];
    const delivery: NotificationDelivery = { deliver: async (notification, options) => (calls.push(options?.priority), phone.deliver(notification)) };
    const { store, notifier } = setup(
      [{ name: "phone", delivery }],
      [project("app", ["phone"], ["run.completed"], -1), project("app", ["phone"], ["run.completed", "run.failed"], 1), project("app", ["phone"], ["run.completed"])],
      async () => ({ workspace: "app" }),
    );

    await notifier.handle(completed);

    expect(phone.delivered).toHaveLength(1);
    expect(calls).toEqual([1]);
    expect((await store.list())[0]?.deliveries).toEqual([delivered("phone")]);
  });

  it("falls back to the channel's default priority, and to none", async () => {
    const calls: Record<string, number | undefined> = {};
    const spy = (name: string): NotificationDelivery => ({ deliver: async (_, options) => void (calls[name] = options?.priority) });
    const { notifier } = setup(
      [
        { name: "quiet", priority: -1, delivery: spy("quiet") },
        { name: "plain", delivery: spy("plain") },
        { name: "urgent", priority: -1, delivery: spy("urgent") },
      ],
      [platform(["quiet", "plain"]), platform(["urgent"], EVERYTHING, 1)],
    );

    await notifier.handle(completed);

    expect(calls).toEqual({ quiet: -1, plain: undefined, urgent: 1 });
  });

  it("records a notification no subscription selects, with no deliveries", async () => {
    const delivery = quiet();
    const { store, notifier } = setup([{ name: "log", delivery }], [platform(["log"], ["run.failed"])]);

    await notifier.handle(completed);

    expect(await store.list()).toEqual([expect.objectContaining({ kind: "run.completed", deliveries: [] })]);
    expect(delivery.delivered).toEqual([]);
  });

  it("lists every notifiable event without any subscription, and delivers none", async () => {
    const delivery = quiet();
    const { store, notifier } = setup([{ name: "log", delivery }], []);

    await notifier.handle(completed);
    await notifier.handle(failed);
    await notifier.handle(approvalRequested(request, request.createdAt));

    expect((await store.list()).map(({ kind, deliveries }) => [kind, deliveries])).toEqual([
      ["approval.requested", []],
      ["run.failed", []],
      ["run.completed", []],
    ]);
    expect(delivery.delivered).toEqual([]);
  });

  it("records the notification before it attempts delivery", async () => {
    const store = createInMemoryNotificationStore();
    let storedAtDelivery: Notification[] = [];
    const delivery: NotificationDelivery = { deliver: async () => void (storedAtDelivery = await store.list()) };

    await createNotifier({ store, channels: [{ name: "log", delivery }], subscriptions: [platform(["log"])] }).handle(completed);

    expect(storedAtDelivery).toEqual([expect.objectContaining({ runId: "run-1", deliveries: [{ channel: "log", status: "pending" }] })]);
  });

  it("records a failed delivery on its channel, and still delivers to the others", async () => {
    const working = quiet();
    const { store, notifier } = setup([
      { name: "broken", delivery: quiet({ refuse: true }) },
      { name: "working", delivery: working },
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
    const { store, notifier } = setup([{ name: "log", delivery }]);

    await notifier.handle(completed);
    await notifier.handle(completed);

    expect(await store.list()).toHaveLength(1);
    expect(delivery.delivered).toHaveLength(1);
  });

  it("delivers on a redelivered event to the channels still pending, e.g. after a crash mid-delivery", async () => {
    const store = createInMemoryNotificationStore();
    const channels = (a: NotificationDelivery, b: NotificationDelivery): NotifierChannel[] => [
      { name: "a", delivery: a },
      { name: "b", delivery: b },
    ];
    const subscriptions = [platform(["a", "b"])];
    await createNotifier({ store, channels: channels(quiet(), quiet()), subscriptions }).handle(completed);
    // As if the process had died after delivering to a, before b's outcome was stored.
    await store.updateDelivery((await store.list())[0]!.id, { channel: "b", status: "pending" });

    const a = quiet();
    const b = quiet();
    await createNotifier({ store, channels: channels(a, b), subscriptions }).handle(completed);

    expect([a.delivered.length, b.delivered.length]).toEqual([0, 1]);
    expect((await store.list())[0]?.deliveries.map(({ status }) => status)).toEqual(["delivered", "delivered"]);
  });
});
