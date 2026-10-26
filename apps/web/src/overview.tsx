import { formatSchedule } from "@tendworks/platform";
import type { ControlPlane } from "@tendworks/shared";
import { useCallback, useId, useMemo, useState } from "react";
import { answer } from "./answers.js";
import { useApi } from "./api.js";
import { DecisionActions, DecisionFailure, Question, THEN, outcomeOf, type ApprovalRequest, type Outcome } from "./approvals.js";
import { LiveMark, Panel } from "./panel.js";
import { Pending } from "./pending.js";
import { unhealthyComponents, usePlatformStatus } from "./platform-status.js";
import { Link } from "./router.js";
import { runTitle, runWorkspace, type Run, type Step } from "./run-summary.js";
import { Age, In } from "./time.js";
import type { TranscriptEntry } from "./transcript.js";
import { TranscriptOf } from "./live-transcript.js";
import { usePolling, type Polled } from "./use-polling.js";
import { useTranscript, type OpenTranscriptStream } from "./use-transcript.js";

type Trigger = ControlPlane.components["schemas"]["triggerList"]["items"][number];

/** Runs that failed within this long count as "failed in the last 24 hours". */
const DAY_MS = 24 * 60 * 60 * 1_000;
/** How many transcript entries a live tile shows on a desktop. */
const TAIL = 6;
/** How many items "Attention" lists; the rest are a link away. */
const ATTENTION = 6;

interface Running {
  run: Run;
  step: Step & { taskId: string };
}

/** The agent steps at work right now, newest run first as the API lists the runs. */
const runningSteps = (runs: readonly Run[]): Running[] =>
  runs.flatMap((run) => run.steps.flatMap((step) => (step.status === "running" && step.taskId !== undefined ? [{ run, step: { ...step, taskId: step.taskId } }] : [])));

const failedRecently = (runs: readonly Run[], now: number) => runs.filter((run) => run.status === "failed" && now - new Date(run.finishedAt ?? run.createdAt).getTime() <= DAY_MS);

/**
 * The platform at a glance (spec #101, ADR 0027): how many agents work, what waits for the
 * operator and what failed, each leading to where the operator acts; live tiles of the agent
 * steps at work and of the approval requests with their answers; what needs attention; when
 * the trigger bindings check next. Each part polls on its own, so one unreachable part does
 * not blank the rest.
 */
export function OverviewPage({ phone }: { phone: boolean }) {
  const { client } = useApi();
  const runs = usePolling(useCallback(async () => ({ items: (await answer(client.GET("/runs"))).items, readAt: Date.now() }), [client]));
  const approvals = usePolling(
    useCallback(async () => ({ items: (await answer(client.GET("/approval-requests", { params: { query: { status: "pending" } } }))).items, readAt: Date.now() }), [client]),
  );
  const notifications = usePolling(useCallback(async () => (await answer(client.GET("/notifications"))).items, [client]));
  const triggers = usePolling(useCallback(async () => ({ items: (await answer(client.GET("/triggers"))).items, readAt: Date.now() }), [client]));
  const status = usePlatformStatus();
  // The answer to a request is told here, not on its tile: the tile goes once the request is decided.
  const [outcome, setOutcome] = useState<Outcome>();
  const answered = (next: Outcome) => {
    setOutcome(next);
    approvals.refresh();
  };

  const running = useMemo(() => (runs.data ? runningSteps(runs.data.items) : undefined), [runs.data]);
  const failed = useMemo(() => (runs.data ? failedRecently(runs.data.items, runs.data.readAt) : undefined), [runs.data]);
  const runById = (id: string) => runs.data?.items.find((run) => run.id === id);

  const idle = running?.length === 0 && approvals.data?.items.length === 0;

  return (
    <>
      <h1>Overview</h1>
      <Figures running={running} waiting={approvals.data?.items} failed={failed} />
      <Panel title="Live" aside={<LiveMark>streaming</LiveMark>}>
        {running === undefined && approvals.data === undefined ? (
          <Pending error={runs.error ?? approvals.error} what="running agents and approval requests" />
        ) : (
          <>
            {runs.error !== undefined && running === undefined && <Pending error={runs.error} what="runs" />}
            {approvals.error !== undefined && approvals.data === undefined && <Pending error={approvals.error} what="approval requests" />}
            <DecisionOutcome outcome={outcome} />
            {idle && <p className="muted">Nothing is running and nothing waits for you.{nextCheck(triggers.data?.items)}</p>}
            {(running?.length || approvals.data?.items.length) ? <ul className="tiles" aria-label="Live">
              {approvals.data?.items.map((request) => approvals.data && (
                <li key={request.id}>
                  <ApprovalTile request={request} run={runById(request.runId)} readAt={approvals.data.readAt} onDone={answered} />
                </li>
              ))}
              {running?.map(({ run, step }) => (
                <li key={`${run.id}/${step.reference}`}>
                  <StepTile run={run} step={step} phone={phone} readAt={runs.data?.readAt ?? 0} />
                </li>
              ))}
            </ul> : null}
          </>
        )}
      </Panel>
      <div className="overview-columns">
        <Attention failed={failed} runs={runs} readAt={runs.data?.readAt ?? 0} notifications={notifications} status={status} />
        <NextChecks triggers={triggers} readAt={triggers.data?.readAt ?? 0} />
      </div>
    </>
  );
}

