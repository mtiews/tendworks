import type { HttpRequest, HttpResponse } from "./http-executor.js";

/** The fetch `Request` for an HTTP request of a `call: http` task. */
export function toRequest({ method, endpoint, headers, body }: HttpRequest): Request {
  return new Request(endpoint, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Reads a fetch `Response` into the result of a `call: http` task. */
export async function fromResponse(response: Response): Promise<HttpResponse> {
  const text = await response.text();
  if (!text) return { status: response.status };
  const type = response.headers.get("content-type") ?? "";
  if (/[/+]json\b/.test(type)) {
    try {
      return { status: response.status, content: JSON.parse(text) as unknown };
    } catch {
      // Announced as JSON but is not; hand the text on.
    }
  }
  return { status: response.status, content: text };
}
