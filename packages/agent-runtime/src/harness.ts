import type { A2A, AgentProfile } from "@tendworks/shared";
import type { TranscriptEntry } from "./transcripts/transcript-store.js";

/** One task as a harness gets it. */
export interface HarnessTask {
  taskId: string;
  profile: AgentProfile.AgentProfile;
  /** The message that started the task. */
  message: A2A.Message;
  /** How long agents already worked on the task before an interruption (0 for a new task). */
  elapsedMs?: number;
}

export interface Cost {
  amount: number;
  /** ISO 4217 currency code, e.g. `USD`. */
  currency: string;
}

/** How the agent session behind a task ended. */
export interface HarnessResult {
  state: Extract<A2A.TaskState, "TASK_STATE_COMPLETED" | "TASK_STATE_FAILED" | "TASK_STATE_CANCELED" | "TASK_STATE_REJECTED">;
  /** The agent's final answer, or why the session failed. */
  message: string;
  artifacts?: A2A.Artifact[];
  /** What the session cost, if the harness knows. */
  cost?: Cost;
}

/** What a harness reports while it works. */
export interface HarnessObserver {
  /** Appends an entry to the task's transcript. */
  record(entry: TranscriptEntry): void;
  /** The agent's progress so far, shown as the working task's status message. */
  progress(text: string): void;
}

/**
 * The harness port: runs one agent session for a task, e.g. Claude Code over ACP in a
 * sandbox, or the fake agent. Agent-level failures end in a result with state
 * `TASK_STATE_FAILED`; the promise rejects only when the session could not be
 * attempted at all.
 */
export interface Harness {
  run(task: HarnessTask, observer: HarnessObserver): Promise<HarnessResult>;
}
