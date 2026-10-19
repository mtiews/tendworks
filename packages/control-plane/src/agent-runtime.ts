import { serverSentEventStream, type ServerSentEvent } from "@tendworks/platform";
import type { AgentRuntime, ControlPlane } from "@tendworks/shared";
import createClient from "openapi-fetch";

export type TranscriptEntry = ControlPlane.components["schemas"]["TranscriptEntryList"]["items"][number];
export type Chat = ControlPlane.components["schemas"]["chat"];
export type StartChatRequest = ControlPlane.components["schemas"]["startChatRequest"];

export interface TranscriptStreamOptions {
  /** Position of the last entry the client received; the stream continues after it. */
  after?: number;
}

/** The agent runtime refused to start a chat (unknown profile, or one without `spec.chat`); the client's mistake. */
export class ChatRefusedError extends Error {
  constructor(
    readonly title: string,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "ChatRefusedError";
  }
}

/** A message the chat cannot take now: a turn runs, or the chat has ended. */
export class ChatConflictError extends Error {
  constructor(
    readonly title: string,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "ChatConflictError";
  }
}

/**
 * Port to the agent runtime, which owns agent sessions and their transcripts. The
 * control plane keeps none of it; it reads through this port on every request.
 *
 * @port
 */
export interface AgentRuntimePort {
  /** The transcript of a task's agent session so far, or undefined for a task without one. */
  transcript(taskId: string): Promise<TranscriptEntry[] | undefined>;
  /**
   * The transcript of a task's agent session as a live `text/event-stream` body (ADR 0017),
   * which the control plane passes through unchanged; undefined for a task without one.
   * Cancelling the body stops the stream at the agent runtime.
   */
  streamTranscript(taskId: string, options: TranscriptStreamOptions): Promise<ReadableStream<Uint8Array> | undefined>;
  /** Starts a chat (ADR 0015); rejects with {@link ChatRefusedError} when the agent runtime refuses it. */
  startChat(request: StartChatRequest): Promise<Chat>;
  /** All chats, the most recently started first. */
  listChats(): Promise<Chat[]>;
  getChat(chatId: string): Promise<Chat | undefined>;
  /** The next message of a chat; rejects with {@link ChatConflictError} during a turn or after the end; undefined for an unknown chat. */
  sendChatMessage(chatId: string, text: string): Promise<Chat | undefined>;
  /** Ends a chat; undefined for an unknown chat. */
  endChat(chatId: string): Promise<Chat | undefined>;
}

