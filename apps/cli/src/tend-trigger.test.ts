import { createControlPlaneApi, createInMemoryRuns, type Trigger } from "@tendworks/control-plane";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runTend } from "./tend.js";

const triggers: Trigger[] = [
  { name: "nightly", workflow: "triage", schedule: { every: { days: 1 } }, nextExecutionAt: "2026-10-19T00:00:00.000Z" },
  { name: "ready-issues", workflow: "implement-issue", schedule: { every: { minutes: 5, seconds: 30 } }, nextExecutionAt: "2026-10-18T10:05:30.000Z" },
];

async function tend(args: string[]) {
  const api = createControlPlaneApi({
    probes: [],
    configuration: { workflowNames: [], workflow: () => undefined, agentProfiles: [], triggerBindings: [] },
    runs: createInMemoryRuns(),
    triggers: { list: async () => triggers },
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

describe("tend trigger list", () => {
  it("shows every trigger with its workflow, schedule and next execution", async () => {
    const { exitCode, stdout } = await tend(["trigger", "list"]);

    expect(exitCode).toBe(0);
    expect(stdout.trimEnd().split("\n")).toEqual([
      expect.stringMatching(/^NAME\s+WORKFLOW\s+EVERY\s+NEXT EXECUTION$/),
      expect.stringMatching(/^nightly\s+triage\s+1d\s+2026-10-19T00:00:00.000Z$/),
      expect.stringMatching(/^ready-issues\s+implement-issue\s+5m30s\s+2026-10-18T10:05:30.000Z$/),
    ]);
  });

  it("prints the triggers as a document with -o json and -o yaml", async () => {
    const json = await tend(["trigger", "list", "-o", "json"]);
    const yaml = await tend(["trigger", "list", "-o", "yaml"]);

    expect(JSON.parse(json.stdout)).toEqual({ items: triggers });
    expect(parse(yaml.stdout)).toEqual({ items: triggers });
  });
});
