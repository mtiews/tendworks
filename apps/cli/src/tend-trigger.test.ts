import { createControlPlaneApi, createInMemoryAgentRuntime, createInMemoryRuns, createInMemoryTriggers, emptyConfiguration, type Run, type Trigger } from "@tendworks/control-plane";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runTend } from "./tend.js";

const triggers: Trigger[] = [
  {
    name: "architecture-review",
    workflow: "review-workspace",
    kind: "manual",
    workspaces: ["app"],
    lastEvaluation: { at: "2026-10-18T09:30:00.000Z", status: "succeeded", startedRuns: 1 },
  },
  {
    name: "github-issues",
    workflow: "develop-issue",
    kind: "github-issues",
    workspaces: ["app", "web"],
    schedule: { every: { minutes: 1 } },
    nextExecutionAt: "2026-10-18T10:01:00.000Z",
    lastEvaluation: { at: "2026-10-18T10:00:00.000Z", status: "failed", startedRuns: 0, message: "secret TENDWORKS_PLATFORM_GITHUB_TOKEN is not set" },
  },
  { name: "nightly", workflow: "triage", kind: "schedule", workspaces: ["app"], schedule: { cron: "0 2 * * *" }, nextExecutionAt: "2026-10-19T02:00:00.000Z", suspended: true },
  {
    name: "ready-issues",
    workflow: "implement-issue",
    kind: "fake",
    workspaces: [],
    schedule: { every: { minutes: 5, seconds: 30 } },
    nextExecutionAt: "2026-10-18T10:05:30.000Z",
    lastEvaluation: { at: "2026-10-18T10:00:00.000Z", status: "succeeded", startedRuns: 2 },
  },
];

