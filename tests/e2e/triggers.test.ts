import type { ControlPlane } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { client } from "./support/control-plane.js";

type Run = ControlPlane.components["schemas"]["run"];

const BINDING = "issue-ready-for-agent"; // tests/fixtures/config/triggers, fake trigger source
const SCHEDULE = "schedule-over-two-workspaces"; // tests/fixtures/config/triggers, schedule over two workspaces

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function nextExecution(binding: string): Promise<Date> {
  const { data } = await client.GET("/triggers");
  const trigger = data?.items.find((item) => item.name === binding);
  if (!trigger) throw new Error(`trigger ${binding} is not listed`);
  return new Date(trigger.nextExecutionAt);
}

/** Runs the binding started, by item key. */
async function runsByItem(binding: string): Promise<Map<string, Run[]>> {
  const { data } = await client.GET("/runs");
  const byItem = new Map<string, Run[]>();
  for (const run of data?.items ?? []) {
    if (run.startedBy?.kind !== "trigger" || run.startedBy.binding !== binding) continue;
    const key = run.startedBy.item.key;
    byItem.set(key, [...(byItem.get(key) ?? []), run]);
  }
  return byItem;
}

describe("triggers on the compose stack", () => {
  it("lists the trigger binding with its kind and next scheduled execution", async () => {
    const { data, response } = await client.GET("/triggers");

    expect(response.status).toBe(200);
    const trigger = data?.items.find((item) => item.name === BINDING);
    expect(trigger).toMatchObject({ workflow: "hello-agent", kind: "fake", workspaces: [], schedule: { every: { seconds: 10 } } });
    const next = new Date(trigger!.nextExecutionAt).getTime();
    // The fake source answers every check.
    expect(trigger?.lastEvaluation === undefined || trigger.lastEvaluation.status === "succeeded").toBe(true);
    expect(next).toBeGreaterThan(Date.now() - 1_000);
    expect(next).toBeLessThanOrEqual(Date.now() + 11_000);
  });

  it("starts one run per item and never a second one", { timeout: 90_000 }, async () => {
    const deadline = Date.now() + 45_000;
    let runs = await runsByItem(BINDING);
    while (!(runs.has("example/playground#101") && runs.has("example/playground#102"))) {
      if (Date.now() > deadline) throw new Error(`no runs for items 101 and 102 in time (found: ${[...runs.keys()].join(", ") || "none"})`);
      await sleep(500);
      runs = await runsByItem(BINDING);
    }

    // Let at least one more scheduled execution pass; it must not start new runs.
    const next = await nextExecution(BINDING);
    await sleep(Math.max(0, next.getTime() - Date.now()) + 3_000);
    runs = await runsByItem(BINDING);

    expect([...runs.keys()].sort()).toEqual(["example/playground#101", "example/playground#102"]);
    expect(runs.get("example/playground#101")).toHaveLength(1);
    expect(runs.get("example/playground#102")).toHaveLength(1);
    expect(runs.get("example/playground#101")![0]).toMatchObject({
      workflow: "hello-agent",
      input: { item: { key: "example/playground#101", number: 101, title: "Add a greeting", url: "https://issues.example/example/playground/101" } },
    });
  });

  it("starts one run per workspace at a tick of a schedule binding over two workspaces", { timeout: 90_000 }, async () => {
    const deadline = Date.now() + 60_000;
    let tick: Run[] | undefined;
    // The first tick the stack fired, once both of its runs exist.
    while (!tick) {
      if (Date.now() > deadline) throw new Error("the schedule binding started no runs for both workspaces in time");
      tick = [...(await runsByItem(SCHEDULE)).values()].find((runs) => runs.length === 2);
      if (!tick) await sleep(500);
    }

    const byWorkspace = new Map(tick.map((run) => [(run.input as { workspace?: string }).workspace, run]));
    expect([...byWorkspace.keys()].sort()).toEqual(["fake-playground", "scripted-playground"]);
    for (const [workspace, run] of byWorkspace) {
      expect(run).toMatchObject({ workflow: "scheduled-noop", startedBy: { kind: "trigger", binding: SCHEDULE, workspace } });
    }
  });
});
