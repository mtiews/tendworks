import type { ControlPlane, TriggerGateway } from "@tendworks/shared";
import createClient from "openapi-fetch";

export type Trigger = ControlPlane.components["schemas"]["trigger"];

/**
 * Port to the trigger gateway, which owns the schedule. The control plane keeps no
 * trigger state; it reads it through this port on every request.
 *
 * @port
 */
export interface TriggersPort {
  /** Triggers, ordered by name, with their next scheduled execution. */
  list(): Promise<Trigger[]>;
}

/** Triggers in memory, for tests and a platform without a trigger gateway. */
export function createInMemoryTriggers(triggers: Trigger[] = []): TriggersPort {
  return { list: async () => structuredClone(triggers) };
}

/** Reaches the trigger gateway through its internal API (contracts/openapi/trigger-gateway.yaml). */
export function createTriggerGatewayClient(options: { baseUrl: string; fetch?: (request: Request) => Promise<Response> }): TriggersPort {
  const client = createClient<TriggerGateway.paths>({ baseUrl: options.baseUrl, ...(options.fetch ? { fetch: options.fetch } : {}) });
  return {
    async list() {
      const { data, response } = await client.GET("/triggers");
      if (!data) throw new Error(`trigger gateway answered HTTP ${response.status}`);
      return data.items;
    },
  };
}
