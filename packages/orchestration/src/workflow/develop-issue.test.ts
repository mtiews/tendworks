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
const runtime = { name: "tendworks", metadata: { controlPlaneUrl: "http://server:8080" } };

/**
 * The control plane's merge endpoint as the gate answers: with merge: auto it merges; with
 * merge: ask it answers 202 with the pending approval request until `approved` is set.
 */
function controlPlane(policy: "auto" | "ask" = "auto") {
  const gate = { approved: false };
  const http = new InMemoryHttpExecutor().respond(({ body }) => {
    const { pullRequest } = body as { run: string; pullRequest: string | null };
    if (pullRequest === null) {
      return { status: 400, content: { title: "No pull request to merge", status: 400, detail: "`pullRequest` is null" } };
    }
    if (policy === "auto") return { status: 200, content: { pullRequest, policy: "merge-gate", decision: "allow", merged: true, commit: "c0ffee" } };
    const approvalRequest = { id: "approval-1", status: gate.approved ? "approved" : "pending" };
    if (!gate.approved) return { status: 202, content: { pullRequest, policy: "careful", decision: "ask", merged: false, approvalRequest } };
    return { status: 200, content: { pullRequest, policy: "careful", decision: "ask", merged: true, commit: "c0ffee", approvalRequest } };
  });
  return Object.assign(http, { gate });
}

const decided = (decision: "approve" | "reject") => ({
  specversion: "1.0",
  id: "approval-1:approval.decided",
  source: "/tendworks/human-interaction",
  type: "dev.tendworks.approval.decided",
  runid: runId,
  data: { approvalRequest: "approval-1", decision, action: "merge" },
});
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

    await runWorkflow(definition, { runId, input: { issue }, http: controlPlane(), runtime, executor });

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

    await runWorkflow(definition, { runId, input: { issue }, http: controlPlane(), runtime, executor: first });
    await runWorkflow(definition, { runId, input: { issue }, http: controlPlane(), runtime, executor: again });
    await runWorkflow(definition, { runId: "7f1d2a9e-other-run", input: { issue }, executor: other });

    const workspace = (executor: InMemoryAgentTaskExecutor) => executor.requests[0]?.request.message.metadata?.["dev.tendworks/workspace"];
    expect(workspace(first)).toEqual({ repository: "https://github.com/acme/playground.git", branch: "tendworks/issue-12-0b6c4c1e" });
    expect(workspace(again)).toEqual(workspace(first));
    expect(workspace(other)).not.toEqual(workspace(first));
  });

  it("asks the control plane to merge the run's reported pull request, naming only the run and the pull request", async () => {
    const http = controlPlane();

    const run = await runWorkflow(definition, { runId, input: { issue }, http, runtime, executor: developer(PR), events: new EventQueue() });

    expect(http.requests).toEqual([
      { method: "POST", endpoint: "http://server:8080/pull-requests/merge", headers: {}, body: { run: runId, pullRequest: PR } },
    ]);
    expect(run).toMatchObject({
      status: "completed",
      steps: [
        { name: "implement", status: "completed" },
        { name: "merge", reference: "/do/1/merge", status: "completed" },
        { name: "merged", reference: "/do/2/merged", status: "completed" },
      ],
      output: { issue: 12, branch: "tendworks/issue-12-0b6c4c1e", pullRequest: PR, merged: true, commit: "c0ffee", decision: "allow" },
    });
  });

  it("waits for the decision on the approval request when the policy asks, and merges once approved", async () => {
    const http = controlPlane("ask");
    const events = new EventQueue();

    const running = runWorkflow(definition, { runId, input: { issue }, http, runtime, executor: developer(PR), events });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(http.requests).toHaveLength(1);
    http.gate.approved = true;
    events.deliver(decided("approve"));
    const run = await running;

    expect(http.requests.map((request) => request.body)).toEqual([
      { run: runId, pullRequest: PR },
      { run: runId, pullRequest: PR },
    ]);
    expect(run).toMatchObject({
      status: "completed",
      output: { pullRequest: PR, merged: true, commit: "c0ffee", decision: "ask", approvalRequest: "approval-1", approval: "approve" },
    });
    expect(run.steps.map((step) => step.name)).toEqual(["implement", "merge", "merged", "awaitDecision", "decided", "mergeApproved"]);
  });

  it("ends without merging when the approval request is rejected", async () => {
    const http = controlPlane("ask");
    const events = new EventQueue();
    events.deliver(decided("reject"));

    const run = await runWorkflow(definition, { runId, input: { issue }, http, runtime, executor: developer(PR), events });

    expect(http.requests).toHaveLength(1);
    expect(run).toMatchObject({ status: "completed", output: { pullRequest: PR, merged: false, decision: "ask", approval: "reject" } });
  });

  it("fails the merge step, with the gate's reason, when the agent reported no pull request", async () => {
    const http = controlPlane();

    const run = await runWorkflow(definition, { runId, input: { issue }, http, runtime, executor: developer() });

    expect(http.requests[0]?.body).toEqual({ run: runId, pullRequest: null });
    expect(run).toMatchObject({
      status: "failed",
      error: { instance: "/do/1/merge", status: 400, title: "No pull request to merge", detail: "`pullRequest` is null" },
      steps: [{ name: "implement", status: "completed" }, { name: "merge", status: "failed" }],
    });
  });
});