function nextCheck(triggers: readonly Trigger[] | undefined): string {
  const next = triggers && sortedByNext(triggers).find((trigger) => !trigger.suspended);
  return next ? ` The next trigger check is ${new Date(next.nextExecutionAt).toLocaleString()}.` : "";
}

/** Bindings by their next check, suspended ones last. */
const sortedByNext = (triggers: readonly Trigger[]) =>
  [...triggers].sort((a, b) => Number(a.suspended ?? false) - Number(b.suspended ?? false) || a.nextExecutionAt.localeCompare(b.nextExecutionAt));

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The three numbers, each a link to where the operator acts on it. */
function Figures({ running, waiting, failed }: { running: Running[] | undefined; waiting: ApprovalRequest[] | undefined; failed: Run[] | undefined }) {
  const runLink = (id: string | undefined) => (id === undefined ? "/runs" : `/runs/${encodeURIComponent(id)}`);
  return (
    <ul className="figures" aria-label="Figures">
      <Figure count={running?.length} label={(n) => plural(n, "agent working", "agents working")} caption="Agents working" to={runLink(running?.[0]?.run.id)} />
      <Figure
        count={waiting?.length}
        label={(n) => plural(n, "approval request waiting", "approval requests waiting")}
        caption="Waiting for you"
        to={runLink(waiting?.[0]?.runId)}
        tone={waiting?.length ? "ask" : undefined}
      />
      <Figure count={failed?.length} label={(n) => plural(n, "run failed in the last 24 hours", "runs failed in the last 24 hours")} caption="Failed in 24 h" to={runLink(failed?.[0]?.id)} tone={failed?.length ? "bad" : undefined} />
    </ul>
  );
}

function Figure({ count, label, caption, to, tone }: { count: number | undefined; label: (n: number) => string; caption: string; to: string; tone?: "ask" | "bad" | undefined }) {
  return (
    <li>
      <Link to={to} className={`figure${tone ? ` figure-${tone}` : ""}`} label={count === undefined ? `${caption}: unknown` : label(count)}>
        <span className="figure-caption" aria-hidden="true">
          {caption}
        </span>
        <span className="figure-value" aria-hidden="true">
          {count ?? "–"}
        </span>
      </Link>
    </li>
  );
}

