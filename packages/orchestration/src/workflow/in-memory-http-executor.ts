import type { HttpExecutor, HttpRequest, HttpResponse } from "./http-executor.js";

type Respond = (request: HttpRequest) => HttpResponse | Promise<HttpResponse>;

/**
 * HTTP executor that answers from memory and records every request. By default every
 * request is answered with 200 and no content.
 */
export class InMemoryHttpExecutor implements HttpExecutor {
  readonly requests: HttpRequest[] = [];
  #respond: Respond = () => ({ status: 200 });

  /** Sets how requests are answered. */
  respond(respond: Respond): this {
    this.#respond = respond;
    return this;
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(structuredClone(request));
    return this.#respond(request);
  }
}
