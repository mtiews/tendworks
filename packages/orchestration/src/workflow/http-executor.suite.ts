import { describe, expect, it } from "vitest";
import type { HttpExecutor } from "./http-executor.js";

/** An endpoint as a fetch handler; the setup makes it reachable at the URL it returns. */
export type Endpoint = (request: Request) => Promise<Response>;

/**
 * The behaviour every HTTP executor must show. Runs against the real adapter and the
 * fake, so the fake stays a faithful stand-in.
 */
export function describeHttpExecutor(name: string, setup: (endpoint: Endpoint) => { executor: HttpExecutor; url: string }) {
  describe(`http executor: ${name}`, () => {
    it("sends method, headers and a JSON body and returns the JSON content", async () => {
      const { executor, url } = setup(async (request) =>
        Response.json({
          method: request.method,
          path: new URL(request.url).pathname,
          type: request.headers.get("content-type"),
          trace: request.headers.get("x-trace"),
          body: await request.json(),
        }),
      );

      const response = await executor.request({ method: "POST", endpoint: `${url}/merges`, headers: { "x-trace": "t-1" }, body: { pr: 7 } });

      expect(response).toEqual({
        status: 200,
        content: { method: "POST", path: "/merges", type: "application/json", trace: "t-1", body: { pr: 7 } },
      });
    });

    it("returns an answer outside 2xx as a result with its problem details", async () => {
      const { executor, url } = setup(async () => Response.json({ title: "Policy not configured", status: 400 }, { status: 400 }));

      const response = await executor.request({ method: "GET", endpoint: `${url}/x`, headers: {} });

      expect(response).toEqual({ status: 400, content: { title: "Policy not configured", status: 400 } });
    });

    it("returns text content as text and no content for an empty answer", async () => {
      const { executor, url } = setup(async (request) =>
        new URL(request.url).pathname === "/text" ? new Response("Bad Gateway", { status: 502 }) : new Response(null, { status: 204 }),
      );

      expect(await executor.request({ method: "GET", endpoint: `${url}/text`, headers: {} })).toEqual({ status: 502, content: "Bad Gateway" });
      expect(await executor.request({ method: "DELETE", endpoint: `${url}/empty`, headers: {} })).toEqual({ status: 204 });
    });
  });
}
