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
});
