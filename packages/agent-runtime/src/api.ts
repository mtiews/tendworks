import { serverSentEventStream, type ServerSentEvent } from "@tendworks/platform";
import type { A2A, AgentRuntime as Contract } from "@tendworks/shared";
import { Hono } from "hono";
import type { AgentRuntime } from "./agent-runtime.js";
import { AgentNotFoundError } from "./agent-tasks.js";
import { AssistantNotEnabledError, ChatBusyError, ChatEndedError, ChatNotAllowedError, UnknownWorkspaceError, type Chat } from "./chats.js";
import type { TranscriptEntry } from "./transcripts/transcript-store.js";

type Schemas = Contract.components["schemas"];

export interface AgentRuntimeApiOptions {
  runtime: Pick<AgentRuntime, "transcript" | "follow" | "startChat" | "sendChatMessage" | "cancelChatTurn" | "endChat" | "getChat" | "listChats" | "listSessions">;
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
  const problem = (status: 400 | 404 | 409, title: string, detail?: string): Response =>
    Response.json({ title, status, ...(detail === undefined ? {} : { detail }) } satisfies Schemas["Problem"], { status });

  const textOf = async (request: Request): Promise<string | undefined> => {
    const body = (await request.json().catch(() => undefined)) as { text?: unknown } | undefined;
    return typeof body?.text === "string" && body.text !== "" ? body.text : undefined;
  };
  const userMessage = (text: string): A2A.Message => ({ messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }] });
  const noChat = (chatId: string) => problem(404, "Chat not found", `no chat '${chatId}' exists`);

  app.post("/chats", async (c) => {
    const body = (await c.req.raw.clone().json().catch(() => undefined)) as Record<string, unknown> | undefined;
    const text = await textOf(c.req.raw);
    const chatWith = chatWithOf(body);
    if (!chatWith || text === undefined) {
      return problem(
        400,
        "Invalid request",
        "the body must be { agent, text } with the name of an agent profile, or { workspace, text } with the name of a workspace whose assistant is enabled, and the first message",
      );
    }
    try {
      const chat = await runtime.startChat(chatWith, userMessage(text));
      return c.json(chat satisfies Chat, 201, { location: `/chats/${chat.id}` });
    } catch (error) {
      if (error instanceof AgentNotFoundError) return problem(400, "Unknown agent profile", error.message);
      if (error instanceof ChatNotAllowedError || error instanceof AssistantNotEnabledError) return problem(400, "Chat not allowed", error.message);
      if (error instanceof UnknownWorkspaceError) return problem(400, "Unknown workspace", error.message);
      throw error;
    }
  });

  app.get("/chats", async (c) => c.json({ items: await runtime.listChats() } satisfies Schemas["chatList"], 200));

  app.get("/chats/:chatId", async (c) => {
    const chat = await runtime.getChat(c.req.param("chatId"));
    return chat ? c.json(chat satisfies Chat, 200) : noChat(c.req.param("chatId"));
  });

  app.post("/chats/:chatId/messages", async (c) => {
    const chatId = c.req.param("chatId");
    const text = await textOf(c.req.raw);
    if (text === undefined) return problem(400, "Invalid request", "the body must be { text } with the next message");
    try {
      const chat = await runtime.sendChatMessage(chatId, userMessage(text));
      return chat ? c.json(chat satisfies Chat, 200) : noChat(chatId);
    } catch (error) {
      if (error instanceof ChatBusyError) return problem(409, "Turn in progress", error.message);
      if (error instanceof ChatEndedError) return problem(409, "Chat ended", error.message);
      throw error;
    }
  });

  app.post("/chats/:chatId/cancel", async (c) => {
    const chatId = c.req.param("chatId");
    try {
      const chat = await runtime.cancelChatTurn(chatId);
      return chat ? c.json(chat satisfies Chat, 200) : noChat(chatId);
    } catch (error) {
      if (error instanceof ChatEndedError) return problem(409, "Chat ended", error.message);
      throw error;
    }
  });

  app.post("/chats/:chatId/end", async (c) => {
    const chat = await runtime.endChat(c.req.param("chatId"));
    return chat ? c.json(chat satisfies Chat, 200) : noChat(c.req.param("chatId"));
  });

  app.get("/sessions", async (c) => c.json({ items: await runtime.listSessions() } satisfies Schemas["agentSessionList"], 200));

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
 * Whom a start-chat body asks to chat with: exactly one of an agent profile (`agent`) and a
 * workspace's assistant (`workspace`), and nothing else besides the text; undefined otherwise.
 */
function chatWithOf(body: Record<string, unknown> | undefined): string | { workspace: string } | undefined {
  if (!body || Object.keys(body).some((key) => key !== "agent" && key !== "workspace" && key !== "text")) return undefined;
  const { agent, workspace } = body;
  if (typeof agent === "string" && workspace === undefined) return agent;
  if (typeof workspace === "string" && agent === undefined) return { workspace };
  return undefined;
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
