import { createSecretResolver, newTraceparent, type SecretResolver } from "@tendworks/platform";
import type { TriggerBinding, TriggerGateway as Contract, Workspace } from "@tendworks/shared";
import type { FiringKey, FiringStore } from "./firings/firing-store.js";
import type { RunStarter } from "./runs.js";
import { checkSchedule, latestExecution, nextExecution } from "./schedule.js";
import type { TriggerItem, TriggerSource, TriggerSources } from "./sources/trigger-source.js";
import { triggerFired } from "./trigger-events.js";

export type Trigger = Contract.components["schemas"]["trigger"];

export interface TriggerGatewayOptions {
  bindings: TriggerBinding.TriggerBinding[];
  /** The configured workspaces; bindings refer to them by name. */
  workspaces?: Workspace.Workspace[];
  /**
   * The trigger sources deployed with the platform, by trigger kind (ADR 0023). The
   * gateway knows sources only through this registry; the server bundle passes it in.
   */
  sources: TriggerSources;
  store: FiringStore;
  runs: RunStarter;
  /** Resolves the secret references of sources: only platform secrets. Without it none resolves. */
  secrets?: SecretResolver;
  now?: () => Date;
  /** Where scheduled checks report what they did; defaults to the console. */
  log?: (line: string) => void;
}

/** What one check of a binding did, per workspace and item it had not fired for yet. */
export interface CheckResult {
  fired: { workspace?: string; item: string; runId: string }[];
  /**
   * Workspaces whose source could not be asked (no `item`), and items whose run could not
   * be started; the next check retries both.
   */
  failed: { workspace?: string; item?: string; error: string }[];
}

export interface TriggerGateway {
  /**
   * Asks the binding's source once per workspace, for the execution at or before now, and
   * starts a run for every new (workspace, item). Records how the check went.
   */
  check(binding: string): Promise<CheckResult>;
  /** The bindings, ordered by name, with their next scheduled execution and how their last check went. */
  triggers(): Promise<Trigger[]>;
  /** Checks every binding that is not suspended at its scheduled executions until {@link stop}. */
  start(): void;
  /** Stops scheduling and waits for running checks. */
  stop(): Promise<void>;
}

/** setTimeout cannot wait longer; a later execution is reached in several waits. */
const MAX_TIMER_MS = 2 ** 31 - 1;

interface Bound {
  binding: TriggerBinding.TriggerBinding;
  kind: string;
  source: TriggerSource;
}

/**
 * Creates the trigger gateway. Throws when a binding's trigger kind has no deployed
 * source or its schedule cannot be read, so such a binding stops the start.
 */
