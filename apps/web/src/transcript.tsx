import type { ControlPlane } from "@tendworks/shared";
import { useId, useMemo, useState, type ReactNode } from "react";
import { formatCost, type Cost } from "./format.js";
import { Markdown, safeHref } from "./markdown.js";

/*
 * The transcript renderer that run steps and chats share (spec #38). It is fed the entries
 * of a transcript in order, from its history or appended one by one from a live stream:
 * items keep their keys (the position of their first entry), so what the operator expanded
 * stays expanded while entries arrive.
 */

export type TranscriptEntry = ControlPlane.components["schemas"]["TranscriptEntryList"]["items"][number];
type Of<T extends TranscriptEntry["type"]> = Extract<TranscriptEntry, { type: T }>;

type Item =
  | { kind: "message"; key: string; time: string; text: string }
  | { kind: "thought"; key: string; time: string; text: string }
  | { kind: "tool"; key: string; call: Of<"tool-call">; result?: Of<"tool-result"> }
  /** A turn ended: what that turn cost (the difference to the running total when the previous turn ended). */
  | { kind: "turn"; key: string; entry: Of<"turn-ended">; cost?: Cost }
  /** The agent waits for the next message: what the turn that just ended cost, and the total so far. */
  | { kind: "waiting"; key: string; entry: Of<"input-required">; turn?: Cost }
  | { kind: "entry"; key: string; entry: Exclude<TranscriptEntry, Of<"message-chunk" | "thought-chunk" | "tool-call" | "turn-ended" | "usage" | "input-required">> };

/** The cost between two running totals (the turn's), when both are in one currency. */
function difference(total: Cost, before: Cost | undefined): Cost | undefined {
  if (!before) return total;
  return before.currency === total.currency ? { amount: total.amount - before.amount, currency: total.currency } : undefined;
}

/**
 * Joins consecutive message and thought chunks, pairs tool calls with their results, gives
 * each turn end its turn's cost and each wait for the next message its turn's cost and the
 * total so far. Usage entries carry the session's running total, not a turn's.
 */
function itemsOf(entries: readonly TranscriptEntry[]): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, Extract<Item, { kind: "tool" }>>();
  let cost: Cost | undefined;
  // The running total when the previous turn ended, where the next turn's cost starts.
  let endedAt: Cost | undefined;
  // The running total when the agent last waited for a message, where the next turn starts.
  let waitedAt: Cost | undefined;
  for (const entry of entries) {
    const key = String(entry.position);
    const last = items.at(-1);
    if (entry.type === "message-chunk" || entry.type === "thought-chunk") {
      const kind = entry.type === "message-chunk" ? "message" : "thought";
      if (last?.kind === kind) items[items.length - 1] = { ...last, text: last.text + entry.text };
      else items.push({ kind, key, time: entry.time, text: entry.text });
    } else if (entry.type === "tool-call") {
      const item = { kind: "tool" as const, key, call: entry };
      tools.set(entry.toolCallId, item);
      items.push(item);
    } else if (entry.type === "usage") {
      cost = entry.cost;
    } else if (entry.type === "turn-ended") {
      const turn = cost && difference(cost, endedAt);
      endedAt = cost;
      items.push({ kind: "turn", key, entry, ...(turn ? { cost: turn } : {}) });
    } else if (entry.type === "input-required") {
      const turn = entry.cost && difference(entry.cost, waitedAt);
      if (entry.cost) cost = waitedAt = entry.cost;
      items.push({ kind: "waiting", key, entry, ...(turn ? { turn } : {}) });
    } else {
      const call = entry.type === "tool-result" ? tools.get(entry.toolCallId) : undefined;
      if (call && entry.type === "tool-result") {
        const item = { ...call, result: entry };
        items[items.indexOf(call)] = item;
        tools.set(entry.toolCallId, item);
        continue;
      }
      if (entry.type === "task-ended" && entry.cost) cost = entry.cost;
      items.push({ kind: "entry", key, entry });
    }
  }
  return items;
}

