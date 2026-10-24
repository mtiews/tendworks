import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ControlPlane } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { client } from "./support/control-plane.js";

type Run = ControlPlane.components["schemas"]["run"];

const getRun = async (runId: string): Promise<Run> => {
  const { data, response } = await client.GET("/runs/{runId}", { params: { path: { runId } } });
  if (!data) throw new Error(`GET /runs/${runId} answered HTTP ${response.status}`);
  return data;
};

async function finished(runId: string): Promise<Run> {
  let run = await getRun(runId);
  for (const deadline = Date.now() + 120_000; run.status !== "completed" && run.status !== "failed"; run = await getRun(runId)) {
    if (Date.now() > deadline) throw new Error(`run ${runId} did not end in time (last status: ${run.status})`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return run;
}

/** The harness needs some credential selected; the stack gets it from the environment or deploy/.env. */
function credentialSelected(): boolean {
  if (process.env.TEND_CLAUDE_CODE_CREDENTIAL) return true;
  const env = fileURLToPath(new URL("../../deploy/.env", import.meta.url));
  return existsSync(env) && /^TEND_CLAUDE_CODE_CREDENTIAL=(oauth-token|api-key)\s*$/m.test(readFileSync(env, "utf8"));
}

// A git workspace on the real path (ADR 0022): the worker resolves the workspace by name,
// the sandbox clones the local bare repository of the scripted image
// (tests/fixtures/config/workspaces/scripted-playground.yaml) and the scripted agent
// reports the branch it finds checked out.
describe.skipIf(!credentialSelected())("git workspaces", () => {
  it("checks the workspace out on the branch the run asks for before the agent starts", { timeout: 180_000 }, async () => {
    const { data: started, response } = await client.POST("/runs", {
      body: { workflow: "workspace-scripted", input: { workspace: "scripted-playground", branch: "tendworks/e2e-workspace" } },
    });
    expect(response.status).toBe(201);

    const run = await finished(started!.id);

    expect(run).toMatchObject({ status: "completed", output: { state: "TASK_STATE_COMPLETED", reply: "branch tendworks/e2e-workspace\nscripted playground" } });
    expect(run.steps[0]?.workspace).toEqual({ name: "scripted-playground", branch: "tendworks/e2e-workspace" });
    const { data: transcript } = await client.GET("/runs/{runId}/tasks/{taskId}/transcript", { params: { path: { runId: run.id, taskId: run.steps[0]!.taskId! } } });
    expect(transcript?.items).toContainEqual(
      expect.objectContaining({ type: "workspace-checkout", workspace: { url: "file:///srv/git/playground.git", name: "scripted-playground", branch: "tendworks/e2e-workspace" }, exitCode: 0 }),
    );
  });

  it("fails the step without a sandbox when the run names a workspace that is not configured", { timeout: 120_000 }, async () => {
    const { data: started } = await client.POST("/runs", { body: { workflow: "workspace-scripted", input: { workspace: "ghost", branch: "tendworks/e2e-ghost" } } });

    const run = await finished(started!.id);

    expect(run.status).toBe("failed");
    expect(JSON.stringify(run)).toContain("no workspace 'ghost' is configured");
  });
});
