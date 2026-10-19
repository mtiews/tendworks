import type { A2A, AgentProfile } from "@tendworks/shared";
import { AgentNotFoundError, COST, TRANSCRIPT, type AgentTasks } from "./agent-tasks.js";
import { createFakeHarness } from "./fake-agent.js";
import type { Harness, HarnessResult } from "./harness.js";
import { createInMemoryTranscriptStore, type TranscriptEntry, type TranscriptStore } from "./transcripts/transcript-store.js";

export type HarnessName = AgentProfile.AgentProfileSpec["harness"];

export interface AgentRuntimeOptions {
  profiles: AgentProfile.AgentProfile[];
  /** Harnesses by the name agent profiles use in `spec.harness`. The fake agent (`fake`) is built in. */
  harnesses?: Partial<Record<HarnessName, Harness>>;
  /** Where transcripts of agent sessions are kept; in memory by default. */
  transcripts?: TranscriptStore;
  /** Waiting, replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/**
 * Accepts A2A tasks and hands each to the harness its agent profile names, recording
 * the session's transcript and cost. Tasks live in memory: after a restart a repeated
 * message starts a new task.
 */
export function createAgentRuntime({
  profiles,
  harnesses = {},
  transcripts = createInMemoryTranscriptStore(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => new Date(),
}: AgentRuntimeOptions): AgentTasks {
  const byName = new Map(profiles.map((profile) => [profile.metadata.name, profile]));
  const available: Partial<Record<HarnessName, Harness>> = { fake: createFakeHarness({ sleep }), ...harnesses };
  const byMessage = new Map<string, Promise<A2A.Task>>();
  const tasks = new Map<string, A2A.Task>();

  async function work(profile: AgentProfile.AgentProfile, request: A2A.SendMessageRequest): Promise<A2A.Task> {
    const taskId = crypto.randomUUID();
    const transcript = transcripts.open(taskId);
    let writes = Promise.resolve();
    const record = (entry: TranscriptEntry) => {
      const stamped = { time: now().toISOString(), ...entry };
      writes = writes.then(() => transcript.append(stamped));
    };
    const task = (state: A2A.TaskState, text: string, extra: Partial<A2A.Task> = {}): A2A.Task => ({
      id: taskId,
      ...(request.message.contextId === undefined ? {} : { contextId: request.message.contextId }),
      status: {
        state,
        message: { messageId: `${taskId}/status`, taskId, role: "ROLE_AGENT", parts: [{ text }] },
        timestamp: now().toISOString(),
      },
      history: [request.message],
      ...extra,
      metadata: { ...extra.metadata, [TRANSCRIPT]: transcript.ref },
    });

    tasks.set(taskId, task("TASK_STATE_WORKING", "starting"));
    record({ type: "task", profile: profile.metadata.name, message: request.message });

    const harness = available[profile.spec.harness];
    let result: HarnessResult;
    if (!harness) {
      result = { state: "TASK_STATE_FAILED", message: `harness ${profile.spec.harness} is not available in this agent runtime` };
    } else {
      try {
        result = await harness.run(
          { taskId, profile, message: request.message },
          { record, progress: (text) => tasks.set(taskId, task("TASK_STATE_WORKING", text)) },
        );
      } catch (error) {
        tasks.delete(taskId);
        throw error;
      }
    }

    record({ type: "result", state: result.state, message: result.message, ...(result.cost ? { cost: result.cost } : {}) });
    await writes;
    const done = task(result.state, result.message, {
      ...(result.artifacts ? { artifacts: result.artifacts } : {}),
      ...(result.cost ? { metadata: { [COST]: { ...result.cost } } } : {}),
    });
    tasks.set(taskId, done);
    return done;
  }

  return {
    sendMessage(agent, request) {
      const profile = byName.get(agent);
      if (!profile) return Promise.reject(new AgentNotFoundError(agent));
      const known = byMessage.get(request.message.messageId);
      if (known) return known;
      const task = work(profile, request);
      byMessage.set(request.message.messageId, task);
      // A failed delivery may be retried with the same message.
      task.catch(() => byMessage.delete(request.message.messageId));
      return task;
    },
    async getTask(taskId) {
      return tasks.get(taskId);
    },
  };
}
