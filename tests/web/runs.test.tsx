import { createInMemoryAgentRuntime, createInMemoryRuns, type Run, type TranscriptEntry } from "@tendworks/control-plane";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp, signedIn } from "./support/platform.js";
import { rows as tableRows } from "./support/table.js";

const time = "2026-10-19T10:00:00.000Z";

const manualRun: Run = {
  id: "run-1",
  workflow: "hello-agent",
  status: "completed",
  input: {},
  startedBy: { kind: "manual" },
  steps: [],
  createdAt: "2026-10-19T09:00:00.000Z",
  finishedAt: "2026-10-19T09:05:00.000Z",
};

const triggeredRun: Run = {
  id: "run-2",
  workflow: "develop-issue",
  status: "running",
  input: {},
  startedBy: { kind: "trigger", binding: "playground", workspace: "playground", item: { key: "acme/playground#7", title: "Fix the login", url: "https://github.com/acme/playground/issues/7" } },
  steps: [],
  createdAt: time,
};

function runsOf(...items: Run[]) {
  const runs = createInMemoryRuns();
  for (const run of items) runs.runs.set(run.id, run);
  return runs;
}

/** The rows of the table `name` as text per cell, header first. */
const rows = (name: string) => tableRows(screen.getByRole("table", { name }));

afterEach(() => {
  vi.useRealTimers();
});

describe("run list", () => {
  it("lists runs newest first with workflow, status, who started them and their times, like `tend run list`", async () => {
    signedIn();
    renderApp({ path: "/ui/runs", runs: runsOf(manualRun, triggeredRun) });

    await screen.findByRole("link", { name: "run-2" });

    expect(rows("Runs")).toEqual([
      ["Run", "Workflow", "Status", "Started by", "Created", "Finished"],
      ["run-2", "develop-issue", "running", "trigger playground in playground: acme/playground#7", time, ""],
      ["run-1", "hello-agent", "completed", "manual", "2026-10-19T09:00:00.000Z", "2026-10-19T09:05:00.000Z"],
    ]);
    expect(screen.getByRole("link", { name: "run-1" }).getAttribute("href")).toBe("/ui/runs/run-1");
  });

  it("says when there are no runs yet", async () => {
    signedIn();
    renderApp({ path: "/ui/runs" });

    expect(await screen.findByText("No runs yet.")).toBeTruthy();
  });

  it("updates by polling while the tab is visible, and not while it is hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const runs = runsOf(manualRun);
    signedIn();
    const { platform } = renderApp({ path: "/ui/runs", runs });
    await screen.findByRole("link", { name: "run-1" });

    runs.runs.set(triggeredRun.id, triggeredRun);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await screen.findByRole("link", { name: "run-2" })).toBeTruthy();

    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    const before = platform.requests.filter((request) => new URL(request.url).pathname === "/runs").length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(platform.requests.filter((request) => new URL(request.url).pathname === "/runs").length).toBe(before);

    runs.runs.set("run-3", { ...manualRun, id: "run-3" });
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(await screen.findByRole("link", { name: "run-3" })).toBeTruthy();
  });

  it("says when the platform cannot be reached", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    signedIn();
    const { platform } = renderApp({ path: "/ui/runs", runs: runsOf(manualRun) });
    await screen.findByRole("link", { name: "run-1" });
    platform.unreachable(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect((await screen.findByRole("alert")).textContent).toBe("Cannot reach the platform. Is it running?");
    // What was known stays on the screen.
    expect(screen.getByRole("link", { name: "run-1" })).toBeTruthy();
  });
});

const transcript = (...entries: Record<string, unknown>[]): TranscriptEntry[] => entries.map((item, position) => ({ time, position, ...item }) as TranscriptEntry);

const failure = { type: "https://serverlessworkflow.io/spec/1.0.0/errors/runtime", status: 500, instance: "/do/1/review", title: "Agent failed", detail: "the harness ended unexpectedly" };

const failedRun: Run = {
  id: "run-3",
  workflow: "develop-issue",
  status: "failed",
  input: {},
  startedBy: { kind: "manual" },
  error: failure,
  steps: [
    {
      name: "implement",
      reference: "/do/0/implement",
      status: "completed",
      taskId: "task-1",
      transcript: "file:///t/task-1.jsonl",
      cost: { amount: 0.25, currency: "USD" },
      artifacts: [{ name: "pull-request", url: "https://example.test/acme/playground/pull/8" }],
      startedAt: "2026-10-19T10:00:00.000Z",
      finishedAt: "2026-10-19T10:10:00.000Z",
    },
    {
      name: "review",
      reference: "/do/1/review",
      status: "failed",
      taskId: "task-2",
      transcript: "file:///t/task-2.jsonl",
      cost: { amount: 0.125, currency: "USD" },
      error: failure,
      startedAt: "2026-10-19T10:10:00.000Z",
      finishedAt: "2026-10-19T10:12:00.000Z",
    },
  ],
  createdAt: "2026-10-19T09:59:00.000Z",
  startedAt: "2026-10-19T10:00:00.000Z",
  finishedAt: "2026-10-19T10:12:00.000Z",
};

const completedRun: Run = {
  id: "run-4",
  workflow: "hello-agent",
  status: "completed",
  input: {},
  output: { summary: "said hello", pullRequest: { number: 8 } },
  steps: [{ name: "greet", reference: "/do/0/greet", status: "completed", startedAt: time, finishedAt: time }],
  createdAt: time,
  startedAt: time,
  finishedAt: time,
};

