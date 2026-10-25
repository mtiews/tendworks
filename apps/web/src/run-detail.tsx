import { formatCost, formatOrigin } from "@tendworks/platform";
import { useCallback, useId, useState, type ReactNode } from "react";
import { useApi } from "./api.js";
import { AnswerError, answer } from "./answers.js";
import { Artifacts } from "./artifacts.js";
import { LiveTranscript } from "./live-transcript.js";
import { safeHref } from "./markdown.js";
import { RunApprovalRequest } from "./run-approval.js";
import { defaultStep, duration, runCost, runTitle, runWorkspace, type Run, type Step } from "./run-summary.js";
import { Link } from "./router.js";
import { Time } from "./time.js";
import { usePolling } from "./use-polling.js";
import type { OpenTranscriptStream } from "./use-transcript.js";

type WorkflowError = NonNullable<Run["error"]>;
type Tab = "transcript" | "output" | "artifacts";

const describeError = (error: WorkflowError) => `${error.title}${error.detail ? `: ${error.detail}` : ""}`;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * One run in the workbench (`tend run get` and `tend run logs`): named by what started it,
 * its facts, a failure prominently, its pending approval request (a bar at the bottom on a
 * phone), its steps to choose from, and tabs for the chosen step's transcript, the output and
 * the artifacts. It opens on its agent step.
 */
