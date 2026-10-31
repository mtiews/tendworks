import { createInMemoryTriggers, TriggerFireRefusedError, type FireTriggerRequest, type Trigger } from "@tendworks/control-plane";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { phoneWidth, READ_TOKEN, renderApp, signedIn } from "./support/platform.js";
import { rows } from "./support/table.js";

beforeEach(() => {
  // 30 seconds after the last check of the bindings below.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-18T10:00:30.000Z"));
  signedIn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "matchMedia");
});

// The trigger bindings of `tend trigger list`'s tests, so the page shows what `tend` shows.
const triggers: Trigger[] = [
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
    name: "hourly",
    workflow: "implement-issue",
    kind: "fake",
    workspaces: [],
    schedule: { every: { hours: 1 } },
    nextExecutionAt: "2026-10-18T11:00:00.000Z",
    lastEvaluation: { at: "2026-10-18T10:00:00.000Z", status: "succeeded", startedRuns: 2 },
  },
  { name: "morning", workflow: "triage", kind: "schedule", workspaces: ["web"], schedule: { cron: "0 2 * * *" }, nextExecutionAt: "2026-10-18T20:00:00.000Z" },
  // Fired by hand only: no schedule, no next check (ADR 0028).
  {
    name: "architecture-review",
    workflow: "review-workspace",
    kind: "manual",
    workspaces: ["app"],
    lastEvaluation: { at: "2026-10-18T09:30:00.000Z", status: "succeeded", startedRuns: 1 },
  },
  { name: "security-review", workflow: "review-workspace", kind: "manual", workspaces: ["app", "web", "docs"] },
  { name: "release", workflow: "cut-release", kind: "manual", workspaces: [], suspended: true },
];

const disabled = (element: HTMLElement) => (element as HTMLButtonElement).disabled;

