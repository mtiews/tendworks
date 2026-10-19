import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runWorkflow, validateWorkflow } from "../index.js";
import { InMemoryAgentTaskExecutor } from "./in-memory-agent-task-executor.js";

// The example workflow of the automated path (examples/config/workflows/develop-issue.sw.yaml),
// run by the interpreter against an in-memory developer agent.

const definition = validateWorkflow(
  parse(readFileSync(new URL("../../../../examples/config/workflows/develop-issue.sw.yaml", import.meta.url), "utf8")),
);

const issue = {
  repository: "acme/playground",
  number: 12,
  title: "Add a greeting",
  body: "Print `hello` on start.",
  state: "open",
  labels: ["ready-for-agent"],
  url: "https://github.com/acme/playground/issues/12",
};
const runId = "0b6c4c1e-5f1a-4c3e-9d2b-1a2b3c4d5e6f";

function developer(pullRequest?: string) {
  return new InMemoryAgentTaskExecutor().agent("developer", () => ({
    id: "task-1",
    status: { state: "TASK_STATE_COMPLETED", message: { messageId: "s", role: "ROLE_AGENT", parts: [{ text: "Opened the pull request." }] } },
    artifacts: [
      { artifactId: "task-1/echo", name: "notes", parts: [{ text: "irrelevant" }] },
      ...(pullRequest ? [{ artifactId: "task-1/pull-request", name: "pull-request", parts: [{ url: pullRequest }] }] : []),
    ],
  }));
}

describe("example workflow develop-issue", () => {
  it("hands the issue's title and body to the developer agent as its task", async () => {
    const executor = developer();

    await runWorkflow(definition, { runId, input: { issue }, executor });

    expect(executor.requests).toHaveLength(1);
    expect(executor.requests[0]?.agent).toBe("developer");
    const text = executor.requests[0]!.request.message.parts.flatMap((part) => ("text" in part ? [part.text] : [])).join("\n");
    expect(text).toContain("#12");
    expect(text).toContain("Add a greeting");
    expect(text).toContain("Print `hello` on start.");
    expect(text).toContain(issue.url);
  });

  it("asks for a checkout of the issue's repository on a branch fixed by the run", async () => {
    const first = developer();
    const again = developer();
    const other = developer();

    await runWorkflow(definition, { runId, input: { issue }, executor: first });
    await runWorkflow(definition, { runId, input: { issue }, executor: again });
    await runWorkflow(definition, { runId: "7f1d2a9e-other-run", input: { issue }, executor: other });

    const workspace = (executor: InMemoryAgentTaskExecutor) => executor.requests[0]?.request.message.metadata?.["dev.tendworks/workspace"];
    expect(workspace(first)).toEqual({ repository: "https://github.com/acme/playground.git", branch: "tendworks/issue-12-0b6c4c1e" });
    expect(workspace(again)).toEqual(workspace(first));
    expect(workspace(other)).not.toEqual(workspace(first));
  });

  it("records the pull request the agent reported in the run's output", async () => {
    const run = await runWorkflow(definition, { runId, input: { issue }, executor: developer("https://github.com/acme/playground/pull/13") });

    expect(run).toMatchObject({
      status: "completed",
      output: { issue: 12, branch: "tendworks/issue-12-0b6c4c1e", pullRequest: "https://github.com/acme/playground/pull/13" },
    });
  });

  it("leaves the pull request empty when the agent reported none", async () => {
    const run = await runWorkflow(definition, { runId, input: { issue }, executor: developer() });

    expect(run).toMatchObject({ status: "completed", output: { pullRequest: null } });
  });
});
