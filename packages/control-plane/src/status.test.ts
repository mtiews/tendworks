import { createHealthApi } from "@tendworks/health";
import { describe, expect, it } from "vitest";
import { createControlPlaneApi, createInMemoryRuns, type HealthProbe, type PlatformStatus } from "./index.js";

const noRuns = { configuration: { workflowNames: [], workflow: () => undefined, agentProfiles: [] }, runs: createInMemoryRuns() };

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
