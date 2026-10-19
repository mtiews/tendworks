import type { TriggerBinding, TriggerGateway as Contract } from "@tendworks/shared";
import type { FiringStore } from "./firings/firing-store.js";
import { mapInput } from "./input.js";
import type { Issue, IssueSource, IssueTracker } from "./issues/issue-tracker.js";
import { issueTrackerFor } from "./issues/issue-tracker-for.js";
import type { RunStarter } from "./runs.js";
import { nextExecution } from "./schedule.js";
import { triggerFired } from "./trigger-events.js";

export type Trigger = Contract.components["schemas"]["trigger"];

export interface TriggerGatewayOptions {
  bindings: TriggerBinding.TriggerBinding[];
  store: FiringStore;
  runs: RunStarter;
  /** Resolves a binding's source to its issue tracker; defaults to the built-in integrations. */
  issueTrackers?: (source: IssueSource) => IssueTracker;
  now?: () => Date;
  /** Where scheduled checks report what they did; defaults to the console. */
  log?: (line: string) => void;
}

/** What one check of a binding did, per matching issue it had not fired for yet. */
export interface CheckResult {
  fired: { issue: string; runId: string }[];
  /** Issues whose run could not be started; the next check retries them. */
  failed: { issue: string; error: string }[];
}

export interface TriggerGateway {
  /** Asks the binding's source once and starts a run for every new match. */
  check(binding: string): Promise<CheckResult>;
  /** The bindings, ordered by name, with their next scheduled execution. */
  triggers(): Trigger[];
  /** Checks every binding at its scheduled executions until {@link stop}. */
  start(): void;
  /** Stops scheduling and waits for running checks. */
  stop(): Promise<void>;
}

const DEFAULT_INPUT = { issue: "${ .issue }" };
/** setTimeout cannot wait longer; a later execution is reached in several waits. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export function createTriggerGateway({
  bindings,
  store,
  runs,
  issueTrackers = issueTrackerFor,
  now = () => new Date(),
  log = (line) => console.log(line),
}: TriggerGatewayOptions): TriggerGateway {
  const byName = new Map(bindings.map((binding) => [binding.metadata.name, binding]));
  const timers = new Map<string, NodeJS.Timeout>();
  const running = new Map<string, Promise<unknown>>();
  let started = false;

  async function check(name: string): Promise<CheckResult> {
    const binding = byName.get(name);
    if (!binding) throw new Error(`unknown trigger binding '${name}'`);
    const { source, workflow, input = DEFAULT_INPUT } = binding.spec;
    const issues = await issueTrackers(source).findIssues(source.issues);
    const result: CheckResult = { fired: [], failed: [] };
    for (const issue of issues) {
      const key = { binding: name, item: itemKey(issue) };
      if (!(await store.claim(key))) continue;
      let runId: string;
      try {
        runId = (await runs.start({ workflow, input: mapInput(input, { issue }) as Record<string, unknown> })).id;
      } catch (error) {
        await store.release(key);
        result.failed.push({ issue: key.item, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      // From here on the run exists: the claim is never released again, so no second run starts.
      const reference = { repository: issue.repository, number: issue.number, title: issue.title, url: issue.url };
      await store.fired(key, runId, triggerFired({ ...key, workflow, runId, issue: reference, time: now().toISOString() }));
      result.fired.push({ issue: key.item, runId });
    }
    return result;
  }

  // One check per binding at a time; an execution that finds the previous one still running is skipped.
  async function scheduledCheck(name: string): Promise<void> {
    if (running.has(name)) return;
    const done = check(name).then(
      ({ fired, failed }) => {
        for (const { issue, runId } of fired) log(`trigger ${name}: ${issue} started run ${runId}`);
        for (const { issue, error } of failed) log(`trigger ${name}: ${issue} could not start a run, retrying next time: ${error}`);
      },
      (error: unknown) => log(`trigger ${name}: check failed: ${error instanceof Error ? error.message : String(error)}`),
    );
    running.set(name, done);
    await done;
    running.delete(name);
  }

  function schedule(name: string, at: Date): void {
    if (!started) return;
    const wait = at.getTime() - now().getTime();
    const timer = setTimeout(() => {
      if (wait > MAX_TIMER_MS) return schedule(name, at);
      void scheduledCheck(name).then(() => schedule(name, nextExecution(byName.get(name)!.spec.schedule, now())));
    }, Math.max(0, Math.min(wait, MAX_TIMER_MS)));
    timers.set(name, timer);
  }

  return {
    check,
    triggers() {
      return [...byName.values()]
        .map(({ metadata, spec }) => ({
          name: metadata.name,
          workflow: spec.workflow,
          schedule: structuredClone(spec.schedule),
          nextExecutionAt: nextExecution(spec.schedule, now()).toISOString(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    start() {
      if (started) return;
      started = true;
      for (const [name, binding] of byName) schedule(name, nextExecution(binding.spec.schedule, now()));
    },
    async stop() {
      started = false;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await Promise.all(running.values());
    },
  };
}

const itemKey = (issue: Issue) => `${issue.repository}#${issue.number}`;
