import { describe, expect, it } from "vitest";
import { createControlPlaneApi, createInMemoryRuns, createTriggerGatewayClient, type Trigger } from "./index.js";

const trigger: Trigger = {
  name: "ready-issues",
  workflow: "implement-issue",
  schedule: { every: { minutes: 5 } },
  nextExecutionAt: "2026-10-18T10:05:00.000Z",
};

function api(gateway: (request: Request) => Promise<Response>) {
  return createControlPlaneApi({
    probes: [],
    configuration: { workflowNames: [], workflow: () => undefined, agentProfiles: [], triggerBindings: [], policies: [], pullRequestIntegrations: [] },
    runs: createInMemoryRuns(),
    triggers: createTriggerGatewayClient({ baseUrl: "http://trigger-gateway.test", fetch: gateway }),
  });
}

describe("triggers API", () => {
  it("lists the triggers the trigger gateway reports", async () => {
    const asked: string[] = [];
    const controlPlane = api(async (request) => {
      asked.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json({ items: [trigger] });
    });

    const response = await controlPlane.fetch(new Request("http://tend.test/triggers"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [trigger] });
    expect(asked).toEqual(["GET /triggers"]);
  });

  it("answers 503 when the trigger gateway cannot be reached", async () => {
    const controlPlane = api(() => Promise.reject(new Error("connect ECONNREFUSED")));

    const response = await controlPlane.fetch(new Request("http://tend.test/triggers"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ title: "Trigger gateway unavailable", status: 503, detail: "connect ECONNREFUSED" });
  });
});
