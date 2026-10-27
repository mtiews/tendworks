import type { ControlPlane, TriggerGateway } from "@tendworks/shared";
import createClient from "openapi-fetch";

export type Trigger = ControlPlane.components["schemas"]["trigger"];
export type FireTriggerRequest = ControlPlane.components["schemas"]["fireRequest"];
export type FireTriggerResult = ControlPlane.components["schemas"]["fireResult"];

/**
 * Port to the trigger gateway, which owns the schedule. The control plane keeps no
 * trigger state; it reads it through this port on every request.
 *
 * @port
 */
export interface TriggersPort {
  /** Triggers, ordered by name, with their next scheduled execution. */
  list(): Promise<Trigger[]>;
  /**
   * Fires a binding of kind `manual` (ADR 0028) and resolves to the runs it started.
   * Rejects with {@link TriggerFireRefusedError} when the trigger gateway refuses the firing.
   */
  fire(name: string, request: FireTriggerRequest): Promise<FireTriggerResult>;
}

/** The trigger gateway refused a firing: the binding is unknown (404), cannot be fired (409) or the request is invalid (400). */
export class TriggerFireRefusedError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly title: string,
    readonly detail?: string,
  ) {
    super(detail ?? title);
    this.name = "TriggerFireRefusedError";
  }
}

/**
 * Triggers in memory, for tests and a platform without a trigger gateway. Fires a listed
 * binding without schedule like the trigger gateway refuses or answers it, with run ids
 * `run-1`, `run-2`, …; `fired` records the firings.
 */
export function createInMemoryTriggers(triggers: Trigger[] = []): TriggersPort & { fired: { name: string; request: FireTriggerRequest }[] } {
  const fired: { name: string; request: FireTriggerRequest }[] = [];
  let runs = 0;
  return {
    fired,
    list: async () => structuredClone(triggers),
    async fire(name, request) {
      const trigger = triggers.find((candidate) => candidate.name === name);
      if (!trigger) throw new TriggerFireRefusedError(404, "Trigger binding not found", `no trigger binding '${name}'`);
      if (trigger.suspended) throw new TriggerFireRefusedError(409, "Trigger binding not fireable", `trigger binding '${name}' is suspended`);
      if (trigger.schedule) throw new TriggerFireRefusedError(409, "Trigger binding not fireable", `trigger binding '${name}' of kind '${trigger.kind}' fires on its own; only a binding of kind 'manual' can be fired`);
      if (request.workspace !== undefined && !trigger.workspaces.includes(request.workspace)) {
        throw new TriggerFireRefusedError(400, "Invalid request", `trigger binding '${name}' does not start runs in workspace '${request.workspace}' (workspaces: ${trigger.workspaces.join(", ") || "none"})`);
      }
      fired.push({ name, request: structuredClone(request) });
      const workspaces = request.workspace !== undefined ? [request.workspace] : trigger.workspaces.length > 0 ? trigger.workspaces : [undefined];
      return { items: workspaces.map((workspace) => ({ ...(workspace === undefined ? {} : { workspace }), runId: `run-${++runs}` })) };
    },
  };
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
    async fire(name, request) {
      const { data, error, response } = await client.POST("/triggers/{name}/fire", { params: { path: { name } }, body: request });
      if (data) return data;
      const { status } = response;
      if (error && (status === 400 || status === 404 || status === 409)) throw new TriggerFireRefusedError(status, error.title, error.detail);
      throw new Error(`trigger gateway answered HTTP ${status}`);
    },
  };
}
