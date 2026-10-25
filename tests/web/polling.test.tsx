import { createInMemoryRuns, type Notification } from "@tendworks/control-plane";
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_TOKEN, renderApp, type Platform, type PlatformOptions } from "./support/platform.js";

/*
 * Lists refresh themselves about every 5 seconds and stop while the tab is hidden (spec #38).
 * The clock is faked but keeps running, so the app's requests still answer.
 */

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  showTab();
});

function open(path: string, options: PlatformOptions) {
  window.sessionStorage.setItem("tendworks.token", API_TOKEN);
  return renderApp({ path, ...options });
}

function hideTab() {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Back to jsdom's own, always visible document. */
function showTab() {
  if (!Object.hasOwn(document, "hidden")) return;
  Reflect.deleteProperty(document, "hidden");
  Reflect.deleteProperty(document, "visibilityState");
  document.dispatchEvent(new Event("visibilitychange"));
}

const requestsTo = (platform: Platform, pathname: string) => platform.requests.filter((request) => new URL(request.url).pathname === pathname).length;

const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

function notification(id: string, title: string): Notification {
  return { id, kind: "run.completed", runId: `run-${id}`, title, createdAt: "2026-10-18T10:00:03.000Z", deliveries: [] };
}

describe("polling", () => {
  it("shows new notifications without reloading", async () => {
    const recorded = [notification("1", "Run run-1 of hello-agent completed")];
    open("/ui/notifications", { notifications: { list: async () => [...recorded] } });
    await screen.findByText("Run run-1 of hello-agent completed");

    recorded.unshift(notification("2", "Run run-2 of hello-agent completed"));
    await wait(5_000);

    expect(await screen.findByText("Run run-2 of hello-agent completed")).toBeTruthy();
  });

  it("shows on the overview who started working since", async () => {
    const runs = createInMemoryRuns();
    open("/ui/overview", { runs });
    expect(await screen.findByRole("link", { name: "0 agents working" })).toBeTruthy();

    runs.runs.set("r-1", {
      id: "r-1",
      workflow: "hello-agent",
      status: "running",
      input: {},
      steps: [{ name: "implement", reference: "/do/0/implement", status: "running", taskId: "task-1", startedAt: "2026-10-18T10:00:00.000Z" }],
      createdAt: "2026-10-18T10:00:00.000Z",
    });
    await wait(5_000);

    expect(await screen.findByRole("link", { name: "1 agent working" })).toBeTruthy();
  });

  it("stops while the tab is hidden and refreshes at once when it shows again", async () => {
    const recorded = [notification("1", "Run run-1 of hello-agent completed")];
    const { platform } = open("/ui/notifications", { notifications: { list: async () => [...recorded] } });
    await screen.findByText("Run run-1 of hello-agent completed");

    hideTab();
    const whileVisible = requestsTo(platform, "/notifications");
    recorded.unshift(notification("2", "Run run-2 of hello-agent completed"));
    await wait(60_000);

    expect(requestsTo(platform, "/notifications")).toBe(whileVisible);
    expect(screen.queryByText("Run run-2 of hello-agent completed")).toBeNull();

    showTab();

    expect(await screen.findByText("Run run-2 of hello-agent completed")).toBeTruthy();
    // The page's list and the shell's badge for failed deliveries both poll at once.
    expect(requestsTo(platform, "/notifications")).toBe(whileVisible + 2);
  });
});
