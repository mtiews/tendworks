import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ControlPlane } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { DIRECTORY_WORKSPACE } from "../fixtures/fixture-configuration.js";
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

// A directory workspace on the real path (ADR 0022): `pnpm e2e` sets the stack's workspace
// root to tests/fixtures/workspace-root and adds the workspace scripted-directory under it;
// the worker binds that host directory into the sandbox, where the scripted agent writes a file.
describe.skipIf(!credentialSelected())("directory workspaces", () => {
  it("lets the agent of a run write into the host directory of its workspace", { timeout: 180_000 }, async () => {
    const written = join(DIRECTORY_WORKSPACE, "written-by-the-agent.txt");
    rmSync(written, { force: true });

    const { data: started, response } = await client.POST("/runs", { body: { workflow: "directory-scripted", input: { workspace: "scripted-directory" } } });
    expect(response.status).toBe(201);
    const run = await finished(started!.id);

    expect(run).toMatchObject({ status: "completed", output: { state: "TASK_STATE_COMPLETED", reply: "wrote written-by-the-agent.txt" } });
    expect(readFileSync(written, "utf8")).toBe("written by the scripted agent\n");
  });
});