describe("triggers page", () => {
  it("shows the scheduled bindings with their source, workspaces, schedule, next check and how their last check went", async () => {
    renderApp({ path: "/ui/triggers", triggers: createInMemoryTriggers(triggers) });

    const panel = await screen.findByRole("region", { name: "Scheduled" });
    expect(within(panel).getByText("3 active · 1 suspended")).toBeTruthy();
    expect(rows(within(panel).getByRole("table", { name: "Scheduled bindings" }))).toEqual([
      ["Name", "Source", "Workflow", "Workspaces", "Schedule", "Next check", "Last check"],
      [
        "github-issues",
        "github-issues",
        "develop-issue",
        "app, web",
        "every 1m",
        "2026-10-18T10:01:00.000Z",
        "failed 2026-10-18T10:00:00.000Z: secret TENDWORKS_PLATFORM_GITHUB_TOKEN is not set",
      ],
      ["nightly", "schedule", "triage", "app", "cron 0 2 * * *", "suspended", "not checked yet"],
      ["hourly", "fake", "implement-issue", "none", "every 1h", "2026-10-18T11:00:00.000Z", "succeeded 2026-10-18T10:00:00.000Z, 2 runs started"],
      ["morning", "schedule", "triage", "web", "cron 0 2 * * *", "2026-10-18T20:00:00.000Z", "not checked yet"],
    ]);
    expect(within(panel).queryAllByRole("button")).toEqual([]);
  });

  it("shows the manual bindings by hand with their workflow, workspaces, last start and Start", async () => {
    const fake = createInMemoryTriggers([
      ...triggers,
      {
        name: "broken-review",
        workflow: "review-workspace",
        kind: "manual",
        workspaces: ["web"],
        lastEvaluation: { at: "2026-10-18T09:00:00.000Z", status: "failed", startedRuns: 0, message: "workspace 'web' is not declared" },
      },
    ]);
    renderApp({ path: "/ui/triggers", triggers: fake });

    const panel = await screen.findByRole("region", { name: "By hand" });
    expect(within(panel).getByText("3 active · 1 suspended")).toBeTruthy();
    expect(rows(within(panel).getByRole("table", { name: "Bindings by hand" }))).toEqual([
      ["Name", "Workflow", "Workspaces", "Last start", "Start"],
      ["architecture-review", "review-workspace", "app", "succeeded 2026-10-18T09:30:00.000Z, 1 run started", "Start"],
      ["security-review", "review-workspace", "app, web, docs", "never started", "Start"],
      ["release suspended", "cut-release", "none", "never started", "Start"],
      ["broken-review", "review-workspace", "web", "failed 2026-10-18T09:00:00.000Z: workspace 'web' is not declared", "Start"],
    ]);
  });

  it("offers no suspend or resume, which the API does not have", async () => {
    renderApp({ path: "/ui/triggers", triggers: createInMemoryTriggers(triggers) });

    await screen.findByRole("table", { name: "Scheduled bindings" });
    expect(screen.queryByRole("button", { name: /suspend|resume/i })).toBeNull();
  });

  it("draws the checks of the last and next 12 hours per scheduled binding on a desktop", async () => {
    renderApp({ path: "/ui/triggers", triggers: createInMemoryTriggers(triggers) });

    const timeline = await screen.findByRole("list", { name: "Trigger checks" });
    expect(within(timeline).getAllByRole("listitem").map((item) => item.querySelector(".timeline-name")?.textContent)).toEqual(["github-issues", "nightly", "hourly", "morning"]);
    const says = (name: string) => within(within(timeline).getByText(name).closest("li") as HTMLElement).getByText(/check|suspended/).textContent;
    expect(says("github-issues")).toBe("checks continuously (every 1m)");
    expect(says("nightly")).toBe("suspended, no checks");
    expect(says("hourly")).toBe("12 checks in the last 12 hours, 12 checks in the next 12 hours");
    // A cron expression shows its next check only (the browser does not evaluate it).
    expect(says("morning")).toBe("0 checks in the last 12 hours, 1 check in the next 12 hours");
  });

  it("shows cards in both panels without a table or timeline on a phone", async () => {
    phoneWidth(true);
    renderApp({ path: "/ui/triggers", triggers: createInMemoryTriggers(triggers) });

    const scheduledCards = await screen.findByRole("list", { name: "Scheduled bindings" });
    const manualCards = screen.getByRole("list", { name: "Bindings by hand" });
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("list", { name: "Trigger checks" })).toBeNull();
    const card = within(within(scheduledCards).getByText("hourly").closest("li") as HTMLElement);
    expect(card.getByText("implement-issue")).toBeTruthy();
    expect(card.getByText("every 1h")).toBeTruthy();
    expect(within(within(scheduledCards).getByText("nightly").closest("li") as HTMLElement).getByText("suspended")).toBeTruthy();
    expect(within(scheduledCards).queryAllByRole("button")).toEqual([]);
    expect(within(scheduledCards).queryByText("architecture-review")).toBeNull();
    const manual = within(within(manualCards).getByText("architecture-review").closest("li") as HTMLElement);
    expect(manual.getByText("review-workspace")).toBeTruthy();
    expect(manual.getByText("Last start")).toBeTruthy();
    expect(manual.queryByText("Schedule")).toBeNull();
    expect(within(within(manualCards).getByText("security-review").closest("li") as HTMLElement).getByText("never started")).toBeTruthy();
    expect(within(within(manualCards).getByText("release").closest("li") as HTMLElement).getByText("suspended")).toBeTruthy();
    expect(within(manualCards).queryByText("hourly")).toBeNull();
  });

  it("starts a manual binding from its card on a phone", async () => {
    phoneWidth(true);
    const fake = createInMemoryTriggers(triggers);
    const { user } = renderApp({ path: "/ui/triggers", triggers: fake });

    const cards = await screen.findByRole("list", { name: "Bindings by hand" });
    expect(within(cards).getAllByRole("button").map((button) => [button.getAttribute("aria-label"), disabled(button)])).toEqual([
      ["Start architecture-review", false],
      ["Start security-review", false],
      ["Start release", true],
    ]);
    await user.click(within(cards).getByRole("button", { name: "Start security-review" }));
    const dialog = screen.getByRole("alertdialog", { name: "Start security-review?" });
    await user.click(within(dialog).getByRole("checkbox", { name: "docs" }));
    await user.click(within(dialog).getByRole("button", { name: "Start runs" }));

    await waitFor(() => expect(window.location.pathname).toBe("/ui/runs"));
    expect(fake.fired).toEqual([
      { name: "security-review", request: { workspace: "app" } },
      { name: "security-review", request: { workspace: "web" } },
    ]);
  });

  it("leaves out the By hand panel without manual bindings", async () => {
    renderApp({ path: "/ui/triggers", triggers: createInMemoryTriggers(triggers.filter((trigger) => trigger.kind !== "manual")) });

    await screen.findByRole("region", { name: "Scheduled" });
    expect(screen.queryByRole("region", { name: "By hand" })).toBeNull();
  });

  it("leaves out the Scheduled panel and the timeline without scheduled bindings", async () => {
    renderApp({ path: "/ui/triggers", triggers: createInMemoryTriggers(triggers.filter((trigger) => trigger.kind === "manual")) });

    await screen.findByRole("region", { name: "By hand" });
    expect(screen.queryByRole("region", { name: "Scheduled" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Trigger checks" })).toBeNull();
  });

  describe("starting a manual binding", () => {
    it("offers Start on manual bindings only, disabled on a suspended one", async () => {
      renderApp({ path: "/ui/triggers", triggers: createInMemoryTriggers(triggers) });

      const table = await screen.findByRole("table", { name: "Bindings by hand" });
      expect(within(table).getAllByRole("button").map((button) => [button.getAttribute("aria-label"), disabled(button)])).toEqual([
        ["Start architecture-review", false],
        ["Start security-review", false],
        ["Start release", true],
      ]);
    });

    it("offers no Start for read-only access, which the API would refuse", async () => {
      signedIn(READ_TOKEN);
      renderApp({ path: "/ui/triggers", triggers: createInMemoryTriggers(triggers) });

      const table = await screen.findByRole("table", { name: "Bindings by hand" });
      expect(rows(table)[0]).toEqual(["Name", "Workflow", "Workspaces", "Last start"]);
      expect(within(table).queryAllByRole("button")).toEqual([]);
    });

    it("starts a binding with one workspace on one tap and opens its run", async () => {
      const fake = createInMemoryTriggers(triggers);
      const { user } = renderApp({ path: "/ui/triggers", triggers: fake });

      await user.click(await screen.findByRole("button", { name: "Start architecture-review" }));

      await waitFor(() => expect(window.location.pathname).toBe("/ui/runs/run-1"));
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(fake.fired).toEqual([{ name: "architecture-review", request: {} }]);
    });

    it("starts a binding without workspaces on one tap", async () => {
      const fake = createInMemoryTriggers([{ name: "release", workflow: "cut-release", kind: "manual", workspaces: [] }]);
      const { user } = renderApp({ path: "/ui/triggers", triggers: fake });

      await user.click(await screen.findByRole("button", { name: "Start release" }));

      await waitFor(() => expect(window.location.pathname).toBe("/ui/runs/run-1"));
      expect(fake.fired).toEqual([{ name: "release", request: {} }]);
    });

    it("disables Start while the firing is pending, so a double tap starts nothing twice", async () => {
      const fake = createInMemoryTriggers(triggers);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      const fire = async (name: string, request: FireTriggerRequest) => {
        await held;
        return fake.fire(name, request);
      };
      const { user } = renderApp({ path: "/ui/triggers", triggers: { ...fake, fire } });

      const start = await screen.findByRole("button", { name: "Start architecture-review" });
      await user.click(start);
      expect(disabled(start)).toBe(true);
      await user.click(start);
      release();

      await waitFor(() => expect(window.location.pathname).toBe("/ui/runs/run-1"));
      expect(fake.fired).toHaveLength(1);
    });

    it("asks for the workspaces of a binding with several, all preselected; all of them is one firing, then Runs", async () => {
      const fake = createInMemoryTriggers(triggers);
      const { user } = renderApp({ path: "/ui/triggers", triggers: fake });

      await user.click(await screen.findByRole("button", { name: "Start security-review" }));
      const dialog = screen.getByRole("alertdialog", { name: "Start security-review?" });
      expect(within(dialog).getAllByRole("checkbox").map((box) => [box.closest("label")?.textContent, (box as HTMLInputElement).checked])).toEqual([
        ["app", true],
        ["web", true],
        ["docs", true],
      ]);
      expect(fake.fired).toEqual([]);
      await user.click(within(dialog).getByRole("button", { name: "Start runs" }));

      await waitFor(() => expect(window.location.pathname).toBe("/ui/runs"));
      expect(fake.fired).toEqual([{ name: "security-review", request: {} }]);
    });

    it("fires once per chosen workspace when the operator narrows the start; one run opens that run", async () => {
      const fake = createInMemoryTriggers(triggers);
      const { user } = renderApp({ path: "/ui/triggers", triggers: fake });

      await user.click(await screen.findByRole("button", { name: "Start security-review" }));
      const dialog = screen.getByRole("alertdialog", { name: "Start security-review?" });
      await user.click(within(dialog).getByRole("checkbox", { name: "app" }));
      await user.click(within(dialog).getByRole("checkbox", { name: "docs" }));
      await user.click(within(dialog).getByRole("button", { name: "Start runs" }));

      await waitFor(() => expect(window.location.pathname).toBe("/ui/runs/run-1"));
      expect(fake.fired).toEqual([{ name: "security-review", request: { workspace: "web" } }]);
    });

    it("cannot start with no workspace chosen, and starts nothing on Cancel", async () => {
      const fake = createInMemoryTriggers(triggers);
      const { user } = renderApp({ path: "/ui/triggers", triggers: fake });

      await user.click(await screen.findByRole("button", { name: "Start security-review" }));
      const dialog = screen.getByRole("alertdialog", { name: "Start security-review?" });
      for (const workspace of ["app", "web", "docs"]) await user.click(within(dialog).getByRole("checkbox", { name: workspace }));
      expect(disabled(within(dialog).getByRole("button", { name: "Start runs" }))).toBe(true);
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(fake.fired).toEqual([]);
      expect(window.location.pathname).toBe("/ui/triggers");
    });

    it("shows why a firing failed and starts nothing more", async () => {
      const fake = createInMemoryTriggers(triggers);
      const fire = async (name: string, request: FireTriggerRequest) => {
        if (request.workspace === "web") throw new TriggerFireRefusedError(400, "Invalid request", "trigger binding 'security-review' does not start runs in workspace 'web'");
        return fake.fire(name, request);
      };
      const { user } = renderApp({ path: "/ui/triggers", triggers: { ...fake, fire } });

      await user.click(await screen.findByRole("button", { name: "Start security-review" }));
      const dialog = screen.getByRole("alertdialog", { name: "Start security-review?" });
      await user.click(within(dialog).getByRole("checkbox", { name: "docs" }));
      await user.click(within(dialog).getByRole("button", { name: "Start runs" }));

      expect(await screen.findByText("Invalid request: trigger binding 'security-review' does not start runs in workspace 'web'. Started before it: run-1 in app.")).toBeTruthy();
      expect(fake.fired).toEqual([{ name: "security-review", request: { workspace: "app" } }]);
      expect(window.location.pathname).toBe("/ui/triggers");
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(disabled(screen.getByRole("button", { name: "Start security-review" }))).toBe(false);
    });
  });

  it("says when there are no bindings", async () => {
    renderApp({ path: "/ui/triggers", triggers: createInMemoryTriggers([]) });

    expect(await screen.findByText("No trigger bindings are configured.")).toBeTruthy();
  });

  it("says when the trigger gateway cannot be reached", async () => {
    renderApp({ path: "/ui/triggers", triggers: { ...createInMemoryTriggers(), list: () => Promise.reject(new Error("connection refused")) } });

    expect((await screen.findByRole("alert")).textContent).toBe("Cannot read the trigger bindings. Is the platform running?");
  });
});
