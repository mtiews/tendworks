import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { EventQueue, runWorkflow, validateWorkflow } from "../index.js";
import { InMemoryAgentTaskExecutor } from "./in-memory-agent-task-executor.js";

// The example workflow of the scheduled path (examples/config/workflows/check-workspace.sw.yaml),
// run by the interpreter against an in-memory developer agent.

const definition = validateWorkflow(
  parse(readFileSync(new URL("../../../../examples/config/workflows/check-workspace.sw.yaml", import.meta.url), "utf8")),
);

// The item a schedule trigger hands the workflow: the tick.
const tick = { key: "2026-10-25T02:00:00.000Z", title: "Scheduled at 2026-10-25T02:00:00.000Z", at: "2026-10-25T02:00:00.000Z" };
const runId = "0b6c4c1e-5f1a-4c3e-9d2b-1a2b3c4d5e6f";

function developer() {
  return new InMemoryAgentTaskExecutor().agent("developer", () => ({
    id: "task-1",
    status: { state: "TASK_STATE_COMPLETED", message: { messageId: "s", role: "ROLE_AGENT", parts: [{ text: "pnpm test: 12 passed." }] } },
  }));
}

describe("example workflow check-workspace", () => {
  it("asks the developer for a check that changes nothing, in the workspace the input names, read-only on its default branch", async () => {
    const executor = developer();

    await runWorkflow(definition, { runId, input: { workspace: "playground", item: tick }, executor });

    expect(executor.requests.map((request) => request.agent)).toEqual(["developer"]);
    const message = executor.requests[0]!.request.message;
    const text = message.parts.flatMap((part) => ("text" in part ? [part.text] : [])).join("\n");
    expect(text).toContain("Do not change, commit or push anything");
    expect(message.metadata?.["dev.tendworks/workspace"]).toEqual({ name: "playground", write: false });
  });

  it("completes with the agent's report and the tick it checked at", async () => {
    const run = await runWorkflow(definition, { runId, input: { workspace: "playground", item: tick }, executor: developer(), events: new EventQueue() });

    expect(run).toMatchObject({
      status: "completed",
      output: { workspace: "playground", checkedAt: tick.key, taskId: "task-1", report: "pnpm test: 12 passed." },
    });
  });

  it("runs when started by hand without an item", async () => {
    const run = await runWorkflow(definition, { runId, input: { workspace: "playground" }, executor: developer(), events: new EventQueue() });

    expect(run).toMatchObject({ status: "completed", output: { workspace: "playground", checkedAt: null } });
  });
});
