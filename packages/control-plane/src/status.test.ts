import { createHealthApi, createStaticHealthProbe } from "@tendworks/health";
import { MigrationError } from "@tendworks/platform/migrations";
import { describe, expect, it } from "vitest";
import { createControlPlaneApi, createInMemoryRuns, createStoppedControlPlaneApi, emptyConfiguration, type HealthProbe, type PlatformStatus } from "./index.js";

const noRuns = { configuration: emptyConfiguration(), runs: createInMemoryRuns(), apiToken: "test-token" };

const healthy = (name: string): HealthProbe => ({ name, check: async () => ({ status: "healthy" }) });

async function getStatus(probes: HealthProbe[]) {
  const api = createControlPlaneApi({ probes, ...noRuns });
  const response = await api.fetch(new Request("http://tend.test/status"));
  return { code: response.status, body: (await response.json()) as PlatformStatus };
}

describe("GET /status", () => {
  it("reports a healthy platform when every component is healthy", async () => {
    const { code, body } = await getStatus([healthy("store"), healthy("execution-engine")]);

    expect(code).toBe(200);
    expect(body).toMatchObject({
      status: "healthy",
      components: [
        { name: "store", status: "healthy" },
        { name: "execution-engine", status: "healthy" },
      ],
    });
    expect(Date.parse(body.checkedAt)).not.toBeNaN();
  });

  it("reports an unhealthy platform with 503 when one component is unhealthy", async () => {
    const down: HealthProbe = {
      name: "store",
      check: async () => ({ status: "unhealthy", message: "connection refused" }),
    };

    const { code, body } = await getStatus([down, healthy("execution-engine")]);

    expect(code).toBe(503);
    expect(body).toMatchObject({
      status: "unhealthy",
      components: [
        { name: "store", status: "unhealthy", message: "connection refused" },
        { name: "execution-engine", status: "healthy" },
      ],
    });
  });

  it("reports a component as unhealthy when its check fails", async () => {
    const broken: HealthProbe = {
      name: "store",
      check: async () => {
        throw new Error("password authentication failed");
      },
    };

    const { code, body } = await getStatus([broken]);

    expect(code).toBe(503);
    expect(body.components).toEqual([
      { name: "store", status: "unhealthy", message: "password authentication failed" },
    ]);
  });

  it("reports a component as unhealthy when its check does not answer in time", async () => {
    const hanging: HealthProbe = { name: "sandbox-backend", check: () => new Promise(() => {}) };

    const api = createControlPlaneApi({ probes: [hanging, healthy("store")], probeTimeoutMs: 20, ...noRuns });
    const response = await api.fetch(new Request("http://tend.test/status"));
    const body = (await response.json()) as PlatformStatus;

    expect(response.status).toBe(503);
    expect(body.components).toEqual([
      { name: "sandbox-backend", status: "unhealthy", message: "no answer within 20 ms" },
      { name: "store", status: "healthy" },
    ]);
  });

  it("includes the components a runtime bundle reports about itself", async () => {
    const worker = createHealthApi({
      probes: [healthy("execution-engine"), { name: "sandbox-backend", check: async () => ({ status: "unhealthy", message: "proxy down" }) }],
    });

    const api = createControlPlaneApi({
      ...noRuns,
      probes: [healthy("store")],
      bundles: [{ name: "worker", baseUrl: "http://worker.test", fetch: (request) => worker.fetch(request) }],
    });
    const response = await api.fetch(new Request("http://tend.test/status"));
    const body = (await response.json()) as PlatformStatus;

    expect(response.status).toBe(503);
    expect(body.components).toEqual([
      { name: "store", status: "healthy" },
      { name: "execution-engine", status: "healthy" },
      { name: "sandbox-backend", status: "unhealthy", message: "proxy down" },
    ]);
  });

  it("reports a runtime bundle as unhealthy when it cannot be reached", async () => {
    const api = createControlPlaneApi({
      ...noRuns,
      probes: [healthy("store")],
      bundles: [
        {
          name: "worker",
          baseUrl: "http://worker.test",
          fetch: async () => {
            throw new TypeError("fetch failed");
          },
        },
      ],
    });
    const response = await api.fetch(new Request("http://tend.test/status"));
    const body = (await response.json()) as PlatformStatus;

    expect(response.status).toBe(503);
    expect(body.components).toEqual([
      { name: "store", status: "healthy" },
      { name: "worker", status: "unhealthy", message: "fetch failed" },
    ]);
  });
});

describe("GET /status: a failed schema migration", () => {
  // What a bundle builds from the MigrationError that stopped it.
  const failed = new MigrationError("human_interaction", 'migration 2 (add-channel) failed: column "channel" already exists', {
    version: 2,
    migration: "add-channel",
  });
  const failure = createStaticHealthProbe(failed.component, { status: "unhealthy", message: failed.message });

  it("shows the server's own failed migration while the stopped server refuses everything else", async () => {
    const api = createStoppedControlPlaneApi({ probes: [healthy("store"), failure] });

    const status = await api.fetch(new Request("http://tend.test/status"));
    const runs = await api.fetch(new Request("http://tend.test/runs", { headers: { authorization: "Bearer test-token" } }));

    expect(status.status).toBe(503);
    expect(((await status.json()) as PlatformStatus).components).toEqual([
      { name: "store", status: "healthy" },
      {
        name: "human-interaction-schema",
        status: "unhealthy",
        message: 'schema human_interaction: migration 2 (add-channel) failed: column "channel" already exists',
      },
    ]);
    expect(runs.status).toBe(503);
    // The reason, with whatever the store said, only in GET /status, which reveals no more than the platform's health.
    expect(await runs.json()).toEqual({
      title: "Platform stopped",
      status: 503,
      detail: "The platform stopped working; GET /status names the component that stopped it.",
    });
  });

  it("shows a worker's failed migration from the worker's health API", async () => {
    const worker = createHealthApi({ probes: [failure] });
    const api = createControlPlaneApi({
      ...noRuns,
      probes: [healthy("store")],
      bundles: [{ name: "worker", baseUrl: "http://worker.test", fetch: (request) => worker.fetch(request) }],
    });

    const response = await api.fetch(new Request("http://tend.test/status"));

    expect(response.status).toBe(503);
    expect(((await response.json()) as PlatformStatus).components).toEqual([
      { name: "store", status: "healthy" },
      { name: "human-interaction-schema", status: "unhealthy", message: failed.message },
    ]);
  });
});

describe("GET /status: overview", () => {
  const run = (id: string, status: "pending" | "running" | "completed" | "failed") => ({ id, workflow: "hello-agent", status, input: {}, steps: [], createdAt: "2026-10-18T10:00:00.000Z" });

  it("reports the number of active (pending or running) runs", async () => {
    const runs = createInMemoryRuns();
    for (const fixture of [run("r-1", "running"), run("r-2", "pending"), run("r-3", "completed"), run("r-4", "failed")]) runs.runs.set(fixture.id, fixture);
    const api = createControlPlaneApi({ ...noRuns, probes: [healthy("store")], runs });

    const response = await api.fetch(new Request("http://tend.test/status"));

    expect(await response.json()).toMatchObject({ status: "healthy", activeRuns: 2 });
  });

  it("leaves the number out when runs cannot be read, without making the platform unhealthy", async () => {
    const runs = { ...createInMemoryRuns(), list: () => Promise.reject(new Error("orchestration down")) };
    const api = createControlPlaneApi({ ...noRuns, probes: [healthy("store")], runs });

    const response = await api.fetch(new Request("http://tend.test/status"));

    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("activeRuns");
  });
});