export function createTriggerGateway({
  bindings,
  workspaces = [],
  sources,
  store,
  runs,
  secrets = createSecretResolver("platform", {}),
  now = () => new Date(),
  log = (line) => console.info(line),
}: TriggerGatewayOptions): TriggerGateway {
  const byName = new Map(bindings.map((binding) => [binding.metadata.name, bind(binding, sources, secrets)]));
  const workspacesByName = new Map(workspaces.map((workspace) => [workspace.metadata.name, workspace]));
  const timers = new Map<string, NodeJS.Timeout>();
  const running = new Map<string, Promise<unknown>>();
  let started = false;

  async function check(name: string, execution?: Date): Promise<CheckResult> {
    const bound = byName.get(name);
    if (!bound) throw new Error(`unknown trigger binding '${name}'`);
    const at = now().toISOString();
    let result: CheckResult;
    try {
      result = await evaluate(name, bound, execution ?? latestExecution(bound.source.schedule, now()));
    } catch (error) {
      await store.recordEvaluation(name, { at, status: "failed", startedRuns: 0, message: errorMessage(error) });
      throw error;
    }
    const { fired, failed } = result;
    const message = failed.map(describeFailure).join("; ");
    await store.recordEvaluation(name, { at, status: failed.length > 0 ? "failed" : "succeeded", startedRuns: fired.length, ...(message ? { message } : {}) });
    return result;
  }

  async function evaluate(name: string, { binding, source }: Bound, execution: Date): Promise<CheckResult> {
    const { workflow, workspaces: names } = binding.spec;
    const result: CheckResult = { fired: [], failed: [] };
    // Without workspaces the binding is asked once, for no workspace.
    for (const workspaceName of names?.length ? names : [undefined]) {
      const workspace = workspaceName === undefined ? undefined : workspacesByName.get(workspaceName);
      const scope = workspaceName === undefined ? {} : { workspace: workspaceName };
      let items: TriggerItem[];
      try {
        if (workspaceName !== undefined && !workspace) throw new Error(`no workspace '${workspaceName}' is configured`);
        items = await source.items({ at: execution, ...(workspace ? { workspace } : {}) });
      } catch (error) {
        result.failed.push({ ...scope, error: errorMessage(error) });
        continue;
      }
      for (const item of items) {
        const key: FiringKey = { binding: name, workspace: workspaceName ?? "", item: item.key };
        if (!(await store.claim(key))) continue;
        // A firing starts a trace; the run and all its events belong to it.
        const traceparent = newTraceparent();
        const reference = { key: item.key, title: item.title, ...(item.url === undefined ? {} : { url: item.url }) };
        let runId: string;
        try {
          const startedBy = { kind: "trigger" as const, binding: name, ...scope, item: reference };
          runId = (await runs.start({ workflow, input: { ...scope, item: structuredClone(item) }, traceparent, startedBy })).id;
        } catch (error) {
          await store.release(key);
          result.failed.push({ ...scope, item: item.key, error: errorMessage(error) });
          continue;
        }
        // From here on the run exists: the claim is never released again, so no second run starts.
        await store.fired(key, runId, triggerFired({ binding: name, ...scope, workflow, runId, item: reference, time: now().toISOString(), traceparent }));
        result.fired.push({ ...scope, item: item.key, runId });
      }
    }
    return result;
  }

  // One check per binding at a time; an execution that finds the previous one still running is skipped.
  async function scheduledCheck(name: string, execution: Date): Promise<void> {
    if (running.has(name)) return;
    const done = check(name, execution).then(
      ({ fired, failed }) => {
        for (const { workspace, item, runId } of fired) log(`trigger ${name}: ${workspace === undefined ? "" : `workspace ${workspace}: `}${item} started run ${runId}`);
        for (const failure of failed) log(`trigger ${name}: ${describeFailure(failure)}`);
      },
      (error: unknown) => log(`trigger ${name}: check failed: ${errorMessage(error)}`),
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
      void scheduledCheck(name, at).then(() => schedule(name, nextExecution(byName.get(name)!.source.schedule, now())));
    }, Math.max(0, Math.min(wait, MAX_TIMER_MS)));
    timers.set(name, timer);
  }

  return {
    check: (name) => check(name),
    async triggers() {
      const evaluations = await store.lastEvaluations();
      return [...byName.values()]
        .map(({ binding: { metadata, spec }, kind, source }) => {
          const lastEvaluation = evaluations.get(metadata.name);
          return {
            name: metadata.name,
            workflow: spec.workflow,
            kind,
            workspaces: [...(spec.workspaces ?? [])],
            schedule: structuredClone(source.schedule),
            nextExecutionAt: nextExecution(source.schedule, now()).toISOString(),
            ...(spec.suspend ? { suspended: true } : {}),
            ...(lastEvaluation ? { lastEvaluation } : {}),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    start() {
      if (started) return;
      started = true;
      for (const [name, { binding, source }] of byName) {
        if (!binding.spec.suspend) schedule(name, nextExecution(source.schedule, now()));
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

/** The binding's trigger source, created by the factory its trigger kind selects. */
function bind(binding: TriggerBinding.TriggerBinding, sources: TriggerSources, secrets: SecretResolver): Bound {
  const name = binding.metadata.name;
  const [kind, settings] = Object.entries(binding.spec.trigger)[0] ?? [];
  if (kind === undefined) throw new Error(`trigger binding '${name}' has no trigger`);
  const create = Object.hasOwn(sources, kind) ? sources[kind] : undefined;
  if (!create) {
    const deployed = Object.keys(sources).sort().join(", ") || "none";
    throw new Error(`trigger binding '${name}' has a trigger of kind '${kind}', but no trigger source '${kind}' is deployed (deployed: ${deployed})`);
  }
  const source = create(settings as never, { secrets });
  try {
    checkSchedule(source.schedule);
  } catch (error) {
    throw new Error(`trigger binding '${name}': ${errorMessage(error)}`, { cause: error });
  }
  return { binding, kind, source };
}

function describeFailure({ workspace, item, error }: CheckResult["failed"][number]): string {
  const scope = workspace === undefined ? "" : `workspace ${workspace}: `;
  return `${scope}${item === undefined ? "could not ask the source" : `${item} could not start a run`}: ${error}`;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
