import type { ControlPlane } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { client } from "./support/control-plane.js";

type Notification = ControlPlane.components["schemas"]["notification"];

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen in time`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe("notifications on the compose stack", () => {
  it("records and delivers a notification when a run completes", { timeout: 60_000 }, async () => {
    const { data: started } = await client.POST("/runs", {
      body: { workflow: "hello-agent", input: { issue: { number: 9, title: "Notify me" } } },
    });
    expect(started).toBeDefined();

    const notification = await waitFor<Notification>("notification for the run", async () => {
      const { data } = await client.GET("/notifications");
      return data?.items.find((item) => item.runId === started!.id && item.delivery.status !== "pending");
    });

    expect(notification).toMatchObject({
      kind: "run.completed",
      runId: started!.id,
      title: `Run ${started!.id} of hello-agent completed`,
      delivery: { status: "delivered" },
    });
    const { data: run } = await client.GET("/runs/{runId}", { params: { path: { runId: started!.id } } });
    expect(run?.status).toBe("completed");
  });
});
