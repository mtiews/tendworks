import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ControlPlane } from "@tendworks/shared";
import { afterAll, describe, expect, it } from "vitest";
import { client } from "./support/control-plane.js";

type Notification = ControlPlane.components["schemas"]["notification"];

const compose = (...args: string[]) =>
  promisify(execFile)("docker", ["compose", "-f", fileURLToPath(new URL("../../deploy/compose.yaml", import.meta.url)), ...args], { timeout: 180_000 });

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen in time`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

const notificationOf = (kind: Notification["kind"], after: string) => async () => {
  const { data } = await client.GET("/notifications");
  return data?.items.find((item) => item.kind === kind && item.createdAt >= after && item.deliveries.every(({ status }) => status !== "pending"));
};

describe("platform health on the compose stack", () => {
  // Never leave the stack without its worker, whatever the test did.
  afterAll(async () => {
    await compose("up", "-d", "--wait", "worker");
  });

  it("notifies the platform's subscribers when the worker stops, and when it runs again", { timeout: 120_000 }, async () => {
    const stoppedAt = new Date().toISOString();
    await compose("stop", "worker");

    // The control plane publishes after two equal results in a row. It checks every minute by
    // default; `pnpm e2e` sets TEND_PLATFORM_CHECK_SECONDS=5 (tests/fixtures/fixture-configuration.ts),
    // so each change shows within about 10 s.
    const degraded = await waitFor("platform.degraded", notificationOf("platform.degraded", stoppedAt), 45_000);
    expect(degraded.title).toContain("worker");
    expect(degraded).not.toHaveProperty("runId");
    // The fixture subscription platform-log (tests/fixtures/config/notifications) selects it for fake-log.
    expect(degraded.deliveries).toEqual([{ channel: "fake-log", status: "delivered", attemptedAt: expect.any(String) }]);

    const startedAt = new Date().toISOString();
    await compose("up", "-d", "--wait", "worker");

    const recovered = await waitFor("platform.recovered", notificationOf("platform.recovered", startedAt), 45_000);
    expect(recovered.title).toContain("worker");
    expect(recovered.deliveries).toEqual([{ channel: "fake-log", status: "delivered", attemptedAt: expect.any(String) }]);
  });
});
