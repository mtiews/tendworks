import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { EventQueue, runWorkflow, validateWorkflow } from "../index.js";
import { InMemoryAgentTaskExecutor } from "./in-memory-agent-task-executor.js";
import { InMemoryHttpExecutor } from "./in-memory-http-executor.js";

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
const PR = "https://github.com/acme/playground/pull/13";

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

    await runWorkflow(definition, { runId, input: { workspace: "playground", issue }, executor });

    expect(executor.requests).toHaveLength(1);
    expect(executor.requests[0]?.agent).toBe("developer");
    const text = executor.requests[0]!.request.message.parts.flatMap((part) => ("text" in part ? [part.text] : [])).join("\n");
    expect(text).toContain("#12");
    expect(text).toContain("Add a greeting");
    expect(text).toContain("Print `hello` on start.");
    expect(text).toContain(issue.url);
  });

  it("asks for the workspace the input names, on a branch fixed by the run", async () => {
    const first = developer();
    const again = developer();
    const other = developer();

    await runWorkflow(definition, { runId, input: { workspace: "playground", issue }, executor: first });
    await runWorkflow(definition, { runId, input: { workspace: "playground", issue }, executor: again });
    await runWorkflow(definition, { runId: "7f1d2a9e-other-run", input: { workspace: "playground", issue }, executor: other });

    const workspace = (executor: InMemoryAgentTaskExecutor) => executor.requests[0]?.request.message.metadata?.["dev.tendworks/workspace"];
    expect(workspace(first)).toEqual({ name: "playground", branch: "tendworks/issue-12-0b6c4c1e" });
    expect(workspace(again)).toEqual(workspace(first));
    expect(workspace(other)).not.toEqual(workspace(first));
  });

  it("records the workspace the run handed to the agent on the step that reported the pull request", async () => {
    const run = await runWorkflow(definition, { runId, input: { workspace: "playground", issue }, executor: developer(PR), events: new EventQueue() });

    expect(run.steps[0]).toMatchObject({
      name: "implement",
      workspace: { name: "playground", branch: "tendworks/issue-12-0b6c4c1e" },
      artifacts: [{ name: "pull-request", url: PR }],
    });
  });

  it("ends after the agent step, with the reported pull request in its output and no call to the platform", async () => {
    const http = new InMemoryHttpExecutor();

    const run = await runWorkflow(definition, { runId, input: { workspace: "playground", issue }, http, executor: developer(PR), events: new EventQueue() });

    expect(http.requests).toEqual([]);
    expect(run).toMatchObject({
      status: "completed",
      output: { issue: 12, branch: "tendworks/issue-12-0b6c4c1e", taskId: "task-1", pullRequest: PR },
    });
    expect(run.steps.map((step) => step.name)).toEqual(["implement"]);
  });
});