const textOf = (message: Of<"task-started">["message"]) => message.parts.flatMap((part) => ("text" in part ? [part.text] : [])).join(" ");

const STATES: Record<Of<"task-ended">["state"], string> = {
  TASK_STATE_SUBMITTED: "submitted",
  TASK_STATE_WORKING: "working",
  TASK_STATE_COMPLETED: "completed",
  TASK_STATE_FAILED: "failed",
  TASK_STATE_CANCELED: "cancelled",
  TASK_STATE_INPUT_REQUIRED: "waits for input",
  TASK_STATE_REJECTED: "rejected",
  TASK_STATE_AUTH_REQUIRED: "waits for authorization",
};

const TURN_ENDS: Record<Of<"turn-ended">["reason"], string> = {
  completed: "Turn completed",
  cancelled: "Turn cancelled",
  refused: "Turn refused",
  "token-limit": "Turn stopped at the token limit",
  "request-limit": "Turn stopped at the request limit",
};

const withCost = (cost: Cost | undefined, suffix = "") => (cost ? ` · ${formatCost(cost)}${suffix}` : "");

export interface TranscriptProps {
  /** The entries so far, in order; a live stream appends to them. */
  entries: readonly TranscriptEntry[];
}

/**
 * The transcript of an agent session (a run step or a chat): the agent's messages as
 * sanitized Markdown, tool calls as rows that expand to their output, thoughts and the
 * harness's own output on request, turn ends with their cost and resumes as markers.
 */
export function Transcript({ entries }: TranscriptProps) {
  const items = useMemo(() => itemsOf(entries), [entries]);
  const [showThoughts, setShowThoughts] = useState(false);
  const [showHarness, setShowHarness] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div className="transcript">
      <div className="transcript-options">
        <label>
          <input type="checkbox" checked={showThoughts} onChange={(event) => setShowThoughts(event.target.checked)} /> Show thoughts
        </label>
        <label>
          <input type="checkbox" checked={showHarness} onChange={(event) => setShowHarness(event.target.checked)} /> Show harness output
        </label>
      </div>
      <ol className="transcript-entries" aria-label="Transcript">
        {items.map((item) => {
          switch (item.kind) {
            case "message":
              return (
                <li key={item.key} className="entry entry-message" title={item.time}>
                  <Markdown text={item.text} />
                </li>
              );
            case "thought":
              return (
                showThoughts && (
                  <li key={item.key} className="entry entry-thought" title={item.time}>
                    <p>{item.text}</p>
                  </li>
                )
              );
            case "tool": {
              const { call, result } = item;
              return (
                <Expandable key={item.key} className="entry entry-tool" time={call.time} open={expanded.has(item.key)} toggle={() => toggle(item.key)} detail={result?.output ?? (result ? "(no output)" : "(no result yet)")}>
                  <span className="tool-title">{call.title}</span>
                  {call.kind && <span className="muted"> {call.kind}</span>}
                  <span className={`status status-${result?.status ?? "running"}`}> {result?.status ?? "running"}</span>
                </Expandable>
              );
            }
            case "turn":
              return (
                <li key={item.key} className="entry entry-marker" title={item.entry.time}>
                  {TURN_ENDS[item.entry.reason]}
                  {withCost(item.cost)}
                </li>
              );
            case "waiting":
              return (
                <li key={item.key} className="entry entry-marker entry-waiting" title={item.entry.time}>
                  Waiting for the next message{item.turn && ` · turn ${formatCost(item.turn)}`}
                  {withCost(item.entry.cost, " so far")}
                </li>
              );
            case "entry":
              return <Entry key={item.key} entry={item.entry} showHarness={showHarness} open={expanded.has(item.key)} toggle={() => toggle(item.key)} />;
          }
        })}
      </ol>
    </div>
  );
}