async function tend(args: string[]) {
  const api = createControlPlaneApi({
    probes: [],
    configuration: emptyConfiguration(),
    apiToken: "test-token",
    runs: createInMemoryRuns(),
    triggers: createInMemoryTriggers(triggers),
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

describe("tend trigger list", () => {
  it("shows every trigger with its workflow, kind, workspaces, schedule, next execution and how its last check went", async () => {
    const { exitCode, stdout } = await tend(["trigger", "list"]);

    expect(exitCode).toBe(0);
    expect(stdout.trimEnd().split("\n")).toEqual([
      expect.stringMatching(/^NAME\s+WORKFLOW\s+TRIGGER\s+WORKSPACES\s+SCHEDULE\s+NEXT EXECUTION\s+LAST CHECK$/),
      expect.stringMatching(/^architecture-review\s+review-workspace\s+manual\s+app\s+-\s+-\s+succeeded 2026-10-18T09:30:00.000Z, 1 run started$/),
      expect.stringMatching(
        /^github-issues\s+develop-issue\s+github-issues\s+app,web\s+every 1m\s+2026-10-18T10:01:00.000Z\s+failed 2026-10-18T10:00:00.000Z: secret TENDWORKS_PLATFORM_GITHUB_TOKEN is not set$/,
      ),
      expect.stringMatching(/^nightly\s+triage\s+schedule\s+app\s+cron 0 2 \* \* \*\s+suspended$/),
      expect.stringMatching(/^ready-issues\s+implement-issue\s+fake\s+-\s+every 5m30s\s+2026-10-18T10:05:30.000Z\s+succeeded 2026-10-18T10:00:00.000Z, 2 runs started$/),
    ]);
  });

  it("prints the triggers as a document with -o json and -o yaml", async () => {
    const json = await tend(["trigger", "list", "-o", "json"]);
    const yaml = await tend(["trigger", "list", "-o", "yaml"]);

    expect(JSON.parse(json.stdout)).toEqual({ items: triggers });
    expect(parse(yaml.stdout)).toEqual({ items: triggers });
  });
});

describe("tend trigger fire", () => {
  const manual: Trigger[] = [
    { name: "architecture-review", workflow: "review-workspace", kind: "manual", workspaces: ["app", "web"] },
    { name: "security-review", workflow: "review-workspace", kind: "manual", workspaces: ["app"] },
    { name: "cleanup", workflow: "cleanup", kind: "manual", workspaces: [] },
    { name: "paused-review", workflow: "review-workspace", kind: "manual", workspaces: ["app"], suspended: true },
    triggers[1]!,
  ];
  const started: Run = {
    id: "run-1",
    workflow: "review-workspace",
    status: "completed",
    input: { workspace: "app" },
    startedBy: { kind: "trigger", binding: "security-review", workspace: "app", item: { key: "2026-10-18T10:00:00.000Z", title: "started by hand" } },
    steps: [{ name: "review", reference: "/do/0/review", status: "completed", taskId: "task-1", startedAt: "2026-10-18T10:00:01.000Z" }],
    createdAt: "2026-10-18T10:00:00.000Z",
  };

  async function fire(args: string[], token = "test-token") {
    const firing = createInMemoryTriggers(manual);
    const runs = createInMemoryRuns();
    runs.runs.set(started.id, started);
    const agentRuntime = createInMemoryAgentRuntime();
    agentRuntime.transcripts.set("task-1", [{ position: 0, time: "2026-10-18T10:00:01.000Z", type: "task-ended", state: "TASK_STATE_COMPLETED", message: "Reviewed." }]);
    const api = createControlPlaneApi({
      agentRuntime,
      probes: [],
      configuration: emptyConfiguration(),
      apiToken: "test-token",
      readToken: "test-read-token",
      runs,
      triggers: firing,
    });
    let stdout = "";
    let stderr = "";
    const exitCode = await runTend(["--token", token, "trigger", "fire", ...args], {
      fetch: (request) => api.fetch(request),
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
      sleep: async () => {},
    });
    return { exitCode, stdout, stderr, fired: firing.fired };
  }

  it("fires the binding and prints one line per started run with its workspace and id", async () => {
    const { exitCode, stdout, fired } = await fire(["architecture-review"]);

    expect(exitCode).toBe(0);
    expect(fired).toEqual([{ name: "architecture-review", request: {} }]);
    expect(stdout).toBe("run run-1 started by trigger architecture-review in workspace app\nrun run-2 started by trigger architecture-review in workspace web\n");
  });

  it("names no workspace for a binding without workspaces", async () => {
    const { exitCode, stdout } = await fire(["cleanup"]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe("run run-1 started by trigger cleanup\n");
  });

  it("fires only the workspace given with --workspace", async () => {
    const { exitCode, stdout, fired } = await fire(["architecture-review", "--workspace", "web"]);

    expect(exitCode).toBe(0);
    expect(fired).toEqual([{ name: "architecture-review", request: { workspace: "web" } }]);
    expect(stdout).toBe("run run-1 started by trigger architecture-review in workspace web\n");
  });

  it("prints the started runs as a document with -o json and -o yaml", async () => {
    const json = await fire(["architecture-review", "-o", "json"]);
    const yaml = await fire(["architecture-review", "-o", "yaml"]);

    const expected = { items: [{ workspace: "app", runId: "run-1" }, { workspace: "web", runId: "run-2" }] };
    expect(JSON.parse(json.stdout)).toEqual(expected);
    expect(parse(yaml.stdout)).toEqual(expected);
  });

  it("streams the started run with --follow when exactly one run starts", async () => {
    const { exitCode, stdout } = await fire(["security-review", "--follow"]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe(
      ["run run-1 started by trigger security-review in workspace app", "== /do/0/review (task-1)", "10:00:01  ended      TASK_STATE_COMPLETED: Reviewed.", ""].join("\n"),
    );
  });

  it("refuses --follow before firing when the binding would start more than one run", async () => {
    const { exitCode, stdout, stderr, fired } = await fire(["architecture-review", "--follow"]);

    expect(exitCode).toBe(1);
    expect(fired).toEqual([]);
    expect(stdout).toBe("");
    expect(stderr).toContain("--follow follows one run, but trigger binding architecture-review would start 2 (app, web); name one with --workspace");
  });

  it("allows --follow over several workspaces once --workspace names one", async () => {
    const { exitCode, fired } = await fire(["architecture-review", "--workspace", "app", "--follow"]);

    expect(exitCode).toBe(0);
    expect(fired).toEqual([{ name: "architecture-review", request: { workspace: "app" } }]);
  });

  it("exits 1 with the reason for an unknown, a suspended or a scheduled binding, and a foreign workspace", async () => {
    const unknown = await fire(["nope"]);
    const suspended = await fire(["paused-review"]);
    const scheduled = await fire(["github-issues"]);
    const foreign = await fire(["security-review", "--workspace", "web"]);

    expect(unknown).toMatchObject({ exitCode: 1, stdout: "", stderr: "tend: trigger binding nope not found\n" });
    expect(suspended).toMatchObject({ exitCode: 1, stderr: "tend: trigger binding paused-review cannot be fired: trigger binding 'paused-review' is suspended\n" });
    expect(scheduled).toMatchObject({
      exitCode: 1,
      stderr: "tend: trigger binding github-issues cannot be fired: trigger binding 'github-issues' of kind 'github-issues' fires on its own; only a binding of kind 'manual' can be fired\n",
    });
    expect(foreign).toMatchObject({ exitCode: 1, stderr: "tend: trigger binding security-review cannot be fired: trigger binding 'security-review' does not start runs in workspace 'web' (workspaces: app)\n" });
    expect([unknown, suspended, scheduled, foreign].flatMap(({ fired }) => fired)).toEqual([]);
  });

  it("says that the read-only token cannot fire a binding", async () => {
    const { exitCode, stderr, fired } = await fire(["security-review"], "test-read-token");

    expect(exitCode).toBe(1);
    expect(stderr).toContain("read-only");
    expect(fired).toEqual([]);
  });

  it("exits 1 with a message when the control plane cannot be reached", async () => {
    let stderr = "";
    const exitCode = await runTend(["--token", "test-token", "trigger", "fire", "security-review"], {
      fetch: () => Promise.reject(new TypeError("fetch failed")),
      stdout: () => {},
      stderr: (text) => (stderr += text),
    });

    expect(exitCode).toBe(1);
    expect(stderr).toBe("tend: cannot reach the control plane at http://localhost:8080 (fetch failed)\n");
  });

  it("exits 1 when the firing started no run", async () => {
    let stderr = "";
    const exitCode = await runTend(["--token", "test-token", "trigger", "fire", "security-review"], {
      fetch: async () => Response.json({ items: [] }, { status: 201 }),
      stdout: () => {},
      stderr: (text) => (stderr += text),
    });

    expect(exitCode).toBe(1);
    expect(stderr).toBe("tend: trigger binding security-review started no run; tend trigger list shows why in its last check\n");
  });
});
