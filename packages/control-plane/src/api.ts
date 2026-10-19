import { isTraceparent } from "@tendworks/platform";
import type { ControlPlane } from "@tendworks/shared";
import { Hono } from "hono";
import type { ApprovalsPort, ApprovalStatus } from "./approvals.js";
import type { Configuration } from "./configuration.js";
import { REFUSAL_STATUS, type MergesPort } from "./merges.js";
import type { NotificationsPort } from "./notifications.js";
import { RunRejectedError, type RunsPort } from "./runs.js";
import { checkPlatform, type HealthProbe, type RuntimeBundle } from "./status.js";
import { createInMemoryTriggers, type TriggersPort } from "./triggers.js";

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
  /** The trigger gateway, which owns the schedule; without it no triggers are listed. */
  triggers?: TriggersPort;
  /** Human interaction, which owns notifications; `GET /notifications` answers 503 without it. */
  notifications?: NotificationsPort;
  /** Human interaction's merge gate; `POST /pull-requests/merge` answers 503 without it. */
  merges?: MergesPort;
  /** Human interaction's approval requests; their endpoints answer 503 without it. */
  approvals?: ApprovalsPort;
}

/** The public control plane API as a fetch handler; see contracts/openapi/control-plane.yaml. */
export function createControlPlaneApi({
  probes,
  bundles = [],
  probeTimeoutMs,
  configuration,
  runs,
  triggers = createInMemoryTriggers(),
  notifications,
  merges,
  approvals,
}: ControlPlaneApiOptions): { fetch(request: Request): Promise<Response> } {
  const app = new Hono();
  const problem = (status: 400 | 403 | 404 | 409 | 502 | 503, title: string, detail?: string): Response =>
    Response.json({ title, status, ...(detail === undefined ? {} : { detail }) } satisfies Schemas["Problem"], { status });

  app.get("/status", async (c) => {
    const [checked, pendingApprovals] = await Promise.all([
      checkPlatform(probes, bundles, probeTimeoutMs),
      // Part of the overview, not of health: unreadable approvals leave the number out.
      approvals?.list({ status: "pending" }).then(
        (pending) => pending.length,
        () => undefined,
      ),
    ]);
    const report = { ...checked, ...(pendingApprovals === undefined ? {} : { pendingApprovals }) };
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
    const traceparent = c.req.header("traceparent");
    if (traceparent !== undefined && !isTraceparent(traceparent)) return problem(400, "Invalid request", "`traceparent` must be a W3C traceparent (version 00)");
    const definition = configuration.workflow(body.workflow);
    if (!definition) {
      return problem(400, "Unknown workflow", `no workflow '${body.workflow}' is configured (configured: ${configuration.workflowNames.join(", ") || "none"})`);
    }
    const run = await runs.start({ workflow: definition as unknown as Record<string, unknown>, input: body.input ?? {} }, traceparent ? { traceparent } : {});
    return c.json(run satisfies Schemas["run"], 201, { location: `/runs/${run.id}` });
  });

  app.get("/runs", async (c) => c.json({ items: await runs.list() } satisfies Schemas["RunList"], 200));

  app.get("/runs/:runId", async (c) => {
    const run = await runs.get(c.req.param("runId"));
    return run ? c.json(run satisfies Schemas["run"], 200) : problem(404, "Run not found");
  });

  app.get("/triggers", async (c) => {
    let items;
    try {
      items = await triggers.list();
    } catch (error) {
      return problem(503, "Trigger gateway unavailable", error instanceof Error ? error.message : String(error));
    }
    return c.json({ items } satisfies Schemas["triggerList"], 200);
  });

  app.get("/notifications", async (c) => {
    if (!notifications) return problem(503, "Notifications unavailable", "no notification store is configured");
    try {
      return c.json({ items: await notifications.list() } satisfies Schemas["NotificationList"], 200);
    } catch (error) {
      return problem(503, "Notifications unavailable", error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/pull-requests/merge", async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    // Only these two fields: what the gate decides by comes from the platform's records.
    const valid =
      body !== undefined &&
      typeof body.run === "string" &&
      (typeof body.pullRequest === "string" || body.pullRequest === null) &&
      Object.keys(body).every((key) => key === "run" || key === "pullRequest");
    if (!valid) {
      return problem(
        400,
        "Invalid request",
        "the body must be { run, pullRequest } with the id of a running run and the URL of its pull request (or null); the policy comes from the platform's configuration",
      );
    }
    if (!merges) return problem(503, "Merging unavailable", "no merge gate is configured");
    const outcome = await merges.merge({ run: body.run as string, pullRequest: body.pullRequest as string | null });
    if ("merged" in outcome) return c.json(outcome.merged satisfies Schemas["PullRequestMerge"], 200);
    if ("pending" in outcome) return c.json(outcome.pending satisfies Schemas["PullRequestMerge"], 202);
    const { reason, title, detail } = outcome.refused;
    return problem(REFUSAL_STATUS[reason], title, detail);
  });

  const STATUSES: ApprovalStatus[] = ["pending", "approved", "rejected"];

  app.get("/approval-requests", async (c) => {
    const status = c.req.query("status");
    if (status !== undefined && !STATUSES.includes(status as ApprovalStatus)) {
      return problem(400, "Invalid request", `\`status\` must be one of ${STATUSES.join(", ")}`);
    }
    if (!approvals) return problem(503, "Approval requests unavailable", "no approval store is configured");
    try {
      const items = await approvals.list(status === undefined ? {} : { status: status as ApprovalStatus });
      return c.json({ items } satisfies Schemas["ApprovalRequestList"], 200);
    } catch (error) {
      return problem(503, "Approval requests unavailable", error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/approval-requests/:approvalRequestId/decision", async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as Partial<Schemas["ApprovalDecisionRequest"]> | undefined;
    if (body?.decision !== "approve" && body?.decision !== "reject") {
      return problem(400, "Invalid request", "`decision` must be approve or reject");
    }
    if (!approvals) return problem(503, "Approval requests unavailable", "no approval store is configured");
    const id = c.req.param("approvalRequestId");
    let outcome;
    try {
      outcome = await approvals.decide(id, body.decision);
    } catch (error) {
      return problem(503, "Approval requests unavailable", error instanceof Error ? error.message : String(error));
    }
    if (!outcome) return problem(404, "Approval request not found", `no approval request '${id}' exists`);
    if ("conflict" in outcome) {
      return problem(409, "Approval request already decided", `approval request ${id} was already ${outcome.conflict.status}`);
    }
    return c.json(outcome.decided satisfies Schemas["approvalRequest"], 200);
  });

  app.onError((error) => {
    if (error instanceof RunRejectedError) return problem(400, error.title, error.detail);
    return problem(503, "Orchestration unavailable", error.message);
  });

  return { fetch: async (request) => app.fetch(request) };
}
