import { createControlPlaneApi, createInMemoryAgentRuntime, createInMemoryRuns, emptyConfiguration, type Run, type TranscriptEntry } from "@tendworks/control-plane";
import { describe, expect, it, vi } from "vitest";
import { parse, parseAllDocuments } from "yaml";
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
  startedBy: { kind: "trigger", binding: "ready-issues", workspace: "playground", item: { key: "acme/playground#7", title: "Fix the login", url: "https://github.com/acme/playground/issues/7" } },
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
    { position: 5, time: at("12:00:03"), type: "workspace-checkout", workspace: { url: "https://git.example/acme/app.git", name: "app", branch: "tendworks/run-1" }, exitCode: 0, output: "" },
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
    configuration: emptyConfiguration(),
    apiToken: "test-token",
    readToken: "test-read-token",
    runs,
  });
  let stdout = "";
  let stderr = "";
  const exitCode = await runTend(["--token", "test-token", ...args], {
    fetch: (request) => api.fetch(request),
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { exitCode, stdout, stderr };
}

describe("tend run list", () => {
  it("reads with the read-only token too, and says how to pass a token when the control plane refuses", async () => {
    const withReadToken = await tend(["--token", "test-read-token", "run", "list"]);
    const refused = await tend(["--token", "wrong-token", "run", "list"]);

    expect(withReadToken.exitCode).toBe(0);
    expect(refused).toEqual({ exitCode: 1, stdout: "", stderr: "tend: the control plane refused the token (HTTP 401); set TEND_API_TOKEN or pass --token\n" });
  });

  it("shows runs newest first with status, workflow and start time", async () => {
    const { exitCode, stdout } = await tend(["run", "list"]);

    expect(exitCode).toBe(0);
    const lines = stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^ID\s+WORKFLOW\s+STATUS\s+STARTED BY\s+CREATED\s+FINISHED$/);
    expect(lines[1]).toMatch(
      /^7f1d2a9e-run-failed\s+hello-agent\s+failed\s+trigger ready-issues in playground: acme\/playground#7\s+2026-10-18T11:00:00.000Z\s+2026-10-18T10:00:02.000Z$/,
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

  it("shows the artifacts each step's agent reported, e.g. the pull request it opened", async () => {
    const withArtifacts: Run = {
      ...completed,
      id: "run-with-artifacts",
      steps: [
        { ...completed.steps[0]!, artifacts: [{ name: "Pull request #7", url: "https://git.example/acme/app/pull/7" }, { name: "Preview", url: "https://preview.example/7" }] },
        { ...completed.steps[0]!, reference: "/do/1/notify", taskId: "task-2" },
      ],
    };
    const { stdout } = await tend(["run", "get", withArtifacts.id], [withArtifacts]);

    expect(stdout).toMatch(/^STEP\s+ARTIFACT\s+URL$/m);
    expect(stdout).toMatch(/^\/do\/0\/implement\s+Pull request #7\s+https:\/\/git\.example\/acme\/app\/pull\/7$/m);
    expect(stdout).toMatch(/^\/do\/0\/implement\s+Preview\s+https:\/\/preview\.example\/7$/m);
    expect(stdout).not.toMatch(/^\/do\/1\/notify\s+\S+\s+https?:/m);
  });

  it("shows no artifacts table for a run without artifacts", async () => {
    const { stdout } = await tend(["run", "get", completed.id]);

    expect(stdout).not.toMatch(/ARTIFACT/);
  });

  it("shows why a failed run failed", async () => {
    const { exitCode, stdout } = await tend(["run", "get", failed.id]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^STATUS\s+failed$/m);
    expect(stdout).toMatch(/^STARTED BY\s+trigger ready-issues in playground: acme\/playground#7 \(https:\/\/github.com\/acme\/playground\/issues\/7\)$/m);
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

describe("tend run retry", () => {
  const configured = emptyConfiguration({
    workflowNames: ["hello-agent"],
    workflow: (name) => (name === "hello-agent" ? ({ document: { name } } as never) : undefined),
  });

  async function retry(args: string[], token = "test-token") {
    const runs = createInMemoryRuns();
    for (const run of [completed, failed]) runs.runs.set(run.id, run);
    const api = createControlPlaneApi({ probes: [], configuration: configured, apiToken: "test-token", readToken: "test-read-token", runs });
    let stdout = "";
    let stderr = "";
    const exitCode = await runTend(["--token", token, "run", "retry", ...args], {
      fetch: (request) => api.fetch(request),
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
    });
    return { exitCode, stdout, stderr, runs };
  }

  it("starts a new run of a failed run's workflow with its input and origin, and names it", async () => {
    const { exitCode, stdout, runs } = await retry([failed.id]);

    expect(exitCode).toBe(0);
    expect(runs.started).toEqual([expect.objectContaining({ input: failed.input, startedBy: { ...failed.startedBy, retryOf: failed.id } })]);
    const [retried] = [...runs.runs.values()].filter((run) => run.startedBy?.retryOf === failed.id);
    expect(stdout).toBe(`run ${retried!.id} of hello-agent started, retry of ${failed.id}\n`);
  });

  it("prints the new run as a document with -o json", async () => {
    const { stdout } = await retry([failed.id, "-o", "json"]);

    expect(JSON.parse(stdout)).toMatchObject({ workflow: "hello-agent", status: "pending", startedBy: { retryOf: failed.id } });
  });

  it("exits 1 with the reason for a run that did not fail, and for an unknown run", async () => {
    const notFailed = await retry([completed.id]);
    const unknown = await retry(["nope"]);

    expect(notFailed.exitCode).toBe(1);
    expect(notFailed.stderr).toContain(`run ${completed.id} is completed; only a failed run can be retried`);
    expect(notFailed.runs.started).toEqual([]);
    expect(unknown).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("run nope not found") });
  });

  it("says that the read-only token cannot retry", async () => {
    const { exitCode, stderr, runs } = await retry([failed.id], "test-read-token");

    expect(exitCode).toBe(1);
    expect(stderr).toContain("read-only");
    expect(runs.started).toEqual([]);
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

describe("tend run logs --follow", () => {
  const step = (reference: string, taskId: string, status: Run["steps"][number]["status"] = "running") => ({
    name: reference.split("/").at(-1)!,
    reference,
    status,
    taskId,
    startedAt: at("13:00:00"),
  });
  const live: Run = { ...running, id: "run-live", steps: [step("/do/0/implement", "task-live")] };
  const entry = {
    started: { position: 0, time: at("13:00:01"), type: "task-started", agent: "developer", message: { messageId: "m-1", role: "ROLE_USER", parts: [{ text: "Say hello" }] } },
    tool: { position: 1, time: at("13:00:02"), type: "tool-call", toolCallId: "tool-1", title: "Write hello.txt" },
    hel: { position: 2, time: at("13:00:03"), type: "message-chunk", text: "Hel" },
    lo: { position: 3, time: at("13:00:03"), type: "message-chunk", text: "lo\nthere" },
    ended: { position: 4, time: at("13:00:04"), type: "task-ended", state: "TASK_STATE_COMPLETED", message: "Hello" },
  } satisfies Record<string, TranscriptEntry>;

  function follow(args: string[], run: Run = live) {
    const runs = createInMemoryRuns();
    runs.runs.set(run.id, structuredClone(run));
    const agentRuntime = createInMemoryAgentRuntime();
    const api = createControlPlaneApi({
      agentRuntime,
      probes: [],
      configuration: emptyConfiguration(),
      apiToken: "test-token",
      readToken: "test-read-token",
      runs,
    });
    const requests: Request[] = [];
    let stdout = "";
    let stderr = "";
    const exitCode = runTend(["--token", "test-read-token", "run", "logs", run.id, "--follow", ...args], {
      fetch: (request) => {
        requests.push(request.clone());
        return api.fetch(request);
      },
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
      sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    });
    const update = (change: (run: Run) => void) => change(runs.runs.get(run.id)!);
    return { exitCode, agentRuntime, update, requests, out: () => stdout, err: () => stderr };
  }

  it("streams the entries of a running step as they come, reconnects without gaps or duplicates and stops when the run ends", async () => {
    const { exitCode, agentRuntime, update, requests, out } = follow([]);
    agentRuntime.transcripts.set("task-live", [entry.started]);
    agentRuntime.running.add("task-live");

    await vi.waitFor(() => expect(out()).toContain("Say hello"));
    agentRuntime.append("task-live", entry.tool);
    agentRuntime.append("task-live", entry.hel);
    await vi.waitFor(() => expect(out()).toContain("Hel"));
    // The connection breaks; tend reconnects after the last entry it printed.
    const streams = () => requests.filter((request) => request.url.endsWith("/transcript/stream"));
    agentRuntime.drop();
    await vi.waitFor(() => expect(streams()).toHaveLength(2));
    agentRuntime.append("task-live", entry.lo);
    agentRuntime.append("task-live", entry.ended);
    agentRuntime.end("task-live");
    update((run) => {
      run.status = "completed";
      run.steps[0]!.status = "completed";
    });

    expect(await exitCode).toBe(0);
    expect(out()).toBe(
      [
        "== /do/0/implement (task-live)",
        "13:00:01  task       developer: Say hello",
        "13:00:02  tool       Write hello.txt",
        "13:00:03  agent      Hello",
        "                     there",
        "13:00:04  ended      TASK_STATE_COMPLETED: Hello",
        "",
      ].join("\n"),
    );
    expect(streams().at(-1)!.headers.get("last-event-id")).toBe("2");
  });

  it("follows the agent steps of a run one after another, also steps that start later", async () => {
    const { exitCode, agentRuntime, update, out } = follow([], { ...live, steps: [step("/do/0/implement", "task-1", "completed")] });
    agentRuntime.transcripts.set("task-1", [entry.started, entry.ended]);
    agentRuntime.transcripts.set("task-2", [{ ...entry.started, agent: "reviewer", message: { ...entry.started.message, parts: [{ text: "Review it" }] } }]);
    agentRuntime.running.add("task-2");

    await vi.waitFor(() => expect(out()).toContain("TASK_STATE_COMPLETED"));
    update((run) => run.steps.push(step("/do/1/review", "task-2")));
    await vi.waitFor(() => expect(out()).toContain("Review it"));
    agentRuntime.end("task-2");
    update((run) => void (run.status = "failed"));

    expect(await exitCode).toBe(0);
    expect(out()).toBe(
      [
        "== /do/0/implement (task-1)",
        "13:00:01  task       developer: Say hello",
        "13:00:04  ended      TASK_STATE_COMPLETED: Hello",
        "",
        "== /do/1/review (task-2)",
        "13:00:01  task       reviewer: Review it",
        "",
      ].join("\n"),
    );
  });

  it("stops when the run ended, even if a step's stream stays open", async () => {
    const { exitCode, agentRuntime, update, out } = follow([]);
    agentRuntime.transcripts.set("task-live", [entry.started]);
    agentRuntime.running.add("task-live");

    await vi.waitFor(() => expect(out()).toContain("Say hello"));
    update((run) => void (run.status = "failed"));

    expect(await exitCode).toBe(0);
  });

  it("prints one JSON document per line with -o json", async () => {
    const { exitCode, agentRuntime, out } = follow(["-o", "json"], { ...live, status: "completed" });
    agentRuntime.transcripts.set("task-live", [entry.started, entry.ended]);

    expect(await exitCode).toBe(0);
    expect(out().trimEnd().split("\n").map((line) => JSON.parse(line) as unknown)).toEqual([
      { step: "/do/0/implement", taskId: "task-live", entry: entry.started },
      { step: "/do/0/implement", taskId: "task-live", entry: entry.ended },
    ]);
  });

  it("prints one YAML document per entry with -o yaml", async () => {
    const { exitCode, agentRuntime, out } = follow(["-o", "yaml"], { ...live, status: "completed" });
    agentRuntime.transcripts.set("task-live", [entry.started]);

    expect(await exitCode).toBe(0);
    expect(parseAllDocuments(out()).map((document) => document.toJS() as unknown)).toEqual([{ step: "/do/0/implement", taskId: "task-live", entry: entry.started }]);
  });

  it("says so for a step without a transcript and goes on", async () => {
    const { exitCode, out } = follow([], { ...live, status: "completed" });

    expect(await exitCode).toBe(0);
    expect(out()).toBe("== /do/0/implement (task-live)\n(no transcript)\n");
  });

  it("gives up with a message when the control plane cannot be reached again", async () => {
    let calls = 0;
    let stderr = "";
    const exitCode = await runTend(["--token", "test-token", "run", "logs", "run-live", "--follow"], {
      fetch: async (request) => {
        calls++;
        if (new URL(request.url).pathname === "/runs/run-live") return Response.json(live);
        throw new TypeError("fetch failed");
      },
      stdout: () => {},
      stderr: (text) => (stderr += text),
      sleep: async () => {},
    });

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/cannot reach the control plane at http:\/\/localhost:8080 \(fetch failed\)/);
    expect(calls).toBeGreaterThan(2);
  });
});
