import type { TriggerBinding, Workspace } from "@tendworks/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeTriggerSource,
  fakeTriggerBinding,
  type FakeTriggerSettings,
  createInMemoryFiringStore,
  createInMemoryRunStarter,
  createTriggerGateway,
  type SourceCheck,
  type TriggerItem,
  type TriggerSources,
} from "./index.js";

type Binding = TriggerBinding.TriggerBinding;

const NOW = "2026-10-18T10:02:30.000Z";

const item = (number: number, overrides: Partial<TriggerItem> = {}): TriggerItem => ({
  key: `acme/playground#${number}`,
  title: `Issue ${number}`,
  url: `https://issues.example/acme/playground/${number}`,
  number,
  ...overrides,
});

const workspace = (name: string): Workspace.Workspace => ({
  apiVersion: "tendworks.dev/v1",
  kind: "Workspace",
  metadata: { name },
  spec: { git: { url: `https://git.example/acme/${name}.git`, defaultBranch: "main" } },
});
const WORKSPACES = [workspace("app"), workspace("web")];

const binding = (items: TriggerItem[], spec: Partial<Omit<Binding["spec"], "trigger">> = {}): Binding =>
  fakeTriggerBinding({ name: "ready-issues" }, { workflow: "implement-issue", trigger: { every: { minutes: 5 }, items }, ...spec });

/** A fake source whose items a test changes between checks, and which records what it was asked. */
function liveSource(items: (check: SourceCheck) => TriggerItem[] | Promise<TriggerItem[]>) {
  const checks: { at: string; workspace?: string }[] = [];
  const sources: TriggerSources = {
    fake: (settings: FakeTriggerSettings) => ({
      schedule: { every: settings.every },
      async items(check) {
        checks.push({ at: check.at.toISOString(), ...(check.workspace ? { workspace: check.workspace.metadata.name } : {}) });
        return items(check);
      },
    }),
  };
  return { checks, sources };
}

function setup(bindings: Binding[], options: { sources?: TriggerSources } = {}) {
  const runs = createInMemoryRunStarter();
  const store = createInMemoryFiringStore();
  const gateway = createTriggerGateway({
    bindings,
    workspaces: WORKSPACES,
    sources: options.sources ?? { fake: createFakeTriggerSource },
    store,
    runs,
    now: () => new Date(NOW),
    log: () => {},
  });
  return { runs, store, gateway };
}

describe("trigger gateway schedule", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(NOW) });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks each binding at its scheduled executions once started, and no more once stopped", async () => {
    const items = [item(1)];
    const { checks, sources } = liveSource(() => items);
    const runs = createInMemoryRunStarter();
    const gateway = createTriggerGateway({ bindings: [binding([])], sources, store: createInMemoryFiringStore(), runs, log: () => {} });

    gateway.start();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(runs.started).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30_000); // 10:05:00
    expect(runs.started).toHaveLength(1);
    expect((await gateway.triggers())[0]?.nextExecutionAt).toBe("2026-10-18T10:10:00.000Z");

    items.push(item(2));
    await vi.advanceTimersByTimeAsync(5 * 60_000); // 10:10:00
    expect(runs.started).toHaveLength(2);
    expect(checks.map((check) => check.at)).toEqual(["2026-10-18T10:05:00.000Z", "2026-10-18T10:10:00.000Z"]);

    await gateway.stop();
    items.push(item(3));
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runs.started).toHaveLength(2);
  });

  it("checks a cron binding at the times of its expression", async () => {
    const { checks, sources } = liveSource(() => []);
    const gateway = createTriggerGateway({
      bindings: [binding([])],
      sources: { fake: (settings, context) => ({ ...sources.fake!(settings, context), schedule: { cron: "30 10 * * *" } }) },
      store: createInMemoryFiringStore(),
      runs: createInMemoryRunStarter(),
      log: () => {},
    });

    gateway.start();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    await gateway.stop();

    expect(checks.map((check) => check.at)).toEqual(["2026-10-18T10:30:00.000Z"]);
    expect((await gateway.triggers())[0]).toMatchObject({ schedule: { cron: "30 10 * * *" } });
  });

  it("reports a check whose source fails and keeps checking at the next executions", async () => {
    let rateLimited = true;
    const { sources } = liveSource(() => {
      if (rateLimited) throw new Error("GitHub rate limit exhausted; it resets at 2026-10-18T10:07:00.000Z");
      return [item(1)];
    });
    const lines: string[] = [];
    const runs = createInMemoryRunStarter();
    const gateway = createTriggerGateway({ bindings: [binding([])], sources, store: createInMemoryFiringStore(), runs, log: (line) => lines.push(line) });

    gateway.start();
    await vi.advanceTimersByTimeAsync(2.5 * 60_000); // 10:05:00
    expect(lines).toEqual(["trigger ready-issues: could not ask the source: GitHub rate limit exhausted; it resets at 2026-10-18T10:07:00.000Z"]);
    expect(runs.started).toHaveLength(0);

    rateLimited = false;
    await vi.advanceTimersByTimeAsync(5 * 60_000); // 10:10:00
    expect(runs.started).toHaveLength(1);
    await gateway.stop();
  });

  it("never checks a suspended binding, and lists it as suspended", async () => {
    const { checks, sources } = liveSource(() => [item(1)]);
    const { runs, gateway } = setup([binding([], { suspend: true })], { sources });

    gateway.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await gateway.stop();

    expect(checks).toEqual([]);
    expect(runs.started).toEqual([]);
    expect((await gateway.triggers())[0]).toMatchObject({ name: "ready-issues", suspended: true });
  });
});

