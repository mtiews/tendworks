import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProfile, TriggerBinding, Workflow } from "@tendworks/shared";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { parse } from "yaml";

// The control plane reads the configuration folder and validates every document
// against the JSON Schema of its kind (contracts/schemas), so mistakes surface at
// startup instead of in a run.

const schemas = new URL("../../../contracts/schemas/", import.meta.url);

/** Schemas of the `kind`s in the apiVersion/kind/metadata/spec envelope. */
const KINDS: Record<string, string> = {
  AgentProfile: "agent-profile.schema.yaml",
  SandboxTemplate: "sandbox-template.schema.json",
  TriggerBinding: "trigger-binding.schema.yaml",
};
const WORKFLOW_SCHEMA = "serverless-workflow.schema.yaml";

export class ConfigurationError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid configuration:\n${issues.map((issue) => `  ${issue}`).join("\n")}`);
    this.name = "ConfigurationError";
  }
}

export interface Configuration {
  /** Names of all workflows (`document.name`), sorted. */
  workflowNames: string[];
  /** The definition of the workflow with this name, as parsed from its file. */
  workflow(name: string): Workflow.Workflow | undefined;
  agentProfiles: AgentProfile.AgentProfile[];
  /** Trigger bindings, ordered by name; each starts a configured workflow. */
  triggerBindings: TriggerBinding.TriggerBinding[];
}

/** A configuration with nothing configured, for tests; `overrides` sets what a test needs. */
export function emptyConfiguration(overrides: Partial<Configuration> = {}): Configuration {
  return { workflowNames: [], workflow: () => undefined, agentProfiles: [], triggerBindings: [], ...overrides };
}

let ajv: Ajv2020 | undefined;
const validators = new Map<string, ValidateFunction>();

function validatorFor(schemaFile: string): ValidateFunction {
  ajv ??= new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).addKeyword({ keyword: "tsType" });
  let validate = validators.get(schemaFile);
  if (!validate) {
    validate = ajv.compile(parse(readFileSync(new URL(schemaFile, schemas), "utf8")));
    validators.set(schemaFile, validate);
  }
  return validate;
}

/**
 * Reads and validates the configuration folder: workflows (YAML with a `document`),
 * agent profiles (`agents/*.md`, Markdown with YAML frontmatter) and every other YAML
 * document by its `kind`. Throws a {@link ConfigurationError} listing every issue.
 */
