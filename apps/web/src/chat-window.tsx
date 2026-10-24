import type { ControlPlane } from "@tendworks/shared";
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { useApi } from "./api.js";
import { AnswerError, answer } from "./answers.js";
import { Confirmation } from "./confirm.js";
import { formatCost } from "@tendworks/platform";
import { TranscriptOf } from "./live-transcript.js";
import { Time } from "./time.js";
import type { TranscriptEntry } from "./transcript.js";
import { useFollowEnd } from "./use-follow-end.js";
import { usePolling } from "./use-polling.js";
import { useTranscript, type OpenTranscriptStream } from "./use-transcript.js";

type Chat = ControlPlane.components["schemas"]["chat"];

const messageOf = (error: unknown) => (error instanceof AnswerError ? error.reason : error instanceof Error ? error.message : String(error));
/** A touch screen: its keyboard has no Shift for a new line. */
const coarsePointer = () => typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
const isOpen = (chat: Chat) => chat.status === "working" || chat.status === "input-required";

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
 * One chat (ADR 0015, `tend chat attach`): its profile, status and total cost, its history and
 * then the agent's output live, the input while the agent waits for the next message, and
 * ending it after a confirmation. Several windows on one chat behave like several `tend`
 * clients: all state is on the platform. Read-only access shows the chat without actions.
 */
export function ChatWindow({ chatId }: { chatId: string }) {
  const { client } = useApi();
  const { data: chat, error, refresh } = usePolling(useCallback(() => answer(client.GET("/chats/{chatId}", { params: { path: { chatId } } })), [client, chatId]));

  if (!chat) {
    return (
      <>
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
      </>
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
    <>
      <h1>Chat {chat.id}</h1>
      {error !== undefined && <p className="message message-error">{messageOf(error)}</p>}
      <dl className="fields">
        {fields.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <Conversation chat={chat} changed={refresh} />
    </>
  );
}

/** The chat's transcript, live while the chat is open, and what the operator can do in it. */
function Conversation({ chat, changed }: { chat: Chat; changed: () => void }) {
  const { client, canChange } = useApi();
  const chatId = chat.id;
  const read = useCallback(async () => (await answer(client.GET("/chats/{chatId}/transcript", { params: { path: { chatId } } }))).items, [client, chatId]);
  const open = useCallback<OpenTranscriptStream>((header) => client.GET("/chats/{chatId}/transcript/stream", { params: { path: { chatId }, header }, parseAs: "stream" }), [client, chatId]);
  const view = useTranscript({ read, open, live: isOpen(chat), onEnded: changed });
  const turn = turnOf(view.phase === "shown" ? view.entries : []);
  // The page follows the transcript's end while the operator is there; the input stays in view (`chats.css`).
  const toEnd = useFollowEnd(view.phase === "shown" ? view.entries : undefined, view.phase === "shown");

  // A turn that starts or ends changes the chat's status and cost: read it again at once.
  useEffect(() => {
    if (turn.position >= 0) changed();
  }, [turn.state, turn.position, changed]);

  return (
    <section className="chat panel" aria-label="Conversation">
      <TranscriptOf view={view} missing="No transcript was found for this chat." />
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
  const hintId = useId();
  // Touch screens keep Enter for a new line (see the input's key handling) and show no hint.
  const [touch] = useState(coarsePointer);
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
          aria-describedby={waiting && !touch ? hintId : undefined}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends and Shift+Enter is a new line; Ctrl+Enter (Cmd+Enter) sends too. Phone
            // keyboards have no Shift, so on touch screens Enter stays a new line and the button sends.
            // The Enter that ends an input method's composition never sends.
            if (event.key !== "Enter" || event.shiftKey) return;
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (!event.ctrlKey && !event.metaKey && touch) return;
            event.preventDefault();
            void send(event);
          }}
        />
        <div className="chat-buttons">
          <button type="submit" className="primary" disabled={!waiting || text.trim() === ""}>
            Send
          </button>
          {waiting && !touch && (
            <span id={hintId} className="muted chat-hint">
              Enter to send · Shift+Enter for a new line
            </span>
          )}
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
