import type { Health } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { createHealthApi, type HealthProbe } from "./index.js";

type HealthReport = Health.components["schemas"]["HealthReport"];

const healthy = (name: string): HealthProbe => ({ name, check: async () => ({ status: "healthy" }) });

async function getHealth(probes: HealthProbe[], probeTimeoutMs?: number) {
  const api = createHealthApi(probeTimeoutMs === undefined ? { probes } : { probes, probeTimeoutMs });
  const response = await api.fetch(new Request("http://worker.test/health"));
  return { code: response.status, report: (await response.json()) as HealthReport };
}

describe("GET /health", () => {
  it("answers 200 with every component when all are healthy", async () => {
    const { code, report } = await getHealth([healthy("execution-engine"), healthy("sandbox-backend")]);

    expect(code).toBe(200);
    expect(report.status).toBe("healthy");
    expect(report.components).toEqual([
      { name: "execution-engine", status: "healthy" },
      { name: "sandbox-backend", status: "healthy" },
    ]);
  });

  it("answers 503 when a check fails or does not answer in time", async () => {
    const failing: HealthProbe = {
      name: "execution-engine",
      check: async () => {
        throw new Error("connection refused");
      },
    };
    const hanging: HealthProbe = { name: "sandbox-backend", check: () => new Promise(() => {}) };

    const { code, report } = await getHealth([failing, hanging], 20);

    expect(code).toBe(503);
    expect(report.status).toBe("unhealthy");
    expect(report.components).toEqual([
      { name: "execution-engine", status: "unhealthy", message: "connection refused" },
      { name: "sandbox-backend", status: "unhealthy", message: "no answer within 20 ms" },
    ]);
  });
});
