import { createControlPlaneApi, createInMemoryRuns, createInMemoryTriggers, emptyConfiguration, type Trigger } from "@tendworks/control-plane";
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
