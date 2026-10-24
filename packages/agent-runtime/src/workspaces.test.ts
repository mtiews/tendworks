import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadWorkspaces, WorkspaceError } from "./index.js";

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tend-workspaces-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const workspace = (name: string, extra = "") =>
  `apiVersion: tendworks.dev/v1\nkind: Workspace\nmetadata: { name: ${name} }\nspec:\n  git: { url: https://git.example/acme/${name}.git, defaultBranch: main }\n  ${extra}\n`;

function issuesOf(dir: string): string[] {
  try {
    loadWorkspaces(dir);
  } catch (error) {
    if (error instanceof WorkspaceError) return error.issues;
    throw error;
  }
  throw new Error("expected the workspaces to be rejected");
}

describe("loadWorkspaces", () => {
  it("reads every workspace of the configuration folder, wherever it lies, and nothing else", () => {
    const dir = folder({
      "workspaces/app.yaml": workspace("app", "credentials: { secretRef: { name: TENDWORKS_AGENT_APP_TOKEN }, env: GH_TOKEN }"),
      "elsewhere/docs.yaml": workspace("docs"),
      "triggers/other.yaml": "apiVersion: tendworks.dev/v1\nkind: TriggerBinding\nmetadata: { name: other }\n",
      "broken.yaml": "not: [yaml",
      ".git/ignored.yaml": workspace("hidden"),
    });

    const workspaces = loadWorkspaces(dir);

    expect(workspaces.map((w) => w.metadata.name)).toEqual(["docs", "app"]);
    expect(workspaces[1]?.spec.credentials).toEqual({ secretRef: { name: "TENDWORKS_AGENT_APP_TOKEN" }, env: "GH_TOKEN" });
  });

  it("names the file of an invalid workspace and of a duplicate", () => {
    const dir = folder({
      "workspaces/a.yaml": workspace("app"),
      "workspaces/b.yaml": workspace("app"),
      "workspaces/c.yaml": workspace("platform", "credentials: { secretRef: { name: TENDWORKS_PLATFORM_GITHUB_TOKEN } }"),
    });

    expect(issuesOf(dir)).toEqual([
      "workspaces/b.yaml: workspace 'app' is already defined in workspaces/a.yaml",
      `workspaces/c.yaml: /spec/credentials/secretRef/name: must match pattern "^TENDWORKS_AGENT_[A-Z0-9_]+$"`,
    ]);
  });

  it("reads the starter configuration's workspaces", () => {
    const starter = fileURLToPath(new URL("../../../examples/config", import.meta.url));

    expect(loadWorkspaces(starter).map((w) => w.metadata.name)).toEqual(["playground"]);
  });
});
