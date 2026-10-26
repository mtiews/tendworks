import { useCallback, useEffect, useId, useState } from "react";
import { useApi } from "./api.js";
import { answer } from "./answers.js";
import { Age } from "./approvals.js";
import { Pending } from "./pending.js";
import { RunDetail } from "./run-detail.js";
import { defaultRun, groupRuns, matchesFilter, runTitle, runWorkspace, stateOf, type Run, type RunState } from "./run-summary.js";
import { Link, useLocation } from "./router.js";
import { usePolling } from "./use-polling.js";

/**
 * The workbench for runs (spec #101, ADR 0027): the run list next to the selected run on a
 * desktop; on a phone the list (`/runs`) and the run (`/runs/:runId`) one after another. A
 * desktop opened without a run selects the one the operator most likely wants.
 */
export function RunWorkbench({ runId, phone }: { runId?: string | undefined; phone: boolean }) {
  const runs = useRunList();
  const { navigate } = useLocation();
  const preselect = runId === undefined && !phone ? runs.data && defaultRun(runs.data.items, runs.data.waiting) : undefined;

  useEffect(() => {
    if (preselect) navigate(`/runs/${encodeURIComponent(preselect.id)}`, { replace: true });
  }, [preselect, navigate]);

  if (phone) return runId === undefined ? <RunList runs={runs} level={1} /> : <RunDetail key={runId} runId={runId} phone />;
  return (
    <div className="workbench">
      <RunList runs={runs} selected={runId} level={2} />
      <div className="workbench-detail">{runId !== undefined && <RunDetail key={runId} runId={runId} phone={false} />}</div>
    </div>
  );
}

interface RunListData {
  items: Run[];
  /** Runs with a pending approval request. */
  waiting: ReadonlySet<string>;
  readAt: number;
}

/** Recent and active runs (`tend run list`) with which of them wait for an answer, refreshed by polling. */
function useRunList() {
  const { client } = useApi();
  return usePolling(
    useCallback(async (): Promise<RunListData> => {
      const [runs, pending] = await Promise.all([answer(client.GET("/runs")), answer(client.GET("/approval-requests", { params: { query: { status: "pending" } } })).catch(() => undefined)]);
      return { items: runs.items, waiting: new Set(pending?.items.map((request) => request.runId) ?? []), readAt: Date.now() };
    }, [client]),
  );
}

/** The run list; its heading is the page heading on a phone, below the run's on a desktop. */
function RunList({ runs, selected, level }: { runs: ReturnType<typeof useRunList>; selected?: string | undefined; level: 1 | 2 }) {
  const Heading = level === 1 ? "h1" : "h2";
  const [filter, setFilter] = useState("");
  const filterId = useId();
  const { data, error } = runs;
  const shown = data?.items.filter((run) => matchesFilter(run, filter)) ?? [];
  const groups = data ? groupRuns(shown, data.waiting) : undefined;

  return (
    <section className="workbench-list" aria-labelledby={`${filterId}-heading`}>
      <Heading id={`${filterId}-heading`}>Runs</Heading>
      <label className="filter" htmlFor={filterId}>
        <span className="visually-hidden">Filter runs</span>
        <input id={filterId} type="search" placeholder="Filter by title, workspace, workflow…" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </label>
      {data === undefined && <Pending error={error} what="runs" />}
      {data !== undefined && error instanceof Error && (
        <p className="message message-error" role="alert">
          {error.message}
        </p>
      )}
      {data && data.items.length === 0 && <p className="muted">No runs yet.</p>}
      {data && data.items.length > 0 && shown.length === 0 && <p className="muted">No run matches “{filter}”.</p>}
      {groups && data && (
        <>
          <RunGroup level={level} title="Needs you" runs={groups.needsYou} data={data} selected={selected} />
          <RunGroup level={level} title="Running" runs={groups.running} data={data} selected={selected} />
          <RunGroup level={level} title="Finished" runs={groups.finished} data={data} selected={selected} />
        </>
      )}
    </section>
  );
}

function RunGroup({ level, title, runs, data, selected }: { level: 1 | 2; title: string; runs: Run[]; data: RunListData; selected?: string | undefined }) {
  const headingId = useId();
  const Heading = level === 1 ? "h2" : "h3";
  if (runs.length === 0) return null;
  return (
    <section aria-labelledby={headingId}>
      <Heading id={headingId} className="group-heading">
        {title}
      </Heading>
      <ul className="item-list" aria-labelledby={headingId}>
        {runs.map((run) => (
          <li key={run.id}>
            <RunItem run={run} data={data} selected={run.id === selected} />
          </li>
        ))}
      </ul>
    </section>
  );
}

const NOTE: Partial<Record<RunState, string>> = { waiting: "Waiting for you", failed: "Failed" };

function RunItem({ run, data, selected }: { run: Run; data: RunListData; selected: boolean }) {
  const { title, key } = runTitle(run);
  const state = stateOf(run, data.waiting);
  const where = [runWorkspace(run), key].filter(Boolean).join(" ");
  const note = NOTE[state];
  return (
    <Link to={`/runs/${encodeURIComponent(run.id)}`} current={selected} className={`item item-${state}`}>
      <span className={`dot dot-${state}`} aria-hidden="true" />
      <span className="item-title">{title}</span>
      <span className="item-age">
        <Age value={run.createdAt} now={data.readAt} />
      </span>
      <span className={`item-sub${note ? ` item-sub-${state}` : ""}`}>{[note, where || "manual"].filter(Boolean).join(" · ")}</span>
    </Link>
  );
}
