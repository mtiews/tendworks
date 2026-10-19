import type { Health } from "@tendworks/shared";
import { Hono } from "hono";

export type HealthState = Health.components["schemas"]["HealthState"];
export type ComponentStatus = Health.components["schemas"]["ComponentStatus"];
export type HealthReport = Health.components["schemas"]["HealthReport"];

/**
 * A component a runtime bundle depends on, checked on every health request.
 *
 * @port
 */
export interface HealthProbe {
  name: string;
  check(): Promise<Omit<ComponentStatus, "name">>;
}

/** A probe that always reports `result`; for tests and demos. */
export function createStaticHealthProbe(name: string, result: Omit<ComponentStatus, "name">): HealthProbe {
  return { name, check: async () => ({ ...result }) };
}

export interface HealthOptions {
  probes: HealthProbe[];
  /** How long a single probe may take before its component counts as unhealthy. */
  probeTimeoutMs?: number;
}

const defaultProbeTimeoutMs = 2_000;

/** Runs all probes concurrently; a failing or hanging probe makes its component unhealthy. */
export function checkComponents(probes: HealthProbe[], timeoutMs = defaultProbeTimeoutMs): Promise<ComponentStatus[]> {
  return Promise.all(probes.map((probe) => checkComponent(probe, timeoutMs)));
}

export function overallState(components: ComponentStatus[]): HealthState {
  return components.every((c) => c.status === "healthy") ? "healthy" : "unhealthy";
}

/** The runtime health API (contracts/openapi/health.yaml) as a fetch handler. */
export function createHealthApi({ probes, probeTimeoutMs }: HealthOptions): { fetch(request: Request): Promise<Response> } {
  const app = new Hono();

  app.get("/health", async (c) => {
    const components = await checkComponents(probes, probeTimeoutMs);
    const report: HealthReport = { status: overallState(components), components, checkedAt: new Date().toISOString() };
    return c.json(report, report.status === "healthy" ? 200 : 503);
  });

  return { fetch: async (request) => app.fetch(request) };
}

async function checkComponent(probe: HealthProbe, timeoutMs: number): Promise<ComponentStatus> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return { name: probe.name, ...(await Promise.race([probe.check(), timeout])) };
  } catch (error) {
    return { name: probe.name, status: "unhealthy", message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
