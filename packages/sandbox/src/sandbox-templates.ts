import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { parse } from "yaml";
import type { SandboxTemplate } from "./sandbox-api.js";

const SCHEMA = new URL("../../../contracts/schemas/sandbox-template.schema.json", import.meta.url);

export class SandboxTemplateError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid sandbox templates:\n${issues.map((issue) => `  ${issue}`).join("\n")}`);
    this.name = "SandboxTemplateError";
  }
}

let validate: ((data: unknown) => boolean) & { errors?: ErrorObject[] | null };

/**
 * Reads every `kind: SandboxTemplate` document (YAML) from a configuration folder,
 * validated against its schema, by name. Throws a {@link SandboxTemplateError} listing
 * every issue by file.
 */
export function loadSandboxTemplates(configDir: string): Map<string, SandboxTemplate> {
  validate ??= new Ajv2020({ allErrors: true, strict: true }).compile(JSON.parse(readFileSync(SCHEMA, "utf8")));
  const files = readdirSync(configDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => relative(configDir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
  const issues: string[] = [];
  const templates = new Map<string, { file: string; template: SandboxTemplate }>();

  for (const file of files) {
    let document: unknown;
    try {
      document = parse(readFileSync(join(configDir, file), "utf8"));
    } catch {
      continue; // not readable as YAML: the control plane reports it
    }
    if (typeof document !== "object" || document === null || (document as { kind?: unknown }).kind !== "SandboxTemplate") continue;
    if (!validate(document)) {
      issues.push(...(validate.errors ?? []).map((error) => `${file}: ${error.instancePath || "/"}: ${error.message ?? error.keyword}`));
      continue;
    }
    const template = document as SandboxTemplate;
    const existing = templates.get(template.metadata.name);
    if (existing) issues.push(`${file}: sandbox template '${template.metadata.name}' is already defined in ${existing.file}`);
    else templates.set(template.metadata.name, { file, template });
  }

  if (issues.length > 0) throw new SandboxTemplateError(issues);
  return new Map([...templates].map(([name, { template }]) => [name, template]));
}
