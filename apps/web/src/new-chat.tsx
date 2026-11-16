import { useCallback, useId, useState, type FormEvent } from "react";
import { useApi } from "./api.js";
import { AnswerError, answer } from "./answers.js";
import { useEnterToSend } from "./enter-to-send.js";
import { Pending } from "./pending.js";
import { useLocation } from "./router.js";
import { usePolling } from "./use-polling.js";

/** The profile chosen unless the operator picks another: the platform assistant. */
export const PLATFORM_ASSISTANT = "assistant";

/** Whom a new chat is with: a profile (`agent`) or a workspace's assistant (`workspace`), as `POST /chats` takes it. */
type ChatWith = { agent: string } | { workspace: string };

/**
 * Which branch the operator may choose for a chat (spec #146): a writing assistant its own
 * `tendworks/chat-<chat id>` or a name under one of the workspace's `branchPrefixes`, a
 * read-only one any branch the repository has. Absent for a profile, a directory workspace and
 * a writing assistant without prefixes, which has nothing to choose.
 */
type BranchChoice = { write: true; prefixes: string[] } | { write: false };

interface Choice {
  value: string;
  label: string;
  chatWith: ChatWith;
  branch?: BranchChoice;
}

/**
 * Starts a chat (ADR 0015, `tend chat`): with one of the profiles that allow chats (those
 * with `chat` in `GET /agents`), e.g. the platform assistant, or with the assistant of a
 * workspace that has one (`GET /workspaces`, ADR 0022), and the first message. A profile
 * that serves as a workspace's assistant is offered only through its workspaces (except
 * the platform assistant), so the operator picks the project; `tend chat <profile>` still
 * starts it in an empty workspace. A git workspace's assistant also takes a branch (spec #146): a
 * writing one a prefix and a name, a read-only one any branch. The platform decides; its
 * reason for a refusal shows here.
 */
