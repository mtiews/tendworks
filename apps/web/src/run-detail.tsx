import type { ControlPlane } from "@tendworks/shared";
import { useCallback, type ReactNode } from "react";
import { useApi } from "./api.js";
import { AnswerError, answer } from "./answers.js";
import { formatCost, formatOrigin, totalCost } from "@tendworks/platform";
import { safeHref } from "./markdown.js";
import { RunApprovalRequest } from "./run-approval.js";
import { Time } from "./time.js";
import { LiveTranscript } from "./live-transcript.js";
import { usePolling } from "./use-polling.js";
import type { OpenTranscriptStream } from "./use-transcript.js";

type Run = ControlPlane.components["schemas"]["run"];
type Step = Run["steps"][number];
type WorkflowError = NonNullable<Run["error"]>;

const describeError = (error: WorkflowError) => `${error.title}${error.detail ? `: ${error.detail}` : ""}`;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * One run (`tend run get` and `tend run logs`): its summary, a failure prominently, its
 * steps with status and cost, its output, and the transcript of each agent step.
 */
export function RunDetail({ runId }: { runId: string }) {
  const { client } = useApi();
  const { data: run, error, refresh } = usePolling(useCallback(() => answer(client.GET("/runs/{runId}", { params: { path: { runId } } })), [client, runId]));

  if (!run) {
    return (
      <>
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
      </>
    );
  }

  const costs = run.steps.flatMap((step) => (step.cost ? [step.cost] : []));
  const fields: [string, ReactNode][] = [
    ["Workflow", run.workflow],
    ["Status", <span className={`status status-${run.status}`}>{run.status}</span>],
    ...(run.startedBy ? [["Started by", formatOrigin(run.startedBy)] as [string, ReactNode]] : []),
    ["Created", <Time value={run.createdAt} />],
    ["Started", run.startedAt && <Time value={run.startedAt} />],
    ["Finished", run.finishedAt && <Time value={run.finishedAt} />],
    ...(costs.length > 0 ? [["Cost", totalCost(costs)] as [string, ReactNode]] : []),
  ];

  return (
    <>
      <h1>Run {run.id}</h1>
      {error !== undefined && <p className="message message-error">{messageOf(error)}</p>}
      {run.error && (
        <p className="message message-error failure" role="alert">
          Failed at {run.error.instance}: {describeError(run.error)}
        </p>
      )}
      <RunApprovalRequest runId={run.id} />
      <dl className="fields">
        {fields.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {run.startedBy?.kind === "trigger" && safeHref(run.startedBy.issue.url) && (
        <p>
          <a href={safeHref(run.startedBy.issue.url)} target="_blank" rel="noopener noreferrer">
            {run.startedBy.issue.title ?? `${run.startedBy.issue.repository}#${run.startedBy.issue.number}`}
          </a>
        </p>
      )}
      <h2>Steps</h2>
      {run.steps.length === 0 ? (
        <p className="muted">No steps yet.</p>
      ) : (
        <table aria-label="Steps">
          <thead>
            <tr>
              <th>Step</th>
              <th>Status</th>
              <th>Task</th>
              <th>Cost</th>
              <th>Started</th>
              <th>Finished</th>
            </tr>
          </thead>
          <tbody>
            {run.steps.map((step) => (
              <tr key={step.reference} className={step.status === "failed" ? "row-failed" : undefined}>
                <td>{step.taskId ? <a href={`#step-${step.taskId}`}>{step.reference}</a> : step.reference}</td>
                <td>
                  <span className={`status status-${step.status}`}>{step.status}</span>
                </td>
                <td>{step.taskId ?? ""}</td>
                <td>{step.cost ? formatCost(step.cost) : ""}</td>
                <td>
                  <Time value={step.startedAt} />
                </td>
                <td>{step.finishedAt && <Time value={step.finishedAt} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Output output={run.output} />
      {run.steps.map((step) => step.taskId && <AgentStep key={step.reference} runId={run.id} step={step} taskId={step.taskId} ended={refresh} />)}
    </>
  );
}

/** The run's output, one row per top-level field: single-line strings as they are, anything else as JSON (as `tend run get`). */
function Output({ output }: { output: unknown }) {
  if (output === undefined) return null;
  const entries: [string, unknown][] = output !== null && typeof output === "object" && !Array.isArray(output) ? Object.entries(output) : [["output", output]];
  if (entries.length === 0) return null;
  return (
    <>
      <h2>Output</h2>
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
    </>
  );
}

/** An agent step: its status, cost, error and results, and its transcript, live while the step runs. */
function AgentStep({ runId, step, taskId, ended }: { runId: string; step: Step; taskId: string; ended: () => void }) {
  const { client } = useApi();
  const read = useCallback(async () => (await answer(client.GET("/runs/{runId}/tasks/{taskId}/transcript", { params: { path: { runId, taskId } } }))).items, [client, runId, taskId]);
  const open = useCallback<OpenTranscriptStream>(
    (header) => client.GET("/runs/{runId}/tasks/{taskId}/transcript/stream", { params: { path: { runId, taskId }, header }, parseAs: "stream" }),
    [client, runId, taskId],
  );

  const headingId = `step-${taskId}`;
  return (
    <section className="step panel" aria-labelledby={headingId}>
      <h2 id={headingId}>{step.reference}</h2>
      <p className="step-meta">
        <span className={`status status-${step.status}`}>{step.status}</span>
        {step.cost && <span>{formatCost(step.cost)}</span>}
        <span className="muted">{taskId}</span>
      </p>
      {step.error && <p className="message message-error failure">{describeError(step.error)}</p>}
      {step.artifacts && step.artifacts.length > 0 && (
        <ul className="artifacts">
          {step.artifacts.map((artifact) => {
            const href = safeHref(artifact.url);
            return (
              <li key={`${artifact.name} ${artifact.url}`}>
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {artifact.name}
                  </a>
                ) : (
                  artifact.name
                )}
                {artifact.description && <span className="muted"> {artifact.description}</span>}
              </li>
            );
          })}
        </ul>
      )}
      <LiveTranscript read={read} open={open} live={step.status === "running"} missing="No transcript was found for this step." onEnded={ended} />
    </section>
  );
}
