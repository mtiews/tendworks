import { createSecretResolver, newTraceparent, type SecretResolver } from "@tendworks/platform";
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
  /** Resolves the secret references of bindings: only platform secrets. Without it none resolves. */
  secrets?: SecretResolver;
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
  /**
   * Asks the binding's source once and starts a run for every new match. Records how
   * the check went, also when it fails (and then rejects).
   */
  check(binding: string): Promise<CheckResult>;
  /** The bindings, ordered by name, with their next scheduled execution and how their last check went. */
  triggers(): Promise<Trigger[]>;
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
  secrets = createSecretResolver("platform", {}),
  issueTrackers = (source) => issueTrackerFor(source, { secrets }),
  now = () => new Date(),
  log = (line) => console.info(line),
}: TriggerGatewayOptions): TriggerGateway {
  const byName = new Map(bindings.map((binding) => [binding.metadata.name, binding]));
  const timers = new Map<string, NodeJS.Timeout>();
  const running = new Map<string, Promise<unknown>>();
  let started = false;

  async function check(name: string): Promise<CheckResult> {
    const binding = byName.get(name);
    if (!binding) throw new Error(`unknown trigger binding '${name}'`);
    const at = now().toISOString();
    let result: CheckResult;
    try {
      result = await evaluate(name, binding);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.recordEvaluation(name, { at, status: "failed", startedRuns: 0, message });
      throw error;
    }
    const { fired, failed } = result;
    const message = failed.map(({ issue, error }) => `${issue} could not start a run: ${error}`).join("; ");
    await store.recordEvaluation(name, { at, status: failed.length > 0 ? "failed" : "succeeded", startedRuns: fired.length, ...(message ? { message } : {}) });
    return result;
  }

  async function evaluate(name: string, binding: TriggerBinding.TriggerBinding): Promise<CheckResult> {
    const { source, workflow, input = DEFAULT_INPUT } = binding.spec;
    const issues = await issueTrackers(source).findIssues(source.issues);
    const result: CheckResult = { fired: [], failed: [] };
    for (const issue of issues) {
      const key = { binding: name, item: itemKey(issue) };
      if (!(await store.claim(key))) continue;
      // A firing starts a trace; the run and all its events belong to it.
      const traceparent = newTraceparent();
      const reference = { repository: issue.repository, number: issue.number, title: issue.title, url: issue.url };
      let runId: string;
      try {
        const startedBy = { kind: "trigger" as const, binding: name, issue: reference };
        runId = (await runs.start({ workflow, input: mapInput(input, { issue }) as Record<string, unknown>, traceparent, startedBy })).id;
      } catch (error) {
        await store.release(key);
        result.failed.push({ issue: key.item, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      // From here on the run exists: the claim is never released again, so no second run starts.
      await store.fired(key, runId, triggerFired({ ...key, workflow, runId, issue: reference, time: now().toISOString(), traceparent }));
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
    async triggers() {
      const evaluations = await store.lastEvaluations();
      return [...byName.values()]
        .map(({ metadata, spec }) => {
          const lastEvaluation = evaluations.get(metadata.name);
          return {
            name: metadata.name,
            workflow: spec.workflow,
            schedule: structuredClone(spec.schedule),
            nextExecutionAt: nextExecution(spec.schedule, now()).toISOString(),
            ...(spec.suspend ? { suspended: true } : {}),
            ...(lastEvaluation ? { lastEvaluation } : {}),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    start() {
      if (started) return;
      started = true;
      for (const [name, binding] of byName) {
        if (!binding.spec.suspend) schedule(name, nextExecution(binding.spec.schedule, now()));
      }
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
