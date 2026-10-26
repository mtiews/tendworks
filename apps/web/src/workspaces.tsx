import { useCallback } from "react";
import { answer } from "./answers.js";
import { useApi } from "./api.js";
import { Pending } from "./pending.js";
import { Chip } from "./pill.js";
import { Link } from "./router.js";
import { usePolling } from "./use-polling.js";

/**
 * The workspaces of the configuration (`GET /workspaces`, ADR 0022): kind and assistant. A
 * workspace with an assistant offers a new chat with it, preselected. Read-only access
 * cannot start chats, so it gets no link.
 */
export function WorkspacesPage() {
  const { client, canChange } = useApi();
  const workspaces = usePolling(useCallback(async () => (await answer(client.GET("/workspaces"))).items, [client]));

  return (
    <>
      <h1>Workspaces</h1>
      {workspaces.data === undefined ? (
        <Pending error={workspaces.error} what="workspaces" />
      ) : workspaces.data.length === 0 ? (
        <p className="muted">No workspaces are configured.</p>
      ) : (
        <ul className="cards" aria-label="Workspaces">
          {workspaces.data.map((workspace) => (
            <li key={workspace.name} className="card">
              <div className="card-head">
                <span className="card-kind">{workspace.name}</span>
                <Chip>{workspace.kind}</Chip>
              </div>
              <dl className="facts">
                <dt>Assistant</dt>
                <dd>{workspace.assistant ? `${workspace.assistant.profile} (${workspace.assistant.write ? "may write" : "read-only"})` : <span className="muted">none</span>}</dd>
              </dl>
              {workspace.assistant && canChange && (
                <Link to={`/chats/new?workspace=${encodeURIComponent(workspace.name)}`} className="button" label={`Chat with the assistant of ${workspace.name}`}>
                  Chat
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
