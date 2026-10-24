import type { ControlPlane } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { client } from "./support/control-plane.js";

type Run = ControlPlane.components["schemas"]["run"];
type Notification = ControlPlane.components["schemas"]["notification"];

const BINDING = "fake-issue-to-pull-request"; // tests/fixtures/config/triggers, fake integration

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen in time`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// The automated path of the walking skeleton with fakes only: a time trigger finds an
// issue in the fake issue tracker, the fake agent reports a pull request, the run
// completes with it after the agent step and a notification is recorded.
describe("the automated chain on the compose stack, with fakes", () => {
  it("goes from a matching issue to a run that completes with the reported pull request, and a notification", { timeout: 120_000 }, async () => {
    const run = await waitFor<Run>("a completed run started by the trigger", async () => {
      const { data } = await client.GET("/runs");
      const found = data?.items.find((item) => item.startedBy?.kind === "trigger" && item.startedBy.binding === BINDING);
      return found && (found.status === "completed" || found.status === "failed") ? found : undefined;
    });

    expect(run).toMatchObject({
      workflow: "fake-develop-issue",
      status: "completed",
      startedBy: { kind: "trigger", binding: BINDING, issue: { repository: "chain/playground", number: 201 } },
      steps: [
        {
          name: "implement",
          status: "completed",
          workspace: { repository: "https://git.example/example/playground.git", branch: "tendworks/fake" },
          artifacts: [{ name: "pull-request", url: "https://git.example/example/playground/pull/1" }],
        },
      ],
      output: { pullRequest: "https://git.example/example/playground/pull/1" },
    });
    expect(run.steps).toHaveLength(1);
    expect(run.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    const notification = await waitFor<Notification>("the run's notification", async () => {
      const { data } = await client.GET("/notifications");
      return data?.items.find((item) => item.runId === run.id && item.delivery.status !== "pending");
    });
    expect(notification).toMatchObject({ kind: "run.completed", delivery: { status: "delivered" } });

    const { data: triggers } = await client.GET("/triggers");
    expect(triggers?.items.find((trigger) => trigger.name === BINDING)?.lastEvaluation).toMatchObject({ status: "succeeded" });
    // One firing per issue and binding: no second run for the same issue.
    const { data: runs } = await client.GET("/runs");
    expect(runs?.items.filter((item) => item.startedBy?.kind === "trigger" && item.startedBy.binding === BINDING)).toHaveLength(1);
  });

  it("lists the playground binding as suspended until it is given the platform token", async () => {
    const { data } = await client.GET("/triggers");

    expect(data?.items.find((trigger) => trigger.name === "playground-ready-for-agent")).toMatchObject({ workflow: "develop-issue", suspended: true });
  });
});
