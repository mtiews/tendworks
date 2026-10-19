import type { AgentRuntime, ControlPlane } from "@tendworks/shared";
import createClient from "openapi-fetch";

export type TranscriptEntry = ControlPlane.components["schemas"]["TranscriptEntryList"]["items"][number];

/**
 * Port to the agent runtime, which owns agent sessions and their transcripts. The
 * control plane keeps none of it; it reads through this port on every request.
 *
 * @port
 */
export interface AgentRuntimePort {
  /** The transcript of a task's agent session so far, or undefined for a task without one. */
  transcript(taskId: string): Promise<TranscriptEntry[] | undefined>;
}

/** Reaches the agent runtime through its internal API (contracts/openapi/agent-runtime.yaml). */
export function createAgentRuntimeClient(options: { baseUrl: string; fetch?: (request: Request) => Promise<Response> }): AgentRuntimePort {
  const client = createClient<AgentRuntime.paths>({ baseUrl: options.baseUrl, ...(options.fetch ? { fetch: options.fetch } : {}) });
  return {
    async transcript(taskId) {
      const { data, error, response } = await client.GET("/tasks/{taskId}/transcript", { params: { path: { taskId } } });
      if (data) return data.items;
      if (response.status === 404) return undefined;
      throw new Error(`agent runtime answered HTTP ${response.status}${error?.detail ? `: ${error.detail}` : ""}`);
    },
  };
}

/** Transcripts in memory by task id. For tests of clients of the control plane. */
export function createInMemoryAgentRuntime(): AgentRuntimePort & { transcripts: Map<string, TranscriptEntry[]> } {
  const transcripts = new Map<string, TranscriptEntry[]>();
  return {
    transcripts,
    async transcript(taskId) {
      const entries = transcripts.get(taskId);
      return entries && structuredClone(entries);
    },
  };
}
