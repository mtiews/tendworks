import { useCallback, useId, useState, type FormEvent } from "react";
import { useApi } from "./api.js";
import { AnswerError, answer } from "./answers.js";
import { Pending } from "./pending.js";
import { useLocation } from "./router.js";
import { usePolling } from "./use-polling.js";

/**
 * Starts a chat (ADR 0015, `tend chat start`): one of the profiles that allow chats (those
 * with `chat` in `GET /agents`), the first message and, optionally, a public repository to
 * check out as the workspace. The platform checks the repository; its reason shows here.
 */
export function NewChat() {
  const { client, canChange } = useApi();
  const { navigate } = useLocation();
  const { data: agents, error } = usePolling(useCallback(() => answer(client.GET("/agents")), [client]));
  const [agent, setAgent] = useState("");
  const [text, setText] = useState("");
  const [repository, setRepository] = useState("");
  const [starting, setStarting] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const ids = { agent: useId(), text: useId(), repository: useId() };

  if (!canChange) {
    return (
      <>
        <h1>New chat</h1>
        <p className="muted">Read-only access cannot start chats.</p>
      </>
    );
  }
  if (!agents) {
    return (
      <>
        <h1>New chat</h1>
        <Pending error={error} what="agent profiles" />
      </>
    );
  }

  const chatProfiles = agents.items.filter((profile) => profile.chat !== undefined).map((profile) => profile.name);
  const chosen = chatProfiles.includes(agent) ? agent : (chatProfiles[0] ?? "");

  const start = async (event: FormEvent) => {
    event.preventDefault();
    setStarting(true);
    setRefusal(undefined);
    const url = repository.trim();
    try {
      const chat = await answer(client.POST("/chats", { body: { agent: chosen, text, ...(url === "" ? {} : { repository: url }) } }));
      navigate(`/chats/${encodeURIComponent(chat.id)}`);
    } catch (failure: unknown) {
      setRefusal(failure instanceof AnswerError ? failure.reason : failure instanceof Error ? failure.message : String(failure));
      setStarting(false);
    }
  };

  return (
    <>
      <h1>New chat</h1>
      {chatProfiles.length === 0 ? (
        <p className="muted">No agent profile allows chats. Give a profile spec.chat to chat with it.</p>
      ) : (
        <form className="panel form" onSubmit={(event) => void start(event)}>
          <div className="field">
            <label htmlFor={ids.agent}>Agent profile</label>
            <select id={ids.agent} value={chosen} onChange={(event) => setAgent(event.target.value)}>
              {chatProfiles.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.text}>Message</label>
            <textarea id={ids.text} rows={4} required value={text} onChange={(event) => setText(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={ids.repository}>Public repository (optional)</label>
            <input
              id={ids.repository}
              type="text"
              inputMode="url"
              placeholder="https://github.com/owner/name.git"
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
            />
            <p className="hint muted">Checked out as the chat&apos;s workspace. The agent can change files there but cannot push.</p>
          </div>
          {refusal !== undefined && (
            <p className="message message-error" role="alert">
              {refusal}
            </p>
          )}
          <div>
            <button type="submit" className="primary" disabled={starting || text.trim() === ""}>
              Start chat
            </button>
          </div>
        </form>
      )}
    </>
  );
}
