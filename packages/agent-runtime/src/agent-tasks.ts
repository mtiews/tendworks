import type { A2A } from "@tendworks/shared";

/**
 * The A2A boundary of the agent runtime (operations `SendMessage` and `GetTask` of the
 * A2A task model), in process for now. Orchestration reaches agents only through it.
 */
export interface AgentTasks {
  /**
   * Hands a message to the agent profile `agent` and resolves once the task reached a
   * terminal or interrupted state (blocking `SendMessage`). A message whose id is
   * already known returns the existing task instead of starting a new one. Rejects
   * when the message cannot be delivered, e.g. the profile does not exist.
   */
  sendMessage(agent: string, request: A2A.SendMessageRequest, options?: SendMessageOptions): Promise<A2A.Task>;
  getTask(taskId: string): Promise<A2A.Task | undefined>;
}

export interface SendMessageOptions {
  /**
   * Called once the runtime keeps the task, before the agent starts working on it (also
   * when an interrupted task is resumed): the working task with its id and transcript
   * reference. A failure here does not stop the task.
   */
  onTask?: (task: A2A.Task) => void | Promise<void>;
}

/** `Task.metadata` key: reference to the transcript of the agent session (string). */
export const TRANSCRIPT = "dev.tendworks/transcript";
/** `Task.metadata` key: what the agent session cost, `{ amount, currency }`. */
export const COST = "dev.tendworks/cost";

export class AgentNotFoundError extends Error {
  constructor(agent: string) {
    super(`no such agent profile: ${agent}`);
    this.name = "AgentNotFoundError";
  }
}
