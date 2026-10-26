import { totalCost } from "@tendworks/platform";
import type { ControlPlane } from "@tendworks/shared";

/*
 * How the workbench presents a run (spec #101), derived from the run as the API gives it:
 * no field here is stored anywhere.
 */

export type Run = ControlPlane.components["schemas"]["run"];
export type Step = Run["steps"][number];

/** What the operator sees of a run in a list: waiting for them comes before the run's own status. */
export type RunState = Run["status"] | "waiting";

/** The run's name: the title of the item that started it (e.g. the issue) with its key, else the workflow. */
export function runTitle(run: Run): { title: string; key?: string } {
  if (run.startedBy?.kind === "trigger") return { title: run.startedBy.item.title || run.startedBy.item.key, key: run.startedBy.item.key };
  return { title: run.workflow };
}

/** The workspace the run works in: its trigger's, else the first one a step names. */
export function runWorkspace(run: Run): string | undefined {
  if (run.startedBy?.kind === "trigger" && run.startedBy.workspace !== undefined) return run.startedBy.workspace;
  return run.steps.find((step) => step.workspace !== undefined)?.workspace?.name;
}

/** What the run's steps cost so far, or `undefined` when none reported a cost. */
export function runCost(run: Run): string | undefined {
  const costs = run.steps.flatMap((step) => (step.cost ? [step.cost] : []));
  return costs.length === 0 ? undefined : totalCost(costs);
}

/** How long a run or step took, or has taken by `now` while it runs: `42 s`, `14 min`, `2 h 5 min`. */
export function duration(startedAt: string | undefined, finishedAt: string | undefined, now: number): string | undefined {
  if (startedAt === undefined) return undefined;
  const seconds = Math.max(0, Math.round(((finishedAt === undefined ? now : new Date(finishedAt).getTime()) - new Date(startedAt).getTime()) / 1_000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest === 0 ? "" : ` ${rest} min`}`;
}

/** What the run needs: an answer when it has a pending approval request (`waiting` holds those runs), else its own status. */
export function stateOf(run: Run, waiting: ReadonlySet<string>): RunState {
  return waiting.has(run.id) ? "waiting" : run.status;
}

/** The runs by what they need: waiting for an answer, still at work, done; each group in the API's order (newest first). */
export function groupRuns(runs: readonly Run[], waiting: ReadonlySet<string>): { needsYou: Run[]; running: Run[]; finished: Run[] } {
  const needsYou = runs.filter((run) => waiting.has(run.id));
  const rest = runs.filter((run) => !waiting.has(run.id));
  return {
    needsYou,
    running: rest.filter((run) => run.status === "pending" || run.status === "running"),
    finished: rest.filter((run) => run.status === "completed" || run.status === "failed"),
  };
}

/** The run a desktop workbench opens without one chosen: the first waiting for the operator, else the first at work, else the newest. */
export function defaultRun(runs: readonly Run[], waiting: ReadonlySet<string>): Run | undefined {
  const { needsYou, running } = groupRuns(runs, waiting);
  return needsYou[0] ?? running[0] ?? runs[0];
}

/** Everything the run's steps reported as results, in step order. */
export function runArtifacts(run: Run): NonNullable<Step["artifacts"]> {
  return run.steps.flatMap((step) => step.artifacts ?? []);
}

/** Whether `filter` finds the run by its title, item key, workspace, workflow or id (case-insensitive). */
export function matchesFilter(run: Run, filter: string): boolean {
  const wanted = filter.trim().toLowerCase();
  if (wanted === "") return true;
  const { title, key } = runTitle(run);
  return [title, key, runWorkspace(run), run.workflow, run.id].some((text) => text?.toLowerCase().includes(wanted));
}

/** The step a run opens on: its agent step at work, else the one that failed, else its last agent step, else its first step. */
export function defaultStep(run: Run): Step | undefined {
  const agentSteps = run.steps.filter((step) => step.taskId !== undefined);
  return agentSteps.find((step) => step.status === "running") ?? agentSteps.find((step) => step.status === "failed") ?? agentSteps.at(-1) ?? run.steps[0];
}
