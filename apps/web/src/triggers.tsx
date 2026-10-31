import { formatSchedule } from "@tendworks/platform";
import type { ControlPlane } from "@tendworks/shared";
import { useCallback } from "react";
import { answer } from "./answers.js";
import { useApi } from "./api.js";
import { Pending } from "./pending.js";
import { Panel } from "./panel.js";
import { Chip, Pill } from "./pill.js";
import { isManual, useStart } from "./start-binding.js";
import { In } from "./time.js";
import { Evaluation } from "./trigger-evaluation.js";
import { checksAround, type Checks } from "./trigger-checks.js";
import { usePolling } from "./use-polling.js";

type Trigger = ControlPlane.components["schemas"]["triggerList"]["items"][number];

/**
 * The trigger bindings (`GET /triggers`, ADR 0023) in two panels, each with only the columns
 * that mean something for its bindings. "Scheduled" holds the bindings that check on their own
 * (source, workflow, workspaces, schedule, next and last check), followed on a desktop by a
 * timeline of their checks of the last and next 12 hours. "By hand" holds the bindings fired by
 * hand (kind `manual`, ADR 0028: workflow, workspaces, last start, whose last check is its last
 * firing) with their Start (`tend trigger fire`). Tables on a desktop, cards on a phone; a panel
 * that would be empty is left out. The API offers no suspend or resume.
 */
export function TriggersPage({ phone }: { phone: boolean }) {
  const { client } = useApi();
  const triggers = usePolling(useCallback(async () => ({ items: (await answer(client.GET("/triggers"))).items, readAt: Date.now() }), [client]));
  const items = triggers.data?.items ?? [];
  const readAt = triggers.data?.readAt ?? 0;
  const scheduled = items.filter((trigger) => !isManual(trigger));
  const manual = items.filter(isManual);

  return (
    <>
      <h1>Triggers</h1>
      {triggers.data === undefined ? (
        <Pending error={triggers.error} what="trigger bindings" />
      ) : items.length === 0 ? (
        <p className="muted">No trigger bindings are configured.</p>
      ) : (
        <>
          {scheduled.length > 0 && (
            <>
              <Panel title="Scheduled" aside={activeAndSuspended(scheduled)}>
                {phone ? (
                  <ul className="rows" aria-label="Scheduled bindings">
                    {scheduled.map((trigger) => (
                      <ScheduledCard key={trigger.name} trigger={trigger} readAt={readAt} />
                    ))}
                  </ul>
                ) : (
                  <table aria-label="Scheduled bindings">
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
                      {scheduled.map((trigger) => (
                        <ScheduledRow key={trigger.name} trigger={trigger} readAt={readAt} />
                      ))}
                    </tbody>
                  </table>
                )}
              </Panel>
              {!phone && <Timeline triggers={scheduled} now={readAt} />}
            </>
          )}
          {manual.length > 0 && (
            <Panel title="By hand" aside={activeAndSuspended(manual)}>
              {phone ? (
                <ul className="rows" aria-label="Bindings by hand">
                  {manual.map((trigger) => (
                    <ManualCard key={trigger.name} trigger={trigger} readAt={readAt} />
                  ))}
                </ul>
              ) : (
                <ManualTable triggers={manual} readAt={readAt} />
              )}
            </Panel>
          )}
        </>
      )}
    </>
  );
}

/** A panel's aside: how many of its bindings are active and how many suspended. */
const activeAndSuspended = (triggers: readonly Trigger[]) => {
  const suspended = triggers.filter((trigger) => trigger.suspended).length;
  return `${triggers.length - suspended} active · ${suspended} suspended`;
};

const workspacesOf = (trigger: Trigger) => trigger.workspaces.join(", ") || <span className="muted">none</span>;

/** A scheduled binding as a card on a phone. */
function ScheduledCard({ trigger, readAt }: { trigger: Trigger; readAt: number }) {
  return (
    <li className="binding">
      <div className="card-head">
        <span className="card-kind">{trigger.name}</span>
        {trigger.suspended ? (
          <Pill tone="neutral">suspended</Pill>
        ) : (
          trigger.nextExecutionAt !== undefined && (
            <span>
              next <In value={trigger.nextExecutionAt} now={readAt} />
            </span>
          )
        )}
      </div>
      <dl className="facts">
        <dt>Source</dt>
        <dd>
          <Chip>{trigger.kind}</Chip>
        </dd>
        <dt>Workflow</dt>
        <dd>{trigger.workflow}</dd>
        <dt>Workspaces</dt>
        <dd>{workspacesOf(trigger)}</dd>
        <dt>Schedule</dt>
        <dd>{scheduleOf(trigger)}</dd>
        <dt>Last check</dt>
        <dd>
          <Evaluation evaluation={trigger.lastEvaluation} now={readAt} />
        </dd>
      </dl>
    </li>
  );
}

