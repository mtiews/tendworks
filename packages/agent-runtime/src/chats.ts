import type { A2A, Chat as Contract } from "@tendworks/shared";
import { COST, TRANSCRIPT } from "./agent-tasks.js";
import type { Cost } from "./harness.js";
import { workspaceOf } from "./workspace.js";

/** A chat as clients see it (contracts/schemas/chat.schema.yaml). */
export type Chat = Contract.Chat;

/** `Task.metadata` key of a chat's task: what the chat is, `{ agent, startedAt, traceparent }`. */
export const CHAT = "dev.tendworks/chat";

export interface ChatFacts {
  agent: string;
  startedAt: string;
  /** The trace the chat started; its events belong to it. */
  traceparent: string;
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
  const repository = repositoryOf(task);
  return {
    id: task.id,
    agent: facts.agent,
    status,
    startedAt: facts.startedAt,
    lastActivityAt,
    ...(status === "ended" || status === "failed" ? { endedAt: lastActivityAt } : {}),
    ...(message ? { message } : {}),
    ...(cost ? { cost: { amount: cost.amount, currency: cost.currency } } : {}),
    ...(typeof transcript === "string" ? { transcript } : {}),
    ...(repository === undefined ? {} : { repository }),
  };
}

/** Adds a turn's cost to what a chat cost so far; amounts in another currency are not added. */
export function addCost(total: Cost | undefined, turn: Cost | undefined): Cost | undefined {
  if (!turn) return total;
  if (!total) return { ...turn };
  if (total.currency !== turn.currency) return total;
  return { amount: Math.round((total.amount + turn.amount) * 1e6) / 1e6, currency: total.currency };
}

/** A chat's repository, from the workspace its first message asked for. */
function repositoryOf(task: A2A.Task): string | undefined {
  const workspace = workspaceOf(task.history?.[0] ?? { messageId: "", role: "ROLE_USER", parts: [] });
  return "workspace" in workspace ? workspace.workspace?.repository : undefined;
}

/**
 * Why a chat cannot start with the workspace its first message asks for, if it cannot: a
 * chat's profile holds no repository credential, so only a repository reachable without
 * one, by an `https` or `http` URL that carries no credential itself, can be its workspace.
 */
export function workspaceProblem(message: A2A.Message): string | undefined {
  const rule = "it must be an https or http clone URL without user name or password, e.g. https://github.com/acme/playground.git";
  const requested = workspaceOf(message);
  if ("problem" in requested) return `the repository is malformed (${requested.problem}): ${rule}`;
  if (!requested.workspace) return undefined;
  const { repository } = requested.workspace;
  let url: URL;
  try {
    url = new URL(repository);
  } catch {
    return `repository ${JSON.stringify(repository)} is no URL: ${rule}`;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return `repository ${JSON.stringify(repository)} is no https or http URL: ${rule}`;
  if (url.username !== "" || url.password !== "") return `repository ${url.host}${url.pathname} carries credentials in its URL: ${rule}`;
  if (repository.length > 2048) return `repository is longer than 2048 characters: ${rule}`;
  return undefined;
}

/** A chat was asked to start with a repository it cannot check out. */
export class InvalidRepositoryError extends Error {
  constructor(problem: string) {
    super(problem);
    this.name = "InvalidRepositoryError";
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
