import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";

/*
 * Every document under contracts/, loaded into one validator. Each document is known by
 * the URL that mirrors its path under contracts/ (JSON Schemas carry it as `$id`, OpenAPI
 * documents get it here), so relative `$ref`s between documents resolve exactly as they
 * do on disk.
 */

export const CONTRACTS = new URL("../../../contracts/", import.meta.url);
export const CONTRACT_BASE = "https://tendworks.dev/schemas/v1/";

export type Document = Record<string, unknown>;

/** Path under contracts/ of every contract document, e.g. `events/run-events.schema.yaml`. */
export function contractFiles(): string[] {
  return readdirSync(CONTRACTS, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ya?ml|json)$/.test(entry.name))
    .map((entry) => relative(fileURLToPath(CONTRACTS), join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

export function readContract(file: string): Document {
  const text = readFileSync(new URL(file, CONTRACTS), "utf8");
  return (file.endsWith(".json") ? JSON.parse(text) : parse(text)) as Document;
}

let ajv: Ajv2020 | undefined;

function contracts(): Ajv2020 {
  if (ajv) return ajv;
  // OpenAPI 3.1 schemas are JSON Schema 2020-12, but OpenAPI documents and the
  // generators' annotations (`tsType`) are not, so unknown keywords are tolerated.
  ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
  addFormats.default(ajv);
  for (const file of contractFiles()) {
    const document = readContract(file);
    if ("openapi" in document) ajv.addSchema(document, `${CONTRACT_BASE}${file}`);
    else ajv.addSchema(document);
  }
  return ajv;
}

/** A validator for the schema at `ref`, a URL relative to {@link CONTRACT_BASE}, e.g. `events/run-events.schema.yaml#/$defs/runStarted`. */
export function contractSchema(ref: string): ValidateFunction {
  const id = new URL(ref, CONTRACT_BASE).href;
  const validate = contracts().getSchema(id);
  if (!validate) throw new Error(`no contract schema ${id}`);
  return validate;
}

export function describeErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? ""} ${JSON.stringify(error.params)}`).join("; ");
}
