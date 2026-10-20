import { createControlPlaneApi, createInMemoryRuns, type Trigger } from "@tendworks/control-plane";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runTend } from "./tend.js";

const triggers: Trigger[] = [
  {
    name: "github-issues",
    workflow: "develop-issue",
    schedule: { every: { minutes: 1 } },
    nextExecutionAt: "2026-10-18T10:01:00.000Z",
    lastEvaluation: { at: "2026-10-18T10:00:00.000Z", status: "failed", startedRuns: 0, message: "secret TENDWORKS_PLATFORM_GITHUB_TOKEN is not set" },
  },
  { name: "nightly", workflow: "triage", schedule: { every: { days: 1 } }, nextExecutionAt: "2026-10-19T00:00:00.000Z", suspended: true },
  {
    name: "ready-issues",
    workflow: "implement-issue",
    schedule: { every: { minutes: 5, seconds: 30 } },
    nextExecutionAt: "2026-10-18T10:05:30.000Z",
    lastEvaluation: { at: "2026-10-18T10:00:00.000Z", status: "succeeded", startedRuns: 2 },
  },
];

async function tend(args: string[]) {
  const api = createControlPlaneApi({
    probes: [],
    configuration: { workflowNames: [], workflow: () => undefined, agentProfiles: [], triggerBindings: [], policies: [], pullRequestIntegrations: [] },
    apiToken: "test-token",
    runs: createInMemoryRuns(),
    triggers: { list: async () => triggers },
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
  it("shows every trigger with its workflow, schedule, next execution and how its last check went", async () => {
    const { exitCode, stdout } = await tend(["trigger", "list"]);

    expect(exitCode).toBe(0);
    expect(stdout.trimEnd().split("\n")).toEqual([
      expect.stringMatching(/^NAME\s+WORKFLOW\s+EVERY\s+NEXT EXECUTION\s+LAST CHECK$/),
      expect.stringMatching(
        /^github-issues\s+develop-issue\s+1m\s+2026-10-18T10:01:00.000Z\s+failed 2026-10-18T10:00:00.000Z: secret TENDWORKS_PLATFORM_GITHUB_TOKEN is not set$/,
      ),
      expect.stringMatching(/^nightly\s+triage\s+1d\s+suspended$/),
      expect.stringMatching(/^ready-issues\s+implement-issue\s+5m30s\s+2026-10-18T10:05:30.000Z\s+succeeded 2026-10-18T10:00:00.000Z, 2 runs started$/),
    ]);
  });

  it("prints the triggers as a document with -o json and -o yaml", async () => {
    const json = await tend(["trigger", "list", "-o", "json"]);
    const yaml = await tend(["trigger", "list", "-o", "yaml"]);

    expect(JSON.parse(json.stdout)).toEqual({ items: triggers });
    expect(parse(yaml.stdout)).toEqual({ items: triggers });
  });
});
