import type { ControlPlane } from "@tendworks/shared";
import { Age } from "./time.js";

type Trigger = ControlPlane.components["schemas"]["triggerList"]["items"][number];

/**
 * A binding's last check, as `tend trigger list` says it: `failed <at>: <why>` or
 * `succeeded <at>, <n> runs started`; `never`, e.g. `never started` for a manual binding,
 * whose last firing is its last check (ADR 0028), when there is none.
 */
export function Evaluation({ evaluation, now, never = "not checked yet" }: { evaluation: Trigger["lastEvaluation"]; now: number; never?: string }) {
  if (!evaluation) return <span className="muted">{never}</span>;
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