function Expandable({ className, time, open, toggle, detail, children }: { className: string; time: string; open: boolean; toggle: () => void; detail: string; children: ReactNode }) {
  const id = useId();
  return (
    <li className={className} title={time}>
      <button type="button" className="entry-toggle" aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}>
        {children}
      </button>
      {open && (
        <pre id={id} className="entry-detail">
          {detail}
        </pre>
      )}
    </li>
  );
}

function Entry({ entry, showHarness, open, toggle }: { entry: Extract<Item, { kind: "entry" }>["entry"]; showHarness: boolean; open: boolean; toggle: () => void }) {
  const marker = (text: ReactNode, className = "entry entry-marker") => (
    <li className={className} title={entry.time}>
      {text}
    </li>
  );
  const harness = (info?: { name: string; version?: string }) => (info ? ` (${[info.name, info.version].filter(Boolean).join(" ")})` : "");
  switch (entry.type) {
    case "task-started":
      return marker(
        <>
          <span className="label">Task for {entry.agent}:</span> <span className="prompt">{textOf(entry.message)}</span>
        </>,
        "entry entry-human",
      );
    case "message-received":
      return marker(<span className="prompt">{textOf(entry.message)}</span>, "entry entry-human");
    case "task-resumed":
      return marker("Resumed the task after an interruption", "entry entry-marker entry-resume");
    case "session-started":
      return marker(`Session started${harness(entry.harness)}`);
    case "session-resumed":
      return marker("Resumed the session in a new sandbox; processes the agent started before are gone", "entry entry-marker entry-resume");
    case "session-resume-failed":
      return marker(`Could not resume the session (${entry.reason}); started a new one on the kept workspace`, "entry entry-marker entry-resume");
    case "tool-result":
      return marker(`Tool result ${entry.status}${entry.output ? `: ${entry.output}` : ""}`);
    case "permission":
      return marker(`Permission ${entry.granted ? "granted" : "refused"}: ${entry.tool}`);
    case "plan":
      return marker(
        <>
          <span className="label">Plan: </span>
          <ul className="plan">
            {entry.steps.map((step, index) => (
              <li key={index} className={`plan-${step.status}`}>
                [{step.status}] {step.content}{" "}
              </li>
            ))}
          </ul>
        </>,
        "entry entry-plan",
      );
    case "workspace-checkout":
      return (
        <Expandable className={`entry entry-tool${entry.exitCode === 0 ? "" : " entry-error"}`} time={entry.time} open={open} toggle={toggle} detail={entry.output || "(no output)"}>
          Checked out {[entry.workspace.repository, entry.workspace.branch].filter(Boolean).join(" ")} (exit code {entry.exitCode})
        </Expandable>
      );
    case "artifacts":
      return marker(
        <>
          <span className="label">Result{entry.artifacts.length === 1 ? "" : "s"}: </span>
          {entry.artifacts.map((artifact, index) => {
            const href = safeHref(artifact.url);
            return (
              <span key={index}>
                {index > 0 && ", "}
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {artifact.name}
                  </a>
                ) : (
                  artifact.name
                )}
              </span>
            );
          })}
        </>,
      );
    case "artifacts-ignored":
      return marker(`Results ignored: ${entry.problem}`);
    case "task-ended":
      return marker(`Task ${STATES[entry.state]}${entry.state === "TASK_STATE_COMPLETED" ? "" : `: ${entry.message}`}${withCost(entry.cost)}`, `entry entry-marker${entry.state === "TASK_STATE_FAILED" ? " entry-error" : ""}`);
    case "harness-output":
      return (
        showHarness && (
          <li className="entry entry-harness" title={entry.time}>
            <pre>{entry.text}</pre>
          </li>
        )
      );
    case "error":
      return marker(
        <>
          <span className="label">Error:</span> <span>{entry.message}</span>
        </>,
        "entry entry-error",
      );
  }
}
