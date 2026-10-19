import { createControlPlaneApi, createInMemoryAgentRuntime, createInMemoryRuns, type Run, type TranscriptEntry } from "@tendworks/control-plane";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runTend } from "./tend.js";

const completed: Run = {
  id: "0b6c4c1e-run-completed",
  workflow: "hello-agent",
  status: "completed",
  input: { issue: { number: 1 } },
  startedBy: { kind: "manual" },
  output: { state: "TASK_STATE_COMPLETED" },
  steps: [
    {
      name: "implement",
      reference: "/do/0/implement",
      status: "completed",
      taskId: "task-1",
      transcript: "file:///var/lib/tendworks/transcripts/task-1.jsonl",
      cost: { amount: 0.4217, currency: "USD" },
      startedAt: "2026-10-18T10:00:01.000Z",
      finishedAt: "2026-10-18T10:00:02.000Z",
    },
  ],
  createdAt: "2026-10-18T10:00:00.000Z",
  startedAt: "2026-10-18T10:00:00.500Z",
  finishedAt: "2026-10-18T10:00:02.000Z",
};

const error = {
  type: "https://serverlessworkflow.io/spec/1.0.0/errors/runtime",
  status: 500,
  instance: "/do/0/implement",
  title: "Agent task ended in state TASK_STATE_FAILED",
  detail: "not today",
};
const { output: _output, ...withoutOutput } = completed;
const failed: Run = {
  ...withoutOutput,
  id: "7f1d2a9e-run-failed",
  status: "failed",
  error,
  startedBy: { kind: "trigger", binding: "ready-issues", issue: { repository: "acme/playground", number: 7, url: "https://github.com/acme/playground/issues/7" } },
  steps: [{ ...completed.steps[0]!, status: "failed", error }],
  createdAt: "2026-10-18T11:00:00.000Z",
};

const running: Run = {
  ...withoutOutput,
  id: "5c2e9b7a-run-running",
  status: "running",
  steps: [{ name: "implement", reference: "/do/0/implement", status: "running", taskId: "task-3", transcript: "file:///t/task-3.jsonl", startedAt: "2026-10-18T12:00:01.000Z" }],
  createdAt: "2026-10-18T12:00:00.000Z",
};

const twoAgents: Run = {
  ...running,
  id: "run-with-two-agents",
  steps: [
    completed.steps[0]!,
    { name: "merge", reference: "/do/1/merge", status: "completed", startedAt: "2026-10-18T12:00:00.000Z", finishedAt: "2026-10-18T12:00:00.500Z" },
    { name: "review", reference: "/do/2/review", status: "running", taskId: "task-3", startedAt: "2026-10-18T12:00:01.000Z" },
  ],
};

const at = (time: string) => `2026-10-18T${time}.000Z`;
const transcripts: Record<string, TranscriptEntry[]> = {
  "task-1": [
    { position: 0, time: at("10:00:01"), type: "task-started", agent: "developer", message: { messageId: "m-1", role: "ROLE_USER", parts: [{ text: "Implement issue #7" }, { data: [7] }] } },
    { position: 1, time: at("10:00:01"), type: "session-started", sessionId: "session-1", harness: { name: "scripted-agent", version: "1.0.0" } },
    { position: 2, time: at("10:00:02"), type: "thought-chunk", text: "Let me look." },
    { position: 3, time: at("10:00:02"), type: "tool-call", toolCallId: "tool-1", title: "Write hello.txt", kind: "edit" },
    { position: 4, time: at("10:00:03"), type: "tool-result", toolCallId: "tool-1", status: "completed", output: "changed /workspace/hello.txt" },
    { position: 5, time: at("10:00:04"), type: "message-chunk", text: "Created " },
    { position: 6, time: at("10:00:04"), type: "message-chunk", text: "hello.txt.\nIt says hello." },
    { position: 7, time: at("10:00:04"), type: "usage", cost: { amount: 0.42, currency: "USD" } },
    { position: 8, time: at("10:00:04"), type: "turn-ended", reason: "completed" },
    { position: 9, time: at("10:00:05"), type: "task-ended", state: "TASK_STATE_COMPLETED", message: "Created hello.txt.", cost: { amount: 0.42, currency: "USD" } },
  ],
  "task-3": [
    { position: 0, time: at("12:00:01"), type: "task-started", agent: "reviewer", message: { messageId: "m-3", role: "ROLE_USER", parts: [{ text: "Review it" }] } },
    { position: 1, time: at("12:00:02"), type: "task-resumed", agent: "reviewer", message: { messageId: "m-3", role: "ROLE_USER", parts: [{ text: "Review it" }] } },
    { position: 2, time: at("12:00:02"), type: "session-resume-failed", sessionId: "session-1", reason: "gone" },
    { position: 3, time: at("12:00:02"), type: "session-resumed", sessionId: "session-2" },
    { position: 4, time: at("12:00:02"), type: "plan", steps: [{ content: "Read the diff", status: "completed" }, { content: "Comment", status: "in-progress" }] },
    { position: 5, time: at("12:00:03"), type: "workspace-checkout", workspace: { repository: "https://git.example/acme/app.git", branch: "tendworks/run-1" }, exitCode: 0, output: "" },
    { position: 6, time: at("12:00:03"), type: "permission", tool: "Write review.md", granted: true },
    { position: 7, time: at("12:00:03"), type: "harness-output", text: "warning: slow" },
    { position: 8, time: at("12:00:04"), type: "error", message: "the harness ended unexpectedly" },
    { position: 9, time: at("12:00:04"), type: "artifacts", artifacts: [{ name: "pull-request", url: "https://git.example/acme/app/pull/7" }] },
    { position: 10, time: at("12:00:04"), type: "artifacts-ignored", problem: "artifacts: not a list" },
  ],
};

