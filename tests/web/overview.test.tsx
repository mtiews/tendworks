import { createInMemoryAgentRuntime, createInMemoryApprovals, createInMemoryRuns, createInMemoryTriggers, TriggerFireRefusedError, type ApprovalRequest, type FireTriggerRequest, type HealthProbe, type Run, type Trigger } from "@tendworks/control-plane";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { phoneWidth, READ_TOKEN, renderApp, signedIn, type PlatformOptions } from "./support/platform.js";

function openOverview(options: PlatformOptions = {}) {
  signedIn();
  return renderApp({ path: "/ui/overview", ...options });
}

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
  vi.useRealTimers();
});

const probe = (name: string, status: "healthy" | "unhealthy", message?: string): HealthProbe => ({
  name,
  check: async () => ({ status, ...(message === undefined ? {} : { message }) }),
});

const now = Date.now();
const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

function run(id: string, status: Run["status"], extra: Partial<Run> = {}): Run {
  return { id, workflow: "develop-issue", status, input: {}, steps: [], createdAt: ago(30), ...extra };
}

const working = (id: string, title: string): Run =>
  run(id, "running", {
    createdAt: ago(1),
    startedAt: ago(1),
    startedBy: { kind: "trigger", binding: "github-issues", workspace: "playground", item: { key: "#12", title } },
    steps: [{ name: "implement", reference: "/do/0/implement", status: "running", taskId: `task-${id}`, transcript: `memory:task-${id}`, startedAt: ago(1) }],
  });

const request: ApprovalRequest = {
  id: "a-1",
  runId: "r-wait",
  workflow: "wait-for-merge",
  step: "/do/1/confirmMerge",
  action: "merge-pull-request",
  policy: "careful",
  question: "Merge https://github.com/acme/playground/pull/13, then continue?",
  links: [],
  answers: [
    { label: "Merged – continue", outcome: "continue" },
    { label: "Cancel", outcome: "stop" },
  ],
  status: "pending",
  createdAt: ago(2),
};

function runsOf(...items: Run[]) {
  const runs = createInMemoryRuns();
  for (const item of items) runs.runs.set(item.id, item);
  return runs;
}

const tool = (position: number, title: string) => ({ position, time: ago(0), type: "tool-call" as const, toolCallId: `t-${position}`, title });

describe("overview: figures", () => {
  it("counts agents working, requests waiting and runs failed in the last 24 hours, each linking to where the operator acts", async () => {
    const runs = runsOf(
      working("r-1", "Fix the login"),
      run("r-wait", "running", { createdAt: ago(3), steps: [{ name: "confirmMerge", reference: "/do/1/confirmMerge", status: "running", startedAt: ago(3) }] }),
      run("r-old", "failed", { createdAt: ago(40), finishedAt: ago(30) }),
      run("r-bad", "failed", { createdAt: ago(5), finishedAt: ago(4), error: { type: "about:blank", title: "Step failed", status: 500, instance: "/do/0" } }),
      run("r-ok", "completed", { createdAt: ago(5), finishedAt: ago(4) }),
    );
    const agentRuntime = createInMemoryAgentRuntime();
    agentRuntime.transcripts.set("task-r-1", []);
    agentRuntime.running.add("task-r-1");
    openOverview({ runs, agentRuntime, approvals: createInMemoryApprovals([request]) });

    const figures = await screen.findByRole("list", { name: "Figures" });
    expect((await within(figures).findByRole("link", { name: "1 agent working" })).getAttribute("href")).toBe("/ui/runs/r-1");
    expect(within(figures).getByRole("link", { name: "1 approval request waiting" }).getAttribute("href")).toBe("/ui/runs/r-wait");
    expect(within(figures).getByRole("link", { name: "1 run failed in the last 24 hours" }).getAttribute("href")).toBe("/ui/runs/r-bad");
  });

  it("says calmly that nothing happens", async () => {
    openOverview({ runs: runsOf(run("r-ok", "completed", { finishedAt: ago(4) })), approvals: createInMemoryApprovals(), notifications: { list: async () => [] }, triggers: createInMemoryTriggers([trigger("nightly", "2026-10-19T02:00:00.000Z")]) });

    expect(await screen.findByText(/Nothing is running and nothing waits for you\./)).toBeTruthy();
    expect(await screen.findByText("Nothing needs attention.")).toBeTruthy();
    const figures = screen.getByRole("list", { name: "Figures" });
    expect(within(figures).getByRole("link", { name: "0 agents working" }).getAttribute("href")).toBe("/ui/runs");
    expect(within(figures).getByRole("link", { name: "0 approval requests waiting" })).toBeTruthy();
    expect(within(figures).getByRole("link", { name: "0 runs failed in the last 24 hours" })).toBeTruthy();
  });

  it("shows a figure as unknown while its source cannot be read, and the rest still shows", async () => {
    openOverview({ approvals: { ...createInMemoryApprovals(), list: () => Promise.reject(new Error("store down")) }, probes: [probe("store", "healthy")] });

    expect(await screen.findByRole("link", { name: "Waiting for you: unknown" })).toBeTruthy();
    expect(await screen.findByRole("link", { name: "0 agents working" })).toBeTruthy();
  });
});

