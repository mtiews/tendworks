import type { ControlPlane } from "@tendworks/shared";

export type TranscriptEntry = ControlPlane.components["schemas"]["TranscriptEntryList"]["items"][number];

export interface TranscriptExcerpt {
  /** How many entries the whole transcript has. */
  total: number;
  /** How many of them the excerpt leaves out. */
  omitted: number;
  items: TranscriptEntry[];
}

export interface ExcerptOptions {
  /** How many of the newest entries to keep. */
  last: number;
  /** `problems` keeps only the entries that tell what went wrong, before taking the newest. */
  only?: "problems" | undefined;
}

/**
 * The part of a transcript an agent reads, small enough for its context window: the newest
 * `last` entries, of only the problems when asked for. A failed tool result keeps the call
 * it answers, so the agent sees what failed and not only that something did.
 */
export function excerpt(entries: TranscriptEntry[], { last, only }: ExcerptOptions): TranscriptExcerpt {
  const kept = only === "problems" ? problems(entries) : entries;
  const items = kept.slice(Math.max(0, kept.length - last));
  return { total: entries.length, omitted: entries.length - items.length, items };
}

function problems(entries: TranscriptEntry[]): TranscriptEntry[] {
  const failedCalls = new Set(entries.flatMap((entry) => (entry.type === "tool-result" && entry.status === "failed" ? [entry.toolCallId] : [])));
  return entries.filter((entry) => {
    switch (entry.type) {
      case "tool-call":
      case "tool-result":
        return failedCalls.has(entry.toolCallId);
      case "error":
      case "session-resume-failed":
      case "artifacts-ignored":
      case "harness-output":
        return true;
      case "permission":
        return !entry.granted;
      case "workspace-checkout":
        return entry.exitCode !== 0;
      case "turn-ended":
        return entry.reason !== "completed";
      case "task-ended":
        return entry.state !== "TASK_STATE_COMPLETED";
      case "task-started":
      case "task-resumed":
      case "message-received":
      case "input-required":
      case "session-started":
      case "session-resumed":
      case "message-chunk":
      case "thought-chunk":
      case "plan":
      case "usage":
      case "artifacts":
        return false;
    }
  });
}
