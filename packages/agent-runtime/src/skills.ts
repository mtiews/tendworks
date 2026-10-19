import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** One file of a skill, by its path relative to the skill's directory (`/`-separated). */
export interface SkillFile {
  path: string;
  content: Uint8Array;
}

/** Skills by name: every directory under `skills/` of the configuration folder that holds a `SKILL.md`. */
export type Skills = Map<string, SkillFile[]>;

/**
 * Reads the skills (Agent Skills format) of a configuration folder: each
 * `skills/<name>/SKILL.md` with every file next to and below it, sorted by path.
 */
export function loadSkills(configDir: string): Skills {
  const root = join(configDir, "skills");
  const skills: Skills = new Map();
  if (!existsSync(root)) return skills;
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = join(root, entry.name);
    if (!entry.isDirectory() || !existsSync(join(dir, "SKILL.md"))) continue;
    const files = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((file) => file.isFile())
      .map((file) => join(file.parentPath, file.name))
      .map((path) => ({ path: relative(dir, path).split(sep).join("/"), content: new Uint8Array(readFileSync(path)) }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    skills.set(entry.name, files);
  }
  return skills;
}
