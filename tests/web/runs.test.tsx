import { createInMemoryAgentRuntime, createInMemoryApprovals, createInMemoryRuns, emptyConfiguration, type ApprovalRequest, type Run, type TranscriptEntry } from "@tendworks/control-plane";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { phoneWidth, READ_TOKEN, renderApp, signedIn } from "./support/platform.js";
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

const waitingRun: Run = {
  id: "run-5",
  workflow: "wait-for-merge",
  status: "running",
  input: {},
  startedBy: { kind: "trigger", binding: "playground", workspace: "app", item: { key: "acme/app#3", title: "Rename the flag" } },
  steps: [],
  createdAt: time,
};

const pendingOfWaitingRun: ApprovalRequest = {
  id: "approval-1",
  runId: waitingRun.id,
  workflow: "wait-for-merge",
  step: "/do/1/confirmMerge",
  action: "merge-pull-request",
  question: "Merge the pull request, then continue?",
  links: [],
  answers: [{ label: "Merged – continue", outcome: "continue" }],
  status: "pending",
  createdAt: time,
};

function runsOf(...items: Run[]) {
  const runs = createInMemoryRuns();
  for (const run of items) runs.runs.set(run.id, run);
  return runs;
}

/** The runs a group of the run list shows, by the text of each entry. */
const group = (name: string) =>
  within(screen.getByRole("list", { name }))
    .getAllByRole("link")
    .map((link) => link.textContent);

const runLink = (title: string | RegExp) => screen.getByRole("link", { name: typeof title === "string" ? new RegExp(title) : title });

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "matchMedia");
});

