import type { PlatformEvents, RunEvents } from "@tendworks/shared";
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
  question: "Deploy release 1.4?",
  links: [],
  answers: [
    { label: "Deploy", outcome: "continue" },
    { label: "Cancel", outcome: "stop" },
  ],
  status: "pending",
  createdAt: "2026-10-18T10:00:02.000Z",
};

const LONG_RUN = "3f2a9c1e-4b7d-4e2a-8c1f-5d6e7f8a9b0c";
const ISSUE = { kind: "trigger" as const, binding: "ready-issues", workspace: "app", item: { key: "#42", title: "Fix login", url: "https://git.example/acme/app/issues/42" } };
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
  it("subscribes to run.started, run.completed, run.failed, approval.requested and platform.health-changed", () => {
    expect(setup().notifier.types).toEqual([
      "dev.tendworks.run.started",
      "dev.tendworks.run.completed",
      "dev.tendworks.run.failed",
      "dev.tendworks.approval.requested",
      "dev.tendworks.platform.health-changed",
    ]);
  });

  describe("platform.health-changed", () => {
    const healthEvent = (id: string, data: PlatformEvents.PlatformHealthChangedEvent["data"]): PlatformEvents.PlatformHealthChangedEvent => ({
      specversion: "1.0",
      id,
      source: "/tendworks/control-plane",
      subject: "platform/health",
      time: "2026-10-18T10:00:02.000Z",
      datacontenttype: "application/json",
      traceparent: envelope.traceparent,
      type: "dev.tendworks.platform.health-changed",
      data,
    });
    const degraded = healthEvent("health-changed:1", {
      status: "unhealthy",
      components: [
        { name: "worker", status: "unhealthy", message: "connection refused" },
        { name: "store", status: "unhealthy", message: "timeout" },
      ],
    });
    const recovered = healthEvent("health-changed:2", { status: "healthy", components: [{ name: "worker", status: "healthy" }] });

    it("turns an unhealthy platform into platform.degraded naming the components and their messages, and delivers it to the platform's subscribers", async () => {
      const delivery = quiet();
      const runOf = async () => {
        throw new Error("a platform event belongs to no run");
      };
      const { store, notifier } = setup([{ name: "log", delivery }], [platform(["log"], ["platform.degraded", "platform.recovered"], 1)], runOf);

      await notifier.handle(degraded);

      const [notification] = await store.list();
      expect(notification).toMatchObject({
        kind: "platform.degraded",
        title: "Platform degraded: worker, store",
        detail: "worker: connection refused; store: timeout",
        deliveries: [delivered("log")],
      });
      expect(notification).not.toHaveProperty("runId");
      expect(delivery.delivered).toHaveLength(1);
    });

    it("turns a healthy platform into platform.recovered naming the components that recovered", async () => {
      const { store, notifier } = setup([{ name: "log", delivery: quiet() }], [platform(["log"], ["platform.recovered"])]);

      await notifier.handle(recovered);

      expect((await store.list())[0]).toMatchObject({ kind: "platform.recovered", title: "Platform recovered: worker", deliveries: [delivered("log")] });
    });

    it("only lists the change when no platform subscription selects it, and never delivers it to a workspace's subscribers", async () => {
      const delivery = quiet();
      const { store, notifier } = setup([{ name: "log", delivery }], [project("app", ["log"], ["run.failed"]), platform(["log"], ["platform.recovered"])]);

      await notifier.handle(degraded);

      expect((await store.list())[0]).toMatchObject({ kind: "platform.degraded", deliveries: [] });
      expect(delivery.delivered).toEqual([]);
    });

    it("records a redelivered event once", async () => {
      const { store, notifier } = setup([{ name: "log", delivery: quiet() }], [platform(["log"], ["platform.degraded"])]);

      await notifier.handle(degraded);
      await notifier.handle(degraded);

      expect(await store.list()).toHaveLength(1);
    });
  });

  describe("run.started", () => {
    const started: RunEvents.RunStartedEvent = { ...envelope, id: "run-1:run.started", type: "dev.tendworks.run.started", data: { workflow: "develop-issue" } };
    const issue = { kind: "trigger" as const, binding: "ready-issues", workspace: "app", item: { key: "acme/app#7", title: "Fix the login", url: "https://git.example/acme/app/issues/7" } };

    it("names the status, the workspace and workflow and the triggering item in the title, and links the item", async () => {
      const delivery = quiet();
      const { store, notifier } = setup([{ name: "log", delivery }], [project("app", ["log"], ["run.started"])], async () => ({ workspace: "app", origin: issue }));

      await notifier.handle({ ...started, runid: LONG_RUN });

      const [notification] = await store.list();
      expect(notification).toMatchObject({
        kind: "run.started",
        runId: LONG_RUN,
        title: "Started · app/develop-issue · acme/app#7 Fix the login",
        detail: "acme/app#7: https://git.example/acme/app/issues/7\nRun 3f2a9c1e",
        artifacts: [{ name: "acme/app#7", url: "https://git.example/acme/app/issues/7", description: "Fix the login" }],
        deliveries: [delivered("log")],
      });
      expect(delivery.delivered).toHaveLength(1);
    });

    it("names only the status and the workflow of a manual run without a workspace, and links nothing", async () => {
      const { store, notifier } = setup(undefined, undefined, async () => ({ origin: { kind: "manual" } }));

      await notifier.handle(started);

      const [notification] = await store.list();
      expect(notification).toMatchObject({ title: "Started · develop-issue", detail: "Run run-1" });
      expect(notification).not.toHaveProperty("artifacts");
    });

    it("names the run a retry retries, shortened, on the last line", async () => {
      const { store, notifier } = setup(undefined, undefined, async () => ({ workspace: "app", origin: { ...issue, retryOf: "9b1c0d2e-7a4f-4c1e-9d3b-0e5f6a7b8c9d" } }));

      await notifier.handle({ ...started, runid: LONG_RUN });

      const [notification] = await store.list();
      expect(notification?.detail).toBe("acme/app#7: https://git.example/acme/app/issues/7\nRun 3f2a9c1e (retry of 9b1c0d2e)");
      expect(notification?.artifacts).toEqual([{ name: "acme/app#7", url: "https://git.example/acme/app/issues/7", description: "Fix the login" }]);
    });

    it("links nothing when the origin has no link", async () => {
      const { store, notifier } = setup(undefined, undefined, async () => ({ origin: { ...issue, item: { key: issue.item.key, title: issue.item.title } } }));

      await notifier.handle(started);

      const [notification] = await store.list();
      expect(notification).toMatchObject({ title: "Started · develop-issue · acme/app#7 Fix the login", detail: "Run run-1" });
      expect(notification).not.toHaveProperty("artifacts");
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
      title: "Completed · develop-issue",
      detail: "pull-request: https://git.example/acme/app/pull/7\nRun run-1",
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
        title: "Failed · develop-issue",
        detail: "/do/0/implement: Agent task ended in state TASK_STATE_FAILED: not today\npull-request: https://git.example/acme/app/pull/7\nRun run-1",
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
      title: "Approval needed · release-app · Deploy release 1.4?",
      detail: 'Answers: "Deploy", "Cancel". Answer with: tend approval answer approval-1 "<answer>"\nRun run-1',
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

  it("lists the triggering item before a completed run's artifacts, yet keeps the first artifact first to link", async () => {
    const { store, notifier } = setup(undefined, undefined, async () => ({ workspace: "tendworks", origin: ISSUE }));

    await notifier.handle({ ...completed, runid: LONG_RUN });

    const [notification] = await store.list();
    expect(notification).toMatchObject({
      title: "Completed · tendworks/develop-issue · #42 Fix login",
      detail: "#42: https://git.example/acme/app/issues/42\npull-request: https://git.example/acme/app/pull/7\nRun 3f2a9c1e",
      artifacts: [PULL_REQUEST, { name: "#42", url: "https://git.example/acme/app/issues/42", description: "Fix login" }],
    });
    expect(`${notification?.title}\n${notification?.detail}`).not.toContain(LONG_RUN);
  });

  it("links the triggering item of a failed run without artifacts, and names the run it retries", async () => {
    const { store, notifier } = setup(undefined, undefined, async () => ({ workspace: "tendworks", origin: { ...ISSUE, retryOf: "9b1c0d2e-0000-4000-8000-000000000000" } }));

    await notifier.handle({ ...failed, runid: LONG_RUN, data: { ...failed.data, error: { ...failed.data.error, instance: "develop", title: "Sandbox exited with code 137" }, artifacts: [] } });

    expect((await store.list())[0]).toMatchObject({
      title: "Failed · tendworks/develop-issue · #42 Fix login",
      detail: "develop: Sandbox exited with code 137: not today\n#42: https://git.example/acme/app/issues/42\nRun 3f2a9c1e (retry of 9b1c0d2e)",
      artifacts: [{ name: "#42", url: "https://git.example/acme/app/issues/42", description: "Fix login" }],
    });
  });

  it("names a completed run's workspace without an item, and keeps no artifacts empty", async () => {
    const { store, notifier } = setup(undefined, undefined, async () => ({ workspace: "app", origin: { kind: "manual" } }));

    await notifier.handle({ ...completed, data: { ...completed.data, artifacts: [] } });

    expect((await store.list())[0]).toMatchObject({ title: "Completed · app/develop-issue", detail: "Run run-1", artifacts: [] });
  });

  it("names an approval's workspace and workflow and its question, with its links and the run it retries", async () => {
    const { store, notifier } = setup(undefined, undefined, async () => ({ workspace: "tendworks", origin: { ...ISSUE, retryOf: "9b1c0d2e-0000" } }));
    const links = [{ title: "Release notes", url: "https://git.example/acme/app/releases/1.4" }];

    await notifier.handle(approvalRequested({ ...request, runId: LONG_RUN, links }, request.createdAt));

    expect((await store.list())[0]).toMatchObject({
      title: "Approval needed · tendworks/release-app · Deploy release 1.4?",
      detail: 'Answers: "Deploy", "Cancel". Answer with: tend approval answer approval-1 "<answer>"\nRelease notes: https://git.example/acme/app/releases/1.4\nRun 3f2a9c1e (retry of 9b1c0d2e)',
      artifacts: [{ name: "Release notes", url: "https://git.example/acme/app/releases/1.4" }],
    });
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
