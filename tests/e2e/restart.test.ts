import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ControlPlane } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { client } from "./support/control-plane.js";

type Run = ControlPlane.components["schemas"]["run"];

const compose = (...args: string[]) =>
  promisify(execFile)("docker", ["compose", "-f", fileURLToPath(new URL("../../deploy/compose.yaml", import.meta.url)), ...args], {
    timeout: 120_000,
  });

const getRun = async (runId: string): Promise<Run> => {
  const { data, response } = await client.GET("/runs/{runId}", { params: { path: { runId } } });
  if (!data) throw new Error(`GET /runs/${runId} answered HTTP ${response.status}`);
  return data;
};

describe("restarting the platform mid-run", () => {
  it("resumes the run, the agent continues its task, and the run stays readable", { timeout: 180_000 }, async () => {
    const { data: started } = await client.POST("/runs", {
      body: { workflow: "slow-agent", input: { issue: { number: 7, title: "Survive a restart" } } },
    });
    const runId = started!.id;
    // Wait until the agent works on the step.
    for (let run = await getRun(runId); run.steps[0]?.status !== "running"; run = await getRun(runId)) {
      expect(run.status).not.toMatch(/completed|failed/);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    await compose("restart", "server", "worker");
    await compose("up", "-d", "--wait", "server", "worker");

    // From now on every read succeeds, while the run is still running and after it ended.
    const seen = new Set<string>();
    let run = await getRun(runId);
    for (const deadline = Date.now() + 120_000; run.status !== "completed" && run.status !== "failed"; run = await getRun(runId)) {
      seen.add(run.status);
      if (Date.now() > deadline) throw new Error(`run ${runId} did not end in time (last status: ${run.status})`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    expect(seen).toEqual(new Set(["running"]));
    expect(run).toMatchObject({
      status: "completed",
      steps: [{ reference: "/do/0/implement", status: "completed" }],
      // One task with the one message that started it, resumed instead of started again.
      output: { state: "TASK_STATE_COMPLETED", messages: 1, resumed: 1 },
    });
  });
});
