import { describe, expect, it } from "vitest";
import type { ReceivedEvent } from "../workflow/event-inbox.js";
import { createRunEventForwarder } from "./run-event-forwarder.js";

describe("run event forwarder", () => {
  const forwarded = () => {
    const delivered: [string, ReceivedEvent][] = [];
    const forwarder = createRunEventForwarder({ deliver: async (runId, event) => void delivered.push([runId, event]) });
    return { forwarder, delivered };
  };

  it("hands an event that names a run to that run", async () => {
    const { forwarder, delivered } = forwarded();
    const event = { specversion: "1.0", id: "a1", source: "/tendworks/human-interaction", type: "dev.tendworks.approval.decided", runid: "run-1", data: {} };

    await forwarder.handle(event);

    expect(delivered).toEqual([["run-1", event]]);
  });

  it("skips events without a run and orchestration's own events", async () => {
    const { forwarder, delivered } = forwarded();

    await forwarder.handle({ id: "t1", source: "/tendworks/trigger-gateway", type: "dev.tendworks.trigger.fired" });
    await forwarder.handle({ id: "r1", source: "/tendworks/orchestration", type: "dev.tendworks.run.started", runid: "run-1" });

    expect(delivered).toEqual([]);
  });
});
