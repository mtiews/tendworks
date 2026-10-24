import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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
      ".git/ignored.yaml": workspace("hidden"),
      ".git/broken.yaml": "not: [yaml",
    });

    const workspaces = loadWorkspaces(dir);

    expect(workspaces.map((w) => w.metadata.name)).toEqual(["docs", "app"]);
    expect(workspaces[1]?.spec.credentials).toEqual({ secretRef: { name: "TENDWORKS_AGENT_APP_TOKEN" }, env: "GH_TOKEN" });
  });

  it("refuses a configuration file that is not valid YAML, naming it, instead of passing over it", () => {
    const dir = folder({ "workspaces/app.yaml": workspace("app"), "workspaces/broken.yaml": "kind: [Workspace" });

    expect(issuesOf(dir)).toEqual([expect.stringMatching(/^workspaces\/broken\.yaml: invalid YAML: /)]);
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

  it("refuses credentials for a git workspace whose URL is not https, and reads an http URL without them", () => {
    const dir = folder({
      "workspaces/plain.yaml": workspace("plain", "credentials: { secretRef: { name: TENDWORKS_AGENT_APP_TOKEN } }").replace("https://", "http://"),
      "workspaces/public.yaml": workspace("public").replace("https://", "http://"),
    });

    expect(issuesOf(dir)).toEqual([
      "workspaces/plain.yaml: workspace 'plain': credentials need an https:// URL, but git.url is http://git.example/acme/plain.git; the credential would leave the sandbox unencrypted or go nowhere",
    ]);
  });

  it("reads directory workspaces under a workspace root and refuses those outside, also through '..' or a symbolic link", () => {
    const host = realpathSync.native(mkdtempSync(join(tmpdir(), "tend-host-")));
    const root = join(host, "root");
    mkdirSync(join(root, "app"), { recursive: true });
    mkdirSync(join(host, "outside"));
    symlinkSync(join(host, "outside"), join(root, "escape"), "junction");
    const directory = (name: string, path: string) =>
      `apiVersion: tendworks.dev/v1\nkind: Workspace\nmetadata: { name: ${name} }\nspec:\n  directory: { path: ${JSON.stringify(path)} }\n`;
    const app = { "workspaces/app.yaml": directory("app", join(root, "app")) };

    expect(loadWorkspaces(folder(app), { roots: [root] }).map((w) => w.spec.directory?.path)).toEqual([join(root, "app")]);
    let issues: string[] = [];
    try {
      loadWorkspaces(folder({ ...app, "workspaces/dots.yaml": directory("dots", `${join(root, "app")}/../../outside`), "workspaces/escape.yaml": directory("escape", join(root, "escape")) }), {
        roots: [root],
      });
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
      issues = error.issues;
    }
    expect(issues).toEqual([
      expect.stringMatching(/^workspaces\/dots\.yaml: workspace 'dots': directory .* is not under a workspace root/),
      expect.stringMatching(/^workspaces\/escape\.yaml: workspace 'escape': directory .* is not under a workspace root/),
    ]);
    expect(issuesOf(folder(app))).toEqual([expect.stringContaining("TEND_WORKSPACE_ROOTS allows no directory workspaces")]);
  });

  it("reads the starter configuration's workspaces", () => {
    const starter = fileURLToPath(new URL("../../../examples/config", import.meta.url));

    expect(loadWorkspaces(starter).map((w) => w.metadata.name)).toEqual(["playground"]);
  });
});
