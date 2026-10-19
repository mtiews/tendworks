import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSandboxTemplates, SandboxTemplateError } from "./index.js";

function configWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tend-sandboxes-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const template = (name: string, image = "tendworks/sandbox-claude-code:0.85.1") =>
  `apiVersion: tendworks.dev/v1\nkind: SandboxTemplate\nmetadata:\n  name: ${name}\nspec:\n  image: ${image}\n`;

describe("loadSandboxTemplates", () => {
  it("reads every sandbox template of the configuration folder by name, ignoring other documents", () => {
    const dir = configWith({
      "sandboxes/claude-code.yaml": template("claude-code"),
      "sandboxes/nested/busybox.yml": template("busybox", "busybox:1.37.0"),
      "workflows/hello.sw.yaml": "document: { dsl: '1.0.3', namespace: x, name: hello, version: '0.1.0' }\ndo: []\n",
      "agents/developer.md": "---\nkind: AgentProfile\n---\n",
    });

    const templates = loadSandboxTemplates(dir);

    expect([...templates.keys()].sort()).toEqual(["busybox", "claude-code"]);
    expect(templates.get("claude-code")?.spec).toEqual({ image: "tendworks/sandbox-claude-code:0.85.1" });
  });

  it("names the file and field of an invalid template and of a duplicate name", () => {
    const dir = configWith({
      "sandboxes/a.yaml": template("twin"),
      "sandboxes/b.yaml": template("twin"),
      "sandboxes/root.yaml": `${template("root")}  user: "0"\n`,
    });

    expect(() => loadSandboxTemplates(dir)).toThrow(SandboxTemplateError);
    expect(() => loadSandboxTemplates(dir)).toThrow(/sandboxes\/b\.yaml: sandbox template 'twin' is already defined in sandboxes\/a\.yaml/);
    expect(() => loadSandboxTemplates(dir)).toThrow(/sandboxes\/root\.yaml: \/spec\/user: must match pattern/);
  });
});
