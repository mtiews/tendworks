import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "@tendworks/shared";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { parse } from "yaml";

const SCHEMA = new URL("../../../contracts/schemas/workspace.schema.yaml", import.meta.url);

export class WorkspaceError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid workspaces:\n${issues.map((issue) => `  ${issue}`).join("\n")}`);
    this.name = "WorkspaceError";
  }
}

let validate: ((data: unknown) => boolean) & { errors?: ErrorObject[] | null };

/**
 * Reads the workspaces (`kind: Workspace`, ADR 0022) from a configuration folder, in any
 * YAML file outside hidden directories, and validates them. Other documents are left to
 * the control plane, which validates the whole configuration. Throws a
 * {@link WorkspaceError} listing every issue by file.
 */
export function loadWorkspaces(configDir: string): Workspace.Workspace[] {
  validate ??= new Ajv2020({ allErrors: true, strict: true }).compile(parse(readFileSync(SCHEMA, "utf8")));
  const issues: string[] = [];
  const workspaces = new Map<string, { file: string; workspace: Workspace.Workspace }>();

  for (const file of yamlFiles(configDir)) {
    let document: unknown;
    try {
      document = parse(readFileSync(join(configDir, file), "utf8"));
    } catch {
      continue; // not readable as YAML: the control plane reports it
    }
    if (typeof document !== "object" || document === null || (document as { kind?: unknown }).kind !== "Workspace") continue;
    if (!validate(document)) {
      issues.push(...(validate.errors ?? []).map((error) => `${file}: ${error.instancePath || "/"}: ${error.message ?? error.keyword}`));
      continue;
    }
    const workspace = document as Workspace.Workspace;
    const existing = workspaces.get(workspace.metadata.name);
    if (existing) issues.push(`${file}: workspace '${workspace.metadata.name}' is already defined in ${existing.file}`);
    else workspaces.set(workspace.metadata.name, { file, workspace });
  }

  if (issues.length > 0) throw new WorkspaceError(issues);
  return [...workspaces.values()].map(({ workspace }) => workspace);
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
