import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useApi } from "./api.js";
import { AnswerError, answer } from "./answers.js";
import { chatTitle, isOpen, type Chat } from "./chat-summary.js";
import { Confirmation } from "./confirm.js";
import { useEnterToSend } from "./enter-to-send.js";
import { formatCost } from "@tendworks/platform";
import { TranscriptOf } from "./live-transcript.js";
import { Time } from "./time.js";
import type { TranscriptEntry } from "./transcript.js";
import { useFollowEnd } from "./use-follow-end.js";
import { usePolling } from "./use-polling.js";
import { useTranscript, type OpenTranscriptStream } from "./use-transcript.js";

const messageOf = (error: unknown) => (error instanceof AnswerError ? error.reason : error instanceof Error ? error.message : String(error));

/**
 * Where a chat's turn stands by its transcript, which arrives live while the polled chat
 * lags: the last entry that starts a turn (`task-started`, `message-received`, a resume),
 * ends one (`input-required`) or ends the chat (`task-ended`) decides.
 */
export type Turn = { state: "working" | "waiting" | "ended"; position: number };

export function turnOf(entries: readonly TranscriptEntry[]): Turn {
  for (let index = entries.length - 1; index >= 0; index--) {
    const { type, position } = entries[index]!;
    if (type === "input-required") return { state: "waiting", position };
    if (type === "task-ended") return { state: "ended", position };
    if (type === "task-started" || type === "task-resumed" || type === "message-received") return { state: "working", position };
  }
  return { state: "working", position: -1 };
}

/**
 * One chat in the workbench (ADR 0015, `tend chat attach`): named by its first message, with
 * its profile, status and total cost, its history and then the agent's output live, the input while the agent waits for the next message, and
 * ending it after a confirmation. Several windows on one chat behave like several `tend`
 * clients: all state is on the platform. Read-only access shows the chat without actions. On a
 * desktop the transcript scrolls above the input; on a phone the page scrolls and the input
 * stays at the bottom of the screen.
 */
