import type { A2A } from "@tendworks/shared";
import type { AgentTaskExecutor, SendMessageOptions } from "./agent-task-executor.js";

type Respond = (request: A2A.SendMessageRequest, options?: SendMessageOptions) => A2A.Task | Promise<A2A.Task>;

/**
 * Agent task executor that answers from memory and records every request.
 * By default each agent creates a task and completes it immediately with an empty result.
 */
export class InMemoryAgentTaskExecutor implements AgentTaskExecutor {
  readonly requests: { agent: string; request: A2A.SendMessageRequest }[] = [];
  readonly #agents = new Map<string, Respond>();

  /** Sets how an agent answers. */
  agent(name: string, respond: Respond): this {
    this.#agents.set(name, respond);
    return this;
  }

  async sendMessage(agent: string, request: A2A.SendMessageRequest, options?: SendMessageOptions): Promise<A2A.Task> {
    this.requests.push({ agent, request });
    const respond = this.#agents.get(agent);
    if (respond) return respond(request, options);
    const id = `task-${this.requests.length}`;
    await options?.onTask?.({ id, status: { state: "TASK_STATE_WORKING" } });
    return { id, status: { state: "TASK_STATE_COMPLETED" } };
  }

  /** The parts of every message sent so far. */
  get parts(): A2A.Part[][] {
    return this.requests.map(({ request }) => request.message.parts);
  }
}
