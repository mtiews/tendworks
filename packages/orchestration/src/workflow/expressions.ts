import { run, type Value } from "@gabrielbryk/jq-ts";

// Runtime expressions are jq. The library is pure and never reads the clock,
// so evaluation stays deterministic.

const EXPRESSION = /^\s*\$\{([\s\S]+)\}\s*$/;

export type Variables = Record<string, unknown>;

/** A runtime expression could not be evaluated. */
export class ExpressionError extends Error {}

/** Evaluates a jq program; `${ }` around it is optional. Must yield exactly one value. */
export function evaluate(expression: string, input: unknown, variables: Variables): unknown {
  const program = EXPRESSION.exec(expression)?.[1] ?? expression;
  let results: Value[];
  try {
    results = run(program, input as Value, { vars: variables as Record<string, Value> });
  } catch (error) {
    throw new ExpressionError(`expression '${expression}' failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (results.length !== 1) {
    throw new ExpressionError(`expression '${expression}' must yield exactly one value, got ${results.length}`);
  }
  return results[0];
}

/** Evaluates every string leaf of the form `${ ... }`; everything else is copied. */
export function evaluateTemplate(template: unknown, input: unknown, variables: Variables): unknown {
  if (typeof template === "string") {
    return EXPRESSION.test(template) ? evaluate(template, input, variables) : template;
  }
  if (Array.isArray(template)) return template.map((item) => evaluateTemplate(item, input, variables));
  if (template !== null && typeof template === "object") {
    return Object.fromEntries(
      Object.entries(template).map(([key, value]) => [key, evaluateTemplate(value, input, variables)]),
    );
  }
  return template;
}

/** A transformation (`input.from`, `output.as`, `export.as`) is an expression or an object template. */
export function transform(transformation: unknown, input: unknown, variables: Variables): unknown {
  if (transformation === undefined) return input;
  if (typeof transformation === "string") return evaluate(transformation, input, variables);
  return evaluateTemplate(transformation, input, variables);
}