/** What the agent step does: its last transcript entries as a terminal (desktop), or its last tool call (phone). */
function StepTile({ run, step, phone, readAt }: { run: Run; step: Running["step"]; phone: boolean; readAt: number }) {
  const { client } = useApi();
  const runId = run.id;
  const taskId = step.taskId;
  const read = useCallback(async () => (await answer(client.GET("/runs/{runId}/tasks/{taskId}/transcript", { params: { path: { runId, taskId } } }))).items, [client, runId, taskId]);
  const open = useCallback<OpenTranscriptStream>(
    (header) => client.GET("/runs/{runId}/tasks/{taskId}/transcript/stream", { params: { path: { runId, taskId }, header }, parseAs: "stream" }),
    [client, runId, taskId],
  );
  const view = useTranscript({ read, open, live: true });
  const tail = useMemo(() => (view.phase === "shown" ? { ...view, entries: view.entries.slice(-TAIL) } : view), [view]);
  const headingId = useId();
  const { title, key } = runTitle(run);
  const workspace = runWorkspace(run);

  return (
    <article className="tile tile-terminal" aria-labelledby={headingId}>
      <header className="tile-head">
        <h3 id={headingId}>
          <Link to={`/runs/${encodeURIComponent(run.id)}`}>{title}</Link>
        </h3>
        <span className="pill pill-running">{step.name}</span>
      </header>
      <div className="terminal">{phone ? <LastToolCall entries={view.phase === "shown" ? view.entries : undefined} /> : <TranscriptOf view={tail} missing="No transcript was found for this step." />}</div>
      <p className="tile-foot">
        {[workspace, key].filter(Boolean).join(" ")}
        {run.startedAt && (
          <>
            {workspace || key ? " · " : ""}
            <Age value={run.startedAt} now={readAt} />
          </>
        )}
      </p>
    </article>
  );
}

/** The phone's tile: only the last tool call, since a terminal does not fit. */
function LastToolCall({ entries }: { entries: readonly TranscriptEntry[] | undefined }) {
  const call = entries?.findLast((entry) => entry.type === "tool-call");
  if (entries === undefined) return <p className="muted">Loading…</p>;
  return <p className="last-call">{call?.type === "tool-call" ? call.title : "No tool call yet."}</p>;
}

/** A pending approval request with its answers, as in the workbench. */
function ApprovalTile({ request, run, readAt, onDone }: { request: ApprovalRequest; run: Run | undefined; readAt: number; onDone: (outcome: Outcome) => void }) {
  const { canChange } = useApi();
  const headingId = useId();
  const named = run && runTitle(run);
  const workspace = run && runWorkspace(run);

  return (
    <article className="tile tile-ask" aria-labelledby={headingId}>
      <header className="tile-head">
        <h3 id={headingId}>
          <span className="tile-needs">Needs you</span> <Link to={`/runs/${encodeURIComponent(request.runId)}`}>{named?.title ?? `run ${request.runId}`}</Link>
        </h3>
        <span className="pill pill-warn">
          <Age value={request.createdAt} now={readAt} />
        </span>
      </header>
      {workspace && <p className="tile-foot">{workspace}</p>}
      <div className="approval-question">
        <Question request={request} />
      </div>
      {canChange && <DecisionActions key={request.id} request={request} onDone={onDone} />}
    </article>
  );
}

/** What the last answer did: confirmed, or why the platform refused it. */
function DecisionOutcome({ outcome }: { outcome: Outcome | undefined }) {
  if (outcome === undefined) return null;
  if ("error" in outcome) return <DecisionFailure failure={outcome.error} />;
  const then = outcomeOf(outcome.decided);
  return (
    <p className="message" role="status">
      Answered “{outcome.decided.answer}”.{then && ` ${THEN[then]}`}
    </p>
  );
}

