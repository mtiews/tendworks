import { describe, expect, it } from "vitest";
import { createFakeTriggerSource, createInMemoryFiringStore, fakeTriggerBinding, createInMemoryRunStarter, createTriggerGateway, createTriggerGatewayApi } from "./index.js";

describe("trigger gateway API", () => {
  it("lists the triggers with their next scheduled execution", async () => {
    const gateway = createTriggerGateway({
      bindings: [fakeTriggerBinding({ name: "ready-issues" }, { workflow: "implement-issue", trigger: { every: { seconds: 30 } } })],
      sources: { fake: createFakeTriggerSource },
      store: createInMemoryFiringStore(),
      runs: createInMemoryRunStarter(),
      now: () => new Date("2026-10-18T10:00:10.000Z"),
    });
    const api = createTriggerGatewayApi(gateway);

    const response = await api.fetch(new Request("http://trigger-gateway.test/triggers"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        { name: "ready-issues", workflow: "implement-issue", kind: "fake", workspaces: [], schedule: { every: { seconds: 30 } }, nextExecutionAt: "2026-10-18T10:00:30.000Z" },
      ],
    });
  });
});