export function NewChat() {
  const { client, canChange } = useApi();
  const { navigate } = useLocation();
  const { data: choices, error } = usePolling(
    useCallback(async () => {
      const [agents, workspaces] = await Promise.all([answer(client.GET("/agents")), answer(client.GET("/workspaces"))]);
      // A workspace assistant's profile is offered through its workspace, not on its own.
      const assistantProfiles = new Set(workspaces.items.flatMap(({ assistant }) => (assistant ? [assistant.profile] : [])));
      const profiles = agents.items
        .filter((profile) => profile.chat !== undefined && (profile.name === PLATFORM_ASSISTANT || !assistantProfiles.has(profile.name)))
        .map(({ name }): Choice => ({ value: `agent:${name}`, label: name, chatWith: { agent: name } }));
      const assistants = workspaces.items.flatMap(({ name, kind, assistant }): Choice[] =>
        assistant
          ? [
              {
                value: `workspace:${name}`,
                label: `Workspace ${name} (${assistant.write ? "may write" : "read-only"})`,
                chatWith: { workspace: name },
                ...(kind === "git" && !(assistant.write && assistant.branchPrefixes.length === 0)
                  ? { branch: assistant.write ? { write: true, prefixes: assistant.branchPrefixes } : { write: false } }
                  : {}),
              },
            ]
          : [],
      );
      return [...profiles, ...assistants];
    }, [client]),
  );
  // A workspace suggested by the link that opened the form (the workspaces page).
  const [picked, setPicked] = useState(() => {
    const workspace = new URLSearchParams(window.location.search).get("workspace");
    return workspace === null ? "" : `workspace:${workspace}`;
  });
  // The branch as chosen: a writing chat's prefix ("" for its own branch) and name, a read-only chat's branch.
  const [prefix, setPrefix] = useState("");
  const [branchName, setBranchName] = useState("");
  const [text, setText] = useState("");
  const [starting, setStarting] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const ids = { chatWith: useId(), branch: useId(), text: useId() };

  const chosen =
    choices?.find((choice) => choice.value === picked) ?? choices?.find((choice) => choice.value === `agent:${PLATFORM_ASSISTANT}`) ?? choices?.[0];

  // A prefix the chosen workspace does not list (any longer) counts as none.
  const chosenPrefix = chosen?.branch?.write && chosen.branch.prefixes.includes(prefix) ? prefix : "";
  const branch = !chosen?.branch ? undefined : chosen.branch.write ? (chosenPrefix === "" ? undefined : chosenPrefix + branchName.trim()) : branchName.trim() || undefined;
  const missingName = chosenPrefix !== "" && branchName.trim() === "";

  const choose = (value: string) => {
    setPicked(value);
    setPrefix("");
    setBranchName("");
  };

  const start = async (event: FormEvent) => {
    event.preventDefault();
    // The same rules as the button, which Enter shares.
    if (!chosen || starting || text.trim() === "" || missingName) return;
    setStarting(true);
    setRefusal(undefined);
    try {
      const chat = await answer(client.POST("/chats", { body: { ...chosen.chatWith, ...(branch === undefined ? {} : { branch }), text } }));
      navigate(`/chats/${encodeURIComponent(chat.id)}`);
    } catch (failure: unknown) {
      setRefusal(failure instanceof AnswerError ? failure.reason : failure instanceof Error ? failure.message : String(failure));
      setStarting(false);
    }
  };
  const enterToSend = useEnterToSend((event) => void start(event), true);

  if (!canChange) {
    return (
      <>
        <h1>New chat</h1>
        <p className="muted">Read-only access cannot start chats.</p>
      </>
    );
  }
  if (!choices) {
    return (
      <>
        <h1>New chat</h1>
        <Pending error={error} what="agent profiles and workspaces" />
      </>
    );
  }

  return (
    <>
      <h1>New chat</h1>
      {!chosen ? (
        <p className="muted">No agent profile allows chats and no workspace has an assistant. Give a profile spec.chat or a workspace spec.assistant to chat.</p>
      ) : (
        <form className="panel form" onSubmit={(event) => void start(event)}>
          <div className="field">
            <label htmlFor={ids.chatWith}>Chat with</label>
            <select id={ids.chatWith} value={chosen.value} onChange={(event) => choose(event.target.value)}>
              {choices.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <p className="hint muted">A workspace&apos;s assistant talks about that workspace&apos;s contents; read-only unless the workspace allows writing.</p>
          </div>
          {chosen.branch?.write === true && (
            <div className="field">
              <label htmlFor={ids.branch}>Branch</label>
              <div className="branch-choice">
                <select id={ids.branch} value={chosenPrefix} onChange={(event) => setPrefix(event.target.value)}>
                  <option value="">tendworks/chat-&lt;chat id&gt; (default)</option>
                  {chosen.branch.prefixes.map((listed) => (
                    <option key={listed} value={listed}>
                      {listed}…
                    </option>
                  ))}
                </select>
                {chosenPrefix !== "" && (
                  <input type="text" aria-label="Branch name" required value={branchName} onChange={(event) => setBranchName(event.target.value)} />
                )}
              </div>
              <p className="hint muted">A branch the repository has is continued, a new one starts from the default branch.</p>
            </div>
          )}
          {chosen.branch?.write === false && (
            <div className="field">
              <label htmlFor={ids.branch}>Branch</label>
              <input id={ids.branch} type="text" value={branchName} onChange={(event) => setBranchName(event.target.value)} />
              <p className="hint muted">Any branch the repository has; empty for its default branch.</p>
            </div>
          )}
          <div className="field">
            <label htmlFor={ids.text}>Message</label>
            <textarea id={ids.text} rows={4} required value={text} {...enterToSend.inputProps} onChange={(event) => setText(event.target.value)} />
          </div>
          {refusal !== undefined && (
            <p className="message message-error" role="alert">
              {refusal}
            </p>
          )}
          <div className="chat-buttons">
            <button type="submit" className="primary" disabled={starting || text.trim() === "" || missingName}>
              Start chat
            </button>
            {enterToSend.hint}
          </div>
        </form>
      )}
    </>
  );
}
