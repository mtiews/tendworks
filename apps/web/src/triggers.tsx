import { formatSchedule } from "@tendworks/platform";
import type { ControlPlane } from "@tendworks/shared";
import { useCallback } from "react";
import { answer } from "./answers.js";
import { useApi } from "./api.js";
import { Pending } from "./pending.js";
import { Time } from "./time.js";
import { checksAround, type Checks } from "./trigger-checks.js";
import { usePolling } from "./use-polling.js";

type Trigger = ControlPlane.components["schemas"]["triggerList"]["items"][number];

/**
 * The trigger bindings (`GET /triggers`, ADR 0023): source, workflow, workspaces, schedule,
 * next and last check. A table on a desktop, with a timeline of the checks of the last and
 * next 12 hours; cards on a phone. Read-only: the API offers no suspend or resume.
 */
export function TriggersPage({ phone }: { phone: boolean }) {
  const { client } = useApi();
  const triggers = usePolling(useCallback(async () => ({ items: (await answer(client.GET("/triggers"))).items, readAt: Date.now() }), [client]));

  return (
    <>
      <h1>Triggers</h1>
      {triggers.data === undefined ? (
        <Pending error={triggers.error} what="trigger bindings" />
      ) : triggers.data.items.length === 0 ? (
        <p className="muted">No trigger bindings are configured.</p>
      ) : phone ? (
        <ul className="cards" aria-label="Trigger bindings">
          {triggers.data.items.map((trigger) => (
            <li key={trigger.name} className="card">
              <div className="card-head">
                <span className="card-kind">{trigger.name}</span>
                <span>{trigger.suspended ? "suspended" : <>next <Time value={trigger.nextExecutionAt} /></>}</span>
              </div>
              <dl className="facts">
                <dt>Source</dt>
                <dd>{trigger.kind}</dd>
                <dt>Workflow</dt>
                <dd>{trigger.workflow}</dd>
                <dt>Workspaces</dt>
                <dd>{trigger.workspaces.join(", ") || <span className="muted">none</span>}</dd>
                <dt>Schedule</dt>
                <dd>{formatSchedule(trigger.schedule)}</dd>
                <dt>Last check</dt>
                <dd>
                  <Evaluation evaluation={trigger.lastEvaluation} />
                </dd>
              </dl>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <table aria-label="Trigger bindings">
            <thead>
              <tr>
                <th>Name</th>
                <th>Source</th>
                <th>Workflow</th>
                <th>Workspaces</th>
                <th>Schedule</th>
                <th>Next check</th>
                <th>Last check</th>
              </tr>
            </thead>
            <tbody>
              {triggers.data.items.map((trigger) => (
                <tr key={trigger.name}>
                  <td>{trigger.name}</td>
                  <td>{trigger.kind}</td>
                  <td>{trigger.workflow}</td>
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
          <Timeline triggers={triggers.data.items} now={triggers.data.readAt} />
        </>
      )}
    </>
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
      succeeded <Time value={evaluation.at} />, {evaluation.startedRuns} {evaluation.startedRuns === 1 ? "run" : "runs"} started
    </>
  );
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The checks of the last and next 12 hours, one track per binding; the marks are decoration, the text says the numbers. */
function Timeline({ triggers, now }: { triggers: readonly Trigger[]; now: number }) {
  return (
    <section aria-labelledby="trigger-timeline" className="section">
      <h2 id="trigger-timeline">Checks in the last and next 12 hours</h2>
      <ul className="timeline" aria-label="Trigger checks">
        {triggers.map((trigger) => {
          const checks = checksAround(trigger, now);
          return (
            <li key={trigger.name} className={`timeline-row${trigger.suspended ? " timeline-off" : ""}`}>
              <span className="timeline-name">{trigger.name}</span>
              <Track checks={checks} />
              <span className="visually-hidden">{describe(trigger, checks)}</span>
            </li>
          );
        })}
      </ul>
      <p className="timeline-axis muted" aria-hidden="true">
        <span>−12 h</span>
        <span>now</span>
        <span>+12 h</span>
      </p>
      <p className="muted">Earlier checks of a schedule by interval are projected from its next check; a cron schedule shows only its next and last check.</p>
    </section>
  );
}

const describe = (trigger: Trigger, { past, future, dense }: Checks) =>
  trigger.suspended ? "suspended, no checks" : dense ? `checks continuously (${formatSchedule(trigger.schedule)})` : `${count(past.length, "check")} in the last 12 hours, ${count(future.length, "check")} in the next 12 hours`;

function Track({ checks }: { checks: Checks }) {
  // Drawn as SVG so the positions are attributes: the CSP allows no inline styles (ADR 0018).
  return (
    <svg className="timeline-track" viewBox="0 0 100 18" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      {checks.dense ? (
        <rect className="timeline-band" x="0" y="6" width="100" height="6" />
      ) : (
        [...checks.past, ...checks.future].map((at) => <line key={at} className="timeline-mark" x1={at * 100} x2={at * 100} y1="3" y2="15" vectorEffect="non-scaling-stroke" />)
      )}
      <line className="timeline-now" x1="50" x2="50" y1="0" y2="18" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
