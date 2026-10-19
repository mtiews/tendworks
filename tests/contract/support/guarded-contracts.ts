import { afterAll, expect } from "vitest";
import { openApiContract, type OpenApiContract } from "./openapi-contract.js";

/**
 * The OpenAPI contracts `names` for a test file whose platform routes its exchanges
 * through their guards; after the file, none of them may have seen a violation (also
 * none a caller swallowed, e.g. a run's `call: http` step that failed on it).
 */
export function guardedContracts<Name extends string>(...names: Name[]): Record<Name, OpenApiContract> {
  const contracts = Object.fromEntries(names.map((name) => [name, openApiContract(name)])) as Record<Name, OpenApiContract>;
  afterAll(() => {
    for (const name of names) expect(contracts[name].violations(), `${name}: contract violations`).toEqual([]);
  });
  return contracts;
}
