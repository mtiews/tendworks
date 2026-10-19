import type { TriggerBinding } from "@tendworks/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryFiringStore, createInMemoryRunStarter, createTriggerGateway } from "./index.js";

type Binding = TriggerBinding.TriggerBinding;
type Issue = TriggerBinding.Issue;

const issue = (number: number, overrides: Partial<Issue> = {}): Issue => ({
  repository: "acme/playground",
  number,
  title: `Issue ${number}`,
  state: "open",
  labels: ["ready-for-agent"],
  url: `https://issues.example/acme/playground/${number}`,
  ...overrides,
});

const binding = (issues: Issue[], spec: Partial<Binding["spec"]> = {}): Binding => ({
  apiVersion: "tendworks.dev/v1",
  kind: "TriggerBinding",
  metadata: { name: "ready-issues" },
  spec: {
    schedule: { every: { minutes: 5 } },
    source: {
      integration: "fake",
      issues: { repository: "acme/playground", labels: ["ready-for-agent"], state: "open" },
      fake: { issues },
    },
    workflow: "implement-issue",
    ...spec,
  },
});

function setup(bindings: Binding[]) {
  const runs = createInMemoryRunStarter();
  const store = createInMemoryFiringStore();
  const gateway = createTriggerGateway({ bindings, store, runs, now: () => new Date("2026-10-18T10:02:30.000Z") });
  return { runs, store, gateway };
}

describe("trigger gateway schedule", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-18T10:02:30.000Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks each binding at its scheduled executions once started, and no more once stopped", async () => {
    const runs = createInMemoryRunStarter();
    const store = createInMemoryFiringStore();
    const issues = [issue(1)];
    const gateway = createTriggerGateway({
      bindings: [binding([])],
      store,
      runs,
      issueTrackers: () => ({ findIssues: async () => issues }),
      log: () => {},
    });

    gateway.start();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(runs.started).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30_000); // 10:05:00
    expect(runs.started).toHaveLength(1);
    expect((await gateway.triggers())[0]?.nextExecutionAt).toBe("2026-10-18T10:10:00.000Z");

    issues.push(issue(2));
    await vi.advanceTimersByTimeAsync(5 * 60_000); // 10:10:00
    expect(runs.started).toHaveLength(2);

    await gateway.stop();
    issues.push(issue(3));
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runs.started).toHaveLength(2);
  });

  it("reports a check whose issue tracker fails and keeps checking at the next executions", async () => {
    const runs = createInMemoryRunStarter();
    const lines: string[] = [];
    let rateLimited = true;
    const gateway = createTriggerGateway({
      bindings: [binding([])],
      store: createInMemoryFiringStore(),
      runs,
      issueTrackers: () => ({
        findIssues: async () => {
          if (rateLimited) throw new Error("GitHub rate limit exhausted; it resets at 2026-10-18T10:07:00.000Z");
          return [issue(1)];
        },
      }),
      log: (line) => lines.push(line),
    });

    gateway.start();
    await vi.advanceTimersByTimeAsync(2.5 * 60_000); // 10:05:00
    expect(lines).toEqual(["trigger ready-issues: check failed: GitHub rate limit exhausted; it resets at 2026-10-18T10:07:00.000Z"]);
    expect(runs.started).toHaveLength(0);

    rateLimited = false;
    await vi.advanceTimersByTimeAsync(5 * 60_000); // 10:10:00
    expect(runs.started).toHaveLength(1);
    await gateway.stop();
  });
});