describe("run list", () => {
  it("names runs by the item that started them, else by their workflow, and groups them by what they need", async () => {
    signedIn();
    renderApp({ path: "/ui/runs", runs: runsOf(manualRun, triggeredRun, waitingRun), approvals: createInMemoryApprovals([pendingOfWaitingRun]) });

    await screen.findByRole("list", { name: "Needs you" });

    expect(group("Needs you")).toEqual([expect.stringMatching(/^Rename the flag.*Waiting for you · app acme\/app#3$/)]);
    expect(group("Running")).toEqual([expect.stringMatching(/^Fix the login.*playground acme\/playground#7$/)]);
    expect(group("Finished")).toEqual([expect.stringMatching(/^hello-agent.*manual$/)]);
  });

  it("opens the run waiting for the operator when a desktop shows the runs without one chosen", async () => {
    signedIn();
    renderApp({ path: "/ui/runs", runs: runsOf(manualRun, triggeredRun, waitingRun), approvals: createInMemoryApprovals([pendingOfWaitingRun]) });

    expect(await screen.findByRole("heading", { level: 1, name: /Rename the flag/ })).toBeTruthy();
    expect(window.location.pathname).toBe("/ui/runs/run-5");
    expect(runLink("Rename the flag").getAttribute("aria-current")).toBe("page");
  });

  it("opens a run at work when none waits, and the newest otherwise", async () => {
    signedIn();
    renderApp({ path: "/ui/runs", runs: runsOf(manualRun, triggeredRun) });
    expect(await screen.findByRole("heading", { level: 1, name: /Fix the login/ })).toBeTruthy();

    cleanup();
    renderApp({ path: "/ui/runs", runs: runsOf(manualRun) });
    expect(await screen.findByRole("heading", { level: 1, name: "hello-agent" })).toBeTruthy();
  });

  it("filters the runs by title, workspace, workflow or id", async () => {
    signedIn();
    const { user } = renderApp({ path: "/ui/runs", runs: runsOf(manualRun, triggeredRun, waitingRun) });
    await screen.findByRole("list", { name: "Finished" });
    const filter = screen.getByRole("searchbox", { name: "Filter runs" });

    await user.type(filter, "PLAYground");
    expect(screen.queryByRole("list", { name: "Finished" })).toBeNull();
    expect(group("Running")).toEqual([expect.stringMatching(/^Fix the login/)]);

    await user.clear(filter);
    await user.type(filter, "run-1");
    expect(group("Finished")).toEqual([expect.stringMatching(/^hello-agent/)]);

    await user.clear(filter);
    await user.type(filter, "nothing like it");
    expect(screen.getByText("No run matches “nothing like it”.")).toBeTruthy();
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
    const { platform } = renderApp({ path: "/ui/runs/run-1", runs });
    await screen.findByRole("list", { name: "Finished" });

    runs.runs.set(triggeredRun.id, triggeredRun);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await screen.findByRole("link", { name: /Fix the login/ })).toBeTruthy();

    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    const before = platform.requests.filter((request) => new URL(request.url).pathname === "/runs").length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(platform.requests.filter((request) => new URL(request.url).pathname === "/runs").length).toBe(before);

    runs.runs.set("run-3", { ...manualRun, id: "run-3", workflow: "third-workflow" });
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(await screen.findByRole("link", { name: /third-workflow/ })).toBeTruthy();
  });

  it("says when the platform cannot be reached", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    signedIn();
    const { platform } = renderApp({ path: "/ui/runs/run-1", runs: runsOf(manualRun) });
    await screen.findByRole("list", { name: "Finished" });
    platform.unreachable(true);

    await vi.advanceTimersByTimeAsync(5_000);
    const runList = screen.getByRole("region", { name: "Runs" });
    expect((await within(runList).findByRole("alert")).textContent).toBe("Cannot reach the platform. Is it running?");
    // What was known stays on the screen.
    expect(within(runList).getByRole("link", { name: /hello-agent/ })).toBeTruthy();
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
      workspace: { name: "playground", branch: "tendworks/run-3" },
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

/** A field of the run's facts by its label. */
function field(label: string): string {
  const term = screen.getAllByRole("term").find((candidate) => candidate.textContent === label);
  if (!term) throw new Error(`no field ${label}`);
  const value = term.nextElementSibling;
  return value?.querySelector("time")?.getAttribute("datetime") ?? value?.textContent ?? "";
}

const steps = () => within(screen.getByRole("list", { name: "Steps" })).getAllByRole("button");
const stepButton = (name: string) => within(screen.getByRole("list", { name: "Steps" })).getByRole("button", { name: new RegExp(`^Step \\d+${name}`) });

describe("run detail", () => {
  it("shows a failed run with its facts, why it failed and its steps, and opens on the failed agent step", async () => {
    signedIn();
    renderApp({
      path: "/ui/runs/run-3",
      runs: runsOf(failedRun),
      agentRuntime: agentRuntimeWith({
        "task-1": transcript({ type: "message-chunk", text: "Opened the pull request." }),
        "task-2": transcript({ type: "error", message: "the session timed out" }),
      }),
    });

    expect(await screen.findByRole("heading", { level: 1, name: /develop-issue/ })).toBeTruthy();
    expect([field("Run"), field("Workflow"), field("Workspace"), field("Status"), field("Started by"), field("Created"), field("Started"), field("Finished"), field("Duration"), field("Cost")]).toEqual([
      "run-3",
      "develop-issue",
      "playground",
      "failed",
      "manual",
      "2026-10-19T09:59:00.000Z",
      "2026-10-19T10:00:00.000Z",
      "2026-10-19T10:12:00.000Z",
      "12 min",
      "0.375 USD",
    ]);
    expect(screen.getByRole("alert").textContent).toBe("Failed at /do/1/review: Agent failed: the harness ended unexpectedly");
    expect(steps().map((step) => step.textContent)).toEqual(["Step 1implementcompleted · 10 min", "Step 2reviewfailed · 2 min"]);
    expect(stepButton("review").getAttribute("aria-pressed")).toBe("true");

    const review = screen.getByRole("region", { name: "review" });
    expect(within(review).getByText("Agent failed: the harness ended unexpectedly")).toBeTruthy();
    expect(await within(review).findByText("the session timed out")).toBeTruthy();
  });

  it("shows the transcript and results of the step the operator chooses", async () => {
    signedIn();
    const { user } = renderApp({
      path: "/ui/runs/run-3",
      runs: runsOf(failedRun),
      agentRuntime: agentRuntimeWith({ "task-1": transcript({ type: "message-chunk", text: "Opened the pull request." }), "task-2": transcript() }),
    });

    await user.click(await screen.findByRole("button", { name: /^Step 1implement/ }));

    const implement = screen.getByRole("region", { name: "implement" });
    expect(await within(implement).findByText("Opened the pull request.")).toBeTruthy();
    expect(within(implement).getByRole("link", { name: "pull-request" }).getAttribute("href")).toBe("https://example.test/acme/playground/pull/8");
    expect(screen.queryByRole("region", { name: "review" })).toBeNull();
  });

  it("lists the artifacts of all steps on their own tab", async () => {
    signedIn();
    const { user } = renderApp({ path: "/ui/runs/run-3", runs: runsOf(failedRun), agentRuntime: agentRuntimeWith({}) });

    await user.click(await screen.findByRole("tab", { name: "Artifacts (1)" }));

    const panel = screen.getByRole("tabpanel", { name: "Artifacts (1)" });
    expect(within(panel).getByRole("link", { name: "pull-request" }).getAttribute("href")).toBe("https://example.test/acme/playground/pull/8");
  });

  it("opens a run without agent steps on its output, and says a step without an agent has no transcript", async () => {
    signedIn();
    const { user } = renderApp({ path: "/ui/runs/run-4", runs: runsOf(completedRun), agentRuntime: createInMemoryAgentRuntime() });

    await screen.findByRole("tab", { name: "Output", selected: true });
    expect(tableRows(screen.getByRole("table", { name: "Output" }))).toEqual([
      ["Field", "Value"],
      ["summary", "said hello"],
      ["pullRequest", '{"number":8}'],
    ]);

    await user.click(screen.getByRole("tab", { name: "Transcript" }));
    expect(screen.getByText("greet runs without an agent and has no transcript.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says when a step's transcript is missing or empty", async () => {
    signedIn();
    const { user } = renderApp({ path: "/ui/runs/run-3", runs: runsOf(failedRun), agentRuntime: agentRuntimeWith({ "task-1": transcript() }) });

    const review = await screen.findByRole("region", { name: "review" });
    expect(await within(review).findByText("No transcript was found for this step.")).toBeTruthy();
    await user.click(stepButton("implement"));
    expect(await within(screen.getByRole("region", { name: "implement" })).findByText("The transcript is empty so far.")).toBeTruthy();
  });

  it("says when the agent runtime cannot be reached, and still shows the run", async () => {
    signedIn();
    renderApp({ path: "/ui/runs/run-3", runs: runsOf(failedRun) });

    const review = await screen.findByRole("region", { name: "review" });
    expect(await within(review).findByText("Agent runtime unavailable (503)")).toBeTruthy();
  });

  it("offers to ask the platform assistant why a run failed, with the question written", async () => {
    signedIn();
    const configuration = emptyConfiguration({ agentProfiles: [{ apiVersion: "tendworks.dev/v1", kind: "AgentProfile", metadata: { name: "assistant" }, spec: { harness: "fake", chat: {} } }] });
    const agentRuntime = createInMemoryAgentRuntime({ chatAgents: ["assistant"] });
    const { user } = renderApp({ path: "/ui/runs/run-3", runs: runsOf(failedRun), agentRuntime, configuration });

    await user.click(await screen.findByRole("link", { name: "Ask the platform assistant" }));

    expect(window.location.pathname).toBe("/ui/chats/new");
    expect((await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Message" })).value).toBe("Why did run run-3 fail?");
  });

  it("offers no assistant to ask with read-only access", async () => {
    signedIn(READ_TOKEN);
    renderApp({ path: "/ui/runs/run-3", runs: runsOf(failedRun), agentRuntime: createInMemoryAgentRuntime() });

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Ask the platform assistant" })).toBeNull();
  });

  describe("retry", () => {
    const configured = emptyConfiguration({
      workflowNames: ["develop-issue"],
      workflow: (name) => (name === "develop-issue" ? ({ document: { name } } as never) : undefined),
    });

    it("retries a failed run after a confirmation, opens the new run and links it to the failed one", async () => {
      signedIn();
      const runs = runsOf(failedRun);
      const { user } = renderApp({ path: "/ui/runs/run-3", runs, configuration: configured, agentRuntime: createInMemoryAgentRuntime() });

      await user.click(await screen.findByRole("button", { name: "Retry" }));
      const confirmation = screen.getByRole("alertdialog", { name: "Retry run run-3?" });
      expect(confirmation.textContent).toContain("starts a new run of develop-issue with the same input");
      expect(runs.started).toEqual([]);
      await user.click(within(confirmation).getByRole("button", { name: "Retry run" }));

      const [retry] = [...runs.runs.values()].filter((run) => run.startedBy?.retryOf === "run-3");
      expect(retry).toBeDefined();
      await screen.findByText(retry!.id);
      expect(window.location.pathname).toBe(`/ui/runs/${retry!.id}`);
      expect(field("Started by")).toBe("manual");
      expect(field("Retry of")).toBe("run-3");
      await user.click(screen.getByRole("link", { name: "run-3" }));
      expect(window.location.pathname).toBe("/ui/runs/run-3");
    });

    it("starts nothing when the operator cancels", async () => {
      signedIn();
      const runs = runsOf(failedRun);
      const { user } = renderApp({ path: "/ui/runs/run-3", runs, configuration: configured, agentRuntime: createInMemoryAgentRuntime() });

      await user.click(await screen.findByRole("button", { name: "Retry" }));
      await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));

      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(runs.started).toEqual([]);
    });

    it("says why the platform refused the retry", async () => {
      signedIn();
      const { user } = renderApp({ path: "/ui/runs/run-3", runs: runsOf(failedRun), agentRuntime: createInMemoryAgentRuntime() });

      await user.click(await screen.findByRole("button", { name: "Retry" }));
      await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Retry run" }));

      expect(await screen.findByText("Run not retryable: its workflow 'develop-issue' is no longer configured (configured: none)")).toBeTruthy();
      expect(window.location.pathname).toBe("/ui/runs/run-3");
    });

    it("offers no retry with read-only access, nor for a run that did not fail", async () => {
      signedIn(READ_TOKEN);
      renderApp({ path: "/ui/runs/run-3", runs: runsOf(failedRun, completedRun), configuration: configured, agentRuntime: createInMemoryAgentRuntime() });
      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

      cleanup();
      signedIn();
      renderApp({ path: "/ui/runs/run-4", runs: runsOf(failedRun, completedRun), configuration: configured });
      expect(await screen.findByRole("heading", { level: 1, name: /hello-agent/ })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });
  });

  it("opens from the run list and works as a deep link after a reload", async () => {
    signedIn();
    const runs = runsOf(manualRun, failedRun);
    const { user } = renderApp({ path: "/ui/runs/run-1", runs, agentRuntime: createInMemoryAgentRuntime() });

    await user.click(await screen.findByRole("link", { name: /develop-issue/ }));
    expect(await screen.findByRole("heading", { level: 1, name: /develop-issue/ })).toBeTruthy();
    expect(window.location.pathname).toBe("/ui/runs/run-3");
    expect(document.title).toBe("Run · Tendworks");

    cleanup();
    renderApp({ path: window.location.pathname, runs, agentRuntime: createInMemoryAgentRuntime() });
    expect(await screen.findByRole("heading", { level: 1, name: /develop-issue/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Runs", current: "page" })).toBeTruthy();
  });

  it("says when the run does not exist", async () => {
    signedIn();
    renderApp({ path: "/ui/runs/nope" });

    expect(await screen.findByText("There is no run nope.")).toBeTruthy();
  });
});

describe("runs on a phone", () => {
  it("shows the run list on its own and the run after it, with a way back", async () => {
    phoneWidth(true);
    signedIn();
    const { user } = renderApp({ path: "/ui/runs", runs: runsOf(manualRun, failedRun), agentRuntime: createInMemoryAgentRuntime() });

    expect(await screen.findByRole("heading", { level: 1, name: "Runs" })).toBeTruthy();
    expect(window.location.pathname).toBe("/ui/runs");
    expect(screen.queryByRole("list", { name: "Steps" })).toBeNull();

    await user.click(await screen.findByRole("link", { name: /develop-issue/ }));
    expect(await screen.findByRole("heading", { level: 1, name: /develop-issue/ })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Runs" })).toBeNull();
    expect(screen.getByRole("link", { name: "Back" }).getAttribute("href")).toBe("/ui/runs");
  });

  it("shows the pending approval request with its answers (the browser test checks it sits at the bottom)", async () => {
    phoneWidth(true);
    signedIn();
    renderApp({ path: "/ui/runs/run-5", runs: runsOf(waitingRun), approvals: createInMemoryApprovals([pendingOfWaitingRun]) });

    const request = await screen.findByRole("region", { name: "Approval request" });
    expect(within(request).getByRole("button", { name: "Merged – continue" })).toBeTruthy();
  });
});
