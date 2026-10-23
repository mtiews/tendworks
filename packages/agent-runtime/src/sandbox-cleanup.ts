import type { Sandboxes } from "./sandboxes.js";
import type { TaskStore } from "./task-store.js";

/** What the clean-up needs from the sandbox API: the installation's resources, and removing them. */
export type CleanupSandboxes = Pick<Sandboxes, "list" | "listVolumes" | "destroy" | "deleteVolume">;

export interface SandboxCleanupOptions {
  sandboxes: CleanupSandboxes;
  /** Where the live tasks and open chats are found: those that have not ended. */
  store: Pick<TaskStore, "active">;
  /** Where removals and failures go; the console by default. */
  log?: { info(line: string): void; error(line: string): void };
  /** How long between two passes after {@link SandboxCleanup.start}; 5 minutes by default. */
  intervalMs?: number;
}

/** The outcome of one pass: what it removed and what it could not. */
export interface CleanupPass {
  removed: string[];
  failed: string[];
}

/**
 * Removes the sandboxes and session volumes of the installation that belong to no live
 * task and no open chat (tasks of either kind that have not ended): orphans of tasks that
 * ended while a removal failed, of a worker that died, or of a store that was reset.
 * Sandboxes go before volumes, since a volume cannot go while a sandbox mounts it. Every
 * removal is logged; a failed one is logged and reported as an unhealthy component (a
 * health probe) until a later pass gets it done.
 */
export interface SandboxCleanup {
  /** The component name the clean-up reports its health under. */
  readonly name: "sandbox-cleanup";
  /** Unhealthy while removals of the last pass failed, naming them. */
  check(): Promise<{ status: "healthy" } | { status: "unhealthy"; message: string }>;
  /** One pass; a pass already running is joined instead of started again. Never rejects. */
  run(): Promise<CleanupPass>;
  /** A pass now, then one every interval until {@link SandboxCleanup.stop}. Does not keep the process alive. */
  start(): void;
  /** No further passes; resolves once a running pass is over. */
  stop(): Promise<void>;
}

/** Session volumes of tasks, `<task>-workspace` and `<task>-session` (claude-code harness). */
const SESSION_VOLUME = /^(.+)-(?:workspace|session)$/;

export function createSandboxCleanup({ sandboxes, store, log = console, intervalMs = 5 * 60_000 }: SandboxCleanupOptions): SandboxCleanup {
  let running: Promise<CleanupPass> | undefined;
  let problem: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

  async function pass(): Promise<CleanupPass> {
    const removed: string[] = [];
    const failed: string[] = [];
    try {
      // Listed before the live tasks are read: a task is recorded before it creates its
      // sandbox, so whatever a listing holds belongs to a task the later read knows.
      const [listed, volumes] = [await sandboxes.list(), await sandboxes.listVolumes()];
      const live = new Set((await store.active()).map((stored) => stored.task.id));
      const remove = async (what: string, owner: string, action: () => Promise<void>) => {
        try {
          await action();
          removed.push(what);
          log.info(`sandbox clean-up: removed ${what} of ${owner}, which is no live task or open chat`);
        } catch (error) {
          failed.push(`${what}: ${reason(error)}`);
          log.error(`sandbox clean-up: cannot remove ${what} of ${owner}: ${reason(error)}; the next pass retries it`);
        }
      };
      for (const sandbox of listed) {
        // A sandbox without an owner was created by a worker from before owners were
        // recorded, so nothing can reattach to it any more.
        if (sandbox.owner !== undefined && live.has(sandbox.owner)) continue;
        await remove(`sandbox ${sandbox.id}`, sandbox.owner ?? "no recorded task", () => sandboxes.destroy(sandbox.id));
      }
      for (const volume of volumes) {
        // A volume without an owner is a task's by its name; other volumes are left alone.
        const owner = volume.owner ?? SESSION_VOLUME.exec(volume.name)?.[1];
        if (owner === undefined || live.has(owner)) continue;
        await remove(`volume ${volume.name}`, owner, () => sandboxes.deleteVolume(volume.name));
      }
      problem = failed.length === 0 ? undefined : `${failed.length} removal${failed.length === 1 ? "" : "s"} failed in the last pass, the next pass retries: ${failed.join("; ")}`;
    } catch (error) {
      failed.push(reason(error));
      problem = `the last pass failed: ${reason(error)}`;
      log.error(`sandbox clean-up: the pass failed: ${reason(error)}; the next pass retries it`);
    }
    return { removed, failed };
  }

  const cleanup: SandboxCleanup = {
    name: "sandbox-cleanup",
    async check() {
      return problem === undefined ? { status: "healthy" } : { status: "unhealthy", message: problem };
    },
    run() {
      running ??= pass().finally(() => (running = undefined));
      return running;
    },
    start() {
      stopped = false;
      const next = () => {
        void cleanup.run().then(() => {
          if (!stopped) timer = setTimeout(next, intervalMs).unref();
        });
      };
      next();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
  return cleanup;
}
