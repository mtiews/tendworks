import { describe, expect, it } from "vitest";
import { createInMemoryFiringStore, createInMemoryRunStarter, createTriggerGateway, createTriggerGatewayApi } from "./index.js";

describe("trigger gateway API", () => {
  it("lists the triggers with their next scheduled execution", async () => {
    const gateway = createTriggerGateway({
      bindings: [
        {
          apiVersion: "tendworks.dev/v1",
          kind: "TriggerBinding",
          metadata: { name: "ready-issues" },
          spec: {
            schedule: { every: { seconds: 30 } },
            source: { integration: "fake", issues: { repository: "acme/playground" } },
            workflow: "implement-issue",
          },
        },
      ],
      store: createInMemoryFiringStore(),
      runs: createInMemoryRunStarter(),
      now: () => new Date("2026-10-18T10:00:10.000Z"),
    });
    const api = createTriggerGatewayApi(gateway);

    const response = await api.fetch(new Request("http://trigger-gateway.test/triggers"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [{ name: "ready-issues", workflow: "implement-issue", schedule: { every: { seconds: 30 } }, nextExecutionAt: "2026-10-18T10:00:30.000Z" }],
    });
  });
});
