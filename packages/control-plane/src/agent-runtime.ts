import { serverSentEventStream, type ServerSentEvent } from "@tendworks/platform";
import type { AgentRuntime, ControlPlane } from "@tendworks/shared";
import createClient from "openapi-fetch";

export type TranscriptEntry = ControlPlane.components["schemas"]["TranscriptEntryList"]["items"][number];

export interface TranscriptStreamOptions {
  /** Position of the last entry the client received; the stream continues after it. */
  after?: number;
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
  };
}

/**
 * Transcripts in memory by task id, for tests of clients of the control plane. A task in
 * `running` keeps its streams open for entries added with `append` until `end`; `drop`
 * cuts open streams like a lost connection.
 */
export function createInMemoryAgentRuntime() {
  const transcripts = new Map<string, TranscriptEntry[]>();
  const running = new Set<string>();
  const wakers = new Set<() => void>();
  const dropped = new Set<() => void>();
  const wake = () => wakers.forEach((waker) => waker());

  const runtime = {
    transcripts,
    running,
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
