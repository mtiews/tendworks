import type { TriggerBinding } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { createFakeTriggerSource, createInMemoryFiringStore, fakeTriggerBinding, createInMemoryRunStarter, createTriggerGateway, createTriggerGatewayApi } from "./index.js";

const manual = (name: string, spec: Partial<Omit<TriggerBinding.TriggerBinding["spec"], "trigger">> = {}): TriggerBinding.TriggerBinding => ({
  apiVersion: "tendworks.dev/v1",
  kind: "TriggerBinding",
  metadata: { name },
  spec: { workflow: "review-workspace", trigger: { manual: {} }, ...spec },
});

function api() {
  const runs = createInMemoryRunStarter();
  const gateway = createTriggerGateway({
    bindings: [
      fakeTriggerBinding({ name: "ready-issues" }, { workflow: "implement-issue", trigger: { every: { seconds: 30 } } }),
      manual("architecture-review", { workspaces: ["app", "web"] }),
      manual("paused-review", { suspend: true }),
    ],
    workspaces: ["app", "web"].map((name) => ({ apiVersion: "tendworks.dev/v1", kind: "Workspace", metadata: { name }, spec: { directory: { path: `/srv/${name}` } } })),
    sources: { fake: createFakeTriggerSource, manual: () => ({ items: async ({ at }) => [{ key: at.toISOString(), title: "started by hand" }] }) },
    store: createInMemoryFiringStore(),
    runs,
    now: () => new Date("2026-10-18T10:00:10.000Z"),
    log: () => {},
  });
  const handler = createTriggerGatewayApi(gateway);
  const fire = (name: string, body?: unknown) =>
    handler.fetch(
      new Request(`http://trigger-gateway.test/triggers/${name}/fire`, {
        method: "POST",
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }),
      }),
    );
  return { handler, fire, runs };
}

describe("trigger gateway API", () => {
  it("lists the triggers with their next scheduled execution, a manual binding without one", async () => {
    const response = await api().handler.fetch(new Request("http://trigger-gateway.test/triggers"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        { name: "architecture-review", workflow: "review-workspace", kind: "manual", workspaces: ["app", "web"] },
        { name: "paused-review", workflow: "review-workspace", kind: "manual", workspaces: [], suspended: true },
        { name: "ready-issues", workflow: "implement-issue", kind: "fake", workspaces: [], schedule: { every: { seconds: 30 } }, nextExecutionAt: "2026-10-18T10:00:30.000Z" },
      ],
    });
  });

  it("fires a manual binding and answers with the started runs, over all workspaces or the one named", async () => {
    const { fire, runs } = api();

    const all = await fire("architecture-review");
    const one = await fire("architecture-review", { workspace: "web" });

    expect(all.status).toBe(201);
    expect(await all.json()).toEqual({
      items: [
        { workspace: "app", runId: "run-1" },
        { workspace: "web", runId: "run-2" },
      ],
    });
    expect(one.status).toBe(201);
    // Fired at the same instant, it is still a new firing.
    expect(await one.json()).toEqual({ items: [{ workspace: "web", runId: "run-3" }] });
    expect(runs.started).toHaveLength(3);
  });

  it("refuses an unknown binding with 404, a suspended or scheduled one with 409 and a foreign workspace or a malformed body with 400", async () => {
    const { fire } = api();

    const answers = await Promise.all([
      fire("nightly"),
      fire("paused-review"),
      fire("ready-issues"),
      fire("architecture-review", { workspace: "mobile" }),
      fire("architecture-review", { workspace: 7 }),
      fire("architecture-review", "{"),
    ]);

    expect(answers.map((answer) => answer.status)).toEqual([404, 409, 409, 400, 400, 400]);
    expect(await answers[0].json()).toEqual({ title: "Trigger binding not found", status: 404, detail: "no trigger binding 'nightly'" });
    expect(await answers[1].json()).toEqual({ title: "Trigger binding not fireable", status: 409, detail: "trigger binding 'paused-review' is suspended" });
    expect(await answers[3].json()).toEqual({
      title: "Invalid request",
      status: 400,
      detail: "trigger binding 'architecture-review' does not start runs in workspace 'mobile' (workspaces: app, web)",
    });
  });
});
