import { formatSchedule } from "@tendworks/platform";
import type { ControlPlane } from "@tendworks/shared";
import { useCallback, useState, type ReactNode } from "react";
import { AnswerError, answer } from "./answers.js";
import { useApi } from "./api.js";
import { Confirmation } from "./confirm.js";
import { Pending } from "./pending.js";
import { Panel } from "./panel.js";
import { Chip, Pill } from "./pill.js";
import { useLocation } from "./router.js";
import { Age, In } from "./time.js";
import { checksAround, type Checks } from "./trigger-checks.js";
import { usePolling } from "./use-polling.js";

type Trigger = ControlPlane.components["schemas"]["triggerList"]["items"][number];
type Started = ControlPlane.components["schemas"]["fireResult"]["items"][number];

/**
 * The trigger bindings (`GET /triggers`, ADR 0023): source, workflow, workspaces, schedule,
 * next and last check. A binding fired by hand (kind `manual`, ADR 0028) has no schedule
 * and no next check; its last check is its last firing. A table on a desktop, with a timeline of the checks of the last and
 * next 12 hours; cards on a phone. A manual binding can be started here (`tend trigger fire`);
 * the API offers no suspend or resume.
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
            <BindingCard key={trigger.name} trigger={trigger} readAt={readAt} />
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
                <th>
                  <span className="visually-hidden">Start</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {triggers.data.items.map((trigger) => (
                <BindingRow key={trigger.name} trigger={trigger} readAt={readAt} />
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

/** A binding as a card on a phone, with its Start button and what starting it asks or says below its facts. */
function BindingCard({ trigger, readAt }: { trigger: Trigger; readAt: number }) {
  const start = useStart(trigger);
  return (
    <li className="binding">
      <div className="card-head">
        <span className="card-kind">{trigger.name}</span>
        {trigger.suspended ? (
          <Pill tone="neutral">suspended</Pill>
        ) : trigger.nextExecutionAt === undefined ? (
          <span className="muted">fired by hand</span>
        ) : (
          <span>
            next <In value={trigger.nextExecutionAt} now={readAt} />
          </span>
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
        <dd>{trigger.workspaces.join(", ") || <span className="muted">none</span>}</dd>
        <dt>Schedule</dt>
        <dd>{scheduleOf(trigger)}</dd>
        <dt>Last check</dt>
        <dd>
          <Evaluation evaluation={trigger.lastEvaluation} now={readAt} />
        </dd>
      </dl>
      {start.button}
      {start.below}
    </li>
  );
}

/** A binding as a table row; what starting it asks or says spans a row of its own below it. */
function BindingRow({ trigger, readAt }: { trigger: Trigger; readAt: number }) {
  const start = useStart(trigger);
  return (
    <>
      <tr>
        <td className="binding-name">{trigger.name}</td>
        <td>
          <Chip>{trigger.kind}</Chip>
        </td>
        <td>{trigger.workflow}</td>
        <td>{trigger.workspaces.join(", ") || <span className="muted">none</span>}</td>
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
        <td>{start.button}</td>
      </tr>
      {start.below && (
        <tr className="binding-start">
          <td colSpan={8}>{start.below}</td>
        </tr>
      )}
    </>
  );
}

const messageOf = (error: unknown) => (error instanceof AnswerError ? error.reason : error instanceof Error ? error.message : String(error));

/**
 * Starting a manual binding (`POST /triggers/{name}/fire`, ADR 0028): its Start button, and
 * below it the choice of workspaces or why the start failed. A binding over one workspace or
 * none starts on one tap; one over several first asks which of them, all preselected. All of
 * them is one firing without a workspace, a subset one firing per chosen workspace, one after
 * another, stopping at the first that fails. One started run opens it; several open Runs.
 * Other bindings fire on their own and get no button.
 */
function useStart(trigger: Trigger): { button?: ReactNode; below?: ReactNode } {
  const { client } = useApi();
  const { navigate } = useLocation();
  const [chosen, setChosen] = useState<ReadonlySet<string>>();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string>();
  if (trigger.kind !== "manual") return {};
  const { name, workspaces } = trigger;

  const fire = async (only: readonly (string | undefined)[]) => {
    setBusy(true);
    setRefused(undefined);
    const started: Started[] = [];
    try {
      for (const workspace of only) {
        const body = workspace === undefined ? {} : { body: { workspace } };
        started.push(...(await answer(client.POST("/triggers/{name}/fire", { params: { path: { name } }, ...body }))).items);
      }
    } catch (failure: unknown) {
      const before = started.map((run) => (run.workspace === undefined ? run.runId : `${run.runId} in ${run.workspace}`)).join(", ");
      setBusy(false);
      setChosen(undefined);
      setRefused(before ? `${messageOf(failure)}. Started before it: ${before}.` : messageOf(failure));
      return;
    }
    const [first] = started;
    navigate(started.length === 1 && first ? `/runs/${encodeURIComponent(first.runId)}` : "/runs");
  };

  const start = () => {
    if (workspaces.length > 1) {
      setRefused(undefined);
      setChosen(new Set(workspaces));
    } else void fire([undefined]);
  };

  const confirm = () => {
    const subset = workspaces.filter((workspace) => chosen?.has(workspace));
    void fire(subset.length === workspaces.length ? [undefined] : subset);
  };

  const toggle = (workspace: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(workspace);
      else next.delete(workspace);
      return next;
    });

  return {
    button: (
      <button type="button" aria-label={`Start ${name}`} aria-expanded={workspaces.length > 1 ? chosen !== undefined : undefined} disabled={trigger.suspended === true || busy} onClick={start}>
        Start
      </button>
    ),
    below:
      chosen !== undefined ? (
        <Confirmation title={`Start ${name}?`} confirmLabel="Start runs" busy={busy} canConfirm={chosen.size > 0} onConfirm={confirm} onCancel={() => setChosen(undefined)}>
          <fieldset className="binding-workspaces">
            <legend>Starts one run of {trigger.workflow} in each chosen workspace.</legend>
            {workspaces.map((workspace) => (
              <label key={workspace} className="checkbox">
                <input type="checkbox" checked={chosen.has(workspace)} disabled={busy} onChange={(event) => toggle(workspace, event.target.checked)} />
                {workspace}
              </label>
            ))}
          </fieldset>
        </Confirmation>
      ) : refused ? (
        <p className="message message-error">{refused}</p>
      ) : undefined,
  };
}

/** The schedule, or `by hand` for a binding that never fires on its own. */
const scheduleOf = (trigger: Trigger) => (trigger.schedule ? formatSchedule(trigger.schedule) : "by hand");

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
  trigger.suspended
    ? "suspended, no checks"
    : !trigger.schedule
      ? "fired by hand, no scheduled checks"
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
