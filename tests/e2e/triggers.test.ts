import type { ControlPlane } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { client } from "./support/control-plane.js";

type Run = ControlPlane.components["schemas"]["run"];

const SCHEDULE = "schedule-over-two-workspaces"; // tests/fixtures/config/triggers, schedule over two workspaces

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

// Deduplication per item across checks needs a source that reports the same item twice;
// the test-only fake kind does, and the contract tests cover it (tests/contract/triggers.test.ts).
describe("triggers on the compose stack", () => {
  it("lists the trigger binding with its kind, workspaces and next scheduled execution", async () => {
    const { data, response } = await client.GET("/triggers");

    expect(response.status).toBe(200);
    const trigger = data?.items.find((item) => item.name === SCHEDULE);
    expect(trigger).toMatchObject({ workflow: "scheduled-noop", kind: "schedule", workspaces: ["fake-playground", "scripted-playground"], schedule: { every: { seconds: 20 } } });
    const next = new Date(trigger!.nextExecutionAt).getTime();
    // A schedule answers every check.
    expect(trigger?.lastEvaluation === undefined || trigger.lastEvaluation.status === "succeeded").toBe(true);
    expect(next).toBeGreaterThan(Date.now() - 1_000);
    expect(next).toBeLessThanOrEqual(Date.now() + 21_000);
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
