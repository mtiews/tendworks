import type { TriggerGateway as Contract } from "@tendworks/shared";
import { Hono } from "hono";
import type { TriggerGateway } from "./trigger-gateway.js";

type Schemas = Contract.components["schemas"];

/** The internal trigger gateway API (contracts/openapi/trigger-gateway.yaml) as a fetch handler. */
export function createTriggerGatewayApi(gateway: Pick<TriggerGateway, "triggers">): { fetch(request: Request): Promise<Response> } {
  const app = new Hono();
  app.get("/triggers", async (c) => c.json({ items: await gateway.triggers() } satisfies Schemas["triggerList"], 200));
  return { fetch: async (request) => app.fetch(request) };
}
