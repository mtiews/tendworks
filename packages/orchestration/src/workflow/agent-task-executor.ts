import type { A2A } from "@tendworks/shared";

/**
 * Port through which the interpreter hands a task to an agent profile, following the
 * A2A task model (`SendMessage`).
 *
 * @port
 */
export interface AgentTaskExecutor {
  /**
   * Sends a message to the agent profile `agent` (e.g. `developer` for `agent://developer`).
   * Resolves once the task reached a terminal or interrupted state; rejects when the
   * task could not be delivered. The message id is stable per step, so a repeated
   * request for the same message must return the existing task.
   */
  sendMessage(agent: string, request: A2A.SendMessageRequest, options?: SendMessageOptions): Promise<A2A.Task>;
}

export interface SendMessageOptions {
  /**
   * Called with the working task as soon as the agent runtime created it (id and
   * transcript reference known), before the agent finishes. A failure here does not
   * stop the task.
   */
  onTask?: (task: A2A.Task) => void | Promise<void>;
}

/** Keys the interpreter sets in `SendMessageRequest.metadata`. */
export const RUN_ID = "dev.tendworks/runId";
export const STEP_REFERENCE = "dev.tendworks/stepReference";
/** Message metadata key of the workspace a task asks for (contracts/schemas/a2a.schema.yaml#/$defs/workspace). */
export const WORKSPACE = "dev.tendworks/workspace";

/** Keys agents set in `Task.metadata` (contracts/schemas/a2a.schema.yaml). */
export const TRANSCRIPT = "dev.tendworks/transcript";
export const COST = "dev.tendworks/cost";