/** A scheduled binding as a table row. */
function ScheduledRow({ trigger, readAt }: { trigger: Trigger; readAt: number }) {
  return (
    <tr>
      <td className="binding-name">{trigger.name}</td>
      <td>
        <Chip>{trigger.kind}</Chip>
      </td>
      <td>{trigger.workflow}</td>
      <td>{workspacesOf(trigger)}</td>
      <td>{scheduleOf(trigger)}</td>
      <td>
        {trigger.suspended ? (
          <Pill tone="neutral">suspended</Pill>
        ) : trigger.nextExecutionAt === undefined ? (
          <span className="muted">-</span>
        ) : (
          <In value={trigger.nextExecutionAt} now={readAt} />
        )}
      </td>
      <td>
        <Evaluation evaluation={trigger.lastEvaluation} now={readAt} />
      </td>
    </tr>
  );
}

/** A manual binding as a card on a phone, with its Start button and what starting it asks or says below its facts. */
function ManualCard({ trigger, readAt }: { trigger: Trigger; readAt: number }) {
  const start = useStart(trigger);
  return (
    <li className="binding">
      <div className="card-head">
        <span className="card-kind">{trigger.name}</span>
        {trigger.suspended && <Pill tone="neutral">suspended</Pill>}
      </div>
      <dl className="facts">
        <dt>Workflow</dt>
        <dd>{trigger.workflow}</dd>
        <dt>Workspaces</dt>
        <dd>{workspacesOf(trigger)}</dd>
        <dt>Last start</dt>
        <dd>
          <Evaluation evaluation={trigger.lastEvaluation} now={readAt} never="never started" />
        </dd>
      </dl>
      {start.button}
      {start.below}
    </li>
  );
}

/** The manual bindings as a table; the Start column only for those who may start them. */
function ManualTable({ triggers, readAt }: { triggers: readonly Trigger[]; readAt: number }) {
  const { canChange } = useApi();

  return (
    <table aria-label="Bindings by hand">
      <thead>
        <tr>
          <th>Name</th>
          <th>Workflow</th>
          <th>Workspaces</th>
          <th>Last start</th>
          {canChange && (
            <th>
              <span className="visually-hidden">Start</span>
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {triggers.map((trigger) => (
          <ManualRow key={trigger.name} trigger={trigger} readAt={readAt} startColumn={canChange} />
        ))}
      </tbody>
    </table>
  );
}

/** A manual binding as a table row; what starting it asks or says spans a row of its own below it. */
function ManualRow({ trigger, readAt, startColumn }: { trigger: Trigger; readAt: number; startColumn: boolean }) {
  const start = useStart(trigger);
  return (
    <>
      <tr>
        <td className="binding-name">
          {trigger.name}
          {trigger.suspended && (
            <>
              {" "}
              <Pill tone="neutral">suspended</Pill>
            </>
          )}
        </td>
        <td>{trigger.workflow}</td>
        <td>{workspacesOf(trigger)}</td>
        <td>
          <Evaluation evaluation={trigger.lastEvaluation} now={readAt} never="never started" />
        </td>
        {startColumn && <td>{start.button}</td>}
      </tr>
      {start.below && (
        <tr>
          <td colSpan={startColumn ? 5 : 4}>{start.below}</td>
        </tr>
      )}
    </>
  );
}

/** The schedule; the contract makes it optional, as a manual binding has none. */
const scheduleOf = (trigger: Trigger) => (trigger.schedule ? formatSchedule(trigger.schedule) : <span className="muted">-</span>);

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The checks of the last and next 12 hours, one track per scheduled binding; the marks are decoration, the text says the numbers. */
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
  trigger.suspended
    ? "suspended, no checks"
    : !trigger.schedule
      ? "no scheduled checks"
      : dense
        ? `checks continuously (${formatSchedule(trigger.schedule)})`
        : `${count(past.length, "check")} in the last 12 hours, ${count(future.length, "check")} in the next 12 hours`;

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
