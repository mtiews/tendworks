import type { AgentRuntime as Contract } from "@tendworks/shared";
import { Hono } from "hono";
import type { AgentRuntime } from "./agent-runtime.js";

type Schemas = Contract.components["schemas"];

export interface AgentRuntimeApiOptions {
  runtime: Pick<AgentRuntime, "transcript">;
}

/**
 * The agent runtime's internal API as a fetch handler, served by the worker for the
 * control plane; see contracts/openapi/agent-runtime.yaml.
 */
export function createAgentRuntimeApi({ runtime }: AgentRuntimeApiOptions): { fetch(request: Request): Promise<Response> } {
  const app = new Hono();
  const problem = (status: 404, title: string, detail?: string): Response =>
    Response.json({ title, status, ...(detail === undefined ? {} : { detail }) } satisfies Schemas["Problem"], { status });

  app.get("/tasks/:taskId/transcript", async (c) => {
    const taskId = c.req.param("taskId");
    const items = await runtime.transcript(taskId);
    if (!items) return problem(404, "Task not found", `no task '${taskId}' with a transcript exists`);
    // Same schema; the two type generators only disagree on free-form data parts.
    return c.json({ items: items as Schemas["TranscriptEntryList"]["items"] } satisfies Schemas["TranscriptEntryList"], 200);
  });

  return { fetch: async (request) => app.fetch(request) };
}