function agentRuntimeWith(transcripts: Record<string, TranscriptEntry[]>) {
  const agentRuntime = createInMemoryAgentRuntime();
  for (const [taskId, entries] of Object.entries(transcripts)) agentRuntime.transcripts.set(taskId, entries);
  return agentRuntime;
}

/** A field of the run's summary by its label. */
function field(label: string): string {
  const term = screen.getAllByRole("term").find((candidate) => candidate.textContent === label);
  if (!term) throw new Error(`no field ${label}`);
  const value = term.nextElementSibling;
  return value?.querySelector("time")?.getAttribute("datetime") ?? value?.textContent ?? "";
}

describe("run detail", () => {
  it("shows a failed run with its steps, costs and which step failed and why, like `tend run get`", async () => {
    signedIn();
    renderApp({
      path: "/ui/runs/run-3",
      runs: runsOf(failedRun),
      agentRuntime: agentRuntimeWith({
        "task-1": transcript({ type: "message-chunk", text: "Opened the pull request." }),
        "task-2": transcript({ type: "error", message: "the session timed out" }),
      }),
    });

    expect(await screen.findByRole("heading", { level: 1, name: "Run run-3" })).toBeTruthy();
    await screen.findByRole("table", { name: "Steps" });
    expect([field("Workflow"), field("Status"), field("Started by"), field("Created"), field("Started"), field("Finished"), field("Cost")]).toEqual([
      "develop-issue",
      "failed",
      "manual",
      "2026-10-19T09:59:00.000Z",
      "2026-10-19T10:00:00.000Z",
      "2026-10-19T10:12:00.000Z",
      "0.375 USD",
    ]);
    expect(screen.getByRole("alert").textContent).toBe("Failed at /do/1/review: Agent failed: the harness ended unexpectedly");
    expect(rows("Steps")).toEqual([
      ["Step", "Status", "Task", "Cost", "Started", "Finished"],
      ["/do/0/implement", "completed", "task-1", "0.25 USD", "2026-10-19T10:00:00.000Z", "2026-10-19T10:10:00.000Z"],
      ["/do/1/review", "failed", "task-2", "0.125 USD", "2026-10-19T10:10:00.000Z", "2026-10-19T10:12:00.000Z"],
    ]);

    const review = screen.getByRole("region", { name: "/do/1/review" });
    expect(within(review).getByText("Agent failed: the harness ended unexpectedly")).toBeTruthy();
    expect(await within(review).findByText("the session timed out")).toBeTruthy();
    const implement = screen.getByRole("region", { name: "/do/0/implement" });
    expect(await within(implement).findByText("Opened the pull request.")).toBeTruthy();
    expect(within(implement).getByRole("link", { name: "pull-request" }).getAttribute("href")).toBe("https://example.test/acme/playground/pull/8");
  });

  it("shows the output of a completed run and no transcript for a step without an agent", async () => {
    signedIn();
    renderApp({ path: "/ui/runs/run-4", runs: runsOf(completedRun), agentRuntime: createInMemoryAgentRuntime() });

    expect(await screen.findByRole("heading", { level: 1, name: "Run run-4" })).toBeTruthy();
    await screen.findByRole("table", { name: "Output" });
    expect(rows("Output")).toEqual([
      ["Field", "Value"],
      ["summary", "said hello"],
      ["pullRequest", '{"number":8}'],
    ]);
    expect(screen.queryByRole("region", { name: "/do/0/greet" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says when a step's transcript is missing or empty", async () => {
    signedIn();
    renderApp({ path: "/ui/runs/run-3", runs: runsOf(failedRun), agentRuntime: agentRuntimeWith({ "task-1": transcript() }) });

    const review = await screen.findByRole("region", { name: "/do/1/review" });
    expect(await within(review).findByText("No transcript was found for this step.")).toBeTruthy();
    const implement = screen.getByRole("region", { name: "/do/0/implement" });
    expect(await within(implement).findByText("The transcript is empty so far.")).toBeTruthy();
  });

  it("says when the agent runtime cannot be reached, and still shows the run", async () => {
    signedIn();
    renderApp({ path: "/ui/runs/run-3", runs: runsOf(failedRun) });

    const review = await screen.findByRole("region", { name: "/do/1/review" });
    expect(await within(review).findByText("Agent runtime unavailable (503)")).toBeTruthy();
  });

  it("opens from the run list and works as a deep link after a reload", async () => {
    signedIn();
    const runs = runsOf(manualRun, failedRun);
    const { user } = renderApp({ path: "/ui/runs", runs, agentRuntime: createInMemoryAgentRuntime() });

    await user.click(await screen.findByRole("link", { name: "run-3" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Run run-3" })).toBeTruthy();
    expect(window.location.pathname).toBe("/ui/runs/run-3");
    expect(document.title).toBe("Run · Tendworks");

    cleanup();
    renderApp({ path: window.location.pathname, runs, agentRuntime: createInMemoryAgentRuntime() });
    expect(await screen.findByRole("heading", { level: 1, name: "Run run-3" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Runs", current: "page" })).toBeTruthy();
  });

  it("says when the run does not exist", async () => {
    signedIn();
    renderApp({ path: "/ui/runs/nope" });

    expect(await screen.findByText("There is no run nope.")).toBeTruthy();
  });
});
