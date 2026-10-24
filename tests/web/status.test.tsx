import { createAgentRuntimeClient, createInMemoryAgentRuntime, createInMemoryApprovals, createInMemoryRuns, createInMemoryTriggers, emptyConfiguration, type HealthProbe, type Trigger } from "@tendworks/control-plane";
import type { AgentProfile } from "@tendworks/shared";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { API_TOKEN, renderApp, type PlatformOptions } from "./support/platform.js";
import { rows } from "./support/table.js";

function openStatus(options: PlatformOptions = {}) {
  window.sessionStorage.setItem("tendworks.token", API_TOKEN);
  return renderApp({ path: "/ui/", ...options });
}

const probe = (name: string, status: "healthy" | "unhealthy", message?: string): HealthProbe => ({
  name,
  check: async () => ({ status, ...(message === undefined ? {} : { message }) }),
});

function run(id: string, status: "pending" | "running" | "completed" | "failed") {
  return { id, workflow: "hello-agent", status, input: {}, steps: [], createdAt: "2026-10-18T10:00:00.000Z" };
}

const approval = {
  runId: "r-1",
  workflow: "develop-issue",
  action: "merge" as const,
  policy: "careful",
  question: "Merge https://github.com/example/playground/pull/7 for run r-1 of develop-issue?",
  createdAt: "2026-10-18T09:00:00.000Z",
};

describe("status page: platform health", () => {
  it("shows health with each component, the active runs and the pending approval requests", async () => {
    const runs = createInMemoryRuns();
    for (const fixture of [run("r-1", "running"), run("r-2", "pending"), run("r-3", "completed"), run("r-4", "failed")]) runs.runs.set(fixture.id, fixture);
    openStatus({
      probes: [probe("store", "healthy"), probe("execution-engine", "unhealthy", "connection refused")],
      runs,
      approvals: createInMemoryApprovals([
        { ...approval, id: "a-1", status: "pending" },
        { ...approval, id: "a-2", status: "approved", decidedAt: "2026-10-18T09:01:00.000Z" },
      ]),
    });

    const health = await screen.findByRole("region", { name: "Health" });
    expect(await within(health).findByText("Unhealthy")).toBeTruthy();
    expect(rows(within(health).getByRole("table"))).toEqual([
      ["Component", "Status", "Message"],
      ["store", "healthy", ""],
      ["execution-engine", "unhealthy", "connection refused"],
    ]);
    const overview = screen.getByRole("region", { name: "Overview" });
    expect(await within(overview).findByRole("link", { name: "2 active runs" })).toBeTruthy();
    expect(within(overview).getByRole("link", { name: "1 pending approval request" }).getAttribute("href")).toBe("/ui/approval-requests");
  });

  it("says which numbers are unknown when runs and approval requests cannot be read", async () => {
    const runs = { ...createInMemoryRuns(), list: () => Promise.reject(new Error("orchestration down")) };
    openStatus({ runs, approvals: { ...createInMemoryApprovals(), list: () => Promise.reject(new Error("store down")) } });

    const overview = await screen.findByRole("region", { name: "Overview" });
    expect(await within(overview).findByText("Active runs unknown: runs cannot be read.")).toBeTruthy();
    expect(await within(overview).findByText("Pending approval requests unknown: approval requests cannot be read.")).toBeTruthy();
  });
});

const profile = (name: string, spec: Partial<AgentProfile.AgentProfile["spec"]> = {}): AgentProfile.AgentProfile => ({
  apiVersion: "tendworks.dev/v1",
  kind: "AgentProfile",
  metadata: { name },
  spec: { harness: "fake", ...spec },
});

const configuration = (agentProfiles: AgentProfile.AgentProfile[]) => emptyConfiguration({ agentProfiles });

