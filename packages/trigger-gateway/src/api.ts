import type { TriggerGateway as Contract } from "@tendworks/shared";
import { Hono } from "hono";
import { FireRefusedError, type FireRefusal, type TriggerGateway } from "./trigger-gateway.js";

type Schemas = Contract.components["schemas"];

const REFUSED: Record<FireRefusal, { status: 400 | 404 | 409; title: string }> = {
  "unknown-binding": { status: 404, title: "Trigger binding not found" },
  suspended: { status: 409, title: "Trigger binding not fireable" },
  "fires-on-its-own": { status: 409, title: "Trigger binding not fireable" },
  "unknown-workspace": { status: 400, title: "Invalid request" },
};

/** The internal trigger gateway API (contracts/openapi/trigger-gateway.yaml) as a fetch handler. */
export function createTriggerGatewayApi(gateway: Pick<TriggerGateway, "triggers" | "fire">): { fetch(request: Request): Promise<Response> } {
  const app = new Hono();
  const problem = (status: 400 | 404 | 409, title: string, detail: string): Response =>
    Response.json({ title, status, detail } satisfies Schemas["Problem"], { status });

  app.get("/triggers", async (c) => c.json({ items: await gateway.triggers() } satisfies Schemas["triggerList"], 200));

  app.post("/triggers/:name/fire", async (c) => {
    // The body is optional; without one the firing covers all of the binding's workspaces.
    const text = await c.req.text();
    let body: unknown = {};
    try {
      if (text.trim() !== "") body = JSON.parse(text);
    } catch {
      return problem(400, "Invalid request", "the body must be a JSON object");
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) return problem(400, "Invalid request", "the body must be a JSON object");
    const { workspace } = body as { workspace?: unknown };
    if (workspace !== undefined && typeof workspace !== "string") return problem(400, "Invalid request", "`workspace` must be the name of one of the binding's workspaces");
    try {
      const { fired } = await gateway.fire(c.req.param("name"), workspace === undefined ? {} : { workspace });
      const items = fired.map(({ workspace: name, runId }) => ({ ...(name === undefined ? {} : { workspace: name }), runId }));
      return c.json({ items } satisfies Schemas["fireResult"], 201);
    } catch (error) {
      if (!(error instanceof FireRefusedError)) throw error;
      const { status, title } = REFUSED[error.reason];
      return problem(status, title, error.message);
    }
  });

  return { fetch: async (request) => app.fetch(request) };
}
