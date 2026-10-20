import { eventEnvelope } from "@tendworks/platform";
import type { ChatEvents } from "@tendworks/shared";

export type ChatEvent = ChatEvents.ChatStartedEvent | ChatEvents.ChatEndedEvent;

/**
 * Port through which the agent runtime emits lifecycle events of chats. `tx` is the
 * transaction that writes the chat's task, so state and event commit together
 * (ADR 0005). The worker bundle passes the event bus, which has the same shape.
 *
 * @port
 */
export interface ChatEventPublisher<Tx> {
  publish(tx: Tx, event: ChatEvent): Promise<void>;
}

const SOURCE = "/tendworks/agent-runtime";

interface ChatFacts {
  chatId: string;
  agent: string;
  time: string;
  /** The trace the chat started; all its events belong to it. */
  traceparent: string;
}

// A chat belongs to no run: its events name it in `subject` and carry no `runid`.
const envelope = ({ chatId, time, traceparent }: ChatFacts, kind: "started" | "ended") =>
  eventEnvelope({ id: `${chatId}:chat.${kind}`, source: SOURCE, subject: `chats/${chatId}`, time, traceparent });

export function chatStarted(chat: ChatFacts): ChatEvents.ChatStartedEvent {
  return { ...envelope(chat, "started"), type: "dev.tendworks.chat.started", data: { agent: chat.agent } };
}

export function chatEnded(chat: ChatFacts, status: "ended" | "failed"): ChatEvents.ChatEndedEvent {
  return { ...envelope(chat, "ended"), type: "dev.tendworks.chat.ended", data: { agent: chat.agent, status } };
}
