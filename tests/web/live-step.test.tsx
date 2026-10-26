import { createInMemoryAgentRuntime, createInMemoryRuns, type Run, type TranscriptEntry } from "@tendworks/control-plane";
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp, signedIn } from "./support/platform.js";

const time = "2026-10-20T10:00:00.000Z";

const liveRun: Run = {
  id: "run-live",
  workflow: "restart-scripted",
  status: "running",
  input: {},
  startedBy: { kind: "manual" },
  steps: [{ name: "implement", reference: "/do/0/implement", status: "running", taskId: "task-live", transcript: "memory:task-live", startedAt: time }],
  createdAt: time,
  startedAt: time,
};

const entry = {
  started: { position: 0, time, type: "task-started", agent: "scripted-developer", message: { messageId: "m-1", role: "ROLE_USER", parts: [{ text: "Write before.txt" }] } },
  tool: { position: 1, time, type: "tool-call", toolCallId: "tool-1", title: "Write before.txt" },
  hel: { position: 2, time, type: "message-chunk", text: "Hel" },
  lo: { position: 3, time, type: "message-chunk", text: "lo there" },
  ended: { position: 4, time, type: "task-ended", state: "TASK_STATE_COMPLETED", message: "Hello there" },
} satisfies Record<string, TranscriptEntry>;

/** The platform with one running agent step whose transcript has `entries` so far. */
function platformWith(...entries: TranscriptEntry[]) {
  const runs = createInMemoryRuns();
  runs.runs.set(liveRun.id, structuredClone(liveRun));
  const agentRuntime = createInMemoryAgentRuntime();
  agentRuntime.transcripts.set("task-live", entries);
  agentRuntime.running.add("task-live");
  const finish = () => {
    agentRuntime.end("task-live");
    const run = runs.runs.get(liveRun.id)!;
    run.status = "completed";
    run.finishedAt = "2026-10-20T10:05:00.000Z";
    run.steps[0]!.status = "completed";
    run.steps[0]!.finishedAt = "2026-10-20T10:05:00.000Z";
  };
  return { runs, agentRuntime, finish };
}

