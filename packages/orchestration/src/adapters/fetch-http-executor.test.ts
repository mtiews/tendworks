import { describe, expect, it } from "vitest";
import { describeHttpExecutor } from "../workflow/http-executor.suite.js";
import { createFetchHttpExecutor } from "./fetch-http-executor.js";

describeHttpExecutor("fetch", (endpoint) => ({
  executor: createFetchHttpExecutor({ allowedOrigin: "http://control-plane.test:8080", fetch: endpoint }),
  url: "http://control-plane.test:8080",
}));

describe("fetch http executor", () => {
  it("refuses endpoints outside the allowed origin without sending anything", async () => {
    const sent: string[] = [];
    const executor = createFetchHttpExecutor({
      allowedOrigin: "http://server:8080",
      fetch: async (request) => {
        sent.push(request.url);
        return new Response(null, { status: 204 });
      },
    });

    await expect(executor.request({ method: "POST", endpoint: "http://docker-proxy:2375/containers/create", headers: {} })).rejects.toThrow(
      "call: http may only reach the control plane API (http://server:8080), not http://docker-proxy:2375",
    );
    await expect(executor.request({ method: "GET", endpoint: "not a url", headers: {} })).rejects.toThrow("is not an absolute URL");
    expect(sent).toEqual([]);
  });

  it("authenticates every request with the platform's API token, whatever the workflow sets", async () => {
    const sent: (string | null)[] = [];
    const executor = createFetchHttpExecutor({
      allowedOrigin: "http://server:8080",
      apiToken: "platform-api-token",
      fetch: async (request) => {
        sent.push(request.headers.get("authorization"));
        return new Response(null, { status: 204 });
      },
    });

    await executor.request({ method: "POST", endpoint: "http://server:8080/pull-requests/merge", headers: {}, body: {} });
    await executor.request({ method: "POST", endpoint: "http://server:8080/runs", headers: { Authorization: "Bearer chosen-by-workflow" }, body: {} });

    expect(sent).toEqual(["Bearer platform-api-token", "Bearer platform-api-token"]);
  });
});
