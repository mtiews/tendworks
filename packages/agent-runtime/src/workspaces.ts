import { readFileSync } from "node:fs";
import { readConfigDocuments } from "@tendworks/platform/config-documents";
import { workspaceProblem } from "@tendworks/platform/workspace-roots";
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
 * the control plane, which validates the whole configuration; a file that is not valid
 * YAML is an issue here too. A directory workspace must lie under one of `roots`
 * (`TEND_WORKSPACE_ROOTS`, seen at the same path as on the sandbox host), also after
 * resolving `..` and symbolic links. Throws a {@link WorkspaceError} listing every issue by file.
 */
export function loadWorkspaces(configDir: string, { roots = [] }: { roots?: readonly string[] } = {}): Workspace.Workspace[] {
  validate ??= new Ajv2020({ allErrors: true, strict: true }).compile(parse(readFileSync(SCHEMA, "utf8")));
  const { documents, issues } = readConfigDocuments(configDir, "Workspace");
  const workspaces = new Map<string, { file: string; workspace: Workspace.Workspace }>();

  for (const { file, document } of documents) {
    if (!validate(document)) {
      issues.push(...(validate.errors ?? []).map((error) => `${file}: ${error.instancePath || "/"}: ${error.message ?? error.keyword}`));
      continue;
    }
    const workspace = document as Workspace.Workspace;
    const problem = workspaceProblem(workspace.spec, roots);
    if (problem) {
      issues.push(`${file}: workspace '${workspace.metadata.name}': ${problem}`);
      continue;
    }
    const existing = workspaces.get(workspace.metadata.name);
    if (existing) issues.push(`${file}: workspace '${workspace.metadata.name}' is already defined in ${existing.file}`);
    else workspaces.set(workspace.metadata.name, { file, workspace });
  }

  if (issues.length > 0) throw new WorkspaceError(issues);
  return [...workspaces.values()].map(({ workspace }) => workspace);
}