export function loadConfiguration(dir: string): Configuration {
  let files: string[];
  try {
    files = listFiles(dir);
  } catch (error) {
    throw new ConfigurationError([`cannot read configuration folder ${dir}: ${error instanceof Error ? error.message : String(error)}`]);
  }

  const issues: string[] = [];
  const workflows = new Map<string, { file: string; definition: Workflow.Workflow }>();
  const profiles = new Map<string, { file: string; profile: AgentProfile.AgentProfile }>();
  const bindings = new Map<string, { file: string; binding: TriggerBinding.TriggerBinding }>();

  const check = (file: string, schemaFile: string, document: unknown): boolean => {
    const validate = validatorFor(schemaFile);
    if (validate(document)) return true;
    issues.push(...describe(validate.errors ?? []).map((issue) => `${file}: ${issue}`));
    return false;
  };

  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8");
    if (file.endsWith(".md")) {
      if (!file.startsWith("agents/")) continue; // documentation, not configuration
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
      if (!frontmatter) {
        issues.push(`${file}: missing YAML frontmatter`);
        continue;
      }
      const document = parseYaml(file, frontmatter[1]!, issues);
      if (document === undefined || !check(file, KINDS.AgentProfile!, document)) continue;
      const profile = document as AgentProfile.AgentProfile;
      const existing = profiles.get(profile.metadata.name);
      if (existing) issues.push(`${file}: agent profile '${profile.metadata.name}' is already defined in ${existing.file}`);
      else profiles.set(profile.metadata.name, { file, profile });
      continue;
    }

    const document = parseYaml(file, text, issues);
    if (document === undefined) continue;
    if (isObject(document) && "document" in document) {
      if (!check(file, WORKFLOW_SCHEMA, document)) continue;
      const definition = document as unknown as Workflow.Workflow;
      const existing = workflows.get(definition.document.name);
      if (existing) issues.push(`${file}: workflow '${definition.document.name}' is already defined in ${existing.file}`);
      else workflows.set(definition.document.name, { file, definition });
      continue;
    }
    const kind = isObject(document) ? document.kind : undefined;
    const schemaFile = typeof kind === "string" ? KINDS[kind] : undefined;
    if (schemaFile === undefined) {
      const known = `known: ${Object.keys(KINDS).join(", ")}`;
      issues.push(typeof kind === "string" ? `${file}: unknown kind '${kind}' (${known})` : `${file}: neither a workflow nor a document with a kind (${known})`);
      continue;
    }
    if (!check(file, schemaFile, document)) continue;
    if (kind !== "TriggerBinding") continue;
    const binding = document as unknown as TriggerBinding.TriggerBinding;
    const existing = bindings.get(binding.metadata.name);
    if (existing) issues.push(`${file}: trigger binding '${binding.metadata.name}' is already defined in ${existing.file}`);
    else bindings.set(binding.metadata.name, { file, binding });
  }

  for (const { file, definition } of workflows.values()) {
    for (const [reference, agent] of agentCalls(definition.do, "")) {
      if (!profiles.has(agent)) issues.push(`${file}: ${reference} calls agent://${agent}, but no agent profile '${agent}' is configured`);
    }
  }

  for (const { file, binding } of bindings.values()) {
    const { workflow } = binding.spec;
    if (!workflows.has(workflow)) {
      issues.push(`${file}: trigger binding '${binding.metadata.name}' starts workflow '${workflow}', but no workflow '${workflow}' is configured`);
    }
  }

  if (issues.length > 0) throw new ConfigurationError(issues);
  return {
    workflowNames: [...workflows.keys()].sort(),
    workflow: (name) => workflows.get(name)?.definition,
    agentProfiles: [...profiles.values()].map(({ profile }) => profile),
    triggerBindings: [...bindings.values()].map(({ binding }) => binding).sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)),
  };
}

/**
 * Configuration files by path relative to `dir` (`/`-separated), sorted. Hidden files and
 * directories (`.git`, `.github`) are skipped, so a configuration repository can carry its
 * own history and CI.
 */
function listFiles(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .flatMap((entry) => {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) return listFiles(dir, path);
      return entry.isFile() && /\.(ya?ml|md)$/.test(entry.name) ? [path] : [];
    })
    .sort();
}

function parseYaml(file: string, text: string, issues: string[]): unknown {
  try {
    return parse(text) as unknown;
  } catch (error) {
    issues.push(`${file}: invalid YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    return undefined;
  }
}

/** Every `call: a2a` in a task list as [task reference, agent profile name]. */
function agentCalls(tasks: Workflow.TaskList, scope: string): [string, string][] {
  return tasks.flatMap((item, index) =>
    Object.entries(item).flatMap(([name, task]): [string, string][] => {
      const reference = `${scope}/do/${index}/${name}`;
      if ("call" in task) return task.call === "a2a" ? [[reference, task.with.agentCard.endpoint.slice("agent://".length)]] : [];
      return "do" in task ? agentCalls(task.do, reference) : [];
    }),
  );
}

function describe(errors: ErrorObject[]): string[] {
  return errors
    .filter((error) => error.keyword !== "if") // the failing branch reports the cause
    .map((error) => `${error.instancePath || "/"}: ${message(error)}`);
}

function message(error: ErrorObject): string {
  switch (error.keyword) {
    case "additionalProperties":
      return `unsupported property '${error.params.additionalProperty}'`;
    case "const":
      return `must be '${error.params.allowedValue}'`;
    case "enum":
      return `${error.message} (${(error.params.allowedValues as unknown[]).join(", ")})`;
    default:
      return error.message ?? error.keyword;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
