import { createInMemoryTriggers, type Trigger } from "@tendworks/control-plane";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { phoneWidth, renderApp, signedIn } from "./support/platform.js";
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
];

describe("triggers page", () => {
  it("shows each trigger binding with its source, workspaces, schedule, next check and how its last check went", async () => {
    renderApp({ path: "/ui/triggers", triggers: createInMemoryTriggers(triggers) });

    expect(rows(await screen.findByRole("table", { name: "Trigger bindings" }))).toEqual([
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
      ["architecture-review", "manual", "review-workspace", "app", "by hand", "-", "succeeded 2026-10-18T09:30:00.000Z, 1 run started"],
    ]);
  });

  it("offers no suspend or resume, which the API does not have", async () => {
    renderApp({ path: "/ui/triggers", triggers: createInMemoryTriggers(triggers) });

    await screen.findByRole("table", { name: "Trigger bindings" });
    expect(screen.queryByRole("button", { name: /suspend|resume/i })).toBeNull();
  });

  it("draws the checks of the last and next 12 hours per binding on a desktop", async () => {
    renderApp({ path: "/ui/triggers", triggers: createInMemoryTriggers(triggers) });

    const timeline = await screen.findByRole("list", { name: "Trigger checks" });
    const says = (name: string) => within(within(timeline).getByText(name).closest("li") as HTMLElement).getByText(/check|suspended/).textContent;
    expect(says("github-issues")).toBe("checks continuously (every 1m)");
    expect(says("nightly")).toBe("suspended, no checks");
    expect(says("hourly")).toBe("12 checks in the last 12 hours, 12 checks in the next 12 hours");
    // A cron expression shows its next check only (the browser does not evaluate it).
    expect(says("morning")).toBe("0 checks in the last 12 hours, 1 check in the next 12 hours");
    expect(says("architecture-review")).toBe("fired by hand, no scheduled checks");
  });

  it("shows cards without a table or timeline on a phone", async () => {
    phoneWidth(true);
    renderApp({ path: "/ui/triggers", triggers: createInMemoryTriggers(triggers) });

    const cards = await screen.findByRole("list", { name: "Trigger bindings" });
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("list", { name: "Trigger checks" })).toBeNull();
    const card = within(within(cards).getByText("hourly").closest("li") as HTMLElement);
    expect(card.getByText("implement-issue")).toBeTruthy();
    expect(card.getByText("every 1h")).toBeTruthy();
    expect(within(within(cards).getByText("nightly").closest("li") as HTMLElement).getByText("suspended")).toBeTruthy();
    const manual = within(within(cards).getByText("architecture-review").closest("li") as HTMLElement);
    expect(manual.getByText("by hand")).toBeTruthy();
    expect(manual.getByText("fired by hand")).toBeTruthy();
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
