import type { A2A, AgentProfile } from "@tendworks/shared";
import { AgentNotFoundError, type AgentTasks } from "./agent-tasks.js";
import { answerAsFakeAgent } from "./fake-agent.js";
import { createInMemoryTaskStore, type TaskStore } from "./task-store.js";

/** Task metadata key: how often the runtime resumed the task after an interruption. */
export const RESUMED = "dev.tendworks/resumed";

export interface AgentRuntimeOptions {
  profiles: AgentProfile.AgentProfile[];
  /** Where tasks are kept; durable so tasks survive a restart. In memory by default. */
  store?: TaskStore;
  /** Waiting, replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const TERMINAL: ReadonlySet<A2A.TaskState> = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);

/**
 * Accepts A2A tasks and hands each to the harness its agent profile names. A message
 * whose task exists already returns that task: a finished one as it is, one that was
 * interrupted (e.g. by a restart) is resumed, never started again.
 */
export function createAgentRuntime({
  profiles,
  store = createInMemoryTaskStore(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => new Date(),
}: AgentRuntimeOptions): AgentTasks {
  const byName = new Map(profiles.map((profile) => [profile.metadata.name, profile]));
  // Tasks this process is working on, so a repeated message joins the running work.
  const inProgress = new Map<string, Promise<A2A.Task>>();

  async function work(profile: AgentProfile.AgentProfile, request: A2A.SendMessageRequest): Promise<A2A.Task> {
    const startedAt = now();
    const taskId = crypto.randomUUID();
    const claimed = await store.claim({
      messageId: request.message.messageId,
      agent: profile.metadata.name,
      startedAt: startedAt.toISOString(),
      task: {
        id: taskId,
        ...(request.message.contextId === undefined ? {} : { contextId: request.message.contextId }),
        status: { state: "TASK_STATE_WORKING", timestamp: startedAt.toISOString() },
        history: [request.message],
      },
    });
    if (TERMINAL.has(claimed.task.status.state)) return claimed.task;

    let metadata = claimed.task.metadata;
    if (claimed.task.id !== taskId) {
      // Known but unfinished: this process did not start it, so it was interrupted.
      const resumed = Number(metadata?.[RESUMED] ?? 0) + 1;
      metadata = { ...metadata, [RESUMED]: resumed };
      await store.update({ ...claimed.task, metadata });
    }
    const answer = await answerAsFakeAgent(profile.spec.fake ?? {}, request, {
      taskId: claimed.task.id,
      elapsedMs: now().getTime() - Date.parse(claimed.startedAt),
      sleep,
    });
    const done: A2A.Task = { ...answer, history: claimed.task.history ?? [request.message], ...(metadata ? { metadata } : {}) };
    await store.update(done);
    return done;
  }

  return {
    sendMessage(agent, request) {
      const profile = byName.get(agent);
      if (!profile) return Promise.reject(new AgentNotFoundError(agent));
      const known = inProgress.get(request.message.messageId);
      if (known) return known;
      const task = work(profile, request);
      inProgress.set(request.message.messageId, task);
      // Settled tasks are found in the store; a failed delivery may be retried.
      void task.finally(() => inProgress.delete(request.message.messageId)).catch(() => {});
      return task;
    },
    getTask: (taskId) => store.get(taskId),
  };
}
