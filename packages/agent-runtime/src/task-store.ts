import type { A2A } from "@tendworks/shared";
import type { ChatEvent } from "./chat-events.js";
import type { HarnessSession } from "./harness.js";

/** What kind of work a task is: a run's step hands one to an agent (`task`), a human starts a chat (`chat`). */
export type TaskKind = "task" | "chat";

/** A task as the agent runtime keeps it, with the message that started it. */
export interface StoredTask {
  /** Id of the message that started the task; unique per task. */
  messageId: string;
  agent: string;
  /** When the agent began working on the task. */
  startedAt: string;
  task: A2A.Task;
  /** `task` when absent. */
  kind?: TaskKind;
  /** What the harness kept about its agent session, to resume it after an interruption. */
  session?: HarnessSession;
}

/**
 * The agent runtime's durable record of its tasks. It outlives the process, so a message
 * that is sent again after a restart finds its task instead of starting a new one.
 *
 * @port
 */
export interface TaskStore {
  /**
   * Records `candidate` unless a task for its message exists already, and returns the
   * task that is recorded for the message: the candidate or the existing one. `event` is
   * published with the new task, never for an existing one.
   */
  claim(candidate: StoredTask, event?: ChatEvent): Promise<StoredTask>;
  /** Replaces the recorded state of a claimed task (looked up by task id), publishing `event` with it. */
  update(task: A2A.Task, event?: ChatEvent): Promise<void>;
  get(taskId: string): Promise<A2A.Task | undefined>;
  /** A task as it is kept, with its harness session; undefined for an unknown task. */
  find(taskId: string): Promise<StoredTask | undefined>;
  /** The tasks of a kind, the most recently started first. */
  list(filter: { kind: TaskKind }): Promise<A2A.Task[]>;
  /** Replaces the harness session kept with a claimed task. */
  saveSession(taskId: string, session: HarnessSession): Promise<void>;
}

/** Tasks in memory, lost on restart. For tests and the in-process default; `published` holds the events of its writes. */
export function createInMemoryTaskStore(): TaskStore & { published: ChatEvent[] } {
  const published: ChatEvent[] = [];
  const byMessage = new Map<string, StoredTask>();
  const messageOf = new Map<string, string>();
  const find = (taskId: string) => {
    const messageId = messageOf.get(taskId);
    const stored = messageId === undefined ? undefined : byMessage.get(messageId);
    if (!stored) throw new Error(`no such task: ${taskId}`);
    return stored;
  };
  return {
    published,
    async claim(candidate, event) {
      const existing = byMessage.get(candidate.messageId);
      if (existing) return structuredClone(existing);
      byMessage.set(candidate.messageId, structuredClone(candidate));
      messageOf.set(candidate.task.id, candidate.messageId);
      if (event) published.push(structuredClone(event));
      return structuredClone(candidate);
    },
    async update(task, event) {
      find(task.id).task = structuredClone(task);
      if (event) published.push(structuredClone(event));
    },
    async list({ kind }) {
      return [...byMessage.values()]
        .reverse()
        .filter((stored) => (stored.kind ?? "task") === kind)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .map((stored) => structuredClone(stored.task));
    },
    async saveSession(taskId, session) {
      find(taskId).session = structuredClone(session);
    },
    async get(taskId) {
      const messageId = messageOf.get(taskId);
      const stored = messageId === undefined ? undefined : byMessage.get(messageId);
      return stored && structuredClone(stored.task);
    },
    async find(taskId) {
      const messageId = messageOf.get(taskId);
      const stored = messageId === undefined ? undefined : byMessage.get(messageId);
      return stored && structuredClone(stored);
    },
  };
}
