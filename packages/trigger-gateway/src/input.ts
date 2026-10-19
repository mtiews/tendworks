import { run, type Value } from "@gabrielbryk/jq-ts";

// Input mappings use the same runtime expressions as workflows: jq inside `${ }`.

const EXPRESSION = /^\s*\$\{([\s\S]+)\}\s*$/;

/** The input mapping of a binding could not be evaluated. */
export class InputMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputMappingError";
  }
}

/** Evaluates every string leaf of the form `${ <jq> }` against `context`; everything else is copied. */
export function mapInput(template: unknown, context: unknown): unknown {
  if (typeof template === "string") {
    const program = EXPRESSION.exec(template)?.[1];
    if (program === undefined) return template;
    let results: Value[];
    try {
      results = run(program, context as Value);
    } catch (error) {
      throw new InputMappingError(`expression '${template}' failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (results.length !== 1) throw new InputMappingError(`expression '${template}' must yield exactly one value, got ${results.length}`);
    return results[0];
  }
  if (Array.isArray(template)) return template.map((item) => mapInput(item, context));
  if (template !== null && typeof template === "object") {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, mapInput(value, context)]));
  }
  return template;
}