describe("overview: live tiles", () => {
  it("shows each running agent step with its last transcript entries, following them live", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const agentRuntime = createInMemoryAgentRuntime();
    agentRuntime.transcripts.set("task-r-1", Array.from({ length: 8 }, (_, index) => tool(index, `Tool ${index}`)));
    agentRuntime.running.add("task-r-1");
    openOverview({ runs: runsOf(working("r-1", "Fix the login")), agentRuntime });

    const tile = await screen.findByRole("article", { name: "Fix the login" });
    expect(within(tile).getByRole("link", { name: "Fix the login" }).getAttribute("href")).toBe("/ui/runs/r-1");
    expect(tile.textContent).toContain("playground #12 · 1 h ago");
    expect(within(tile).getByText("implement")).toBeTruthy();
    expect(await within(tile).findByRole("button", { name: /Tool 7/ })).toBeTruthy();
    expect(within(tile).queryByRole("button", { name: /Tool 1\b/ })).toBeNull();

    agentRuntime.append("task-r-1", tool(8, "Tool 8"));
    expect(await within(tile).findByRole("button", { name: /Tool 8/ })).toBeTruthy();
  });

  it("shows only the last tool call of a running step on a phone", async () => {
    phoneWidth(true);
    const agentRuntime = createInMemoryAgentRuntime();
    agentRuntime.transcripts.set("task-r-1", [tool(0, "Read README.md"), tool(1, "Edit login.ts")]);
    agentRuntime.running.add("task-r-1");
    openOverview({ runs: runsOf(working("r-1", "Fix the login")), agentRuntime });

    const tile = await screen.findByRole("article", { name: "Fix the login" });
    expect((await within(tile).findByText("Edit login.ts")).textContent).toBe("Edit login.ts");
    expect(within(tile).queryByText("Read README.md")).toBeNull();
    expect(within(tile).queryByRole("list", { name: "Transcript" })).toBeNull();
  });

  it("answers a pending approval request on its tile as in the workbench", async () => {
    const approvals = createInMemoryApprovals([request]);
    const { user, platform } = openOverview({ approvals, runs: runsOf(run("r-wait", "running", { createdAt: ago(3), startedBy: { kind: "trigger", binding: "github-issues", workspace: "playground", item: { key: "#13", title: "Add search" } } })) });

    const tile = await screen.findByRole("article", { name: /^Needs you/ });
    expect(within(tile).getByRole("link", { name: "Add search" }).getAttribute("href")).toBe("/ui/runs/r-wait");
    expect(tile.textContent).toContain(request.question);
    await user.click(within(tile).getByRole("button", { name: "Merged – continue" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Answer “Merged – continue”?" })).getByRole("button", { name: "Merged – continue" }));

    expect((await screen.findByRole("status")).textContent).toBe("Answered “Merged – continue”. The run continues.");
    const decisions = platform.requests.filter((candidate) => candidate.method === "POST" && new URL(candidate.url).pathname.endsWith("/decision"));
    expect(await Promise.all(decisions.map((candidate) => candidate.json()))).toEqual([{ answer: "Merged – continue" }]);
    await waitFor(() => expect(screen.queryByRole("article", { name: /^Needs you/ })).toBeNull());
  });

  it("shows the request without answers to a read-only token", async () => {
    signedIn(READ_TOKEN);
    renderApp({ path: "/ui/overview", approvals: createInMemoryApprovals([request]) });

    const tile = await screen.findByRole("article", { name: /^Needs you/ });
    expect(within(tile).queryAllByRole("button")).toEqual([]);
  });
});

describe("overview: attention", () => {
  it("lists failed runs, unhealthy components of a 503 status and undelivered notifications", async () => {
    openOverview({
      runs: runsOf(run("r-bad", "failed", { createdAt: ago(5), finishedAt: ago(4), error: { type: "about:blank", title: "Step failed", status: 500, instance: "/do/0" } })),
      probes: [probe("store", "healthy"), probe("execution-engine", "unhealthy", "connection refused")],
      notifications: {
        list: async () => [
          { id: "n-1", kind: "run.failed", title: "Run r-bad failed", createdAt: ago(4), deliveries: [{ channel: "phone", status: "failed", reason: "refused" }] },
          { id: "n-2", kind: "run.completed", title: "Run r-ok completed", createdAt: ago(4), deliveries: [{ channel: "phone", status: "delivered" }] },
        ],
      },
    });

    const attention = await screen.findByRole("region", { name: "Attention" });
    const items = await within(attention).findAllByRole("listitem");
    expect(items.map((item) => item.textContent?.replace(/\s+/g, " "))).toEqual([
      "Component execution-engine is unhealthy: connection refused",
      expect.stringMatching(/^Run failed: develop-issue: Step failed/),
      "Notification not delivered: Run r-bad failed",
    ]);
    expect(within(attention).getByRole("link", { name: /Run failed/ }).getAttribute("href")).toBe("/ui/runs/r-bad");
    expect(within(attention).getByRole("link", { name: /Notification not delivered/ }).getAttribute("href")).toBe("/ui/notifications");
    expect(within(attention).queryByText("Nothing needs attention.")).toBeNull();
  });

});

const trigger = (name: string, nextExecutionAt: string, extra: Partial<Trigger> = {}): Trigger => ({
  name,
  workflow: "develop-issue",
  kind: "schedule",
  workspaces: ["app"],
  schedule: { every: { minutes: 5 } },
  nextExecutionAt,
  ...extra,
});

describe("overview: next trigger checks", () => {
  it("lists the scheduled bindings by their next check, suspended ones last, and leaves manual bindings out", async () => {
    openOverview({
      triggers: createInMemoryTriggers([
        trigger("nightly", "2026-10-19T02:00:00.000Z", { suspended: true }),
        review,
        trigger("later", "2026-10-18T10:05:30.000Z", { workspaces: [], schedule: { every: { minutes: 5, seconds: 30 } } }),
        trigger("soon", "2026-10-18T10:01:00.000Z", { workspaces: ["app", "web"] }),
      ]),
    });

    const list = await screen.findByRole("list", { name: "Next trigger checks" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("soonapp, web · every 5m"),
      expect.stringContaining("later"),
      expect.stringContaining("nightlyapp · every 5msuspended"),
    ]);
    expect(items[0]!.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-18T10:01:00.000Z");
  });

  it("says there are no scheduled bindings when only manual ones are configured", async () => {
    openOverview({ triggers: createInMemoryTriggers([review]) });

    const section = await screen.findByRole("region", { name: "Next trigger checks" });
    expect(await within(section).findByText("No scheduled trigger bindings are configured.")).toBeTruthy();
    expect(within(section).queryByRole("list")).toBeNull();
  });

  it("says when the trigger gateway cannot be reached", async () => {
    openOverview({ triggers: { ...createInMemoryTriggers(), list: () => Promise.reject(new Error("connection refused")) } });

    const section = await screen.findByRole("region", { name: "Next trigger checks" });
    expect((await within(section).findByRole("alert")).textContent).toBe("Cannot read the trigger bindings. Is the platform running?");
  });
});

const review: Trigger = {
  name: "review",
  workflow: "review-workspace",
  kind: "manual",
  workspaces: ["caltrack"],
  lastEvaluation: { at: ago(2), status: "succeeded", startedRuns: 1 },
};
const release: Trigger = { name: "release", workflow: "cut-release", kind: "manual", workspaces: [] };
const security: Trigger = { name: "security-review", workflow: "review-workspace", kind: "manual", workspaces: ["app", "web", "docs"] };

const disabled = (element: HTMLElement) => (element as HTMLButtonElement).disabled;
const regionNames = () => screen.getAllByRole("region").map((region) => document.getElementById(region.getAttribute("aria-labelledby") ?? "")?.textContent);

describe("overview: start", () => {
  it("lists every manual binding by name, suspended ones last with a disabled Start, and links to the Triggers page", async () => {
    openOverview({
      triggers: createInMemoryTriggers([
        security,
        { ...release, suspended: true },
        trigger("nightly", "2026-10-19T02:00:00.000Z"),
        { ...review, name: "audit", lastEvaluation: { at: ago(3), status: "failed", startedRuns: 0, message: "workspace 'caltrack' is not declared" } },
        review,
      ]),
    });

    const section = await screen.findByRole("region", { name: "Start" });
    const items = within(await within(section).findByRole("list", { name: "Start" })).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "auditreview-workspace · caltrackStartfailed 3 h ago: workspace 'caltrack' is not declared",
      "reviewreview-workspace · caltrackStartsucceeded 2 h ago, 1 run started",
      "security-reviewreview-workspace · app, web, docsStartnever started",
      "releasecut-releasesuspendedStartnever started",
    ]);
    expect(disabled(within(items[3]!).getByRole("button", { name: "Start release" }))).toBe(true);
    expect(disabled(within(items[0]!).getByRole("button", { name: "Start audit" }))).toBe(false);
    expect(within(section).getByRole("link", { name: "All trigger bindings" }).getAttribute("href")).toBe("/ui/triggers");
  });

  it("asks before every start; confirming fires once and opens the run", async () => {
    const triggers = createInMemoryTriggers([review]);
    const { user } = openOverview({ triggers });

    await user.click(await screen.findByRole("button", { name: "Start review" }));
    const dialog = screen.getByRole("alertdialog", { name: "Start review?" });
    expect(within(dialog).getByText("Starts one run of review-workspace in caltrack.")).toBeTruthy();
    expect(triggers.fired).toEqual([]);
    const confirm = within(dialog).getByRole("button", { name: "Start run" });
    await user.click(confirm);
    await user.click(confirm);

    await waitFor(() => expect(window.location.pathname).toBe("/ui/runs/run-1"));
    expect(triggers.fired).toEqual([{ name: "review", request: {} }]);
  });

  it("starts nothing on Cancel or Escape and gives the focus back to Start", async () => {
    const triggers = createInMemoryTriggers([release]);
    const { user } = openOverview({ triggers });

    const start = await screen.findByRole("button", { name: "Start release" });
    await user.click(start);
    expect(within(screen.getByRole("alertdialog", { name: "Start release?" })).getByText("Starts one run of cut-release.")).toBeTruthy();
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(start);

    await user.click(start);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(start);
    expect(triggers.fired).toEqual([]);
    expect(window.location.pathname).toBe("/ui/overview");
  });

  it("offers the choice of several workspaces inside the confirmation; several started runs open Runs", async () => {
    const triggers = createInMemoryTriggers([security]);
    const { user } = openOverview({ triggers });

    await user.click(await screen.findByRole("button", { name: "Start security-review" }));
    const dialog = screen.getByRole("alertdialog", { name: "Start security-review?" });
    await user.click(within(dialog).getByRole("checkbox", { name: "docs" }));
    await user.click(within(dialog).getByRole("button", { name: "Start runs" }));

    await waitFor(() => expect(window.location.pathname).toBe("/ui/runs"));
    expect(triggers.fired).toEqual([
      { name: "security-review", request: { workspace: "app" } },
      { name: "security-review", request: { workspace: "web" } },
    ]);
  });

  it("shows why a start was refused in the entry, with the runs started before it", async () => {
    const fake = createInMemoryTriggers([security]);
    let calls = 0;
    const fire = (name: string, request: FireTriggerRequest) =>
      ++calls === 1 ? fake.fire(name, request) : Promise.reject(new TriggerFireRefusedError(409, "Conflict", "trigger binding 'security-review' is suspended"));
    const { user } = openOverview({ triggers: { ...fake, fire } });

    await user.click(await screen.findByRole("button", { name: "Start security-review" }));
    const dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("checkbox", { name: "docs" }));
    await user.click(within(dialog).getByRole("button", { name: "Start runs" }));

    const entry = within(screen.getByRole("list", { name: "Start" })).getByRole("listitem");
    expect(await within(entry).findByText("Conflict: trigger binding 'security-review' is suspended. Started before it: run-1 in app.")).toBeTruthy();
    expect(window.location.pathname).toBe("/ui/overview");
  });

  it("is left out without manual bindings", async () => {
    openOverview({ triggers: createInMemoryTriggers([trigger("nightly", "2026-10-19T02:00:00.000Z")]) });

    expect(await screen.findByRole("list", { name: "Next trigger checks" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Start" })).toBeNull();
  });

  it("is left out for the read-only token", async () => {
    signedIn(READ_TOKEN);
    renderApp({ path: "/ui/overview", triggers: createInMemoryTriggers([review, trigger("nightly", "2026-10-19T02:00:00.000Z")]) });

    expect(await screen.findByRole("list", { name: "Next trigger checks" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Start" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start review" })).toBeNull();
  });

  it("says when the trigger gateway cannot be reached, and the rest of the overview still shows", async () => {
    openOverview({ triggers: { ...createInMemoryTriggers(), list: () => Promise.reject(new Error("connection refused")) } });

    const section = await screen.findByRole("region", { name: "Start" });
    expect((await within(section).findByRole("alert")).textContent).toBe("Cannot read the trigger bindings. Is the platform running?");
    expect(await screen.findByRole("link", { name: "0 agents working" })).toBeTruthy();
  });

  it("comes after Attention and before Next trigger checks on a phone", async () => {
    phoneWidth(true);
    openOverview({ triggers: createInMemoryTriggers([review, trigger("nightly", "2026-10-19T02:00:00.000Z")]) });

    await screen.findByRole("region", { name: "Start" });
    expect(regionNames()).toEqual(["Live", "Attention", "Start", "Next trigger checks"]);
    expect(within(screen.getByRole("region", { name: "Start" })).getByRole("button", { name: "Start review" })).toBeTruthy();
  });
});

describe("platform health in the shell", () => {
  it("shows the health indicator on the rail, naming the unhealthy components", async () => {
    openOverview({ probes: [probe("store", "healthy"), probe("execution-engine", "unhealthy", "connection refused")] });

    expect((await screen.findByRole("link", { name: "Platform unhealthy: execution-engine" })).getAttribute("href")).toBe("/ui/overview");
  });

  it("says the platform is healthy", async () => {
    openOverview({ probes: [probe("store", "healthy")] });

    expect(await screen.findByRole("link", { name: "Platform healthy: all 1 components" })).toBeTruthy();
  });

  it("lists every component under More", async () => {
    signedIn();
    renderApp({ path: "/ui/more", probes: [probe("store", "healthy"), probe("execution-engine", "unhealthy", "connection refused")] });

    const components = await screen.findByRole("list", { name: "Components" });
    expect(within(components).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["storehealthy", "execution-engineunhealthyconnection refused"]);
    expect(await screen.findByText("Unhealthy")).toBeTruthy();
  });
});
