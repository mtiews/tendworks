import { describe, expect, it } from "vitest";
import { excerpt, type TranscriptEntry } from "./transcript-excerpt.js";

const time = "2026-10-19T10:00:00.000Z";

const chunks = (count: number): TranscriptEntry[] => Array.from({ length: count }, (_, position) => ({ position, time, type: "message-chunk", text: `chunk ${position}` }));

describe("a transcript excerpt", () => {
  it("keeps the newest entries and counts the ones it leaves out", () => {
    const entries = chunks(5);

    expect(excerpt(entries, { last: 2 })).toEqual({ total: 5, omitted: 3, items: entries.slice(3) });
  });

  it("keeps a whole transcript shorter than the limit", () => {
    const entries = chunks(3);

    expect(excerpt(entries, { last: 50 })).toEqual({ total: 3, omitted: 0, items: entries });
  });

  it("keeps only the problems, with the calls of failed tool results", () => {
    const fine: TranscriptEntry[] = [
      { position: 0, time, type: "workspace-checkout", workspace: { url: "https://git.test/a.git" }, exitCode: 0, output: "" },
      { position: 1, time, type: "permission", tool: "bash", granted: true },
      { position: 2, time, type: "tool-call", toolCallId: "ok", title: "ls" },
      { position: 3, time, type: "tool-result", toolCallId: "ok", status: "completed" },
      { position: 4, time, type: "turn-ended", reason: "completed" },
      { position: 5, time, type: "task-ended", state: "TASK_STATE_COMPLETED", message: "done" },
    ];
    const wrong: TranscriptEntry[] = [
      { position: 6, time, type: "workspace-checkout", workspace: { url: "https://git.test/a.git" }, exitCode: 128, output: "fatal: not found" },
      { position: 7, time, type: "permission", tool: "bash", granted: false },
      { position: 8, time, type: "tool-call", toolCallId: "bad", title: "pnpm check" },
      { position: 9, time, type: "tool-result", toolCallId: "bad", status: "failed", output: "1 test failed" },
      { position: 10, time, type: "session-resume-failed", sessionId: "s-1", reason: "gone" },
      { position: 11, time, type: "artifacts-ignored", problem: "not JSON" },
      { position: 12, time, type: "harness-output", text: "rate limited" },
      { position: 13, time, type: "turn-ended", reason: "token-limit" },
      { position: 14, time, type: "error", message: "the harness ended unexpectedly" },
      { position: 15, time, type: "task-ended", state: "TASK_STATE_FAILED", message: "the harness ended unexpectedly" },
    ];

    expect(excerpt([...fine, ...wrong], { last: 50, only: "problems" })).toEqual({ total: 16, omitted: 6, items: wrong });
  });

  it("takes the newest of the problems", () => {
    const entries: TranscriptEntry[] = [
      { position: 0, time, type: "error", message: "first" },
      { position: 1, time, type: "message-chunk", text: "retrying" },
      { position: 2, time, type: "error", message: "second" },
    ];

    expect(excerpt(entries, { last: 1, only: "problems" })).toEqual({ total: 3, omitted: 2, items: [entries[2]] });
  });
});