/** Failed runs, unhealthy components and undelivered notifications: what needs the operator even though nothing waits for an answer. */
function Attention({
  failed,
  runs,
  readAt,
  notifications,
  status,
}: {
  failed: Run[] | undefined;
  runs: Polled<unknown>;
  /** When the runs were read: the ages of failed runs count from then. */
  readAt: number;
  notifications: Polled<ControlPlane.components["schemas"]["NotificationList"]["items"]>;
  status: ReturnType<typeof usePlatformStatus>;
}) {
  const undelivered = notifications.data?.filter((notification) => notification.deliveries.some((delivery) => delivery.status === "failed"));
  const unhealthy = status.data && unhealthyComponents(status.data);
  const problems = [
    status.error !== undefined && status.data === undefined && "the platform status",
    runs.error !== undefined && failed === undefined && "the runs",
    notifications.error !== undefined && undelivered === undefined && "the notifications",
  ].filter((what): what is string => what !== false);
  const nothing = failed?.length === 0 && undelivered?.length === 0 && unhealthy?.length === 0;

  const items = [
    ...(unhealthy ?? []).map((component) => (
      <div className="row" key={`c-${component.name}`}>
        <span className="dot dot-failed" aria-hidden="true" />
        <span>
          Component {component.name} is {component.status}
          {component.message && <span className="muted">: {component.message}</span>}
        </span>
      </div>
    )),
    ...(failed ?? []).map((run) => (
      <Link key={`r-${run.id}`} to={`/runs/${encodeURIComponent(run.id)}`} className="row">
        <span className="dot dot-failed" aria-hidden="true" />
        <span>
          Run failed: {runTitle(run).title}
          {run.error && <span className="muted">: {run.error.title}</span>}
        </span>
        <span className="row-end">
          <Age value={run.finishedAt ?? run.createdAt} now={readAt} />
        </span>
      </Link>
    )),
    ...(undelivered ?? []).map((notification) => (
      <Link key={`n-${notification.id}`} to="/notifications" className="row">
        <span className="dot dot-waiting" aria-hidden="true" />
        <span title={notification.title}>Notification not delivered: {notification.title}</span>
      </Link>
    )),
  ];
  const more = items.length - ATTENTION;

  return (
    <Panel title="Attention" aside={items.length > 0 ? String(items.length) : undefined}>
      {problems.map((what) => (
        <p key={what} className="message message-error" role="alert">
          Cannot read {what}. Is the platform running?
        </p>
      ))}
      {items.length > 0 && (
        <ul className="rows" aria-label="Attention">
          {items.slice(0, ATTENTION).map((item) => (
            <li key={item.key}>{item}</li>
          ))}
          {more > 0 && (
            <li>
              <Link to="/notifications" className="row row-more">
                {more} more: see the runs and the inbox
              </Link>
            </li>
          )}
        </ul>
      )}
      {nothing && <p className="muted">Nothing needs attention.</p>}
      {failed === undefined && undelivered === undefined && unhealthy === undefined && problems.length === 0 && <p className="muted">Loading…</p>}
    </Panel>
  );
}

/** Each trigger binding with when it checks its source next. */
function NextChecks({ triggers, readAt }: { triggers: Polled<{ items: Trigger[] }>; readAt: number }) {
  const { error } = triggers;
  const data = triggers.data?.items;
  return (
    <Panel
      title="Next trigger checks"
      aside={
        <Link to="/triggers" label="All trigger bindings">
          all →
        </Link>
      }
    >
      {data === undefined ? (
        <Pending error={error} what="trigger bindings" />
      ) : data.length === 0 ? (
        <p className="muted">No trigger bindings are configured.</p>
      ) : (
        <ul className="rows" aria-label="Next trigger checks">
          {sortedByNext(data).map((trigger) => (
            <li key={trigger.name} className="row">
              <span className={`dot ${trigger.suspended ? "" : "dot-next"}`} aria-hidden="true" />
              <span className="check-name">{trigger.name}</span>
              <span className="muted">{[trigger.workspaces.join(", "), formatSchedule(trigger.schedule)].filter(Boolean).join(" · ")}</span>
              <span className="row-end">{trigger.suspended ? "suspended" : <In value={trigger.nextExecutionAt} now={readAt} />}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