async function tend(args: string[], extra: Run[] = [], transcriptsOf: Record<string, TranscriptEntry[]> = {}) {
  const runs = createInMemoryRuns();
  for (const run of [completed, failed, ...extra]) runs.runs.set(run.id, run);
  const agentRuntime = createInMemoryAgentRuntime();
  for (const [taskId, entries] of Object.entries(transcriptsOf)) agentRuntime.transcripts.set(taskId, entries);
  const api = createControlPlaneApi({
    agentRuntime,
    probes: [],
    configuration: { workflowNames: [], workflow: () => undefined, agentProfiles: [], triggerBindings: [], policies: [], pullRequestIntegrations: [] },
    apiToken: "test-token",
    runs,
  });
  let stdout = "";
  let stderr = "";
  const exitCode = await runTend(args, {
    fetch: (request) => api.fetch(request),
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { exitCode, stdout, stderr };
}

describe("tend run list", () => {
  it("shows runs newest first with status, workflow and start time", async () => {
    const { exitCode, stdout } = await tend(["run", "list"]);

    expect(exitCode).toBe(0);
    const lines = stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^ID\s+WORKFLOW\s+STATUS\s+STARTED BY\s+CREATED\s+FINISHED$/);
    expect(lines[1]).toMatch(
      /^7f1d2a9e-run-failed\s+hello-agent\s+failed\s+trigger ready-issues: acme\/playground#7\s+2026-10-18T11:00:00.000Z\s+2026-10-18T10:00:02.000Z$/,
    );
    expect(lines[2]).toMatch(/^0b6c4c1e-run-completed\s+hello-agent\s+completed\s+manual\s+2026-10-18T10:00:00.000Z/);
  });

  it("prints the runs as a document with -o json and -o yaml", async () => {
    const json = await tend(["run", "list", "-o", "json"]);
    const yaml = await tend(["run", "list", "-o", "yaml"]);

    expect(JSON.parse(json.stdout)).toEqual({ items: [failed, completed] });
    expect(parse(yaml.stdout)).toEqual({ items: [failed, completed] });
  });
});

describe("tend run get", () => {
  it("shows a run with its steps", async () => {
    const { exitCode, stdout } = await tend(["run", "get", completed.id]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^RUN\s+0b6c4c1e-run-completed$/m);
    expect(stdout).toMatch(/^WORKFLOW\s+hello-agent$/m);
    expect(stdout).toMatch(/^STATUS\s+completed$/m);
    expect(stdout).toMatch(/^STEP\s+STATUS\s+TASK\s+COST\s+STARTED\s+FINISHED$/m);
    expect(stdout).toMatch(/^\/do\/0\/implement\s+completed\s+task-1\s+0.4217 USD\s+2026-10-18T10:00:01.000Z\s+2026-10-18T10:00:02.000Z$/m);
  });

  it("shows the cost of the run and where each agent session's transcript is", async () => {
    const twoSteps: Run = {
      ...completed,
      id: "run-with-two-agents",
      steps: [
        completed.steps[0]!,
        { ...completed.steps[0]!, reference: "/do/1/review", taskId: "task-2", transcript: "file:///t/task-2.jsonl", cost: { amount: 0.1, currency: "USD" } },
      ],
    };
    const { stdout } = await tend(["run", "get", twoSteps.id], [twoSteps]);

    expect(stdout).toMatch(/^COST\s+0.5217 USD$/m);
    expect(stdout).toMatch(/^STEP\s+TRANSCRIPT$/m);
    expect(stdout).toMatch(/^\/do\/0\/implement\s+file:\/\/\/var\/lib\/tendworks\/transcripts\/task-1.jsonl$/m);
    expect(stdout).toMatch(/^\/do\/1\/review\s+file:\/\/\/t\/task-2.jsonl$/m);
  });

  it("shows the task and transcript of a step that is still running", async () => {
    const { stdout } = await tend(["--token", "test-token", "run", "get", running.id], [running]);

    expect(stdout).toMatch(/^STATUS\s+running$/m);
    expect(stdout).toMatch(/^\/do\/0\/implement\s+running\s+task-3\s+2026-10-18T12:00:01.000Z$/m);
    expect(stdout).toMatch(/^\/do\/0\/implement\s+file:\/\/\/t\/task-3.jsonl$/m);
  });

  it("shows the run's output, e.g. the pull request the agent opened", async () => {
    const withPullRequest: Run = {
      ...completed,
      id: "run-with-pull-request",
      output: { pullRequest: "https://git.example/acme/app/pull/7", branch: "tendworks/run-1", checks: { passed: 3 } },
    };
    const { stdout } = await tend(["run", "get", withPullRequest.id], [withPullRequest]);

    expect(stdout).toMatch(/^OUTPUT\s+VALUE$/m);
    expect(stdout).toMatch(/^pullRequest\s+https:\/\/git\.example\/acme\/app\/pull\/7$/m);
    expect(stdout).toMatch(/^branch\s+tendworks\/run-1$/m);
    expect(stdout).toMatch(/^checks\s+\{"passed":3\}$/m);
  });

  it("shows why a failed run failed", async () => {
    const { exitCode, stdout } = await tend(["run", "get", failed.id]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^STATUS\s+failed$/m);
    expect(stdout).toMatch(/^STARTED BY\s+trigger ready-issues: acme\/playground#7 \(https:\/\/github.com\/acme\/playground\/issues\/7\)$/m);
    expect(stdout).toMatch(/^ERROR\s+\/do\/0\/implement: Agent task ended in state TASK_STATE_FAILED: not today$/m);
  });

  it("prints the run as a document with -o yaml", async () => {
    const { stdout } = await tend(["run", "get", failed.id, "-o", "yaml"]);

    expect(parse(stdout)).toEqual(failed);
  });

  it("exits 1 with a message for an unknown run", async () => {
    const { exitCode, stdout, stderr } = await tend(["run", "get", "nope"]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("run nope not found");
  });
});

describe("tend run logs", () => {
  const logs = (args: string[]) => tend(["--token", "test-token", "run", "logs", ...args], [running, twoAgents], transcripts);

  it("prints the transcript of each agent step in readable form, finished or running", async () => {
    const { exitCode, stdout } = await logs([twoAgents.id]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe(
      [
        "== /do/0/implement (task-1, completed)",
        "10:00:01  task       developer: Implement issue #7",
        "10:00:01  session    started session-1 (scripted-agent 1.0.0)",
        "10:00:02  thinking   Let me look.",
        "10:00:02  tool       Write hello.txt [edit]",
        "10:00:03  result     completed: changed /workspace/hello.txt",
        "10:00:04  agent      Created hello.txt.",
        "                     It says hello.",
        "10:00:04  usage      0.42 USD so far",
        "10:00:04  turn       completed",
        "10:00:05  ended      TASK_STATE_COMPLETED: Created hello.txt. (0.42 USD)",
        "",
        "== /do/2/review (task-3, running)",
        "12:00:01  task       reviewer: Review it",
        "12:00:02  resumed    task after an interruption",
        "12:00:02  session    could not resume session-1: gone",
        "12:00:02  session    resumed session-2",
        "12:00:02  plan       [completed] Read the diff",
        "                     [in-progress] Comment",
        "12:00:03  checkout   https://git.example/acme/app.git tendworks/run-1 (exit code 0)",
        "12:00:03  permission granted: Write review.md",
        "12:00:03  harness    warning: slow",
        "12:00:04  error      the harness ended unexpectedly",
        "12:00:04  artifact   pull-request https://git.example/acme/app/pull/7",
        "12:00:04  ignored    artifacts: not a list",
        "",
      ].join("\n"),
    );
  });

  it("prints the transcripts as a document with -o json and -o yaml", async () => {
    const json = await logs([twoAgents.id, "-o", "json"]);
    const yaml = await logs([twoAgents.id, "-o", "yaml"]);

    const expected = {
      run: twoAgents.id,
      steps: [
        { reference: "/do/0/implement", status: "completed", taskId: "task-1", entries: transcripts["task-1"] },
        { reference: "/do/2/review", status: "running", taskId: "task-3", entries: transcripts["task-3"] },
      ],
    };
    expect(JSON.parse(json.stdout)).toEqual(expected);
    expect(parse(yaml.stdout)).toEqual(expected);
  });

  it("says so when the run has no agent step yet, and when a step's transcript cannot be found", async () => {
    const noAgents: Run = { ...completed, id: "run-without-agents", steps: [] };
    const lost: Run = { ...running, id: "run-with-lost-transcript", steps: [{ ...running.steps[0]!, taskId: "task-lost" }] };

    expect((await tend(["--token", "test-token", "run", "logs", noAgents.id], [noAgents])).stdout).toBe("run run-without-agents has no agent steps yet\n");
    expect((await tend(["--token", "test-token", "run", "logs", lost.id], [lost])).stdout).toBe("== /do/0/implement (task-lost, running)\n(no transcript)\n");
  });

  it("exits 1 with a message for an unknown run", async () => {
    const { exitCode, stderr } = await logs(["nope"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("run nope not found");
  });
});
