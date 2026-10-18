import type { ControlPlane } from "@tendworks/shared";
import { Hono } from "hono";
import { checkPlatform, type HealthProbe, type RuntimeBundle } from "./status.js";

type StatusResponse = ControlPlane.paths["/status"]["get"]["responses"];

export interface ControlPlaneApiOptions {
  /** Components the control plane owns, e.g. its store. */
  probes: HealthProbe[];
  /** Other runtime bundles whose components are part of the platform status. */
  bundles?: RuntimeBundle[];
  /** How long a single probe or bundle may take before it counts as unhealthy. */
  probeTimeoutMs?: number;
}

/** The public control plane API as a fetch handler; see contracts/openapi/control-plane.yaml. */
export function createControlPlaneApi({
  probes,
  bundles = [],
  probeTimeoutMs,
}: ControlPlaneApiOptions): { fetch(request: Request): Promise<Response> } {
  const app = new Hono();

  app.get("/status", async (c) => {
    const report = await checkPlatform(probes, bundles, probeTimeoutMs);
    if (report.status === "healthy") {
      return c.json(report satisfies StatusResponse[200]["content"]["application/json"], 200);
    }
    return c.json(report satisfies StatusResponse[503]["content"]["application/json"], 503);
  });

  return { fetch: async (request) => app.fetch(request) };
}