export function RunDetail({ runId, phone }: { runId: string; phone: boolean }) {
  const { client } = useApi();
  const { data: run, error, refresh } = usePolling(
    useCallback(async () => ({ run: await answer(client.GET("/runs/{runId}", { params: { path: { runId } } })), readAt: Date.now() }), [client, runId]),
  );
  const [chosenStep, chooseStep] = useState<string>();
  const [chosenTab, chooseTab] = useState<Tab>();

  if (!run) {
    return (
      <article className="run">
        <h1>Run {runId}</h1>
        {error instanceof AnswerError && error.status === 404 ? (
          <p className="muted">There is no run {runId}.</p>
        ) : error !== undefined ? (
          <p className="message message-error" role="alert">
            {messageOf(error)}
          </p>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </article>
    );
  }

  const { run: current, readAt } = run;
  const { title, key } = runTitle(current);
  const step = current.steps.find((candidate) => candidate.reference === chosenStep) ?? defaultStep(current);
  const tab = chosenTab ?? (current.steps.some((candidate) => candidate.taskId !== undefined) ? "transcript" : "output");

  return (
    <article className="run">
      <header className="run-head">
        <h1>
          {title} {key && <span className="muted">{key}</span>}
        </h1>
        <span className={`status status-${current.status}`}>{current.status}</span>
      </header>
      {error !== undefined && <p className="message message-error">{messageOf(error)}</p>}
      <Facts run={current} readAt={readAt} />
      <ItemLink run={current} />
      {current.error && (
        <div className="banner banner-error">
          <p className="failure" role="alert">
            Failed at {current.error.instance}: {describeError(current.error)}
          </p>
          <Link to={`/chats/new?text=${encodeURIComponent(`Why did run ${current.id} fail?`)}`} className="button">
            Ask the platform assistant
          </Link>
        </div>
      )}
      <RunApprovalRequest runId={current.id} bar={phone} />
      {current.steps.length === 0 ? (
        <p className="muted">No steps yet.</p>
      ) : (
        <Stepper
          steps={current.steps}
          chosen={step}
          choose={(reference) => {
            chooseStep(reference);
            chooseTab("transcript");
          }}
          readAt={readAt}
        />
      )}
      <Tabs
        tab={tab}
        choose={chooseTab}
        artifacts={current.steps.flatMap((candidate) => candidate.artifacts ?? []).length}
        panels={{
          transcript: step ? <StepPanel runId={current.id} step={step} ended={refresh} /> : <p className="muted">No steps yet.</p>,
          output: <Output output={current.output} />,
          artifacts: <AllArtifacts steps={current.steps} />,
        }}
      />
    </article>
  );
}

function Facts({ run, readAt }: { run: Run; readAt: number }) {
  const workspace = runWorkspace(run);
  const cost = runCost(run);
  const took = duration(run.startedAt, run.finishedAt, readAt);
  const fields: [string, ReactNode][] = [
    ["Run", run.id],
    ["Workflow", run.workflow],
    ...(workspace ? [["Workspace", workspace] as [string, ReactNode]] : []),
    ["Status", run.status],
    ...(run.startedBy ? [["Started by", formatOrigin(run.startedBy)] as [string, ReactNode]] : []),
    ["Created", <Time value={run.createdAt} />],
    ...(run.startedAt ? [["Started", <Time value={run.startedAt} />] as [string, ReactNode]] : []),
    ...(run.finishedAt ? [["Finished", <Time value={run.finishedAt} />] as [string, ReactNode]] : []),
    ...(took ? [["Duration", took] as [string, ReactNode]] : []),
    ...(cost ? [["Cost", cost] as [string, ReactNode]] : []),
  ];
  return (
    <dl className="fields">
      {fields.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The item a trigger started the run for, e.g. the issue, when it has a safe link. */
function ItemLink({ run }: { run: Run }) {
  const item = run.startedBy?.kind === "trigger" ? run.startedBy.item : undefined;
  const href = item?.url === undefined ? undefined : safeHref(item.url);
  if (!item || !href) return null;
  return (
    <p className="item-link">
      <a href={href} target="_blank" rel="noopener noreferrer">
        {item.title || item.key}
      </a>
    </p>
  );
}

/** The steps in order; choosing one shows its transcript. */
function Stepper({ steps, chosen, choose, readAt }: { steps: Step[]; chosen: Step | undefined; choose: (reference: string) => void; readAt: number }) {
  return (
    <ol className="stepper" aria-label="Steps">
      {steps.map((step, index) => {
        const took = duration(step.startedAt, step.finishedAt, readAt);
        return (
          <li key={step.reference}>
            <button type="button" className={`step-choice step-${step.status}`} aria-pressed={step === chosen} title={step.reference} onClick={() => choose(step.reference)}>
              <span className="step-number">Step {index + 1}</span>
              <span className="step-name">{step.name}</span>
              <span className="step-state">{[step.status, took].filter(Boolean).join(" · ")}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Tabs({ tab, choose, artifacts, panels }: { tab: Tab; choose: (tab: Tab) => void; artifacts: number; panels: Record<Tab, ReactNode> }) {
  const id = useId();
  const labels: Record<Tab, string> = { transcript: "Transcript", output: "Output", artifacts: artifacts > 0 ? `Artifacts (${artifacts})` : "Artifacts" };
  const order: Tab[] = ["transcript", "output", "artifacts"];
  return (
    <>
      <div className="run-tabs" role="tablist" aria-label="Run">
        {order.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`${id}-${name}`}
            aria-selected={tab === name}
            aria-controls={`${id}-panel`}
            tabIndex={tab === name ? 0 : -1}
            onClick={() => choose(name)}
            onKeyDown={(event) => {
              const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (step === 0) return;
              const next = order[(order.indexOf(name) + step + order.length) % order.length]!;
              choose(next);
              document.getElementById(`${id}-${next}`)?.focus();
            }}
          >
            {labels[name]}
          </button>
        ))}
      </div>
      <div className="run-panel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>
        {panels[tab]}
      </div>
    </>
  );
}

/** The chosen step: an agent step with its transcript (live while it runs), else what kind of step it is. */
function StepPanel({ runId, step, ended }: { runId: string; step: Step; ended: () => void }) {
  if (step.taskId === undefined) {
    return (
      <p className="muted">
        {step.name} runs without an agent and has no transcript.{step.status === "running" && " It is at work, or waits for an answer."}
      </p>
    );
  }
  return <AgentStep key={step.reference} runId={runId} step={step} taskId={step.taskId} ended={ended} />;
}

/** An agent step: its status, cost, error and results, and its transcript, live while the step runs. */
function AgentStep({ runId, step, taskId, ended }: { runId: string; step: Step; taskId: string; ended: () => void }) {
  const { client } = useApi();
  const read = useCallback(async () => (await answer(client.GET("/runs/{runId}/tasks/{taskId}/transcript", { params: { path: { runId, taskId } } }))).items, [client, runId, taskId]);
  const open = useCallback<OpenTranscriptStream>(
    (header) => client.GET("/runs/{runId}/tasks/{taskId}/transcript/stream", { params: { path: { runId, taskId }, header }, parseAs: "stream" }),
    [client, runId, taskId],
  );

  const headingId = useId();
  return (
    <section className="step" aria-labelledby={headingId}>
      <h2 id={headingId}>{step.name}</h2>
      <p className="step-meta">
        <span className={`status status-${step.status}`}>{step.status}</span>
        {step.cost && <span>{formatCost(step.cost)}</span>}
        <span className="muted">{taskId}</span>
      </p>
      {step.error && <p className="message message-error failure">{describeError(step.error)}</p>}
      <Artifacts artifacts={step.artifacts ?? []} />
      <LiveTranscript read={read} open={open} live={step.status === "running"} missing="No transcript was found for this step." onEnded={ended} />
    </section>
  );
}

/** The run's output, one row per top-level field: single-line strings as they are, anything else as JSON (as `tend run get`). */
function Output({ output }: { output: unknown }) {
  const entries: [string, unknown][] =
    output === undefined ? [] : output !== null && typeof output === "object" && !Array.isArray(output) ? Object.entries(output) : [["output", output]];
  if (entries.length === 0) return <p className="muted">No output.</p>;
  return (
    <table aria-label="Output">
      <thead>
        <tr>
          <th>Field</th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([key, value]) => (
          <tr key={key}>
            <td>{key}</td>
            <td>{typeof value === "string" && !/[\r\n]/.test(value) ? value : <code className="value">{typeof value === "string" ? value : JSON.stringify(value)}</code>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AllArtifacts({ steps }: { steps: Step[] }) {
  const artifacts = steps.flatMap((step) => step.artifacts ?? []);
  return artifacts.length === 0 ? <p className="muted">No artifacts.</p> : <Artifacts artifacts={artifacts} />;
}