/** Reaches the agent runtime through its internal API (contracts/openapi/agent-runtime.yaml). */
export function createAgentRuntimeClient(options: { baseUrl: string; fetch?: (request: Request) => Promise<Response> }): AgentRuntimePort {
  const client = createClient<AgentRuntime.paths>({ baseUrl: options.baseUrl, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const failed = (response: Response, error?: { detail?: string }) => new Error(`agent runtime answered HTTP ${response.status}${error?.detail ? `: ${error.detail}` : ""}`);
  return {
    async transcript(taskId) {
      const { data, error, response } = await client.GET("/tasks/{taskId}/transcript", { params: { path: { taskId } } });
      if (data) return data.items;
      if (response.status === 404) return undefined;
      throw failed(response, error);
    },
    async streamTranscript(taskId, { after }) {
      const { data, error, response } = await client.GET("/tasks/{taskId}/transcript/stream", {
        params: { path: { taskId }, header: after === undefined ? {} : { "Last-Event-ID": String(after) } },
        parseAs: "stream",
      });
      if (response.ok && data) return data;
      if (response.status === 404) return undefined;
      throw failed(response, error);
    },
    async startChat(request) {
      const { data, error, response } = await client.POST("/chats", { body: request });
      if (data) return data;
      if (response.status === 400 && error) throw new ChatRefusedError(error.title, error.detail ?? error.title);
      throw failed(response, error);
    },
    async listChats() {
      const { data, error, response } = await client.GET("/chats");
      if (data) return data.items;
      throw failed(response, error);
    },
    async getChat(chatId) {
      const { data, error, response } = await client.GET("/chats/{chatId}", { params: { path: { chatId } } });
      if (data) return data;
      if (response.status === 404) return undefined;
      throw failed(response, error);
    },
    async sendChatMessage(chatId, text) {
      const { data, error, response } = await client.POST("/chats/{chatId}/messages", { params: { path: { chatId } }, body: { text } });
      if (data) return data;
      if (response.status === 404) return undefined;
      if (response.status === 409 && error) throw new ChatConflictError(error.title, error.detail ?? error.title);
      throw failed(response, error);
    },
    async endChat(chatId) {
      const { data, error, response } = await client.POST("/chats/{chatId}/end", { params: { path: { chatId } } });
      if (data) return data;
      if (response.status === 404) return undefined;
      throw failed(response, error);
    },
  };
}

/** A transcript entry before the fake numbered and timed it. */
type FakeEntry = TranscriptEntry extends infer E ? (E extends unknown ? Omit<E, "position" | "time"> : never) : never;

export interface InMemoryAgentRuntimeOptions {
  /** Agent profiles that allow chats; a chat with any other is refused. */
  chatAgents?: string[];
}

/**
 * Transcripts and chats in memory by task id, for tests of clients of the control plane.
 * A task in `running` keeps its streams open for entries added with `append` until
 * `end`; `drop` cuts open streams like a lost connection. A chat works on its turn until
 * the test ends it with `finishTurn`; its transcript follows what a real chat records.
 */
export function createInMemoryAgentRuntime({ chatAgents = [] }: InMemoryAgentRuntimeOptions = {}) {
  const transcripts = new Map<string, TranscriptEntry[]>();
  const running = new Set<string>();
  const wakers = new Set<() => void>();
  const dropped = new Set<() => void>();
  const wake = () => wakers.forEach((waker) => waker());
  const chats = new Map<string, Chat>();
  const now = () => new Date().toISOString();
  const record = (taskId: string, entry: FakeEntry) => {
    const entries = transcripts.get(taskId) ?? [];
    runtime.append(taskId, { ...entry, position: entries.length, time: now() });
  };
  const message = (text: string) => ({ messageId: crypto.randomUUID(), role: "ROLE_USER" as const, parts: [{ text }] });
  const update = (chatId: string, change: Partial<Chat>): Chat => {
    const chat: Chat = { ...chats.get(chatId)!, lastActivityAt: now(), ...change };
    chats.set(chatId, chat);
    return structuredClone(chat);
  };

  const runtime = {
    transcripts,
    running,
    chats,
    /** Ends the running turn of a chat with the agent's answer; the chat waits for the next message. */
    finishTurn(chatId: string, reply: string, cost?: { amount: number; currency: string }) {
      record(chatId, { type: "message-chunk", text: reply });
      const total = cost ?? chats.get(chatId)?.cost;
      record(chatId, { type: "input-required", message: reply, ...(total ? { cost: total } : {}) });
      update(chatId, { status: "input-required", message: reply, ...(total ? { cost: total } : {}) });
    },
    async startChat({ agent, text, repository }: StartChatRequest) {
      if (!chatAgents.includes(agent)) throw new ChatRefusedError("Chat not allowed", `agent profile ${agent} does not allow chats: its agent profile has no spec.chat`);
      // Simpler than the agent runtime's rule, enough to tell refused from accepted.
      if (repository !== undefined && !/^https?:\/\/[^\s/@]+(\/\S*)?$/.test(repository)) {
        throw new ChatRefusedError("Invalid repository", `repository ${JSON.stringify(repository)} is no https or http clone URL without credentials`);
      }
      const id = crypto.randomUUID();
      const startedAt = now();
      chats.set(id, { id, agent, status: "working", startedAt, lastActivityAt: startedAt, transcript: `memory:${id}`, ...(repository === undefined ? {} : { repository }) });
      running.add(id);
      record(id, { type: "task-started", agent, message: message(text) });
      return structuredClone(chats.get(id)!);
    },
    async listChats() {
      return [...chats.values()].reverse().map((chat) => structuredClone(chat));
    },
    async getChat(chatId: string) {
      const chat = chats.get(chatId);
      return chat && structuredClone(chat);
    },
    async sendChatMessage(chatId: string, text: string) {
      const chat = chats.get(chatId);
      if (!chat) return undefined;
      if (chat.status === "ended" || chat.status === "failed") throw new ChatConflictError("Chat ended", `chat ${chatId} has ended; start a new chat`);
      if (chat.status === "working") throw new ChatConflictError("Turn in progress", `chat ${chatId} is working on a turn`);
      record(chatId, { type: "message-received", message: message(text) });
      const working: Chat = { ...chat, status: "working", lastActivityAt: now() };
      delete working.message;
      chats.set(chatId, working);
      return structuredClone(working);
    },
    async endChat(chatId: string) {
      const chat = chats.get(chatId);
      if (!chat) return undefined;
      if (chat.status === "ended" || chat.status === "failed") return structuredClone(chat);
      record(chatId, { type: "task-ended", state: "TASK_STATE_COMPLETED", message: "the chat was ended" });
      const at = now();
      const ended = update(chatId, { status: "ended", endedAt: at, lastActivityAt: at });
      runtime.end(chatId);
      return ended;
    },
    append(taskId: string, entry: TranscriptEntry) {
      transcripts.set(taskId, [...(transcripts.get(taskId) ?? []), entry]);
      wake();
    },
    end(taskId: string) {
      running.delete(taskId);
      wake();
    },
    drop() {
      dropped.forEach((drop) => drop());
    },
    async transcript(taskId: string) {
      const entries = transcripts.get(taskId);
      return entries && structuredClone(entries);
    },
    async streamTranscript(taskId: string, { after = -1 }: TranscriptStreamOptions) {
      if (!transcripts.has(taskId)) return undefined;
      let last = after;
      let state: "open" | "ended" | "closed" = "open";
      let waker: (() => void) | undefined;
      let drop: () => void = () => {};
      const close = () => {
        state = "closed";
        if (waker) wakers.delete(waker);
        dropped.delete(drop);
        waker?.();
      };
      const events: AsyncIterableIterator<ServerSentEvent> = {
        [Symbol.asyncIterator]: () => events,
        async next() {
          for (;;) {
            if (state === "closed") return { done: true, value: undefined };
            const entry = (transcripts.get(taskId) ?? []).find((candidate) => candidate.position > last);
            if (entry) {
              last = entry.position;
              return { done: false, value: { id: String(entry.position), event: "entry", data: JSON.stringify(entry) } };
            }
            if (state === "ended" || !running.has(taskId)) {
              close();
              return { done: false, value: { event: "end", data: "{}" } };
            }
            await new Promise<void>((resolve) => {
              waker = resolve;
              wakers.add(resolve);
            });
            wakers.delete(waker!);
            waker = undefined;
          }
        },
        async return() {
          close();
          return { done: true, value: undefined };
        },
      };
      // A cut connection errors the body without an end event.
      let cut = false;
      drop = () => {
        cut = true;
        close();
      };
      dropped.add(drop);
      const reader = serverSentEventStream(events).getReader();
      return new ReadableStream<Uint8Array>({
        async pull(target) {
          const next = await reader.read();
          if (cut) target.error(new TypeError("terminated"));
          else if (next.done) target.close();
          else target.enqueue(next.value);
        },
        async cancel() {
          close();
          await reader.cancel();
        },
      });
    },
  };
  return runtime satisfies AgentRuntimePort;
}
