import type { A2A, AgentProfile } from "@tendworks/shared";
import { AgentNotFoundError, type AgentTasks } from "./agent-tasks.js";
import { answerAsFakeAgent } from "./fake-agent.js";

export interface AgentRuntimeOptions {
  profiles: AgentProfile.AgentProfile[];
  /** Waiting, replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Accepts A2A tasks and hands each to the harness its agent profile names. Tasks live
 * in memory: after a restart a repeated message starts a new task.
 */
export function createAgentRuntime({
  profiles,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: AgentRuntimeOptions): AgentTasks {
  const byName = new Map(profiles.map((profile) => [profile.metadata.name, profile]));
  const byMessage = new Map<string, Promise<A2A.Task>>();
  const tasks = new Map<string, A2A.Task>();

  return {
    sendMessage(agent, request) {
      const profile = byName.get(agent);
      if (!profile) return Promise.reject(new AgentNotFoundError(agent));
      const known = byMessage.get(request.message.messageId);
      if (known) return known;
      const task = answerAsFakeAgent(profile.spec.fake ?? {}, request, { taskId: crypto.randomUUID(), sleep }).then((done) => {
        tasks.set(done.id, done);
        return done;
      });
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