describe("trigger gateway", () => {
  it("starts one run per workspace and item, with the workspace's name and the item as input", async () => {
    const { runs, gateway } = setup([binding([item(1), item(2)], { workspaces: ["app", "web"] })]);

    await gateway.check("ready-issues");

    expect(runs.started.map(({ workflow, input }) => ({ workflow, input }))).toEqual([
      { workflow: "implement-issue", input: { workspace: "app", item: item(1) } },
      { workflow: "implement-issue", input: { workspace: "app", item: item(2) } },
      { workflow: "implement-issue", input: { workspace: "web", item: item(1) } },
      { workflow: "implement-issue", input: { workspace: "web", item: item(2) } },
    ]);
  });

  it("asks the source once per workspace, handing it the workspace and the execution the check belongs to", async () => {
    const { checks, sources } = liveSource(({ workspace }) => (workspace?.metadata.name === "web" ? [item(3)] : []));
    const { runs, gateway } = setup([binding([], { workspaces: ["app", "web"] })], { sources });

    await gateway.check("ready-issues");

    expect(checks).toEqual([
      { at: "2026-10-18T10:00:00.000Z", workspace: "app" },
      { at: "2026-10-18T10:00:00.000Z", workspace: "web" },
    ]);
    expect(runs.started.map((run) => run.input)).toEqual([{ workspace: "web", item: item(3) }]);
  });

  it("starts runs without a workspace for a binding without workspaces", async () => {
    const { checks, sources } = liveSource(() => [item(1)]);
    const { runs, gateway } = setup([binding([])], { sources });

    await gateway.check("ready-issues");

    expect(checks).toEqual([{ at: "2026-10-18T10:00:00.000Z" }]);
    expect(runs.started.map((run) => run.input)).toEqual([{ item: item(1) }]);
    expect(runs.started[0]?.startedBy).toEqual({ kind: "trigger", binding: "ready-issues", item: { key: "acme/playground#1", title: "Issue 1", url: item(1).url } });
  });

  it("never starts a second run for an item in a workspace, also after a restart, but does in another workspace", async () => {
    const { runs, store, gateway } = setup([binding([item(1)], { workspaces: ["app"] })]);
    await gateway.check("ready-issues");

    await gateway.check("ready-issues");
    const restarted = createTriggerGateway({
      bindings: [binding([item(1), item(2)], { workspaces: ["app", "web"] })],
      workspaces: WORKSPACES,
      sources: { fake: createFakeTriggerSource },
      store,
      runs,
    });
    await restarted.check("ready-issues");

    expect(runs.started.map(({ input }) => [input.workspace, (input.item as TriggerItem).key])).toEqual([
      ["app", "acme/playground#1"],
      ["app", "acme/playground#2"],
      ["web", "acme/playground#1"],
      ["web", "acme/playground#2"],
    ]);
  });

  it("keeps the items of different bindings apart", async () => {
    const other: Binding = { ...binding([item(1)]), metadata: { name: "triage" } };
    const { runs, gateway } = setup([binding([item(1)]), other]);

    await gateway.check("ready-issues");
    await gateway.check("triage");

    expect(runs.started).toHaveLength(2);
  });

  it("records each firing as a trigger.fired event referencing the workspace, the item and the run", async () => {
    const { store, gateway } = setup([binding([item(1, { title: "Fix the login" })], { workspaces: ["app"] })]);

    await gateway.check("ready-issues");
    await gateway.check("ready-issues");

    expect(await store.publisher.events()).toEqual([
      {
        specversion: "1.0",
        id: "ready-issues/app/acme/playground#1:trigger.fired",
        source: "/tendworks/trigger-gateway",
        type: "dev.tendworks.trigger.fired",
        subject: "triggers/ready-issues",
        time: NOW,
        datacontenttype: "application/json",
        runid: "run-1",
        traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/),
        data: {
          binding: "ready-issues",
          workflow: "implement-issue",
          workspace: "app",
          item: { key: "acme/playground#1", title: "Fix the login", url: "https://issues.example/acme/playground/1" },
        },
      },
    ]);
  });

  it("declares each run as started by the binding, for its workspace and item", async () => {
    const { runs, gateway } = setup([binding([item(1, { title: "Fix the login" })], { workspaces: ["web"] })]);

    await gateway.check("ready-issues");

    expect(runs.started.map((run) => run.startedBy)).toEqual([
      {
        kind: "trigger",
        binding: "ready-issues",
        workspace: "web",
        item: { key: "acme/playground#1", title: "Fix the login", url: "https://issues.example/acme/playground/1" },
      },
    ]);
  });

  it("starts each run in the trace of its trigger.fired event", async () => {
    const { runs, store, gateway } = setup([binding([item(1), item(2)])]);

    await gateway.check("ready-issues");

    const events = await store.publisher.events();
    expect(runs.started.map((run) => run.traceparent)).toEqual(events.map((event) => event.traceparent));
    expect(events[0]!.traceparent).not.toBe(events[1]!.traceparent);
  });

  it("records no event for an item whose run could not be started", async () => {
    const { runs, store, gateway } = setup([binding([item(1)])]);
    runs.fail(new Error("down"));

    await gateway.check("ready-issues");

    expect(await store.publisher.events()).toEqual([]);
  });

  it("lists its bindings by name with their kind, workspaces, schedule and next execution", async () => {
    const hourly = fakeTriggerBinding({ name: "hourly" }, { workflow: "implement-issue", trigger: { every: { hours: 1 } } });
    const { gateway } = setup([binding([], { workspaces: ["app", "web"] }), hourly]);

    expect(await gateway.triggers()).toEqual([
      { name: "hourly", workflow: "implement-issue", kind: "fake", workspaces: [], schedule: { every: { hours: 1 } }, nextExecutionAt: "2026-10-18T11:00:00.000Z" },
      {
        name: "ready-issues",
        workflow: "implement-issue",
        kind: "fake",
        workspaces: ["app", "web"],
        schedule: { every: { minutes: 5 } },
        nextExecutionAt: "2026-10-18T10:05:00.000Z",
      },
    ]);
  });

  it("lists how each binding's last check went: started runs, or why it failed per workspace", async () => {
    let failing = false;
    const { sources } = liveSource(({ workspace }) => {
      if (failing && workspace?.metadata.name === "web") throw new Error("GitHub answered 403: API rate limit exceeded");
      return [item(1)];
    });
    const { gateway } = setup([binding([], { workspaces: ["app", "web"] })], { sources });
    const lastEvaluation = async () => (await gateway.triggers())[0]!.lastEvaluation;

    expect(await lastEvaluation()).toBeUndefined();
    await gateway.check("ready-issues");
    expect(await lastEvaluation()).toEqual({ at: NOW, status: "succeeded", startedRuns: 2 });

    failing = true;
    const result = await gateway.check("ready-issues");
    expect(result.failed).toEqual([{ workspace: "web", error: "GitHub answered 403: API rate limit exceeded" }]);
    expect(await lastEvaluation()).toEqual({
      at: NOW,
      status: "failed",
      startedRuns: 0,
      message: "workspace web: could not ask the source: GitHub answered 403: API rate limit exceeded",
    });
  });

  it("records a check as failed when an item's run could not be started, and retries it on the next check", async () => {
    const { runs, gateway } = setup([binding([item(1), item(2)], { workspaces: ["app"] })]);
    runs.fail(new Error("control plane answered HTTP 503"));
    const failed = await gateway.check("ready-issues");
    const evaluation = (await gateway.triggers())[0]!.lastEvaluation;

    runs.fail(undefined);
    const retried = await gateway.check("ready-issues");

    expect(failed).toEqual({
      fired: [],
      failed: [
        { workspace: "app", item: "acme/playground#1", error: "control plane answered HTTP 503" },
        { workspace: "app", item: "acme/playground#2", error: "control plane answered HTTP 503" },
      ],
    });
    expect(evaluation).toMatchObject({
      status: "failed",
      message:
        "workspace app: acme/playground#1 could not start a run: control plane answered HTTP 503; workspace app: acme/playground#2 could not start a run: control plane answered HTTP 503",
    });
    expect(retried).toEqual({
      fired: [
        { workspace: "app", item: "acme/playground#1", runId: "run-1" },
        { workspace: "app", item: "acme/playground#2", runId: "run-2" },
      ],
      failed: [],
    });
  });

  it("fails the checks of a binding naming a workspace that is not configured", async () => {
    const { runs, gateway } = setup([binding([item(1)], { workspaces: ["app", "mobile"] })]);

    const result = await gateway.check("ready-issues");

    expect(result.failed).toEqual([{ workspace: "mobile", error: "no workspace 'mobile' is configured" }]);
    expect(runs.started.map((run) => run.input.workspace)).toEqual(["app"]);
  });

  it("refuses a binding whose trigger kind has no source, or whose schedule cannot be read", () => {
    const store = createInMemoryFiringStore();
    const runs = createInMemoryRunStarter();

    expect(() => createTriggerGateway({ bindings: [binding([])], sources: {}, store, runs })).toThrow(
      "trigger binding 'ready-issues' has a trigger of kind 'fake', but no trigger source 'fake' is deployed (deployed: none)",
    );
    expect(() =>
      createTriggerGateway({ bindings: [binding([])], sources: { fake: () => ({ schedule: { cron: "61 * * * *" }, items: async () => [] }) }, store, runs }),
    ).toThrow("trigger binding 'ready-issues': cron expression '61 * * * *' is invalid");
  });

  it("creates each source with the binding's workspaces, and refuses a binding its source cannot serve", () => {
    const store = createInMemoryFiringStore();
    const runs = createInMemoryRunStarter();
    const given: string[][] = [];
    const picky: TriggerSources = {
      fake: (settings: FakeTriggerSettings, { workspaces }) => {
        given.push(workspaces.map((workspace) => workspace.metadata.name));
        if (workspaces.some((workspace) => workspace.metadata.name === "web")) throw new Error("workspace 'web' cannot be read");
        return createFakeTriggerSource(settings);
      },
    };
    const options = { workspaces: WORKSPACES, sources: picky, store, runs };

    createTriggerGateway({ ...options, bindings: [binding([], { workspaces: ["app"] }), { ...binding([]), metadata: { name: "none" } }] });
    expect(given).toEqual([["app"], []]);
    expect(() => createTriggerGateway({ ...options, bindings: [binding([], { workspaces: ["web", "app"] })] })).toThrow(
      "trigger binding 'ready-issues': workspace 'web' cannot be read",
    );
  });
});

