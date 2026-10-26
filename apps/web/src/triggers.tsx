import { formatSchedule } from "@tendworks/platform";
import type { ControlPlane } from "@tendworks/shared";
import { useCallback } from "react";
import { answer } from "./answers.js";
import { useApi } from "./api.js";
import { Pending } from "./pending.js";
import { Panel } from "./panel.js";
import { Chip, Pill } from "./pill.js";
import { Age, In } from "./time.js";
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
  const items = triggers.data?.items ?? [];
  const suspended = items.filter((trigger) => trigger.suspended).length;
  const readAt = triggers.data?.readAt ?? 0;
  const counts = `${items.length - suspended} active · ${suspended} suspended`;

  return (
    <>
      <h1>Triggers</h1>
      {triggers.data === undefined ? (
        <Pending error={triggers.error} what="trigger bindings" />
      ) : triggers.data.items.length === 0 ? (
        <p className="muted">No trigger bindings are configured.</p>
      ) : phone ? (
        <Panel title="Bindings" aside={counts}>
        <ul className="rows" aria-label="Trigger bindings">
          {triggers.data.items.map((trigger) => (
            <li key={trigger.name} className="binding">
              <div className="card-head">
                <span className="card-kind">{trigger.name}</span>
                {trigger.suspended ? <Pill tone="neutral">suspended</Pill> : <span>next <In value={trigger.nextExecutionAt} now={readAt} /></span>}
              </div>
              <dl className="facts">
                <dt>Source</dt>
                <dd>
                  <Chip>{trigger.kind}</Chip>
                </dd>
                <dt>Workflow</dt>
                <dd>{trigger.workflow}</dd>
                <dt>Workspaces</dt>
                <dd>{trigger.workspaces.join(", ") || <span className="muted">none</span>}</dd>
                <dt>Schedule</dt>
                <dd>{formatSchedule(trigger.schedule)}</dd>
                <dt>Last check</dt>
                <dd>
                  <Evaluation evaluation={trigger.lastEvaluation} now={readAt} />
                </dd>
              </dl>
            </li>
          ))}
        </ul>
        </Panel>
      ) : (
        <>
          <Panel title="Bindings" aside={counts}>
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
                  <td className="binding-name">{trigger.name}</td>
                  <td>
                    <Chip>{trigger.kind}</Chip>
                  </td>
                  <td>{trigger.workflow}</td>
                  <td>{trigger.workspaces.join(", ") || <span className="muted">none</span>}</td>
                  <td>{formatSchedule(trigger.schedule)}</td>
                  <td>{trigger.suspended ? <Pill tone="neutral">suspended</Pill> : <In value={trigger.nextExecutionAt} now={readAt} />}</td>
                  <td>
                    <Evaluation evaluation={trigger.lastEvaluation} now={readAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </Panel>
          <Timeline triggers={triggers.data.items} now={triggers.data.readAt} />
        </>
      )}
    </>
  );
}

/** `failed <at>: <why>` or `succeeded <at>, <n> runs started`, as `tend trigger list` says it. */
function Evaluation({ evaluation, now }: { evaluation: Trigger["lastEvaluation"]; now: number }) {
  if (!evaluation) return <span className="muted">not checked yet</span>;
  if (evaluation.status === "failed") {
    return (
      <span className="state-unhealthy">
        failed <Age value={evaluation.at} now={now} />
        {evaluation.message ? `: ${evaluation.message}` : ""}
      </span>
    );
  }
  return (
    <span className="muted">
      succeeded <Age value={evaluation.at} now={now} />, {evaluation.startedRuns} {evaluation.startedRuns === 1 ? "run" : "runs"} started
    </span>
  );
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The checks of the last and next 12 hours, one track per binding; the marks are decoration, the text says the numbers. */
function Timeline({ triggers, now }: { triggers: readonly Trigger[]; now: number }) {
  return (
    <Panel title="Checks in the last and next 12 hours">
      <div className="timeline-body">
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
      <p className="timeline-note muted">Earlier checks of a schedule by interval are projected from its next check; a cron schedule shows only its next and last check.</p>
      </div>
    </Panel>
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
