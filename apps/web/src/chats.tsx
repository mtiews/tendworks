import { formatCost } from "@tendworks/platform";
import { useCallback, useEffect, useId, useState } from "react";
import { useApi } from "./api.js";
import { answer } from "./answers.js";
import { Age } from "./approvals.js";
import { ChatWindow } from "./chat-window.js";
import { chatTitle, defaultChat, groupChats, matchesChatFilter, type Chat } from "./chat-summary.js";
import { NewChat } from "./new-chat.js";
import { Pending } from "./pending.js";
import { Link, useLocation } from "./router.js";
import { usePolling } from "./use-polling.js";

/**
 * The workbench for chats (spec #101, ADR 0027), laid out like the one for runs: the chat
 * list next to the selected chat on a desktop; on a phone the list (`/chats`) and the chat
 * (`/chats/:chatId`) or the new chat form one after another. A desktop opened without a chat
 * selects the one the operator most likely wants.
 */
export function ChatWorkbench({ chatId, creating = false, phone }: { chatId?: string | undefined; creating?: boolean; phone: boolean }) {
  const chats = useChatList();
  const { navigate } = useLocation();
  const open = chatId !== undefined || creating;
  const preselect = !open && !phone ? chats.data && defaultChat(chats.data.items) : undefined;

  useEffect(() => {
    if (preselect) navigate(`/chats/${encodeURIComponent(preselect.id)}`, { replace: true });
  }, [preselect, navigate]);

  if (phone) {
    if (creating) return <NewChat />;
    return chatId === undefined ? <ChatList chats={chats} level={1} /> : <ChatWindow key={chatId} chatId={chatId} phone />;
  }
  return (
    <div className="workbench">
      <ChatList chats={chats} selected={chatId} level={2} />
      <div className="workbench-detail workbench-detail-chat">
        {creating ? <NewChat /> : chatId !== undefined ? <ChatWindow key={chatId} chatId={chatId} phone={false} /> : chats.data?.items.length === 0 && <p className="muted">Start a chat to talk to an agent.</p>}
      </div>
    </div>
  );
}

interface ChatListData {
  items: Chat[];
  readAt: number;
}

/** Open and ended chats, the most recently started first (`tend chat list`), refreshed by polling. */
function useChatList() {
  const { client } = useApi();
  return usePolling(useCallback(async (): Promise<ChatListData> => ({ items: (await answer(client.GET("/chats"))).items, readAt: Date.now() }), [client]));
}

/** The chat list; its heading is the page heading on a phone, below the chat's on a desktop. */
function ChatList({ chats, selected, level }: { chats: ReturnType<typeof useChatList>; selected?: string | undefined; level: 1 | 2 }) {
  const { canChange } = useApi();
  const Heading = level === 1 ? "h1" : "h2";
  const [filter, setFilter] = useState("");
  const filterId = useId();
  const { data, error } = chats;
  const shown = data?.items.filter((chat) => matchesChatFilter(chat, filter)) ?? [];
  const groups = data ? groupChats(shown) : undefined;

  return (
    <section className="workbench-list" aria-labelledby={`${filterId}-heading`}>
      <Heading id={`${filterId}-heading`}>Chats</Heading>
      {canChange && (
        <Link to="/chats/new" className="button primary list-action">
          New chat
        </Link>
      )}
      <label className="filter" htmlFor={filterId}>
        <span className="visually-hidden">Filter chats</span>
        <input id={filterId} type="search" placeholder="Filter by title, agent, workspace…" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </label>
      {data === undefined && <Pending error={error} what="chats" />}
      {data !== undefined && error instanceof Error && (
        <p className="message message-error" role="alert">
          {error.message}
        </p>
      )}
      {data && data.items.length === 0 && <p className="muted">No chats yet.</p>}
      {data && data.items.length > 0 && shown.length === 0 && <p className="muted">No chat matches “{filter}”.</p>}
      {groups && data && (
        <>
          <ChatGroup level={level} title="Open" chats={groups.open} readAt={data.readAt} selected={selected} />
          <ChatGroup level={level} title="Ended" chats={groups.ended} readAt={data.readAt} selected={selected} />
        </>
      )}
    </section>
  );
}

function ChatGroup({ level, title, chats, readAt, selected }: { level: 1 | 2; title: string; chats: Chat[]; readAt: number; selected?: string | undefined }) {
  const headingId = useId();
  const Heading = level === 1 ? "h2" : "h3";
  if (chats.length === 0) return null;
  return (
    <section aria-labelledby={headingId}>
      <Heading id={headingId} className="group-heading">
        {title}
      </Heading>
      <ul className="item-list" aria-labelledby={headingId}>
        {chats.map((chat) => (
          <li key={chat.id}>
            <ChatItem chat={chat} readAt={readAt} selected={chat.id === selected} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ChatItem({ chat, readAt, selected }: { chat: Chat; readAt: number; selected: boolean }) {
  // At work, failed, else calm.
  const state = chat.status === "working" ? "running" : chat.status === "failed" ? "failed" : "idle";
  const sub = [chat.agent, chat.workspace, chat.status === "failed" ? "failed" : undefined, chat.cost && formatCost(chat.cost)].filter(Boolean).join(" · ");
  return (
    <Link to={`/chats/${encodeURIComponent(chat.id)}`} current={selected} className={`item item-${state}`}>
      <span className={`dot dot-${state}`} aria-hidden="true" />
      <span className="item-title">{chatTitle(chat)}</span>
      <span className="item-age">
        <Age value={chat.startedAt} now={readAt} />
      </span>
      <span className="item-sub">{sub}</span>
    </Link>
  );
}
