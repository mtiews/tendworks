import { Hono } from "hono";
import { checkPlatform, type HealthProbe } from "./status.js";

export interface ControlPlaneApiOptions {
  probes: HealthProbe[];
  /** How long a single probe may take before its component counts as unhealthy. */
  probeTimeoutMs?: number;
}

/** The public control plane API as a fetch handler; see contracts/openapi/control-plane.yaml. */
export function createControlPlaneApi({
  probes,
  probeTimeoutMs = 2_000,
}: ControlPlaneApiOptions): { fetch(request: Request): Promise<Response> } {
  const app = new Hono();

  app.get("/status", async (c) => {
    const status = await checkPlatform(probes, probeTimeoutMs);
    return c.json(status, status.status === "healthy" ? 200 : 503);
  });

  return { fetch: async (request) => app.fetch(request) };
}
