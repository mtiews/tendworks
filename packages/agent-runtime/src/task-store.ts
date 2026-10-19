import type { A2A } from "@tendworks/shared";

/** A task as the agent runtime keeps it, with the message that started it. */
export interface StoredTask {
  /** Id of the message that started the task; unique per task. */
  messageId: string;
  agent: string;
  /** When the agent began working on the task. */
  startedAt: string;
  task: A2A.Task;
}

/**
 * The agent runtime's durable record of its tasks. It outlives the process, so a message
 * that is sent again after a restart finds its task instead of starting a new one.
 */
export interface TaskStore {
  /**
   * Records `candidate` unless a task for its message exists already, and returns the
   * task that is recorded for the message: the candidate or the existing one.
   */
  claim(candidate: StoredTask): Promise<StoredTask>;
  /** Replaces the recorded state of a claimed task (looked up by task id). */
  update(task: A2A.Task): Promise<void>;
  get(taskId: string): Promise<A2A.Task | undefined>;
}

/** Tasks in memory, lost on restart. For tests and the in-process default. */
export function createInMemoryTaskStore(): TaskStore {
  const byMessage = new Map<string, StoredTask>();
  const messageOf = new Map<string, string>();
  return {
    async claim(candidate) {
      const existing = byMessage.get(candidate.messageId);
      if (existing) return structuredClone(existing);
      byMessage.set(candidate.messageId, structuredClone(candidate));
      messageOf.set(candidate.task.id, candidate.messageId);
      return structuredClone(candidate);
    },
    async update(task) {
      const messageId = messageOf.get(task.id);
      const stored = messageId === undefined ? undefined : byMessage.get(messageId);
      if (!stored) throw new Error(`no such task: ${task.id}`);
      stored.task = structuredClone(task);
    },
    async get(taskId) {
      const messageId = messageOf.get(taskId);
      const stored = messageId === undefined ? undefined : byMessage.get(messageId);
      return stored && structuredClone(stored.task);
    },
  };
}
