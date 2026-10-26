import type { A2A, Chat as Contract } from "@tendworks/shared";
import { COST, TRANSCRIPT } from "./agent-tasks.js";
import type { Cost } from "./harness.js";

/** A chat as clients see it (contracts/schemas/chat.schema.yaml). */
export type Chat = Contract.Chat;

/** `Task.metadata` key of a chat's task: what the chat is, `{ agent, title, harness, startedAt, traceparent, workspace?, write? }`. */
export const CHAT = "dev.tendworks/chat";

export interface ChatFacts {
  agent: string;
  /** The first message as sent: what the chat is called. */
  title: string;
  /**
   * The harness of the agent profile the chat started with, so the chat's session can still
   * be ended once the profile is gone from the configuration. Missing in chats started
   * before it was kept.
   */
  harness?: string;
  startedAt: string;
  /** The trace the chat started; its events belong to it. */
  traceparent: string;
  /** The configured workspace whose assistant the chat is, by name; absent for an empty workspace. */
  workspace?: string;
  /** Whether the workspace's assistant may change the workspace, as its settings said when the chat started. */
  write?: boolean;
}

/** The chat a task is, or undefined for a task of a run. */
export function chatFacts(task: A2A.Task): ChatFacts | undefined {
  const facts = task.metadata?.[CHAT] as ChatFacts | undefined;
  return facts && typeof facts.agent === "string" ? facts : undefined;
}

const STATUS: Partial<Record<A2A.TaskState, Chat["status"]>> = {
  TASK_STATE_WORKING: "working",
  TASK_STATE_INPUT_REQUIRED: "input-required",
  TASK_STATE_COMPLETED: "ended",
  TASK_STATE_FAILED: "failed",
};

/** A chat's task as the chat. */
export function toChat(task: A2A.Task, facts: ChatFacts): Chat {
  const status = STATUS[task.status.state] ?? "failed";
  const lastActivityAt = task.status.timestamp ?? facts.startedAt;
  const message = task.status.message?.parts.flatMap((part) => ("text" in part ? [part.text] : [])).join("");
  const cost = task.metadata?.[COST] as Cost | undefined;
  const transcript = task.metadata?.[TRANSCRIPT];
  const { workspace, write } = facts;
  return {
    id: task.id,
    agent: facts.agent,
    title: facts.title,
    status,
    startedAt: facts.startedAt,
    lastActivityAt,
    ...(status === "ended" || status === "failed" ? { endedAt: lastActivityAt } : {}),
    ...(message ? { message } : {}),
    ...(cost ? { cost: { amount: cost.amount, currency: cost.currency } } : {}),
    ...(typeof transcript === "string" ? { transcript } : {}),
    ...(workspace === undefined ? {} : { workspace, write: write ?? false }),
  };
}

/** Adds a turn's cost to what a chat cost so far; amounts in another currency are not added. */
export function addCost(total: Cost | undefined, turn: Cost | undefined): Cost | undefined {
  if (!turn) return total;
  if (!total) return { ...turn };
  if (total.currency !== turn.currency) return total;
  return { amount: Math.round((total.amount + turn.amount) * 1e6) / 1e6, currency: total.currency };
}

/** The branch a writing workspace assistant works on in a git workspace. */
export function chatBranch(chatId: string): string {
  return `tendworks/chat-${chatId}`;
}

/** A chat was asked for by the name of a workspace that is not configured. */
export class UnknownWorkspaceError extends Error {
  constructor(workspace: string) {
    super(`no workspace '${workspace}' is configured`);
    this.name = "UnknownWorkspaceError";
  }
}

/** A chat was asked for with a workspace whose assistant is not enabled. */
export class AssistantNotEnabledError extends Error {
  constructor(workspace: string) {
    super(`workspace ${workspace} has no enabled assistant: set spec.assistant.enabled in the workspace to chat with it`);
    this.name = "AssistantNotEnabledError";
  }
}

export class ChatNotAllowedError extends Error {
  constructor(agent: string, reason = "its agent profile has no spec.chat") {
    super(`agent profile ${agent} does not allow chats: ${reason}`);
    this.name = "ChatNotAllowedError";
  }
}

/** A message reached a chat while its agent still works on a turn. */
export class ChatBusyError extends Error {
  constructor(chatId: string) {
    super(`chat ${chatId} is working on a turn; wait for the turn to end before sending the next message`);
    this.name = "ChatBusyError";
  }
}

/** A message reached a chat that has ended. */
export class ChatEndedError extends Error {
  constructor(chatId: string) {
    super(`chat ${chatId} has ended; start a new chat`);
    this.name = "ChatEndedError";
  }
}
