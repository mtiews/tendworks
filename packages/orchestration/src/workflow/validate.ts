import { readFileSync } from "node:fs";
import type { Workflow } from "@tendworks/shared";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { parse } from "yaml";

// Validation needs Node APIs and generated code (Ajv), so it runs before a run starts,
// never inside the deterministic interpreter.

const SCHEMA = new URL("../../../../contracts/schemas/serverless-workflow.schema.yaml", import.meta.url);

const SUPPORTED_TASKS = ["call", "do"];
const SUPPORTED_CALLS = ["a2a", "http"];
// Every task type of DSL 1.0.3. `for` also has a `do` list, so it is checked first.
const DSL_TASKS = ["call", "fork", "emit", "for", "listen", "raise", "run", "set", "switch", "try", "wait", "do"];

export class WorkflowValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid workflow:\n${issues.map((issue) => `  ${issue}`).join("\n")}`);
    this.name = "WorkflowValidationError";
  }
}

let validateSchema: ((data: unknown) => boolean) & { errors?: ErrorObject[] | null };

/**
 * Checks a parsed workflow definition against the DSL subset the interpreter supports.
 * Throws a {@link WorkflowValidationError} listing every issue.
 */
export function validateWorkflow(definition: unknown): Workflow.Workflow {
  const unsupported = unsupportedTasks(definition);
  if (unsupported.length > 0) throw new WorkflowValidationError(unsupported);

  validateSchema ??= new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true })
    .addKeyword({ keyword: "tsType" }) // annotation for the type generator
    .compile(parse(readFileSync(SCHEMA, "utf8")));
  if (!validateSchema(definition)) throw new WorkflowValidationError(describe(validateSchema.errors ?? []));
  return definition as Workflow.Workflow;
}

/** Finds unsupported task and call types first, so they get a clear message instead of schema noise. */
function unsupportedTasks(definition: unknown): string[] {
  const issues: string[] = [];
  const visit = (tasks: unknown, scope: string) => {
    if (!Array.isArray(tasks)) return;
    tasks.forEach((item, index) => {
      if (!isObject(item)) return;
      for (const [name, task] of Object.entries(item)) {
        if (!isObject(task)) continue;
        const reference = `${scope}/do/${index}/${name}`;
        const type = DSL_TASKS.find((key) => key in task);
        if (type !== undefined && !SUPPORTED_TASKS.includes(type)) {
          issues.push(`${reference}: unsupported task type '${type}' (supported: ${SUPPORTED_TASKS.join(", ")})`);
        } else if (type === "call" && typeof task.call === "string" && !SUPPORTED_CALLS.includes(task.call)) {
          issues.push(`${reference}: unsupported call type '${task.call}' (supported: ${SUPPORTED_CALLS.join(", ")})`);
        } else if (type === "do") {
          visit(task.do, reference);
        }
      }
    });
  };
  if (isObject(definition)) visit(definition.do, "");
  return issues;
}

function describe(errors: ErrorObject[]): string[] {
  return errors
    .filter((error) => error.keyword !== "if") // the failing branch reports the cause
    .map((error) => `${error.instancePath || "/"}: ${message(error)}`);
}

function message(error: ErrorObject): string {
  switch (error.keyword) {
    case "additionalProperties":
      return `unsupported property '${error.params.additionalProperty}'`;
    case "const":
      return `must be '${error.params.allowedValue}'`;
    default:
      return error.message ?? error.keyword;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
