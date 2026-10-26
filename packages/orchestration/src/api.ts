import { isTraceparent, newTraceparent } from "@tendworks/platform";
import type { Orchestration } from "@tendworks/shared";
import { Hono } from "hono";
import type { RunEngine } from "./runs/run-engine.js";
import type { Run, RunStore } from "./runs/run-store.js";
import type { RuntimeDescriptor } from "./workflow/interpreter.js";
import { validateWorkflow, WorkflowValidationError } from "./workflow/validate.js";

type Schemas = Orchestration.components["schemas"];

export interface OrchestrationApiOptions {
  store: RunStore;
  engine: RunEngine;
  /** `$runtime` of every run started here (snapshot at start), e.g. the control plane URL. */
  runtime?: RuntimeDescriptor;
  newRunId?: () => string;
  now?: () => Date;
}

/** The internal orchestration API (contracts/openapi/orchestration.yaml) as a fetch handler. */
export function createOrchestrationApi({
  store,
  engine,
  runtime,
  newRunId = () => crypto.randomUUID(),
  now = () => new Date(),
}: OrchestrationApiOptions): { fetch(request: Request): Promise<Response> } {
  const app = new Hono();
  const problem = (status: 400 | 404 | 503, title: string, detail?: string): Response =>
    Response.json({ title, status, ...(detail === undefined ? {} : { detail }) } satisfies Schemas["Problem"], { status });

  app.post("/runs", async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as Partial<Schemas["StartRunRequest"]> | undefined;
    if (!isObject(body?.workflow)) return problem(400, "Invalid request", "`workflow` must be a workflow definition object");
    if (body.input !== undefined && !isObject(body.input)) return problem(400, "Invalid request", "`input` must be an object");
    if (body.startedBy !== undefined && !isRunOrigin(body.startedBy)) {
      return problem(400, "Invalid request", "`startedBy` must be { kind: manual, retryOf? } or { kind: trigger, binding, workspace?, item: { key, title, url? }, retryOf? }");
    }
    // The caller's trace, e.g. the trigger that fired; without one the run starts its own.
    const traceparent = c.req.header("traceparent");
    if (traceparent !== undefined && !isTraceparent(traceparent)) return problem(400, "Invalid request", "`traceparent` must be a W3C traceparent (version 00)");

    let definition;
    try {
      definition = validateWorkflow(body.workflow);
    } catch (error) {
      if (error instanceof WorkflowValidationError) return problem(400, "Invalid workflow", error.message);
      throw error;
    }

    const run: Run = {
      id: newRunId(),
      workflow: definition.document.name,
      status: "pending",
      input: body.input ?? {},
      startedBy: body.startedBy ?? { kind: "manual" },
      traceparent: traceparent ?? newTraceparent(),
      steps: [],
      createdAt: now().toISOString(),
    };
    await store.create(run);
    try {
      await engine.start({ runId: run.id, workflow: run.workflow, traceparent: run.traceparent!, definition, input: run.input, ...(runtime ? { runtime } : {}) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await store.updateRun(run.id, {
        status: "failed",
        finishedAt: now().toISOString(),
        error: { type: "https://serverlessworkflow.io/spec/1.0.0/errors/communication", status: 503, instance: "/", title: "Run could not be handed to the execution engine", detail },
      }, []);
      return problem(503, "Execution engine unavailable", detail);
    }
    return c.json((await store.get(run.id))! satisfies Schemas["run"], 201, { location: `/runs/${run.id}` });
  });

  app.get("/runs", async (c) => c.json({ items: await store.list() } satisfies Schemas["RunList"], 200));

  app.get("/runs/:runId", async (c) => {
    const run = await store.get(c.req.param("runId"));
    return run ? c.json(run satisfies Schemas["run"], 200) : problem(404, "Run not found");
  });

  return { fetch: async (request) => app.fetch(request) };
}

function isRunOrigin(value: unknown): value is NonNullable<Run["startedBy"]> {
  if (!isObject(value)) return false;
  if (value.retryOf !== undefined && typeof value.retryOf !== "string") return false;
  if (value.kind === "manual") return Object.keys(value).every((key) => key === "kind" || key === "retryOf");
  const item = value.item;
  return (
    value.kind === "trigger" &&
    typeof value.binding === "string" &&
    (value.workspace === undefined || typeof value.workspace === "string") &&
    isObject(item) &&
    typeof item.key === "string" &&
    typeof item.title === "string" &&
    (item.url === undefined || typeof item.url === "string")
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
