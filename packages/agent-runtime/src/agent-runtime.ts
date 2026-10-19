import type { A2A, AgentProfile } from "@tendworks/shared";
import { AgentNotFoundError, COST, TRANSCRIPT, type AgentTasks } from "./agent-tasks.js";
import { createFakeHarness } from "./fake-agent.js";
import type { Harness, HarnessResult } from "./harness.js";
import { createInMemoryTaskStore, type TaskStore } from "./task-store.js";
import { createInMemoryTranscriptStore, type TranscriptEntry, type TranscriptStore } from "./transcripts/transcript-store.js";

/** Task metadata key: how often the runtime resumed the task after an interruption. */
export const RESUMED = "dev.tendworks/resumed";

export type HarnessName = AgentProfile.AgentProfileSpec["harness"];

export interface AgentRuntimeOptions {
  profiles: AgentProfile.AgentProfile[];
  /** Harnesses by the name agent profiles use in `spec.harness`. The fake agent (`fake`) is built in. */
  harnesses?: Partial<Record<HarnessName, Harness>>;
  /** Where tasks are kept; durable so tasks survive a restart. In memory by default. */
  store?: TaskStore;
  /** Where transcripts of agent sessions are kept; in memory by default. */
  transcripts?: TranscriptStore;
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
 * Accepts A2A tasks and hands each to the harness its agent profile names, recording
 * the session's transcript and cost. A message whose task exists already returns that
 * task: a finished one as it is, one that was interrupted (e.g. by a restart) is
 * resumed, never started again.
 */
export function createAgentRuntime({
  profiles,
  harnesses = {},
  store = createInMemoryTaskStore(),
  transcripts = createInMemoryTranscriptStore(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => new Date(),
}: AgentRuntimeOptions): AgentTasks {
  const byName = new Map(profiles.map((profile) => [profile.metadata.name, profile]));
  const available: Partial<Record<HarnessName, Harness>> = { fake: createFakeHarness({ sleep }), ...harnesses };
  // Tasks this process is working on, so a repeated message joins the running work.
  const inProgress = new Map<string, Promise<A2A.Task>>();
  // Progress of running tasks; only the start and the end are written to the store.
  const working = new Map<string, A2A.Task>();

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

    const id = claimed.task.id;
    const transcript = transcripts.open(id);
    let metadata: Record<string, unknown> = { ...claimed.task.metadata, [TRANSCRIPT]: transcript.ref };
    if (id !== taskId) {
      // Known but unfinished: this process did not start it, so it was interrupted.
      metadata = { ...metadata, [RESUMED]: Number(metadata[RESUMED] ?? 0) + 1 };
    }
    await store.update({ ...claimed.task, metadata });

    let writes = Promise.resolve();
    const record = (entry: TranscriptEntry) => {
      const stamped = { time: now().toISOString(), ...entry };
      writes = writes.then(() => transcript.append(stamped));
    };
    const withStatus = (state: A2A.TaskState, text: string): A2A.Task => ({
      ...claimed.task,
      history: claimed.task.history ?? [request.message],
      status: {
        state,
        message: { messageId: `${id}/status`, taskId: id, role: "ROLE_AGENT", parts: [{ text }] },
        timestamp: now().toISOString(),
      },
      metadata,
    });

    record({ type: id === taskId ? "task" : "task-resumed", profile: profile.metadata.name, message: request.message });
    const harness = available[profile.spec.harness];
    let result: HarnessResult;
    if (!harness) {
      result = { state: "TASK_STATE_FAILED", message: `harness ${profile.spec.harness} is not available in this agent runtime` };
    } else {
      try {
        result = await harness.run(
          { taskId: id, profile, message: request.message, elapsedMs: now().getTime() - Date.parse(claimed.startedAt) },
          { record, progress: (text) => working.set(id, withStatus("TASK_STATE_WORKING", text)) },
        );
      } finally {
        working.delete(id);
      }
    }

    record({ type: "result", state: result.state, message: result.message, ...(result.cost ? { cost: result.cost } : {}) });
    await writes;
    if (result.cost) metadata = { ...metadata, [COST]: { ...result.cost } };
    const done: A2A.Task = { ...withStatus(result.state, result.message), ...(result.artifacts ? { artifacts: result.artifacts } : {}) };
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
    async getTask(taskId) {
      // The store is the truth once the task ended, possibly in another process after a restart.
      const stored = await store.get(taskId);
      if (stored && TERMINAL.has(stored.status.state)) return stored;
      return working.get(taskId) ?? stored;
    },
  };
}
