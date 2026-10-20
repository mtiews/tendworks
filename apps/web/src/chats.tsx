import { useCallback } from "react";
import { useApi } from "./api.js";
import { answer } from "./answers.js";
import { formatCost } from "./format.js";
import { Link } from "./router.js";
import { Time } from "./time.js";
import { usePolling } from "./use-polling.js";

/** Open and ended chats, the most recently started first, refreshed by polling (`tend chat list`). */
export function ChatList() {
  const { client, scope } = useApi();
  const { data, error } = usePolling(useCallback(() => answer(client.GET("/chats")), [client]));

  return (
    <>
      <div className="page-head">
        <h1>Chats</h1>
        {scope === "full" && (
          <Link to="/chats/new" className="button primary">
            New chat
          </Link>
        )}
      </div>
      {data === undefined && error === undefined && <p className="muted">Loading…</p>}
      {error instanceof Error && (
        <p className="message message-error" role="alert">
          {error.message}
        </p>
      )}
      {data && data.items.length === 0 && <p className="muted">No chats yet.</p>}
      {data && data.items.length > 0 && (
        <table aria-label="Chats">
          <thead>
            <tr>
              <th>Chat</th>
              <th>Agent</th>
              <th>Status</th>
              <th>Started</th>
              <th>Last activity</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((chat) => (
              <tr key={chat.id}>
                <td>
                  <Link to={`/chats/${encodeURIComponent(chat.id)}`}>{chat.id}</Link>
                </td>
                <td>{chat.agent}</td>
                <td>
                  <span className={`status status-${chat.status}`}>{chat.status}</span>
                </td>
                <td>
                  <Time value={chat.startedAt} />
                </td>
                <td>
                  <Time value={chat.lastActivityAt} />
                </td>
                <td>{chat.cost ? formatCost(chat.cost) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
