import type { ControlPlane, Orchestration } from "@tendworks/shared";
import createClient from "openapi-fetch";

export type Run = ControlPlane.components["schemas"]["run"];
export type StartRunRequest = Orchestration.components["schemas"]["StartRunRequest"];

/**
 * Port to orchestration, which owns runs. The control plane does not keep run data;
 * it reads it through this port on every request.
 */
export interface RunsPort {
  /** Starts a run; rejects with {@link RunRejectedError} when orchestration refuses it. */
  start(request: StartRunRequest): Promise<Run>;
  list(): Promise<Run[]>;
  get(runId: string): Promise<Run | undefined>;
}

/** Orchestration refused to start a run, e.g. because the workflow is invalid. */
export class RunRejectedError extends Error {
  constructor(
    readonly title: string,
    readonly detail?: string,
  ) {
    super(detail ?? title);
    this.name = "RunRejectedError";
  }
}

/** Reaches orchestration through its internal API (contracts/openapi/orchestration.yaml). */
export function createOrchestrationClient(options: {
  baseUrl: string;
  fetch?: (request: Request) => Promise<Response>;
}): RunsPort {
  const client = createClient<Orchestration.paths>({ baseUrl: options.baseUrl, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const failed = (response: Response, problem?: { title?: string; detail?: string }) =>
    new Error(`orchestration answered HTTP ${response.status}${problem?.detail ? `: ${problem.detail}` : ""}`);

  return {
    async start(request) {
      const { data, error, response } = await client.POST("/runs", { body: request });
      if (data) return data;
      if (response.status === 400 && error) throw new RunRejectedError(error.title, error.detail);
      throw failed(response, error);
    },
    async list() {
      const { data, response } = await client.GET("/runs");
      if (!data) throw failed(response);
      return data.items;
    },
    async get(runId) {
      const { data, error, response } = await client.GET("/runs/{runId}", { params: { path: { runId } } });
      if (data) return data;
      if (response.status === 404) return undefined;
      throw failed(response, error);
    },
  };
}

/** Runs in memory: started runs stay pending. For tests of clients of the control plane. */
export function createInMemoryRuns(): RunsPort & { started: StartRunRequest[]; runs: Map<string, Run> } {
  const runs = new Map<string, Run>();
  const started: StartRunRequest[] = [];
  return {
    started,
    runs,
    async start(request) {
      started.push(request);
      const document = request.workflow.document as { name?: string } | undefined;
      const run: Run = {
        id: crypto.randomUUID(),
        workflow: document?.name ?? "unknown",
        status: "pending",
        input: request.input ?? {},
        steps: [],
        createdAt: new Date().toISOString(),
      };
      runs.set(run.id, run);
      return structuredClone(run);
    },
    async list() {
      return [...runs.values()].reverse().map((run) => structuredClone(run));
    },
    async get(runId) {
      const run = runs.get(runId);
      return run && structuredClone(run);
    },
  };
}
