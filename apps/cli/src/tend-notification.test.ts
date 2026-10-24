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
  artifacts: [],
  deliveries: [
    { channel: "log", status: "delivered", attemptedAt: "2026-10-18T11:00:03.000Z" },
    { channel: "phone", status: "failed", attemptedAt: "2026-10-18T11:00:03.000Z", error: "Pushover refused the message (HTTP 400): application token is invalid" },
  ],
};

const delivered: Notification = {
  id: "1a7b-notification-completed",
  kind: "run.completed",
  runId: "0b6c4c1e-run-completed",
  title: "Run 0b6c4c1e-run-completed of develop-issue completed",
  artifacts: [
    { name: "pull-request", url: "https://git.example/acme/app/pull/7" },
    { name: "preview", url: "https://preview.example/app/7" },
  ],
  createdAt: "2026-10-18T10:00:03.000Z",
  deliveries: [{ channel: "log", status: "delivered", attemptedAt: "2026-10-18T10:00:03.000Z" }],
};

const unselected: Notification = {
  id: "77c1-notification-approval",
  kind: "approval.requested",
  runId: "5e0f-run-waiting",
  title: "Approval needed: Deploy?",
  createdAt: "2026-10-18T09:00:03.000Z",
  deliveries: [],
};

async function tend(args: string[]) {
  const api = createControlPlaneApi({
    probes: [],
    configuration: emptyConfiguration(),
    apiToken: "test-token",
    runs: createInMemoryRuns(),
    notifications: { list: async () => [failed, delivered, unselected] },
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
  it("shows notifications newest first with their first artifact's link and the delivery status per channel", async () => {
    const { exitCode, stdout } = await tend(["notification", "list"]);

    expect(exitCode).toBe(0);
    const lines = stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^CREATED\s+KIND\s+RUN\s+LINK\s+DELIVERY\s+TITLE$/);
    expect(lines[1]).toMatch(/^2026-10-18T11:00:03.000Z\s+run.failed\s+7f1d2a9e-run-failed\s+-\s+log delivered, phone failed\s+Run 7f1d2a9e-run-failed of hello-agent failed$/);
    expect(lines[2]).toMatch(/^2026-10-18T10:00:03.000Z\s+run.completed\s+0b6c4c1e-run-completed\s+https:\/\/git.example\/acme\/app\/pull\/7\s+log delivered\s+Run 0b6c4c1e/);
    expect(lines[3]).toMatch(/^2026-10-18T09:00:03.000Z\s+approval.requested\s+5e0f-run-waiting\s+-\s+no channel\s+Approval needed/);
  });

  it("says below the table why a delivery failed", async () => {
    const { stdout } = await tend(["notification", "list"]);

    expect(stdout.trimEnd().split("\n").slice(4)).toEqual([
      "",
      "phone failed for 9d2e-notification-failed: Pushover refused the message (HTTP 400): application token is invalid",
    ]);
  });

  it("prints the notifications as a document with -o json and -o yaml", async () => {
    const json = await tend(["notification", "list", "-o", "json"]);
    const yaml = await tend(["notification", "list", "-o", "yaml"]);

    expect(JSON.parse(json.stdout)).toEqual({ items: [failed, delivered, unselected] });
    expect(parse(yaml.stdout)).toEqual({ items: [failed, delivered, unselected] });
  });
});
