import { expect, it } from "vitest";
import { CONTRACT_BASE, contractFiles, readContract } from "../contract/support/contracts.js";

// Relative `$ref`s between contract documents (e.g. from an event schema to
// `../schemas/run.schema.yaml`) must resolve the same way by file path, as the type
// generators read them, and by `$id`, as a JSON Schema validator does.

it("gives every JSON Schema under contracts/ the $id that mirrors its path", () => {
  const schemas = contractFiles().filter((file) => !file.startsWith("openapi/"));

  expect(schemas.length).toBeGreaterThan(0);
  expect(schemas.filter((file) => readContract(file).$id !== `${CONTRACT_BASE}${file}`)).toEqual([]);
});