export function ChatWindow({ chatId, phone }: { chatId: string; phone: boolean }) {
  const { client } = useApi();
  const { data: chat, error, refresh } = usePolling(useCallback(() => answer(client.GET("/chats/{chatId}", { params: { path: { chatId } } })), [client, chatId]));

  if (!chat) {
    return (
      <article className="chat-detail">
        <h1>Chat {chatId}</h1>
        {error instanceof AnswerError && error.status === 404 ? (
          <p className="muted">There is no chat {chatId}.</p>
        ) : error !== undefined ? (
          <p className="message message-error" role="alert">
            {messageOf(error)}
          </p>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </article>
    );
  }

  const fields: [string, ReactNode][] = [
    ["Agent", chat.agent],
    ["Status", <span className={`status status-${chat.status}`}>{chat.status}</span>],
    ...(chat.workspace ? [["Workspace", `${chat.workspace} (${chat.write ? "may write" : "read-only"})`] as [string, ReactNode]] : []),
    ["Started", <Time value={chat.startedAt} />],
    ["Last activity", <Time value={chat.lastActivityAt} />],
    ...(chat.endedAt ? [["Ended", <Time value={chat.endedAt} />] as [string, ReactNode]] : []),
    ["Cost", chat.cost ? formatCost(chat.cost) : ""],
  ];

  return (
    <article className="chat-detail">
      <header className="chat-head">
        <h1>{chatTitle(chat)}</h1>
        <span className={`status status-${chat.status}`}>{chat.status}</span>
      </header>
      {error !== undefined && <p className="message message-error">{messageOf(error)}</p>}
      <dl className="fields">
        {fields.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <Conversation chat={chat} changed={refresh} phone={phone} />
    </article>
  );
}

/** The chat's transcript, live while the chat is open, and what the operator can do in it. */
function Conversation({ chat, changed, phone }: { chat: Chat; changed: () => void; phone: boolean }) {
  const { client, canChange } = useApi();
  const chatId = chat.id;
  const read = useCallback(async () => (await answer(client.GET("/chats/{chatId}/transcript", { params: { path: { chatId } } }))).items, [client, chatId]);
  const open = useCallback<OpenTranscriptStream>((header) => client.GET("/chats/{chatId}/transcript/stream", { params: { path: { chatId }, header }, parseAs: "stream" }), [client, chatId]);
  const view = useTranscript({ read, open, live: isOpen(chat), onEnded: changed });
  const turn = turnOf(view.phase === "shown" ? view.entries : []);
  // The transcript (the page on a phone) follows its end while the operator is there; the input stays in view (`chats.css`).
  const scroller = useRef<HTMLDivElement>(null);
  const toEnd = useFollowEnd(view.phase === "shown" ? view.entries : undefined, view.phase === "shown", phone ? undefined : scroller);

  // A turn that starts or ends changes the chat's status and cost: read it again at once.
  useEffect(() => {
    if (turn.position >= 0) changed();
  }, [turn.state, turn.position, changed]);

  return (
    <section className="chat panel" aria-label="Conversation">
      <div className="chat-scroll" ref={scroller}>
        <TranscriptOf view={view} missing="No transcript was found for this chat." />
      </div>
      {/* The transcript may show the end before the chat is read again: the input goes at once. */}
      {!isOpen(chat) || turn.state === "ended" ? (
        <p className="muted">This chat has ended.</p>
      ) : !canChange ? (
        <p className="muted">Read-only access: you can follow this chat but not write to it.</p>
      ) : (
        <ChatActions chatId={chatId} turn={turn} following={view.phase === "shown"} changed={changed} sent={toEnd} />
      )}
    </section>
  );
}

/** The next message while the agent waits, cancelling the turn while it works, and ending the chat. */
function ChatActions({ chatId, turn, following, changed, sent }: { chatId: string; turn: Turn; following: boolean; changed: () => void; sent: () => void }) {
  const { client } = useApi();
  const inputId = useId();
  const [text, setText] = useState("");
  // The turn position when the last message went out: until the transcript moves past it,
  // the agent is taken to work on it, so the input does not reopen in between.
  const [sentAfter, setSentAfter] = useState<number>();
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [ending, setEnding] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [failure, setFailure] = useState<string>();

  const waiting = following && turn.state === "waiting" && (sentAfter === undefined || turn.position > sentAfter) && !sending;

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!waiting || text.trim() === "") return;
    setSending(true);
    setFailure(undefined);
    setSentAfter(turn.position);
    sent();
    try {
      await answer(client.POST("/chats/{chatId}/messages", { params: { path: { chatId } }, body: { text } }));
      setText("");
    } catch (error: unknown) {
      setSentAfter(undefined);
      setFailure(messageOf(error));
    } finally {
      setSending(false);
      changed();
    }
  };
  // Enter sends under the same rules as Send; the hint shows while the agent waits.
  const enterToSend = useEnterToSend((event) => void send(event), waiting);

  // The agent stops the turn and waits for the next message; the transcript says so.
  const cancel = async () => {
    setCancelling(true);
    setFailure(undefined);
    try {
      await answer(client.POST("/chats/{chatId}/cancel", { params: { path: { chatId } } }));
    } catch (error: unknown) {
      setFailure(messageOf(error));
    } finally {
      setCancelling(false);
      changed();
    }
  };

  const end = async () => {
    setEnding(true);
    setFailure(undefined);
    try {
      await answer(client.POST("/chats/{chatId}/end", { params: { path: { chatId } } }));
    } catch (error: unknown) {
      setFailure(messageOf(error));
    } finally {
      setEnding(false);
      setConfirming(false);
      changed();
    }
  };

  return (
    <div className="chat-actions">
      {failure !== undefined && (
        <p className="message message-error" role="alert">
          {failure}
        </p>
      )}
      <form className="chat-input" onSubmit={(event) => void send(event)}>
        <label htmlFor={inputId}>Message</label>
        <textarea
          id={inputId}
          rows={3}
          value={text}
          disabled={!waiting}
          {...enterToSend.inputProps}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="chat-buttons">
          <button type="submit" className="primary" disabled={!waiting || text.trim() === ""}>
            Send
          </button>
          {enterToSend.hint}
          {!waiting && following && (
            <button type="button" disabled={cancelling} onClick={() => void cancel()}>
              Cancel turn
            </button>
          )}
          {!waiting && <span className="muted">{following ? "The agent is working…" : "Reading the chat…"}</span>}
          <button type="button" className="chat-end" disabled={confirming} onClick={() => setConfirming(true)}>
            End chat
          </button>
        </div>
      </form>
      {confirming && (
        <Confirmation title="End this chat?" confirmLabel="End chat" busy={ending} onConfirm={() => void end()} onCancel={() => setConfirming(false)}>
          <p>The agent stops and its sandbox and volumes are removed; the transcript stays.</p>
        </Confirmation>
      )}
    </div>
  );
}
