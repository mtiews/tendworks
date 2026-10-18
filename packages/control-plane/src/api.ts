import type { ControlPlane } from "@tendworks/shared";
import { Hono } from "hono";
import type { Configuration } from "./configuration.js";
import { RunRejectedError, type RunsPort } from "./runs.js";
import { checkPlatform, type HealthProbe, type RuntimeBundle } from "./status.js";

type StatusResponse = ControlPlane.paths["/status"]["get"]["responses"];
type Schemas = ControlPlane.components["schemas"];

export interface ControlPlaneApiOptions {
  /** Components the control plane owns, e.g. its store. */
  probes: HealthProbe[];
  /** Other runtime bundles whose components are part of the platform status. */
  bundles?: RuntimeBundle[];
  /** How long a single probe or bundle may take before it counts as unhealthy. */
  probeTimeoutMs?: number;
  /** The validated configuration folder. */
  configuration: Configuration;
  /** Orchestration, which owns runs. */
  runs: RunsPort;
}

/** The public control plane API as a fetch handler; see contracts/openapi/control-plane.yaml. */
export function createControlPlaneApi({
  probes,
  bundles = [],
  probeTimeoutMs,
  configuration,
  runs,
}: ControlPlaneApiOptions): { fetch(request: Request): Promise<Response> } {
  const app = new Hono();
  const problem = (status: 400 | 404 | 503, title: string, detail?: string): Response =>
    Response.json({ title, status, ...(detail === undefined ? {} : { detail }) } satisfies Schemas["Problem"], { status });

  app.get("/status", async (c) => {
    const report = await checkPlatform(probes, bundles, probeTimeoutMs);
    if (report.status === "healthy") {
      return c.json(report satisfies StatusResponse[200]["content"]["application/json"], 200);
    }
    return c.json(report satisfies StatusResponse[503]["content"]["application/json"], 503);
  });

  app.post("/runs", async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as Partial<Schemas["StartRunRequest"]> | undefined;
    if (typeof body?.workflow !== "string") return problem(400, "Invalid request", "`workflow` must be the name of a configured workflow");
    if (body.input !== undefined && (body.input === null || typeof body.input !== "object" || Array.isArray(body.input))) {
      return problem(400, "Invalid request", "`input` must be an object");
    }
    const definition = configuration.workflow(body.workflow);
    if (!definition) {
      return problem(400, "Unknown workflow", `no workflow '${body.workflow}' is configured (configured: ${configuration.workflowNames.join(", ") || "none"})`);
    }
    const run = await runs.start({ workflow: definition as unknown as Record<string, unknown>, input: body.input ?? {} });
    return c.json(run satisfies Schemas["run"], 201, { location: `/runs/${run.id}` });
  });

  app.get("/runs", async (c) => c.json({ items: await runs.list() } satisfies Schemas["RunList"], 200));

  app.get("/runs/:runId", async (c) => {
    const run = await runs.get(c.req.param("runId"));
    return run ? c.json(run satisfies Schemas["run"], 200) : problem(404, "Run not found");
  });

  app.onError((error) => {
    if (error instanceof RunRejectedError) return problem(400, error.title, error.detail);
    return problem(503, "Orchestration unavailable", error.message);
  });

  return { fetch: async (request) => app.fetch(request) };
}
