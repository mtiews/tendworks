import { createControlPlaneApi, createInMemoryRuns, emptyConfiguration, type Notification } from "@tendworks/control-plane";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runTend } from "./tend.js";

const failed: Notification = {
  id: "9d2e-notification-failed",
  kind: "run.failed",
  runId: "7f1d2a9e-run-failed",
  title: "Run 7f1d2a9e-run-failed of hello-agent failed",
  detail: "/do/0/implement: Agent task ended in state TASK_STATE_FAILED",
  createdAt: "2026-10-18T11:00:03.000Z",
  delivery: { status: "failed", attemptedAt: "2026-10-18T11:00:03.000Z", error: "delivery channel unavailable" },
};

const delivered: Notification = {
  id: "1a7b-notification-completed",
  kind: "run.completed",
  runId: "0b6c4c1e-run-completed",
  title: "Run 0b6c4c1e-run-completed of hello-agent completed",
  createdAt: "2026-10-18T10:00:03.000Z",
  delivery: { status: "delivered", attemptedAt: "2026-10-18T10:00:03.000Z" },
};

async function tend(args: string[]) {
  const api = createControlPlaneApi({
    probes: [],
    configuration: emptyConfiguration(),
    apiToken: "test-token",
    runs: createInMemoryRuns(),
    notifications: { list: async () => [failed, delivered] },
  });
  let stdout = "";
  let stderr = "";
  const exitCode = await runTend(["--token", "test-token", ...args], {
    fetch: (request) => api.fetch(request),
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { exitCode, stdout, stderr };
}

describe("tend notification list", () => {
  it("shows notifications newest first with their delivery status", async () => {
    const { exitCode, stdout } = await tend(["notification", "list"]);

    expect(exitCode).toBe(0);
    const lines = stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^CREATED\s+KIND\s+RUN\s+DELIVERY\s+TITLE$/);
    expect(lines[1]).toMatch(
      /^2026-10-18T11:00:03.000Z\s+run.failed\s+7f1d2a9e-run-failed\s+failed: delivery channel unavailable\s+Run 7f1d2a9e-run-failed of hello-agent failed$/,
    );
    expect(lines[2]).toMatch(/^2026-10-18T10:00:03.000Z\s+run.completed\s+0b6c4c1e-run-completed\s+delivered\s+Run 0b6c4c1e/);
  });

  it("prints the notifications as a document with -o json and -o yaml", async () => {
    const json = await tend(["notification", "list", "-o", "json"]);
    const yaml = await tend(["notification", "list", "-o", "yaml"]);

    expect(JSON.parse(json.stdout)).toEqual({ items: [failed, delivered] });
    expect(parse(yaml.stdout)).toEqual({ items: [failed, delivered] });
  });
});