describe("trigger gateway", () => {
  it("starts one run of the bound workflow per matching issue, with the mapped input", async () => {
    const { runs, gateway } = setup([
      binding([issue(1), issue(2, { labels: [] }), issue(3, { state: "closed" }), issue(4, { repository: "acme/other" }), issue(5)], {
        input: { issue: { number: "${ .issue.number }", title: "${ .issue.title }" }, mode: "auto" },
      }),
    ]);

    await gateway.check("ready-issues");

    expect(runs.started).toEqual([
      expect.objectContaining({ workflow: "implement-issue", input: { issue: { number: 1, title: "Issue 1" }, mode: "auto" } }),
      expect.objectContaining({ workflow: "implement-issue", input: { issue: { number: 5, title: "Issue 5" }, mode: "auto" } }),
    ]);
  });

  it("passes the whole issue as input when the binding maps none", async () => {
    const { runs, gateway } = setup([binding([issue(1)])]);

    await gateway.check("ready-issues");

    expect(runs.started).toEqual([expect.objectContaining({ workflow: "implement-issue", input: { issue: issue(1) } })]);
  });

  it("never starts a second run for an issue, also after a restart", async () => {
    const { runs, store, gateway } = setup([binding([issue(1)])]);
    await gateway.check("ready-issues");

    await gateway.check("ready-issues");
    const restarted = createTriggerGateway({ bindings: [binding([issue(1), issue(2)])], store, runs });
    await restarted.check("ready-issues");

    expect(runs.started.map((run) => (run.input.issue as Issue).number)).toEqual([1, 2]);
  });

  it("records each fired trigger as a trigger.fired event referencing the issue and the run", async () => {
    const { store, gateway } = setup([binding([issue(1, { title: "Fix the login" })])]);

    await gateway.check("ready-issues");
    await gateway.check("ready-issues");

    expect(await store.publisher.events()).toEqual([
      {
        specversion: "1.0",
        id: "ready-issues/acme/playground#1:trigger.fired",
        source: "/tendworks/trigger-gateway",
        type: "dev.tendworks.trigger.fired",
        subject: "triggers/ready-issues",
        time: "2026-10-18T10:02:30.000Z",
        datacontenttype: "application/json",
        runid: "run-1",
        traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/),
        data: {
          binding: "ready-issues",
          workflow: "implement-issue",
          issue: { repository: "acme/playground", number: 1, title: "Fix the login", url: "https://issues.example/acme/playground/1" },
        },
      },
    ]);
  });

  it("declares each run as started by the binding for the issue it matched", async () => {
    const { runs, gateway } = setup([binding([issue(1, { title: "Fix the login" })])]);

    await gateway.check("ready-issues");

    expect(runs.started.map((run) => run.startedBy)).toEqual([
      {
        kind: "trigger",
        binding: "ready-issues",
        issue: { repository: "acme/playground", number: 1, title: "Fix the login", url: "https://issues.example/acme/playground/1" },
      },
    ]);
  });

  it("starts each run in the trace of its trigger.fired event", async () => {
    const { runs, store, gateway } = setup([binding([issue(1), issue(2)])]);

    await gateway.check("ready-issues");

    const events = await store.publisher.events();
    expect(runs.started.map((run) => run.traceparent)).toEqual(events.map((event) => event.traceparent));
    expect(events[0]!.traceparent).not.toBe(events[1]!.traceparent);
  });

  it("records no event for an issue whose run could not be started", async () => {
    const { runs, store, gateway } = setup([binding([issue(1)])]);
    runs.fail(new Error("down"));

    await gateway.check("ready-issues");

    expect(await store.publisher.events()).toEqual([]);
  });

  it("never checks a suspended binding on its schedule, and lists it as suspended", async () => {
    const runs = createInMemoryRunStarter();
    const suspended = binding([issue(1)], { suspend: true });
    const gateway = createTriggerGateway({ bindings: [suspended], store: createInMemoryFiringStore(), runs, log: () => {} });

    vi.useFakeTimers({ now: new Date("2026-10-18T10:02:30.000Z") });
    try {
      gateway.start();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      await gateway.stop();
    } finally {
      vi.useRealTimers();
    }

    expect(runs.started).toEqual([]);
    expect((await gateway.triggers())[0]).toMatchObject({ name: "ready-issues", suspended: true });
  });

  it("lists its bindings by name with their next scheduled execution", async () => {
    const hourly: Binding = { ...binding([]), metadata: { name: "hourly" }, spec: { ...binding([]).spec, schedule: { every: { hours: 1 } } } };
    const { gateway } = setup([binding([]), hourly]);

    expect(await gateway.triggers()).toEqual([
      { name: "hourly", workflow: "implement-issue", schedule: { every: { hours: 1 } }, nextExecutionAt: "2026-10-18T11:00:00.000Z" },
      { name: "ready-issues", workflow: "implement-issue", schedule: { every: { minutes: 5 } }, nextExecutionAt: "2026-10-18T10:05:00.000Z" },
    ]);
  });

  it("lists how each binding's last check went: started runs, or why it failed", async () => {
    const runs = createInMemoryRunStarter();
    const store = createInMemoryFiringStore();
    const findIssues = vi.fn(async () => [issue(1)]);
    const gateway = createTriggerGateway({
      bindings: [binding([])],
      store,
      runs,
      issueTrackers: () => ({ findIssues }),
      now: () => new Date("2026-10-18T10:02:30.000Z"),
    });
    const lastEvaluation = async () => (await gateway.triggers())[0]!.lastEvaluation;

    expect(await lastEvaluation()).toBeUndefined();
    await gateway.check("ready-issues");
    expect(await lastEvaluation()).toEqual({ at: "2026-10-18T10:02:30.000Z", status: "succeeded", startedRuns: 1 });

    findIssues.mockRejectedValueOnce(new Error("GitHub answered 403: API rate limit exceeded"));
    await expect(gateway.check("ready-issues")).rejects.toThrow("rate limit");
    expect(await lastEvaluation()).toEqual({
      at: "2026-10-18T10:02:30.000Z",
      status: "failed",
      startedRuns: 0,
      message: "GitHub answered 403: API rate limit exceeded",
    });
  });

  it("records a check as failed when a matching issue's run could not be started", async () => {
    const { runs, gateway } = setup([binding([issue(1)])]);
    runs.fail(new Error("control plane answered HTTP 503"));

    await gateway.check("ready-issues");

    expect((await gateway.triggers())[0]!.lastEvaluation).toEqual({
      at: "2026-10-18T10:02:30.000Z",
      status: "failed",
      startedRuns: 0,
      message: "acme/playground#1 could not start a run: control plane answered HTTP 503",
    });
  });

  it("retries an issue on the next check when its run could not be started", async () => {
    const { runs, gateway } = setup([binding([issue(1), issue(2)])]);
    runs.fail(new Error("control plane answered HTTP 503"));
    const failed = await gateway.check("ready-issues");

    runs.fail(undefined);
    const retried = await gateway.check("ready-issues");

    expect(failed).toEqual({
      fired: [],
      failed: [
        { issue: "acme/playground#1", error: "control plane answered HTTP 503" },
        { issue: "acme/playground#2", error: "control plane answered HTTP 503" },
      ],
    });
    expect(retried).toEqual({
      fired: [
        { issue: "acme/playground#1", runId: "run-1" },
        { issue: "acme/playground#2", runId: "run-2" },
      ],
      failed: [],
    });
  });
});
