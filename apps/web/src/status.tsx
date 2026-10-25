import { formatSchedule } from "@tendworks/platform";
import type { ControlPlane } from "@tendworks/shared";
import { useCallback, useId, type ReactNode } from "react";
import { answer, UNREACHABLE } from "./answers.js";
import { useApi } from "./api.js";
import { Pending } from "./pending.js";
import { Link } from "./router.js";
import { Time } from "./time.js";
import { usePolling } from "./use-polling.js";

type PlatformStatus = ControlPlane.components["schemas"]["PlatformStatus"];

/** The platform at a glance (spec #38): health, what is running, what waits for the operator. */
export function StatusPage() {
  const { client } = useApi();

  const status = usePolling(
    useCallback(
      (): Promise<PlatformStatus> =>
        // 503 carries the same status document as 200: an unhealthy platform is an answer, not a failure.
        answer<PlatformStatus>(client.GET("/status").then((result) => (result.error !== undefined && result.response.status === 503 ? { data: result.error, response: result.response } : result))),
      [client],
    ),
  );

  // Both numbers come from the status report, as `tend status` shows them.
  const report = status.data;
  const active = report?.activeRuns;
  const pending = report?.pendingApprovals;

  return (
    <>
      <h1>Status</h1>
      <Section title="Overview">
        <ul className="overview">
          <li>
            {report === undefined ? (
              "Active runs …"
            ) : active === undefined ? (
              "Active runs unknown: runs cannot be read."
            ) : (
              <Link to="/runs">{count(active, "active run")}</Link>
            )}
          </li>
          <li>
            {report === undefined ? (
              "Pending approval requests …"
            ) : pending === undefined ? (
              "Pending approval requests unknown: approval requests cannot be read."
            ) : (
              <Link to="/runs">{count(pending, "pending approval request")}</Link>
            )}
          </li>
        </ul>
      </Section>
      <Section title="Health">
        {report === undefined ? (
          status.error === undefined ? (
            <p className="muted">Loading…</p>
          ) : (
            <p className="message message-error" role="alert">
              {UNREACHABLE}
            </p>
          )
        ) : (
          <>
            <p>
              <span className={`state state-${report.status}`}>{report.status === "healthy" ? "Healthy" : "Unhealthy"}</span>{" "}
              <span className="muted">
                checked <Time value={report.checkedAt} />
              </span>
            </p>
            <table>
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Status</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {report.components.map((component) => (
                  <tr key={component.name}>
                    <td>{component.name}</td>
                    <td className={`state-${component.status}`}>{component.status}</td>
                    <td>{component.message ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Section>
      <Agents />
      <Triggers />
    </>
  );
}

type Trigger = ControlPlane.components["schemas"]["triggerList"]["items"][number];

/** Each trigger binding: when it next checks its source, and how the last check went. */
function Triggers() {
  const { client } = useApi();
  const triggers = usePolling(
    useCallback(async () => (await answer(client.GET("/triggers"))).items, [client]),
  );

  return (
    <Section title="Triggers">
      {triggers.data === undefined ? (
        <Pending error={triggers.error} what="trigger bindings" />
      ) : triggers.data.length === 0 ? (
        <p className="muted">No trigger bindings are configured.</p>
      ) : (
        <table aria-label="Trigger bindings">
          <thead>
            <tr>
              <th>Name</th>
              <th>Workflow</th>
              <th>Trigger</th>
              <th>Workspaces</th>
              <th>Schedule</th>
              <th>Next check</th>
              <th>Last check</th>
            </tr>
          </thead>
          <tbody>
            {triggers.data.map((trigger) => (
              <tr key={trigger.name}>
                <td>{trigger.name}</td>
                <td>{trigger.workflow}</td>
                <td>{trigger.kind}</td>
                <td>{trigger.workspaces.join(", ") || <span className="muted">none</span>}</td>
                <td>{formatSchedule(trigger.schedule)}</td>
                <td>{trigger.suspended ? <span className="muted">suspended</span> : <Time value={trigger.nextExecutionAt} />}</td>
                <td>
                  <Evaluation evaluation={trigger.lastEvaluation} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

/** `failed <at>: <why>` or `succeeded <at>, <n> runs started`, as `tend trigger list` says it. */
function Evaluation({ evaluation }: { evaluation: Trigger["lastEvaluation"] }) {
  if (!evaluation) return <span className="muted">not checked yet</span>;
  if (evaluation.status === "failed") {
    return (
      <span className="state-unhealthy">
        failed <Time value={evaluation.at} />
        {evaluation.message ? `: ${evaluation.message}` : ""}
      </span>
    );
  }
  return (
    <>
      succeeded <Time value={evaluation.at} />, {count(evaluation.startedRuns, "run")} started
    </>
  );
}

type Agent = ControlPlane.components["schemas"]["AgentList"]["items"][number];
type Session = NonNullable<Agent["sessions"]>[number];

/** Each agent profile and who works right now; without the agent runtime, sessions are unknown. */
function Agents() {
  const { client } = useApi();
  const agents = usePolling(
    useCallback(async () => (await answer(client.GET("/agents"))).items, [client]),
  );

  const items = agents.data;
  const sessionsKnown = items?.every((agent) => agent.sessions !== undefined) ?? false;
  const sessions = items?.flatMap((agent) => agent.sessions ?? []) ?? [];

  return (
    <Section title="Agents">
      {items === undefined ? (
        <Pending error={agents.error} what="agent profiles" />
      ) : (
        <>
          <table aria-label="Agent profiles">
            <thead>
              <tr>
                <th>Name</th>
                <th>Harness</th>
                <th>Sandbox</th>
                <th>Skills</th>
                <th>Sessions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((agent) => (
                <tr key={agent.name}>
                  <td>{agent.name}</td>
                  <td>{agent.harness}</td>
                  <td>{agent.sandbox ?? ""}</td>
                  <td>{(agent.skills ?? []).join(", ")}</td>
                  <td>{agent.sessions ? agent.sessions.length : <span className="muted">unknown</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!sessionsKnown ? (
            <p className="message message-warn">The agent runtime cannot be reached: which agents work right now is unknown.</p>
          ) : sessions.length > 0 ? (
            <table aria-label="Active agent sessions">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Session</th>
                  <th>Status</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.taskId}>
                    <td>{session.agent}</td>
                    <td>
                      <SessionLink session={session} />
                    </td>
                    <td>{session.status}</td>
                    <td>
                      <Time value={session.startedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No agent works right now.</p>
          )}
        </>
      )}
    </Section>
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="section">
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