const step = () => screen.getByRole("region", { name: "implement" });
const transcriptText = () => within(step()).getByRole("list", { name: "Transcript" }).textContent;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("live step", () => {
  it("shows a running step's entries as they come and its end without a reload", async () => {
    const { runs, agentRuntime, finish } = platformWith(entry.started);
    signedIn();
    renderApp({ path: "/ui/runs/run-live", runs, agentRuntime });

    expect(await within(await screen.findByRole("region", { name: "implement" })).findByText(/Write before\.txt/)).toBeTruthy();
    expect(within(step()).getByRole("status").textContent).toBe("Live");

    agentRuntime.append("task-live", entry.tool);
    expect(await within(step()).findByRole("button", { name: /Write before\.txt/ })).toBeTruthy();
    agentRuntime.append("task-live", entry.hel);
    agentRuntime.append("task-live", entry.lo);
    expect(await within(step()).findByText("Hello there")).toBeTruthy();

    agentRuntime.append("task-live", entry.ended);
    finish();

    // The stream's end reads the run again at once, without waiting for the next poll.
    await vi.waitFor(() => expect(within(step()).getByText("completed", { selector: ".status" })).toBeTruthy());
    expect(within(step()).queryByRole("status")).toBeNull();
    expect(within(step()).getByText("Hello there")).toBeTruthy();
  });

  it("reconnects after the stream drops and continues after the last entry, without gaps or duplicates", async () => {
    const { runs, agentRuntime, finish } = platformWith(entry.started, entry.tool);
    signedIn();
    const { platform } = renderApp({ path: "/ui/runs/run-live", runs, agentRuntime });
    const streams = () => platform.requests.filter((request) => request.url.endsWith("/transcript/stream"));

    await within(await screen.findByRole("region", { name: "implement" })).findByRole("button", { name: /Write before\.txt/ });
    await vi.waitFor(() => expect(streams()).toHaveLength(1));
    agentRuntime.append("task-live", entry.hel);
    expect(await within(step()).findByText("Hel")).toBeTruthy();

    agentRuntime.drop();
    agentRuntime.append("task-live", entry.lo);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(streams()).toHaveLength(2));
    expect(streams()[1]!.headers.get("last-event-id")).toBe("2");
    expect(await within(step()).findByText("Hello there")).toBeTruthy();

    agentRuntime.append("task-live", entry.ended);
    finish();
    await vi.waitFor(() => expect(within(step()).queryByRole("status")).toBeNull());

    expect(within(step()).getAllByRole("button", { name: /Write before\.txt/ })).toHaveLength(1);
    expect(within(step()).getAllByText("Hello there")).toHaveLength(1);
    expect(transcriptText()).toMatch(/Task for scripted-developer: Write before\.txt.*Write before\.txt.*Hello there/s);
  });

  it("keeps what arrived and says so when the live transcript cannot be reached again", async () => {
    const { runs, agentRuntime } = platformWith(entry.started);
    signedIn();
    const { platform } = renderApp({ path: "/ui/runs/run-live", runs, agentRuntime });
    await within(await screen.findByRole("region", { name: "implement" })).findByText(/Write before\.txt/);
    await vi.waitFor(() => expect(platform.requests.filter((request) => request.url.endsWith("/transcript/stream"))).toHaveLength(1));

    platform.unreachable(true);
    agentRuntime.drop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect((await within(step()).findByText(/The live transcript was lost/)).textContent).toBe(
      "The live transcript was lost: Cannot reach the platform. Is it running? It shows what arrived until then.",
    );
    expect(within(step()).getByText(/Write before\.txt/)).toBeTruthy();
  });

  it("tries again later after losing the live transcript and resumes after the last entry, without gaps or duplicates", async () => {
    const { runs, agentRuntime, finish } = platformWith(entry.started, entry.tool);
    signedIn();
    const { platform } = renderApp({ path: "/ui/runs/run-live", runs, agentRuntime });
    const streams = () => platform.requests.filter((request) => request.url.endsWith("/transcript/stream"));
    await within(await screen.findByRole("region", { name: "implement" })).findByRole("button", { name: /Write before\.txt/ });
    await vi.waitFor(() => expect(streams()).toHaveLength(1));

    platform.unreachable(true);
    agentRuntime.drop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await within(step()).findByText(/The live transcript was lost/)).toBeTruthy();
    const attempts = streams().length;

    platform.unreachable(false);
    agentRuntime.append("task-live", entry.hel);
    agentRuntime.append("task-live", entry.lo);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await within(step()).findByText("Hello there")).toBeTruthy();
    const resumed = streams().slice(attempts).find((request) => request.headers.get("last-event-id") !== null);
    expect(resumed?.headers.get("last-event-id")).toBe("1");
    expect(within(step()).queryByText(/The live transcript was lost/)).toBeNull();
    expect(within(step()).getByRole("status").textContent).toBe("Live");

    agentRuntime.append("task-live", entry.ended);
    finish();
    await vi.waitFor(() => expect(within(step()).queryByRole("status")).toBeNull());
    expect(within(step()).getAllByRole("button", { name: /Write before\.txt/ })).toHaveLength(1);
    expect(within(step()).getAllByText("Hello there")).toHaveLength(1);
  });

  it("tries again at once when the tab becomes visible after losing the live transcript", async () => {
    const { runs, agentRuntime } = platformWith(entry.started, entry.tool);
    signedIn();
    const { platform } = renderApp({ path: "/ui/runs/run-live", runs, agentRuntime });
    const streams = () => platform.requests.filter((request) => request.url.endsWith("/transcript/stream"));
    await within(await screen.findByRole("region", { name: "implement" })).findByRole("button", { name: /Write before\.txt/ });
    await vi.waitFor(() => expect(streams()).toHaveLength(1));

    platform.unreachable(true);
    agentRuntime.drop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await within(step()).findByText(/The live transcript was lost/)).toBeTruthy();
    const attempts = streams().length;

    platform.unreachable(false);
    agentRuntime.append("task-live", entry.hel);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.waitFor(() => expect(streams().length).toBeGreaterThan(attempts));
    } finally {
      visibility.mockRestore();
    }

    expect(streams()[attempts]!.headers.get("last-event-id")).toBe("1");
    expect(await within(step()).findByText("Hel")).toBeTruthy();
    expect(within(step()).queryByText(/The live transcript was lost/)).toBeNull();
  });

  it("shows a finished step's transcript without following it", async () => {
    const { runs, agentRuntime, finish } = platformWith(entry.started, entry.hel, entry.lo);
    finish();
    signedIn();
    const { platform } = renderApp({ path: "/ui/runs/run-live", runs, agentRuntime });

    expect(await within(await screen.findByRole("region", { name: "implement" })).findByText("Hello there")).toBeTruthy();
    expect(within(step()).queryByRole("status")).toBeNull();
    expect(platform.requests.filter((request) => request.url.endsWith("/transcript/stream"))).toHaveLength(0);
  });
});
