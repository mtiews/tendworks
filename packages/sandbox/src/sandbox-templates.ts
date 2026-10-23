import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
 *
 * `pinnedImages` are the deployment's own images with their pins (tag or digest): a
 * template that names one of them by its repository alone gets the pin filled in, so a
 * copied configuration follows the deployment's updates.
 */
export function loadSandboxTemplates(configDir: string, { pinnedImages = [] }: { pinnedImages?: string[] } = {}): Map<string, SandboxTemplate> {
  const pins = new Map(pinnedImages.map((image) => [repositoryOf(image), image]));
  validate ??= new Ajv2020({ allErrors: true, strict: true }).compile(JSON.parse(readFileSync(SCHEMA, "utf8")));
  const files = yamlFiles(configDir);
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
    template.spec.image = pins.get(template.spec.image) ?? template.spec.image;
    const existing = templates.get(template.metadata.name);
    if (existing) issues.push(`${file}: sandbox template '${template.metadata.name}' is already defined in ${existing.file}`);
    else templates.set(template.metadata.name, { file, template });
  }

  if (issues.length > 0) throw new SandboxTemplateError(issues);
  return new Map([...templates].map(([name, { template }]) => [name, template]));
}

/** An image reference without its tag or digest; a registry port (`host:5000/name`) is no tag. */
function repositoryOf(image: string): string {
  const name = image.split("@")[0]!;
  const tag = name.lastIndexOf(":");
  return tag > name.lastIndexOf("/") ? name.slice(0, tag) : name;
}

/** YAML files by path relative to `dir`, sorted; hidden files and directories (`.git`, `.github`) are skipped. */
function yamlFiles(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .flatMap((entry) => {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) return yamlFiles(dir, path);
      return entry.isFile() && /\.ya?ml$/.test(entry.name) ? [path] : [];
    })
    .sort();
}
