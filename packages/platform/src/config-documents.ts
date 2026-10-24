import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * Reading one kind of document from a configuration folder, for the bundles that need
 * only their part of it before the control plane has validated the whole (the worker's
 * workspaces and sandbox templates). Node.js only: imported as
 * `@tendworks/platform/config-documents`.
 */

/** A document of the asked kind, with the file it came from (relative to the folder, `/`-separated). */
export interface ConfigDocument {
  file: string;
  document: unknown;
}

/**
 * The documents of `kind` (e.g. `Workspace`) in the YAML files of `configDir`, in file
 * order; hidden files and directories (`.git`, `.github`) are skipped. A file that is not
 * valid YAML is an issue (`<file>: invalid YAML: <reason>`), never passed over, since it
 * may hold a document of the kind. Validation is up to the caller.
 */
export function readConfigDocuments(configDir: string, kind: string): { documents: ConfigDocument[]; issues: string[] } {
  const documents: ConfigDocument[] = [];
  const issues: string[] = [];
  for (const file of yamlFiles(configDir)) {
    let document: unknown;
    try {
      document = parse(readFileSync(join(configDir, file), "utf8"));
    } catch (error) {
      issues.push(`${file}: invalid YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      continue;
    }
    if (typeof document === "object" && document !== null && (document as { kind?: unknown }).kind === kind) documents.push({ file, document });
  }
  return { documents, issues };
}

/** YAML files by path relative to `dir`, sorted; hidden files and directories are skipped. */
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
