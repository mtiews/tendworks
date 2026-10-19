import type { A2A } from "@tendworks/shared";
import type { LoadedAgentProfile } from "./agent-profiles.js";
import type { TranscriptRecord } from "./transcripts/transcript-store.js";

/** One task as a harness gets it. */
export interface HarnessTask {
  taskId: string;
  profile: LoadedAgentProfile;
  /** The message that started the task. */
  message: A2A.Message;
  /** How long agents already worked on the task before an interruption (0 for a new task). */
  elapsedMs?: number;
  /** What the harness kept about the task's agent session before an interruption; absent for a new task. */
  session?: HarnessSession;
}

/**
 * What a harness keeps about its agent session to resume it after an interruption,
 * e.g. the ACP session id and the sandbox it ran in. The agent runtime stores it with
 * the task without looking inside.
 */
export type HarnessSession = Record<string, string>;

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
  /** Appends an entry to the task's transcript; the runtime stamps its time and position. */
  record(entry: TranscriptRecord): void;
  /** The agent's progress so far, shown as the working task's status message. */
  progress(text: string): void;
  /** Keeps the agent session with the task, durably once the promise resolves; replaces what was kept before. */
  saveSession(session: HarnessSession): Promise<void>;
}

/** How one turn of an agent session that waits for input between turns ended. */
export interface HarnessTurn {
  /** `TASK_STATE_INPUT_REQUIRED`: the agent ended its turn and the session goes on; `TASK_STATE_FAILED`: the session failed for good. */
  state: Extract<A2A.TaskState, "TASK_STATE_INPUT_REQUIRED" | "TASK_STATE_FAILED">;
  /** The agent's answer in this turn, or why the session failed. */
  message: string;
  /** What this turn cost, if the harness knows. */
  cost?: Cost;
}

/**
 * An agent session held open across turns, e.g. a chat's (ADR 0015): one task, one
 * agent session, any number of prompt turns. Between turns the session and its
 * workspace are kept until `end`.
 */
export interface OpenSession {
  /**
   * Runs one prompt turn with `message`. The first turn starts the session; a session
   * whose sandbox is gone (e.g. after a restart) is resumed first.
   */
  turn(message: A2A.Message): Promise<HarnessTurn>;
  /**
   * Asks the agent to stop the running turn, which then ends in `TASK_STATE_INPUT_REQUIRED`
   * with a `turn-ended` entry of reason `cancelled`; the session goes on. Resolves once
   * the request is made, not once the turn ended. Nothing happens while no turn runs.
   */
  cancel(): Promise<void>;
  /** Ends the session for good, also during a turn: removes its sandbox and its volumes. */
  end(): Promise<void>;
}

/** A task without its message, for a session whose messages arrive turn by turn. */
export type HarnessSessionTask = Omit<HarnessTask, "message" | "elapsedMs">;

/**
 * The harness port: runs one agent session for a task, e.g. Claude Code over ACP in a
 * sandbox, or the fake agent. Agent-level failures end in a result with state
 * `TASK_STATE_FAILED`; the promise rejects only when the session could not be
 * attempted at all.
 *
 * @port
 */
export interface Harness {
  run(task: HarnessTask, observer: HarnessObserver): Promise<HarnessResult>;
  /**
   * Opens an agent session that waits for input between turns (a chat). Nothing starts
   * before the first turn. Harnesses without it cannot hold chats.
   */
  open?(task: HarnessSessionTask, observer: HarnessObserver): OpenSession;
}
