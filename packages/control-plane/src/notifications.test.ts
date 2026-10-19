import { describe, expect, it } from "vitest";
import { createControlPlaneApi, createInMemoryRuns, type Notification, type NotificationsPort } from "./index.js";

const delivered: Notification = {
  id: "n-1",
  kind: "run.completed",
  runId: "run-1",
  title: "Run run-1 of build completed",
  createdAt: "2026-10-18T10:00:03.000Z",
  delivery: { status: "delivered", attemptedAt: "2026-10-18T10:00:03.000Z" },
};

async function list(notifications?: NotificationsPort) {
  const api = createControlPlaneApi({
    probes: [],
    configuration: { workflowNames: [], workflow: () => undefined, agentProfiles: [], triggerBindings: [], policies: [], pullRequestIntegrations: [] },
    apiToken: "test-token",
    runs: createInMemoryRuns(),
    ...(notifications ? { notifications } : {}),
  });
  const response = await api.fetch(new Request("http://tend.test/notifications"));
  return { status: response.status, body: await response.json() };
}

describe("notifications API", () => {
  it("lists notifications with their delivery status", async () => {
    const { status, body } = await list({ list: async () => [delivered] });

    expect(status).toBe(200);
    expect(body).toEqual({ items: [delivered] });
  });

  it("answers 503 when notifications cannot be read", async () => {
    const { status, body } = await list({ list: () => Promise.reject(new Error("store down")) });

    expect(status).toBe(503);
    expect(body).toEqual({ title: "Notifications unavailable", status: 503, detail: "store down" });
  });

  it("answers 503 when no notification store is wired", async () => {
    const { status, body } = await list();

    expect(status).toBe(503);
    expect(body).toMatchObject({ title: "Notifications unavailable" });
  });
});