describe("status page: agents", () => {
  it("shows each agent profile with its active agent sessions of run steps and chats", async () => {
    const agentRuntime = createInMemoryAgentRuntime({ chatAgents: ["assistant"] });
    const step = agentRuntime.startStep({ agent: "developer", run: "r-1", step: "/do/0/implement" });
    const chat = await agentRuntime.startChat({ agent: "assistant", text: "Hello" });
    openStatus({
      configuration: configuration([profile("developer", { sandbox: "node-dev", skills: ["tdd", "grill-me"] }), profile("assistant"), profile("reviewer")]),
      agentRuntime,
    });

    const agents = await screen.findByRole("region", { name: "Agents" });
    expect(rows(await within(agents).findByRole("table", { name: "Agent profiles" }))).toEqual([
      ["Name", "Harness", "Sandbox", "Skills", "Sessions"],
      ["assistant", "fake", "", "", "1"],
      ["developer", "fake", "node-dev", "tdd, grill-me", "1"],
      ["reviewer", "fake", "", "", "0"],
    ]);
    const sessions = within(agents).getByRole("table", { name: "Active agent sessions" });
    expect(rows(sessions)).toEqual([
      ["Agent", "Session", "Status", "Started"],
      ["assistant", `chat ${chat.id}`, "working", chat.startedAt],
      ["developer", "run r-1 step /do/0/implement", "working", step.startedAt],
    ]);
    expect(within(sessions).getByRole("link", { name: `chat ${chat.id}` }).getAttribute("href")).toBe(`/ui/chats/${chat.id}`);
    expect(within(sessions).getByRole("link", { name: "run r-1 step /do/0/implement" }).getAttribute("href")).toBe("/ui/runs/r-1");
  });

  it("shows sessions as unknown while the agent runtime is unreachable, and the rest of the page still", async () => {
    openStatus({
      configuration: configuration([profile("developer")]),
      agentRuntime: createAgentRuntimeClient({ baseUrl: "http://agent-runtime.test", fetch: () => Promise.reject(new TypeError("fetch failed")) }),
      probes: [probe("store", "healthy")],
    });

    const agents = await screen.findByRole("region", { name: "Agents" });
    expect(rows(await within(agents).findByRole("table", { name: "Agent profiles" }))).toEqual([
      ["Name", "Harness", "Sandbox", "Skills", "Sessions"],
      ["developer", "fake", "", "", "unknown"],
    ]);
    expect(within(agents).getByText("The agent runtime cannot be reached: which agents work right now is unknown.")).toBeTruthy();
    expect(within(agents).queryByRole("table", { name: "Active agent sessions" })).toBeNull();
    expect(await within(screen.getByRole("region", { name: "Health" })).findByText("Healthy")).toBeTruthy();
  });
});

// The trigger bindings of `tend trigger list`'s tests, so the page shows what `tend` shows.
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

describe("status page: triggers", () => {
  it("shows each trigger binding with its schedule, next check and how its last check went", async () => {
    openStatus({ triggers: createInMemoryTriggers(triggers) });

    const section = await screen.findByRole("region", { name: "Triggers" });
    expect(rows(await within(section).findByRole("table"))).toEqual([
      ["Name", "Workflow", "Every", "Next check", "Last check"],
      ["github-issues", "develop-issue", "1m", "2026-10-18T10:01:00.000Z", "failed 2026-10-18T10:00:00.000Z: secret TENDWORKS_PLATFORM_GITHUB_TOKEN is not set"],
      ["nightly", "triage", "1d", "suspended", "not checked yet"],
      ["ready-issues", "implement-issue", "5m30s", "2026-10-18T10:05:30.000Z", "succeeded 2026-10-18T10:00:00.000Z, 2 runs started"],
    ]);
  });

  it("says when the trigger gateway cannot be reached, and the rest of the page still shows", async () => {
    openStatus({ triggers: { list: () => Promise.reject(new Error("connection refused")) }, probes: [probe("store", "healthy")] });

    const section = await screen.findByRole("region", { name: "Triggers" });
    expect((await within(section).findByRole("alert")).textContent).toBe("Cannot read the trigger bindings. Is the platform running?");
    expect(await within(screen.getByRole("region", { name: "Health" })).findByText("Healthy")).toBeTruthy();
  });
});
