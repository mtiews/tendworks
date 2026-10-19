import { createControlPlaneApi, createInMemoryRuns, type Run } from "@tendworks/control-plane";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runTend } from "./tend.js";

const completed: Run = {
  id: "0b6c4c1e-run-completed",
  workflow: "hello-agent",
  status: "completed",
  input: { issue: { number: 1 } },
  output: { state: "TASK_STATE_COMPLETED" },
  steps: [
    {
      name: "implement",
      reference: "/do/0/implement",
      status: "completed",
      taskId: "task-1",
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
  steps: [{ ...completed.steps[0]!, status: "failed", error }],
  createdAt: "2026-10-18T11:00:00.000Z",
};

async function tend(args: string[]) {
  const runs = createInMemoryRuns();
  runs.runs.set(completed.id, completed);
  runs.runs.set(failed.id, failed);
  const api = createControlPlaneApi({
    probes: [],
    configuration: { workflowNames: [], workflow: () => undefined, agentProfiles: [], triggerBindings: [] },
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
    expect(lines[0]).toMatch(/^ID\s+WORKFLOW\s+STATUS\s+CREATED\s+FINISHED$/);
    expect(lines[1]).toMatch(/^7f1d2a9e-run-failed\s+hello-agent\s+failed\s+2026-10-18T11:00:00.000Z\s+2026-10-18T10:00:02.000Z$/);
    expect(lines[2]).toMatch(/^0b6c4c1e-run-completed\s+hello-agent\s+completed\s+2026-10-18T10:00:00.000Z/);
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
    expect(stdout).toMatch(/^STEP\s+STATUS\s+TASK\s+STARTED\s+FINISHED$/m);
    expect(stdout).toMatch(/^\/do\/0\/implement\s+completed\s+task-1\s+2026-10-18T10:00:01.000Z\s+2026-10-18T10:00:02.000Z$/m);
  });

  it("shows why a failed run failed", async () => {
    const { exitCode, stdout } = await tend(["run", "get", failed.id]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^STATUS\s+failed$/m);
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
