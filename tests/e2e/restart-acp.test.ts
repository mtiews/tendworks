import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ControlPlane } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { client } from "./support/control-plane.js";

type Run = ControlPlane.components["schemas"]["run"];

const composeFile = fileURLToPath(new URL("../../deploy/compose.yaml", import.meta.url));
const compose = (...args: string[]) => promisify(execFile)("docker", ["compose", "-f", composeFile, ...args], { timeout: 120_000 });

const getRun = async (runId: string): Promise<Run> => {
  const { data, response } = await client.GET("/runs/{runId}", { params: { path: { runId } } });
  if (!data) throw new Error(`GET /runs/${runId} answered HTTP ${response.status}`);
  return data;
};

/** The harness needs some credential selected; the stack gets it from the environment or deploy/.env. */
function credentialSelected(): boolean {
  if (process.env.TEND_CLAUDE_CODE_CREDENTIAL) return true;
  const env = fileURLToPath(new URL("../../deploy/.env", import.meta.url));
  return existsSync(env) && /^TEND_CLAUDE_CODE_CREDENTIAL=(oauth-token|api-key)\s*$/m.test(readFileSync(env, "utf8"));
}

// The restart test of the Claude Code harness on the real path: sandbox from the socket
// proxy, volumes, ACP over the attached stdio and session/resume after a platform
// restart, with a scripted ACP agent (images/sandbox-scripted-acp) instead of Claude Code.
describe.skipIf(!credentialSelected())("restarting the platform while an agent session runs in a sandbox", () => {
  it("resumes the ACP session in a new sandbox on the session's volumes and completes the run", { timeout: 300_000 }, async () => {
    const { data: started, response } = await client.POST("/runs", { body: { workflow: "restart-scripted" } });
    expect(response.status).toBe(201);
    const runId = started!.id;
    for (let run = await getRun(runId); run.steps[0]?.status !== "running"; run = await getRun(runId)) {
      expect(run.status).not.toMatch(/completed|failed/);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // Give the harness time to start the sandbox and open the ACP session.
    await new Promise((resolve) => setTimeout(resolve, 15_000));

    await compose("restart", "server", "worker");
    await compose("up", "-d", "--wait", "server", "worker");

    let run = await getRun(runId);
    for (const deadline = Date.now() + 240_000; run.status !== "completed" && run.status !== "failed"; run = await getRun(runId)) {
      if (Date.now() > deadline) throw new Error(`run ${runId} did not end in time (last status: ${run.status})`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    expect(run).toMatchObject({ status: "completed", output: { state: "TASK_STATE_COMPLETED", resumed: 1 } });
    const reply = (run.output as { reply: string }).reply;
    // The same ACP session was resumed (not a new one), and the workspace volume kept before.txt.
    expect(reply).toMatch(/^resumed session scripted-[0-9a-f-]+\nafter\.txt\nbefore\.txt$/);
    expect(run.steps[0]?.cost).toEqual({ amount: 0.01, currency: "USD" });
  });
});
