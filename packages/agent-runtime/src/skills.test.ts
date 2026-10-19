import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkills } from "./index.js";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("loadSkills", () => {
  it("reads every skill with all files next to its SKILL.md, by relative path", () => {
    const dir = mkdtempSync(join(tmpdir(), "tend-skills-"));
    mkdirSync(join(dir, "skills", "tdd", "references"), { recursive: true });
    writeFileSync(join(dir, "skills", "tdd", "SKILL.md"), "---\nname: tdd\n---\nRed, green.\n");
    writeFileSync(join(dir, "skills", "tdd", "references", "mocking.md"), "Mock at boundaries.\n");
    mkdirSync(join(dir, "skills", "not-a-skill"));
    writeFileSync(join(dir, "skills", "not-a-skill", "README.md"), "no SKILL.md here\n");

    const skills = loadSkills(dir);

    expect([...skills.keys()]).toEqual(["tdd"]);
    const files = skills.get("tdd")!.map(({ path, content }) => [path, decode(content)]);
    expect(files).toEqual([
      ["SKILL.md", "---\nname: tdd\n---\nRed, green.\n"],
      ["references/mocking.md", "Mock at boundaries.\n"],
    ]);
  });

  it("finds no skills in a configuration without a skills folder", () => {
    expect(loadSkills(mkdtempSync(join(tmpdir(), "tend-skills-"))).size).toBe(0);
  });
});
