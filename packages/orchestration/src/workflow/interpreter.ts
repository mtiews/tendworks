import type { A2A, Workflow } from "@tendworks/shared";
import { COST, RUN_ID, STEP_REFERENCE, TRANSCRIPT, type AgentTaskExecutor } from "./agent-task-executor.js";
import { evaluateTemplate, ExpressionError, transform, type Variables } from "./expressions.js";
import type { HttpExecutor, HttpResponse } from "./http-executor.js";

// Deterministic core: no I/O, no clock, no randomness. All side effects go through
// the executor, so the interpreter can run inside a durable execution engine.

export interface RunOptions {
  runId: string;
  input: unknown;
  executor: AgentTaskExecutor;
  /** Makes the requests of `call: http` tasks; without it they fail. */
  http?: HttpExecutor;
  /** The `$runtime` argument of runtime expressions. */
  runtime?: RuntimeDescriptor;
  /** Called with a snapshot of a step when it starts and when it ends. */
  recordStep?: (step: Step) => Promise<void>;
}

/** Information about the runtime executing the workflow (DSL runtime descriptor). */
export interface RuntimeDescriptor {
  name: string;
  version?: string;
  /** Implementation specific; Tendworks sets `controlPlaneUrl`, the base URL of the control plane API. */
  metadata: Record<string, unknown>;
}

export interface Step {
  name: string;
  reference: string;
  status: "running" | "completed" | "failed";
  taskId?: string;
  /** Where the transcript of the agent session is kept, as the agent reported it. */
  transcript?: string;
  /** What the agent session cost, as the agent reported it. */
  cost?: { amount: number; currency: string };
  error?: WorkflowError;
}

export interface RunResult {
  status: "completed" | "failed";
  output?: unknown;
  error?: WorkflowError;
  steps: Step[];
}

/** An error as defined by the DSL (RFC 7807 problem details). */
export interface WorkflowError {
  type: string;
  status: number;
  /** JSON pointer of the task that raised the error. */
  instance: string;
  title: string;
  detail?: string;
}

const ERROR_TYPES = "https://serverlessworkflow.io/spec/1.0.0/errors/";

class TaskFailure extends Error {
  constructor(readonly error: WorkflowError) {
    super(error.title);
  }

  /** Turns errors the workflow author can cause into a failure of the task at `instance`. */
  static of(error: unknown, instance: string): unknown {
    if (!(error instanceof ExpressionError)) return error;
    return new TaskFailure({
      type: `${ERROR_TYPES}expression`,
      status: 400,
      instance,
      title: "Runtime expression failed",
      detail: error.message,
    });
  }
}

/**
 * Executes a validated workflow (see `validateWorkflow`) to its end. Failures the
 * workflow can cause (agent task failed, expression failed) end in a failed run;
 * errors of `recordStep` propagate, so the caller can retry.
 */
