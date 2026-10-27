import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { EventQueue, runWorkflow, validateWorkflow } from "../index.js";
import { InMemoryAgentTaskExecutor } from "./in-memory-agent-task-executor.js";

// The example workflow of the manual review bindings (examples/config/workflows/review-workspace.sw.yaml),
// run by the interpreter against an in-memory developer agent.

const definition = validateWorkflow(
  parse(readFileSync(new URL("../../../../examples/config/workflows/review-workspace.sw.yaml", import.meta.url), "utf8")),
);

// The item a manual trigger hands the workflow: the firing.
const firing = { key: "2026-10-27T09:00:00.000Z", title: "started by hand" };
const runId = "0b6c4c1e-5f1a-4c3e-9d2b-1a2b3c4d5e6f";

function developer() {
  return new InMemoryAgentTaskExecutor().agent("developer", () => ({
    id: "task-1",
    status: { state: "TASK_STATE_COMPLETED", message: { messageId: "s", role: "ROLE_AGENT", parts: [{ text: "No findings." }] } },
  }));
}

async function promptFor(focus: string) {
  const executor = developer();
  await runWorkflow(definition, { runId, input: { focus, workspace: "playground", item: firing }, executor });
  const message = executor.requests[0]!.request.message;
  return { text: message.parts.flatMap((part) => ("text" in part ? [part.text] : [])).join("\n"), metadata: message.metadata };
}

describe("example workflow review-workspace", () => {
  it("asks the developer for a review that changes nothing, read-only in the workspace the input names", async () => {
    const { text, metadata } = await promptFor("architecture");

    expect(text).toContain("Do not change, commit or push anything");
    expect(metadata?.["dev.tendworks/workspace"]).toEqual({ name: "playground", write: false });
  });

  it("varies the prompt by the focus the binding passes", async () => {
    const architecture = (await promptFor("architecture")).text;
    const security = (await promptFor("security")).text;
    const other = (await promptFor("test coverage")).text;

    expect(architecture).toContain("Focus on its architecture");
    expect(security).toContain("Focus on security");
    expect(other).toContain("Focus on: test coverage.");
    expect(new Set([architecture, security, other]).size).toBe(3);
  });

  it("completes with the agent's report, its focus and the firing it belongs to", async () => {
    const run = await runWorkflow(definition, {
      runId,
      input: { focus: "security", workspace: "playground", item: firing },
      executor: developer(),
      events: new EventQueue(),
    });

    expect(run).toMatchObject({
      status: "completed",
      output: { workspace: "playground", focus: "security", reviewedAt: firing.key, taskId: "task-1", report: "No findings." },
    });
  });
});
