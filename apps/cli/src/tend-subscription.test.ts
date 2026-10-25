import { createControlPlaneApi, createInMemoryRuns, emptyConfiguration } from "@tendworks/control-plane";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runTend } from "./tend.js";

async function tend(args: string[]) {
  const api = createControlPlaneApi({
    probes: [],
    configuration: emptyConfiguration({
      subscriptions: [
        { apiVersion: "tendworks.dev/v1", kind: "Subscription", metadata: { name: "app-pushes" }, spec: { scope: { workspace: "app" }, events: ["run.started", "run.failed"], channels: ["phone", "log"], priority: 1 } },
        { apiVersion: "tendworks.dev/v1", kind: "Subscription", metadata: { name: "platform-state" }, spec: { scope: { platform: {} }, events: ["platform.degraded", "platform.recovered"], channels: ["phone"] } },
      ],
    }),
    apiToken: "test-token",
    runs: createInMemoryRuns(),
  });
  let stdout = "";
  const exitCode = await runTend(["--token", "test-token", ...args], { fetch: (request) => api.fetch(request), stdout: (text) => (stdout += text), stderr: () => {} });
  return { exitCode, stdout };
}

describe("tend subscription list", () => {
  it("shows every subscription with its scope, events, channels and priority", async () => {
    const { exitCode, stdout } = await tend(["subscription", "list"]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^NAME\s+SCOPE\s+EVENTS\s+CHANNELS\s+PRIORITY$/m);
    expect(stdout).toMatch(/^app-pushes\s+workspace app\s+run\.started,run\.failed\s+phone,log\s+1$/m);
    expect(stdout).toMatch(/^platform-state\s+platform\s+platform\.degraded,platform\.recovered\s+phone\s+-$/m);
  });

  it("prints the list as YAML and as JSON", async () => {
    const expected = { items: [{ name: "app-pushes", scope: { workspace: "app" }, events: ["run.started", "run.failed"], channels: ["phone", "log"], priority: 1 }, { name: "platform-state", scope: { platform: {} } }] };

    expect(parse((await tend(["subscription", "list", "-o", "yaml"])).stdout)).toMatchObject(expected);
    expect(JSON.parse((await tend(["subscription", "list", "-o", "json"])).stdout)).toMatchObject(expected);
  });
});
