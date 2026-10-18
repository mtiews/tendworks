import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigurationError, loadConfiguration } from "./index.js";

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tend-config-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const workflow = (name: string, agent = "developer") => `
document: { dsl: '1.0.3', namespace: test, name: ${name}, version: '0.1.0' }
do:
  - implement:
      call: a2a
      with:
        method: message/send
        agentCard: { endpoint: agent://${agent} }
        parameters:
          message:
            parts: [{ kind: text, text: build it }]
`;

const agent = (name: string, spec = "harness: fake") =>
  `---\napiVersion: tendworks.dev/v1\nkind: AgentProfile\nmetadata:\n  name: ${name}\nspec:\n  ${spec}\n---\nRole description.\n`;

function issuesOf(dir: string): string[] {
  try {
    loadConfiguration(dir);
  } catch (error) {
    if (error instanceof ConfigurationError) return error.issues;
    throw error;
  }
  throw new Error("expected the configuration to be rejected");
}

describe("loadConfiguration", () => {
  it("loads workflows by name and agent profiles", () => {
    const dir = folder({
      "workflows/build.sw.yaml": workflow("build"),
      "agents/developer.md": agent("developer"),
      "sandboxes/node.yaml": "apiVersion: tendworks.dev/v1\nkind: SandboxTemplate\nmetadata:\n  name: node\nspec:\n  image: node:24.21.0-trixie-slim\n",
    });

    const configuration = loadConfiguration(dir);

    expect(configuration.workflow("build")).toMatchObject({ document: { name: "build" } });
    expect(configuration.workflow("nope")).toBeUndefined();
    expect(configuration.workflowNames).toEqual(["build"]);
    expect(configuration.agentProfiles.map((profile) => profile.metadata.name)).toEqual(["developer"]);
  });

  it("names the file and field of every invalid document", () => {
    const dir = folder({
      "workflows/build.sw.yaml": workflow("build").replace("method: message/send", "method: message/stream"),
      "agents/developer.md": agent("developer", "harness: magic"),
      "sandboxes/node.yaml": "apiVersion: tendworks.dev/v1\nkind: SandboxTemplate\nmetadata:\n  name: node\nspec: {}\n",
    });

    expect(issuesOf(dir)).toEqual([
      "agents/developer.md: /spec/harness: must be equal to one of the allowed values (fake)",
      "sandboxes/node.yaml: /spec: must have required property 'image'",
      "workflows/build.sw.yaml: /do/0/implement/with/method: must be 'message/send'",
    ]);
  });

  it("rejects unknown kinds, unreadable YAML and missing frontmatter", () => {
    const dir = folder({
      "triggers/x.yaml": "apiVersion: tendworks.dev/v1\nkind: Gizmo\nmetadata: { name: x }\nspec: {}\n",
      "workflows/broken.sw.yaml": "document: [",
      "agents/plain.md": "no frontmatter\n",
    });

    const issues = issuesOf(dir);

    expect(issues[0]).toBe("agents/plain.md: missing YAML frontmatter");
    expect(issues[1]).toBe("triggers/x.yaml: unknown kind 'Gizmo' (known: AgentProfile, SandboxTemplate)");
    expect(issues[2]).toMatch(/^workflows\/broken\.sw\.yaml: invalid YAML: /);
  });

  it("rejects a workflow that calls an agent profile that is not configured", () => {
    const dir = folder({ "workflows/build.sw.yaml": workflow("build", "ghost"), "agents/developer.md": agent("developer") });

    expect(issuesOf(dir)).toEqual(["workflows/build.sw.yaml: /do/0/implement calls agent://ghost, but no agent profile 'ghost' is configured"]);
  });

  it("rejects two workflows with the same name", () => {
    const dir = folder({
      "workflows/a.sw.yaml": workflow("build"),
      "workflows/b.sw.yaml": workflow("build"),
      "agents/developer.md": agent("developer"),
    });

    expect(issuesOf(dir)).toEqual(["workflows/b.sw.yaml: workflow 'build' is already defined in workflows/a.sw.yaml"]);
  });

  it("rejects a folder that does not exist", () => {
    expect(() => loadConfiguration(join(tmpdir(), "tend-config-missing"))).toThrow(/cannot read configuration folder/);
  });

  it("accepts the example configuration shipped with the repository", () => {
    const examples = fileURLToPath(new URL("../../../examples/config", import.meta.url));

    expect(loadConfiguration(examples).workflowNames.length).toBeGreaterThan(0);
  });
});
