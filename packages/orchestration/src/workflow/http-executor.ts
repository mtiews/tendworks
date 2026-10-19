/** An HTTP request a `call: http` task makes, with its runtime expressions evaluated. */
export interface HttpRequest {
  /** Upper case, e.g. `POST`. */
  method: string;
  endpoint: string;
  headers: Record<string, string>;
  /** Sent as JSON when present. */
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  /** The response content, JSON parsed when it is JSON, otherwise the text; absent when empty. */
  content?: unknown;
}

/**
 * Port through which the interpreter makes the requests of `call: http` tasks.
 * Resolves with any response, whatever its status; rejects only when no response
 * came (unreachable endpoint, endpoint not allowed).
 */
export interface HttpExecutor {
  request(request: HttpRequest): Promise<HttpResponse>;
}
