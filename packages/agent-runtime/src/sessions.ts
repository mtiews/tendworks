import type { AgentRuntime as Contract } from "@tendworks/shared";
import { RUN_ID, STEP_REFERENCE } from "./agent-tasks.js";
import { chatFacts } from "./chats.js";
import { TERMINAL_STATES, type StoredTask } from "./task-store.js";

/** An active agent session as clients see it (contracts/schemas/agent-session.schema.yaml). */
export type AgentSession = Contract.components["schemas"]["agentSession"];

/** The run and step a request of a run's step names in its metadata, as task metadata; undefined for any other request. */
export function runStepOf(metadata: Record<string, unknown> | undefined): Record<string, string> | undefined {
  const runId = metadata?.[RUN_ID];
  const reference = metadata?.[STEP_REFERENCE];
  return typeof runId === "string" && typeof reference === "string" ? { [RUN_ID]: runId, [STEP_REFERENCE]: reference } : undefined;
}

/** The agent session of a task that has not ended; undefined for an ended task, or one neither of a run's step nor a chat. */
export function activeSession({ agent, startedAt, task }: StoredTask): AgentSession | undefined {
  if (TERMINAL_STATES.includes(task.status.state)) return undefined;
  const status = task.status.state === "TASK_STATE_INPUT_REQUIRED" ? "input-required" : "working";
  const facts = chatFacts(task);
  if (facts) return { kind: "chat", agent: facts.agent, taskId: task.id, status, startedAt: facts.startedAt, chat: task.id };
  const runStep = runStepOf(task.metadata);
  if (!runStep) return undefined;
  return { kind: "run-step", agent, taskId: task.id, status, startedAt, run: runStep[RUN_ID]!, step: runStep[STEP_REFERENCE]! };
}
