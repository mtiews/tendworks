import type { ControlPlane } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { client } from "./support/control-plane.js";

type Run = ControlPlane.components["schemas"]["run"];

const BINDING = "issue-ready-for-agent"; // examples/config/triggers, fake integration

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function nextExecution(): Promise<Date> {
  const { data } = await client.GET("/triggers");
  const trigger = data?.items.find((item) => item.name === BINDING);
  if (!trigger) throw new Error(`trigger ${BINDING} is not listed`);
  return new Date(trigger.nextExecutionAt);
}

/** Runs of the example binding, by issue number. */
async function runsByIssue(): Promise<Map<number, Run[]>> {
  const { data } = await client.GET("/runs");
  const byIssue = new Map<number, Run[]>();
  for (const run of data?.items ?? []) {
    const url = (run.input as { issue?: { url?: unknown } }).issue?.url;
    const number = (run.input as { issue?: { number?: unknown } }).issue?.number;
    if (typeof url !== "string" || !url.includes("/example/") || typeof number !== "number") continue;
    byIssue.set(number, [...(byIssue.get(number) ?? []), run]);
  }
  return byIssue;
}

describe("time trigger on the compose stack", () => {
  it("lists the trigger binding with its next scheduled execution", async () => {
    const { data, response } = await client.GET("/triggers");

    expect(response.status).toBe(200);
    const trigger = data?.items.find((item) => item.name === BINDING);
    expect(trigger).toMatchObject({ workflow: "hello-agent", schedule: { every: { seconds: 10 } } });
    const next = new Date(trigger!.nextExecutionAt).getTime();
    expect(next).toBeGreaterThan(Date.now() - 1_000);
    expect(next).toBeLessThanOrEqual(Date.now() + 11_000);
  });

  it("starts one run per matching issue and never a second one", { timeout: 90_000 }, async () => {
    const deadline = Date.now() + 45_000;
    let runs = await runsByIssue();
    while (!(runs.has(101) && runs.has(102))) {
      if (Date.now() > deadline) throw new Error(`no runs for issues 101 and 102 in time (found: ${[...runs.keys()].join(", ") || "none"})`);
      await sleep(500);
      runs = await runsByIssue();
    }

    // Let at least one more scheduled execution pass; it must not start new runs.
    const next = await nextExecution();
    await sleep(Math.max(0, next.getTime() - Date.now()) + 3_000);
    runs = await runsByIssue();

    expect([...runs.keys()].sort()).toEqual([101, 102]);
    expect(runs.get(101)).toHaveLength(1);
    expect(runs.get(102)).toHaveLength(1);
    expect(runs.get(101)![0]).toMatchObject({
      workflow: "hello-agent",
      input: { issue: { number: 101, title: "Add a greeting", url: "https://issues.example/example/playground/101" } },
    });
  });
});