describe("firing a manual trigger binding", () => {
  // Like the manual source package: no schedule, one item per firing keyed by its time.
  const byHand: TriggerSources = { manual: () => ({ items: async ({ at }) => [{ key: at.toISOString(), title: "started by hand" }] }) };
  const manual = (spec: Partial<Omit<Binding["spec"], "trigger">> = {}, name = "architecture-review"): Binding => ({
    apiVersion: "tendworks.dev/v1",
    kind: "TriggerBinding",
    metadata: { name },
    spec: { workflow: "review-workspace", trigger: { manual: {} }, ...spec },
  });

  function manualSetup(bindings: Binding[]) {
    let clock = new Date(NOW).getTime();
    const runs = createInMemoryRunStarter();
    const store = createInMemoryFiringStore();
    const gateway = createTriggerGateway({
      bindings,
      workspaces: WORKSPACES,
      sources: { ...byHand, fake: createFakeTriggerSource },
      store,
      runs,
      now: () => new Date(clock),
      log: () => {},
    });
    return { runs, store, gateway, tick: (ms: number) => (clock += ms) };
  }
  const startedByHand = { key: NOW, title: "started by hand" };

  it("starts one run per workspace of the binding, with the workspace, the item and the binding as origin", async () => {
    const { runs, gateway } = manualSetup([manual({ workspaces: ["app", "web"] })]);

    const result = await gateway.fire("architecture-review");

    expect(result).toEqual({
      fired: [
        { workspace: "app", item: NOW, runId: "run-1" },
        { workspace: "web", item: NOW, runId: "run-2" },
      ],
      failed: [],
    });
    expect(runs.started.map(({ workflow, input, startedBy }) => ({ workflow, input, startedBy }))).toEqual([
      { workflow: "review-workspace", input: { workspace: "app", item: startedByHand }, startedBy: { kind: "trigger", binding: "architecture-review", workspace: "app", item: startedByHand } },
      { workflow: "review-workspace", input: { workspace: "web", item: startedByHand }, startedBy: { kind: "trigger", binding: "architecture-review", workspace: "web", item: startedByHand } },
    ]);
  });

  it("starts one run without a workspace for a binding without workspaces", async () => {
    const { runs, gateway } = manualSetup([manual()]);

    await gateway.fire("architecture-review");

    expect(runs.started.map((run) => run.input)).toEqual([{ item: startedByHand }]);
  });

  it("starts a run only in the workspace the firing names, and refuses one that is not the binding's", async () => {
    const { runs, gateway } = manualSetup([manual({ workspaces: ["app", "web"] }), manual({ workspaces: ["app"] }, "app-only")]);

    await gateway.fire("architecture-review", { workspace: "web" });

    expect(runs.started.map((run) => run.input.workspace)).toEqual(["web"]);
    await expect(gateway.fire("app-only", { workspace: "web" })).rejects.toMatchObject({
      reason: "unknown-workspace",
      message: "trigger binding 'app-only' does not start runs in workspace 'web' (workspaces: app)",
    });
    await expect(gateway.fire("architecture-review", { workspace: "mobile" })).rejects.toMatchObject({ reason: "unknown-workspace" });
    expect(runs.started).toHaveLength(1);
  });

  it("starts new runs at every firing", async () => {
    const { runs, gateway, tick } = manualSetup([manual({ workspaces: ["app"] })]);

    await gateway.fire("architecture-review");
    tick(1_000);
    await gateway.fire("architecture-review");

    expect(runs.started.map((run) => (run.input.item as TriggerItem).key)).toEqual([NOW, "2026-10-18T10:02:31.000Z"]);
  });

  it("starts new runs also for two firings at the same instant", async () => {
    const { runs, gateway } = manualSetup([manual({ workspaces: ["app"] })]);

    await Promise.all([gateway.fire("architecture-review"), gateway.fire("architecture-review")]);

    expect(runs.started.map((run) => (run.input.item as TriggerItem).key).sort()).toEqual([NOW, "2026-10-18T10:02:30.001Z"]);
  });

  it("records each started run as trigger.fired and the firing as the binding's last check", async () => {
    const { runs, store, gateway, tick } = manualSetup([manual({ workspaces: ["app"] })]);

    await gateway.fire("architecture-review");
    expect(await store.publisher.events()).toMatchObject([
      {
        type: "dev.tendworks.trigger.fired",
        subject: "triggers/architecture-review",
        runid: "run-1",
        data: { binding: "architecture-review", workflow: "review-workspace", workspace: "app", item: startedByHand },
      },
    ]);
    expect((await gateway.triggers())[0]?.lastEvaluation).toEqual({ at: NOW, status: "succeeded", startedRuns: 1 });

    tick(1_000);
    runs.fail(new Error("control plane answered HTTP 503"));
    const failed = await gateway.fire("architecture-review");
    expect(failed.fired).toEqual([]);
    expect((await gateway.triggers())[0]?.lastEvaluation).toEqual({
      at: "2026-10-18T10:02:31.000Z",
      status: "failed",
      startedRuns: 0,
      message: "workspace app: 2026-10-18T10:02:31.000Z could not start a run: control plane answered HTTP 503",
    });
  });

  it("refuses an unknown binding, a suspended one and one that fires on its own", async () => {
    const { runs, gateway } = manualSetup([manual({ suspend: true }), binding([item(1)])]);

    await expect(gateway.fire("nightly")).rejects.toMatchObject({ reason: "unknown-binding", message: "no trigger binding 'nightly'" });
    await expect(gateway.fire("architecture-review")).rejects.toMatchObject({
      reason: "suspended",
      message: "trigger binding 'architecture-review' is suspended",
    });
    await expect(gateway.fire("ready-issues")).rejects.toMatchObject({
      reason: "fires-on-its-own",
      message: "trigger binding 'ready-issues' of kind 'fake' fires on its own; only a binding of kind 'manual' can be fired",
    });
    expect(runs.started).toEqual([]);
  });

  it("lists a manual binding without schedule and next execution", async () => {
    const { gateway } = manualSetup([manual({ workspaces: ["app"] })]);

    expect(await gateway.triggers()).toEqual([{ name: "architecture-review", workflow: "review-workspace", kind: "manual", workspaces: ["app"] }]);
  });

  it("never checks a manual binding on its own once started", async () => {
    vi.useFakeTimers({ now: new Date(NOW) });
    try {
      const { runs, gateway } = manualSetup([manual({ workspaces: ["app"] })]);

      gateway.start();
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      await gateway.stop();

      expect(runs.started).toEqual([]);
      await expect(gateway.check("architecture-review")).rejects.toThrow("trigger binding 'architecture-review' has no schedule; fire it instead");
    } finally {
      vi.useRealTimers();
    }
  });
});
