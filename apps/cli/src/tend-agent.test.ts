import { createControlPlaneApi, createInMemoryAgentRuntime, createInMemoryRuns, loadConfiguration } from "@tendworks/control-plane";
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
  writeFileSync(join(dir, "agents", "reviewer.md"), profile("reviewer", "  harness: fake\n  chat: { idleMinutes: 3 }\n  mcp: [tendworks]"));
  writeFileSync(
    join(dir, "agents", "developer.md"),
    profile(
      "developer",
      "  harness: claude-code\n  sandbox: claude-code\n  skills: [tdd]\n  env:\n    GH_TOKEN: { secretRef: { name: TENDWORKS_AGENT_PLAYGROUND_TOKEN } }",
    ),
  );
  return loadConfiguration(dir);
}

/** A control plane on which the developer works on a run's step and the reviewer is in a chat. */
async function busy() {
  const agentRuntime = createInMemoryAgentRuntime({ chatAgents: ["reviewer"] });
  const step = agentRuntime.startStep({ agent: "developer", run: "run-1", step: "/do/0/implement" });
  const chat = await agentRuntime.startChat({ agent: "reviewer", text: "Review it" });
  const api = createControlPlaneApi({ probes: [], configuration: configuration(), apiToken: "test-token", runs: createInMemoryRuns(), agentRuntime });
  return { api, step, chat };
}

async function tend(api: { fetch(request: Request): Promise<Response> }, args: string[]) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runTend(["--token", "test-token", ...args], { fetch: (request) => api.fetch(request), stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) });
  return { exitCode, stdout, stderr };
}

describe("tend agent list", () => {
  it("shows the configured agent profiles by name with harness, sandbox, skills and the number of active sessions", async () => {
    const { api } = await busy();

    const { exitCode, stdout } = await tend(api, ["agent", "list"]);

    expect(exitCode).toBe(0);
    expect(stdout.trimEnd().split("\n")).toEqual([
      expect.stringMatching(/^NAME\s+HARNESS\s+SANDBOX\s+SKILLS\s+SESSIONS$/),
      expect.stringMatching(/^developer\s+claude-code\s+claude-code\s+tdd\s+1$/),
      expect.stringMatching(/^reviewer\s+fake\s+1$/),
    ]);
  });

  it("shows ? as the number of sessions while the agent runtime cannot be reached", async () => {
    const api = createControlPlaneApi({ probes: [], configuration: configuration(), apiToken: "test-token", runs: createInMemoryRuns() });

    const { exitCode, stdout } = await tend(api, ["agent", "list"]);

    expect(exitCode).toBe(0);
    expect(stdout.trimEnd().split("\n").slice(1)).toEqual([
      expect.stringMatching(/^developer\s+claude-code\s+claude-code\s+tdd\s+\?$/),
      expect.stringMatching(/^reviewer\s+fake\s+\?$/),
    ]);
  });

  it("prints the agent profiles with chat settings, MCP servers and sessions as a document with -o json and -o yaml, naming secrets but never their values", async () => {
    const { api, step, chat } = await busy();
    const agents = [
      {
        name: "developer",
        harness: "claude-code",
        sandbox: "claude-code",
        skills: ["tdd"],
        secrets: ["TENDWORKS_AGENT_PLAYGROUND_TOKEN"],
        sessions: [{ kind: "run-step", agent: "developer", taskId: step.taskId, status: "working", startedAt: step.startedAt, run: "run-1", step: "/do/0/implement" }],
      },
      {
        name: "reviewer",
        harness: "fake",
        chat: { idleMinutes: 3 },
        mcp: ["tendworks"],
        sessions: [{ kind: "chat", agent: "reviewer", taskId: chat.id, status: "working", startedAt: chat.startedAt, chat: chat.id }],
      },
    ];

    const json = await tend(api, ["agent", "list", "-o", "json"]);
    const yaml = await tend(api, ["agent", "list", "-o", "yaml"]);

    expect(JSON.parse(json.stdout)).toEqual({ items: agents });
    expect(parse(yaml.stdout)).toEqual({ items: agents });
  });
});
