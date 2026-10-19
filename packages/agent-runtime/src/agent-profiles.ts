import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProfile } from "@tendworks/shared";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { parse } from "yaml";

const SCHEMA = new URL("../../../contracts/schemas/agent-profile.schema.yaml", import.meta.url);

export class AgentProfileError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid agent profiles:\n${issues.map((issue) => `  ${issue}`).join("\n")}`);
    this.name = "AgentProfileError";
  }
}

/** An agent profile as configured: the frontmatter plus the role description below it. */
export type LoadedAgentProfile = AgentProfile.AgentProfile & {
  /** The Markdown body: what the agent is and how it works. Left out when empty. */
  role?: string;
};

let validate: ((data: unknown) => boolean) & { errors?: ErrorObject[] | null };

/**
 * Reads the agent profiles (`agents/*.md`, Markdown with YAML frontmatter) from a
 * configuration folder and validates them, including that every skill a profile names
 * exists as `skills/<name>/SKILL.md`. Throws an {@link AgentProfileError} listing
 * every issue by file.
 */
export function loadAgentProfiles(configDir: string): LoadedAgentProfile[] {
  validate ??= new Ajv2020({ allErrors: true, strict: true }).compile(parse(readFileSync(SCHEMA, "utf8")));
  const files = readdirSync(join(configDir, "agents")).filter((file) => file.endsWith(".md")).sort();
  const issues: string[] = [];
  const profiles = new Map<string, { file: string; profile: LoadedAgentProfile }>();

  for (const name of files) {
    const file = `agents/${name}`;
    const text = readFileSync(join(configDir, "agents", name), "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!frontmatter) {
      issues.push(`${file}: missing YAML frontmatter`);
      continue;
    }
    const document = parse(frontmatter[1]!) as unknown;
    if (!validate(document)) {
      issues.push(...(validate.errors ?? []).map((error) => `${file}: ${error.instancePath || "/"}: ${describe(error)}`));
      continue;
    }
    const missing = (document as AgentProfile.AgentProfile).spec.skills?.filter((skill) => !existsSync(join(configDir, "skills", skill, "SKILL.md")));
    if (missing?.length) {
      issues.push(...missing.map((skill) => `${file}: /spec/skills: no skill '${skill}' (skills/${skill}/SKILL.md)`));
      continue;
    }
    const role = text.slice(frontmatter[0].length).trim();
    const profile: LoadedAgentProfile = { ...(document as AgentProfile.AgentProfile), ...(role ? { role } : {}) };
    const existing = profiles.get(profile.metadata.name);
    if (existing) issues.push(`${file}: agent profile '${profile.metadata.name}' is already defined in ${existing.file}`);
    else profiles.set(profile.metadata.name, { file, profile });
  }

  if (issues.length > 0) throw new AgentProfileError(issues);
  return [...profiles.values()].map(({ profile }) => profile);
}

function describe(error: ErrorObject): string {
  if (error.keyword === "enum") return `${error.message} (${(error.params.allowedValues as unknown[]).join(", ")})`;
  if (error.keyword === "additionalProperties") return `unsupported property '${error.params.additionalProperty}'`;
  return error.message ?? error.keyword;
}