export async function runWorkflow(workflow: Workflow.Workflow, options: RunOptions): Promise<RunResult> {
  const steps: Step[] = [];
  const record = async (step: Step) => options.recordStep?.({ ...step });
  // The spec leaves the initial context open; we start empty.
  let context: unknown = {};
  const workflowVariable = { id: options.runId, input: options.input };
  const runtime = options.runtime ?? { name: "tendworks", metadata: {} };
  const variables = (input: unknown): Variables => ({ context, input, workflow: workflowVariable, runtime });

  async function runTaskList(tasks: Workflow.TaskList, scope: string, input: unknown): Promise<unknown> {
    let data = input;
    for (const [index, item] of tasks.entries()) {
      const [name, task] = Object.entries(item)[0]!;
      data = await runTask(name, task, `${scope}/do/${index}/${name}`, data);
    }
    return data;
  }

  async function runTask(name: string, task: Workflow.Task, reference: string, rawInput: unknown): Promise<unknown> {
    const step: Step = { name, reference, status: "running" };
    steps.push(step);
    await record(step);
    try {
      const input = transform(task.input?.from, rawInput, variables(rawInput));
      let rawOutput: unknown;
      if ("call" in task && task.call === "http") {
        rawOutput = await callHttp(task, reference, input);
      } else if ("call" in task) {
        const result = await call(task, reference, input);
        step.taskId = result.id;
        Object.assign(step, sessionRecord(result));
        if (result.status.state !== "TASK_STATE_COMPLETED") {
          throw new TaskFailure({
            type: `${ERROR_TYPES}runtime`,
            status: 500,
            instance: reference,
            title: `Agent task ended in state ${result.status.state}`,
            ...detail(result.status.message?.parts),
          });
        }
        rawOutput = result;
      } else {
        rawOutput = await runTaskList(task.do, reference, input);
      }
      const output = transform(task.output?.as, rawOutput, variables(input));
      if (task.export?.as !== undefined) context = transform(task.export.as, output, variables(input));
      step.status = "completed";
      await record(step);
      return output;
    } catch (error) {
      const failure = TaskFailure.of(error, reference);
      if (failure instanceof TaskFailure && step.status === "running") {
        step.status = "failed";
        step.error = failure.error;
        await record(step);
      }
      throw failure;
    }
  }

  async function callHttp(task: Workflow.CallHTTPTask, reference: string, input: unknown): Promise<unknown> {
    const { method, endpoint, headers = {}, body } = task.with;
    const request = {
      method: method.toUpperCase(),
      endpoint: String(evaluateTemplate(endpoint, input, variables(input))),
      headers: evaluateTemplate(headers, input, variables(input)) as Record<string, string>,
      ...(body === undefined ? {} : { body: evaluateTemplate(body, input, variables(input)) }),
    };
    let response: HttpResponse;
    try {
      if (!options.http) throw new Error("this runtime makes no HTTP calls");
      response = await options.http.request(request);
    } catch (error) {
      throw new TaskFailure({
        type: `${ERROR_TYPES}communication`,
        status: 503,
        instance: reference,
        title: "HTTP call could not be made",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    if (response.status < 200 || response.status > 299) {
      // Endpoints answer with problem details (RFC 7807); keep their title and detail.
      const problem = isObject(response.content) ? response.content : {};
      throw new TaskFailure({
        type: `${ERROR_TYPES}communication`,
        status: response.status,
        instance: reference,
        title: typeof problem.title === "string" ? problem.title : `HTTP call answered ${response.status}`,
        ...(typeof problem.detail === "string" ? { detail: problem.detail } : typeof response.content === "string" && response.content ? { detail: response.content } : {}),
      });
    }
    return response.content ?? null;
  }

  async function call(task: Workflow.CallA2ATask, reference: string, input: unknown): Promise<A2A.Task> {
    const parameters = evaluateTemplate(task.with.parameters, input, variables(input)) as Workflow.WithA2AParameters;
    // The DSL speaks A2A 0.3 (`kind` parts, role `user`); the port speaks A2A 1.0.
    // The message id is derived from run and step, so a retried call is recognisable.
    const request: A2A.SendMessageRequest = {
      message: {
        messageId: `${options.runId}${reference}`,
        role: "ROLE_USER",
        parts: parameters.message.parts.map(toPart),
        ...(parameters.message.metadata === undefined ? {} : { metadata: parameters.message.metadata }),
      },
      metadata: { [RUN_ID]: options.runId, [STEP_REFERENCE]: reference },
    };
    try {
      return await options.executor.sendMessage(task.with.agentCard.endpoint.slice("agent://".length), request);
    } catch (error) {
      throw new TaskFailure({
        type: `${ERROR_TYPES}communication`,
        status: 503,
        instance: reference,
        title: "Agent task could not be delivered",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const at = <T>(instance: string, evaluate: () => T): T => {
    try {
      return evaluate();
    } catch (error) {
      throw TaskFailure.of(error, instance);
    }
  };
  try {
    const input = at("/input/from", () => transform(workflow.input?.from, options.input, variables(options.input)));
    const data = await runTaskList(workflow.do, "", input);
    const output = at("/output/as", () => transform(workflow.output?.as, data, variables(data)));
    return { status: "completed", output, steps };
  } catch (failure) {
    if (failure instanceof TaskFailure) return { status: "failed", error: failure.error, steps };
    throw failure;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function detail(parts: A2A.Part[] | undefined): { detail?: string } {
  const text = (parts ?? []).flatMap((part) => ("text" in part ? [part.text] : [])).join("\n");
  return text ? { detail: text } : {};
}

/** Transcript reference and cost from the task's metadata; values of the wrong shape are left out. */
function sessionRecord(task: A2A.Task): Pick<Step, "transcript" | "cost"> {
  const transcript = task.metadata?.[TRANSCRIPT];
  const cost = task.metadata?.[COST] as { amount?: unknown; currency?: unknown } | undefined;
  return {
    ...(typeof transcript === "string" ? { transcript } : {}),
    ...(typeof cost?.amount === "number" && typeof cost.currency === "string" ? { cost: { amount: cost.amount, currency: cost.currency } } : {}),
  };
}

function toPart(part: Workflow.A2APart): A2A.Part {
  return part.kind === "text" ? { text: part.text } : { data: part.data };
}
