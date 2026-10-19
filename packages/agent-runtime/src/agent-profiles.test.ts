import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentProfileError, loadAgentProfiles } from "./index.js";

function configWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tend-agents-"));
  mkdirSync(join(dir, "agents"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, "agents", name), content);
  return dir;
}

describe("loadAgentProfiles", () => {
  it("reads every agent profile with its frontmatter and role description", () => {
    const dir = configWith({
      "echo.md": "---\napiVersion: tendworks.dev/v1\nkind: AgentProfile\nmetadata:\n  name: echo\nspec:\n  harness: fake\n  fake:\n    delaySeconds: 1\n---\nYou echo.\n",
      "notes.txt": "not a profile",
    });

    expect(loadAgentProfiles(dir)).toEqual([
      {
        apiVersion: "tendworks.dev/v1",
        kind: "AgentProfile",
        metadata: { name: "echo" },
        spec: { harness: "fake", fake: { delaySeconds: 1 } },
        role: "You echo.",
      },
    ]);
  });

  it("rejects a profile that names a skill the configuration does not contain", () => {
    const dir = configWith({
      "developer.md": "---\napiVersion: tendworks.dev/v1\nkind: AgentProfile\nmetadata:\n  name: developer\nspec:\n  harness: fake\n  skills: [tdd, missing]\n---\n",
    });
    mkdirSync(join(dir, "skills", "tdd"), { recursive: true });
    writeFileSync(join(dir, "skills", "tdd", "SKILL.md"), "---\nname: tdd\n---\n");

    expect(() => loadAgentProfiles(dir)).toThrow("agents/developer.md: /spec/skills: no skill 'missing' (skills/missing/SKILL.md)");
  });

  it("names the file and field of an invalid profile", () => {
    const dir = configWith({
      "broken.md": "---\napiVersion: tendworks.dev/v1\nkind: AgentProfile\nmetadata:\n  name: broken\nspec:\n  harness: magic\n---\n",
      "bare.md": "no frontmatter here\n",
    });

    expect(() => loadAgentProfiles(dir)).toThrow(AgentProfileError);
    expect(() => loadAgentProfiles(dir)).toThrow(
      /agents\/bare\.md: missing YAML frontmatter[\s\S]*agents\/broken\.md: \/spec\/harness: must be equal to one of the allowed values \(fake, claude-code\)/,
    );
  });

  it("requires a sandbox template for a profile whose harness runs in a sandbox", () => {
    const dir = configWith({
      "developer.md": "---\napiVersion: tendworks.dev/v1\nkind: AgentProfile\nmetadata:\n  name: developer\nspec:\n  harness: claude-code\n---\n",
    });

    expect(() => loadAgentProfiles(dir)).toThrow(/agents\/developer\.md: \/spec: must have required property 'sandbox'/);
  });

  it("rejects two profiles with the same name", () => {
    const profile = "---\napiVersion: tendworks.dev/v1\nkind: AgentProfile\nmetadata:\n  name: twin\nspec:\n  harness: fake\n---\n";
    const dir = configWith({ "a.md": profile, "b.md": profile });

    expect(() => loadAgentProfiles(dir)).toThrow("agents/b.md: agent profile 'twin' is already defined in agents/a.md");
  });
});
