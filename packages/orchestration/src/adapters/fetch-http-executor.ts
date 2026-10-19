import type { HttpExecutor } from "../workflow/http-executor.js";
import { fromResponse, toRequest } from "../workflow/http-response.js";

export interface FetchHttpExecutorOptions {
  /**
   * The only origin requests may go to, e.g. the control plane's `http://server:8080`.
   * Workflows run in the worker, which also reaches the sandbox backend; limiting them
   * to the control plane API keeps a workflow from calling anything else from there.
   */
  allowedOrigin: string;
  fetch?: (request: Request) => Promise<Response>;
  /** How long one request may take. Defaults to 60 s. */
  timeoutMs?: number;
}

/** HTTP executor on fetch, limited to one origin. */
export function createFetchHttpExecutor({ allowedOrigin, fetch = globalThis.fetch, timeoutMs = 60_000 }: FetchHttpExecutorOptions): HttpExecutor {
  const allowed = new URL(allowedOrigin).origin;
  return {
    async request(request) {
      let origin: string;
      try {
        origin = new URL(request.endpoint).origin;
      } catch {
        throw new Error(`'${request.endpoint}' is not an absolute URL`);
      }
      if (origin !== allowed) {
        throw new Error(`call: http may only reach the control plane API (${allowed}), not ${origin}`);
      }
      const response = await fetch(new Request(toRequest(request), { signal: AbortSignal.timeout(timeoutMs) }));
      return fromResponse(response);
    },
  };
}
