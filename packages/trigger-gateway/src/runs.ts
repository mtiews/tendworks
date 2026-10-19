import type { ControlPlane } from "@tendworks/shared";
import createClient from "openapi-fetch";

export interface StartRun {
  /** Name of a configured workflow. */
  workflow: string;
  input: Record<string, unknown>;
}

/**
 * Port through which the trigger gateway starts runs. Its adapter uses the public
 * control plane API, like every other client; the gateway never reaches orchestration.
 */
export interface RunStarter {
  /** Starts a run and resolves to its id. */
  start(request: StartRun): Promise<{ id: string }>;
}

/** Starts runs through the public control plane API (`POST /runs`). */
export function createControlPlaneRunStarter(options: { baseUrl: string; fetch?: (request: Request) => Promise<Response> }): RunStarter {
  const client = createClient<ControlPlane.paths>({ baseUrl: options.baseUrl, ...(options.fetch ? { fetch: options.fetch } : {}) });
  return {
    async start(request) {
      const { data, error, response } = await client.POST("/runs", { body: request });
      if (data) return { id: data.id };
      const reason = error?.title ? `: ${error.title}${error.detail ? ` (${error.detail})` : ""}` : "";
      throw new Error(`control plane answered HTTP ${response.status}${reason}`);
    },
  };
}

/** Run starter that only records what it was asked to start. */
export function createInMemoryRunStarter(): RunStarter & { started: StartRun[]; fail(error?: Error): void } {
  const started: StartRun[] = [];
  let failure: Error | undefined;
  return {
    started,
    fail(error) {
      failure = error;
    },
    async start(request) {
      if (failure) throw failure;
      started.push(structuredClone(request));
      return { id: `run-${started.length}` };
    },
  };
}
