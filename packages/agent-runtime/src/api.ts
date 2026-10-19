import { serverSentEventStream, type ServerSentEvent } from "@tendworks/platform";
import type { AgentRuntime as Contract } from "@tendworks/shared";
import { Hono } from "hono";
import type { AgentRuntime } from "./agent-runtime.js";
import type { TranscriptEntry } from "./transcripts/transcript-store.js";

type Schemas = Contract.components["schemas"];

export interface AgentRuntimeApiOptions {
  runtime: Pick<AgentRuntime, "transcript" | "follow">;
  /** How long a transcript stream may stay silent before a comment keeps it open; 15 s by default. */
  keepAliveMs?: number;
}

/** A position as `Last-Event-ID` carries it. */
const POSITION = /^(0|[1-9][0-9]*)$/;

/**
 * The agent runtime's internal API as a fetch handler, served by the worker for the
 * control plane; see contracts/openapi/agent-runtime.yaml.
 */
export function createAgentRuntimeApi({ runtime, keepAliveMs = 15_000 }: AgentRuntimeApiOptions): { fetch(request: Request): Promise<Response> } {
  const app = new Hono();
  const problem = (status: 400 | 404, title: string, detail?: string): Response =>
    Response.json({ title, status, ...(detail === undefined ? {} : { detail }) } satisfies Schemas["Problem"], { status });

  app.get("/tasks/:taskId/transcript", async (c) => {
    const taskId = c.req.param("taskId");
    const items = await runtime.transcript(taskId);
    if (!items) return problem(404, "Task not found", `no task '${taskId}' with a transcript exists`);
    // Same schema; the two type generators only disagree on free-form data parts.
    return c.json({ items: items as Schemas["TranscriptEntryList"]["items"] } satisfies Schemas["TranscriptEntryList"], 200);
  });

  app.get("/tasks/:taskId/transcript/stream", async (c) => {
    const taskId = c.req.param("taskId");
    const lastEventId = c.req.header("last-event-id");
    if (lastEventId !== undefined && !POSITION.test(lastEventId)) {
      return problem(400, "Invalid Last-Event-ID", "Last-Event-ID must be the position of a transcript entry, e.g. 41");
    }
    const entries = await runtime.follow(taskId, lastEventId === undefined ? {} : { after: Number(lastEventId) });
    if (!entries) return problem(404, "Task not found", `no task '${taskId}' exists`);
    return transcriptStream(entries, keepAliveMs);
  });

  return { fetch: async (request) => app.fetch(request) };
}

/**
 * A followed transcript as a `text/event-stream` response (contracts/schemas/
 * transcript-entry.schema.yaml#/$defs/streamEvent): one `entry` event per entry with its
 * position as id, then `end`. A client that goes away stops the following at once.
 */
function transcriptStream(entries: AsyncIterableIterator<TranscriptEntry>, keepAliveMs: number): Response {
  let ended = false;
  const events: AsyncIterableIterator<ServerSentEvent> = {
    [Symbol.asyncIterator]: () => events,
    async next() {
      if (ended) return { done: true, value: undefined };
      const next = await entries.next();
      if (!next.done) return { done: false, value: { id: String(next.value.position), event: "entry", data: JSON.stringify(next.value) } };
      ended = true;
      return { done: false, value: { event: "end", data: "{}" } };
    },
    async return() {
      ended = true;
      await entries.return?.();
      return { done: true, value: undefined };
    },
  };
  return new Response(serverSentEventStream(events, { keepAliveMs }), {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
  });
}
