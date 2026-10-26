import type { ControlPlane } from "@tendworks/shared";
import { useCallback } from "react";
import { answer } from "./answers.js";
import { useApi } from "./api.js";
import { Pending } from "./pending.js";
import { Chip, Pill } from "./pill.js";
import { Link } from "./router.js";
import { Time } from "./time.js";
import { usePolling } from "./use-polling.js";

type Agent = ControlPlane.components["schemas"]["AgentList"]["items"][number];
type Session = NonNullable<Agent["sessions"]>[number];

/**
 * The agent profiles (`GET /agents`): harness, sandbox, skills and who works right now,
 * each session linking to its run or chat. Without the agent runtime the sessions are unknown.
 */
export function AgentsPage() {
  const { client } = useApi();
  const agents = usePolling(useCallback(async () => (await answer(client.GET("/agents"))).items, [client]));
  const items = agents.data;
  const sessionsKnown = items?.every((agent) => agent.sessions !== undefined) ?? true;

  return (
    <>
      <h1>Agents</h1>
      {items === undefined ? (
        <Pending error={agents.error} what="agent profiles" />
      ) : items.length === 0 ? (
        <p className="muted">No agent profiles are configured.</p>
      ) : (
        <>
          {!sessionsKnown && <p className="message message-warn">The agent runtime cannot be reached: which agents work right now is unknown.</p>}
          <ul className="cards" aria-label="Agent profiles">
            {items.map((agent) => (
              <li key={agent.name} className="card">
                <div className="card-head">
                  <span className="card-kind">{agent.name}</span>
                  {agent.sessions === undefined ? <Pill tone="warn">sessions unknown</Pill> : agent.sessions.length === 0 ? <Pill tone="neutral">idle</Pill> : <Pill tone="running">{`${agent.sessions.length} active`}</Pill>}
                </div>
                <dl className="facts">
                  <dt>Harness</dt>
                  <dd>{agent.harness}</dd>
                  <dt>Sandbox</dt>
                  <dd>{agent.sandbox ?? <span className="muted">default</span>}</dd>
                  <dt>Skills</dt>
                  <dd className="chips">{agent.skills?.length ? agent.skills.map((skill) => <Chip key={skill}>{skill}</Chip>) : <span className="muted">none</span>}</dd>
                </dl>
                {agent.sessions !== undefined && agent.sessions.length > 0 && (
                  <ul className="sessions" aria-label={`Sessions of ${agent.name}`}>
                    {agent.sessions.map((session) => (
                      <li key={session.taskId}>
                        <SessionLink session={session} /> <span className="muted">{session.status}, started</span> <Time value={session.startedAt} />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function SessionLink({ session }: { session: Session }) {
  if (session.kind === "chat") return <Link to={`/chats/${encodeURIComponent(session.chat)}`}>chat {session.chat}</Link>;
  return (
    <Link to={`/runs/${encodeURIComponent(session.run)}`}>
      run {session.run} step {session.step}
    </Link>
  );
}
