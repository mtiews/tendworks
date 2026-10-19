import { createControlPlaneApi, createInMemoryRuns, loadConfiguration } from "@tendworks/control-plane";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runTend } from "./tend.js";

function configuration() {
  const dir = mkdtempSync(join(tmpdir(), "tend-agents-"));
  mkdirSync(join(dir, "agents"));
  const profile = (name: string, spec: string) => `---\napiVersion: tendworks.dev/v1\nkind: AgentProfile\nmetadata:\n  name: ${name}\nspec:\n${spec}\n---\nRole.\n`;
  writeFileSync(join(dir, "agents", "reviewer.md"), profile("reviewer", "  harness: fake"));
  writeFileSync(
    join(dir, "agents", "developer.md"),
    profile(
      "developer",
      "  harness: claude-code\n  sandbox: claude-code\n  skills: [tdd]\n  env:\n    GH_TOKEN: { secretRef: { name: TENDWORKS_AGENT_GITHUB_TOKEN } }",
    ),
  );
  return loadConfiguration(dir);
}

async function tend(args: string[]) {
  const api = createControlPlaneApi({ probes: [], configuration: configuration(), apiToken: "test-token", runs: createInMemoryRuns() });
  let stdout = "";
  let stderr = "";
  const exitCode = await runTend(args, { fetch: (request) => api.fetch(request), stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) });
  return { exitCode, stdout, stderr };
}

const agents = [
  { name: "developer", harness: "claude-code", sandbox: "claude-code", skills: ["tdd"], secrets: ["TENDWORKS_AGENT_GITHUB_TOKEN"] },
  { name: "reviewer", harness: "fake" },
];

describe("tend agent list", () => {
  it("shows the configured agent profiles by name with harness, sandbox and skills", async () => {
    const { exitCode, stdout } = await tend(["agent", "list"]);

    expect(exitCode).toBe(0);
    expect(stdout.trimEnd().split("\n")).toEqual([
      expect.stringMatching(/^NAME\s+HARNESS\s+SANDBOX\s+SKILLS$/),
      expect.stringMatching(/^developer\s+claude-code\s+claude-code\s+tdd$/),
      expect.stringMatching(/^reviewer\s+fake$/),
    ]);
  });

  it("prints the agent profiles as a document with -o json and -o yaml, naming secrets but never their values", async () => {
    const json = await tend(["agent", "list", "-o", "json"]);
    const yaml = await tend(["agent", "list", "-o", "yaml"]);

    expect(JSON.parse(json.stdout)).toEqual({ items: agents });
    expect(parse(yaml.stdout)).toEqual({ items: agents });
  });
});
