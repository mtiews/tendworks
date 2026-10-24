import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretResolver } from "@tendworks/platform";
import type { Workspace as Kind } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { createGitWorkspace, createWorkspaces, type PreparedWorkspace } from "./workspace.js";
import { workspaceRequestOf } from "./workspace.js";

/*
 * The checkout runs inside the sandbox; here it runs on the test host against a local
 * bare repository standing in for the remote, with the same shell and git commands.
 */

const identity = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.test",
};

function run(command: string[], cwd: string, env: Record<string, string> = {}) {
  const result = spawnSync(command[0]!, command.slice(1), { cwd, encoding: "utf8", env: { ...process.env, ...identity, ...env } });
  if (result.error) throw result.error;
  return result;
}

function git(cwd: string, ...args: string[]) {
  const result = run(["git", ...args], cwd);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A bare remote with one commit on `main` and an agent branch with one more. */
function remote() {
  const root = mkdtempSync(join(tmpdir(), "tend-workspace-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(seed, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(seed, "README.md"), "hello\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "initial");
  git(seed, "push", "--quiet", origin, "main");
  git(seed, "checkout", "--quiet", "-b", "tendworks/run-earlier");
  writeFileSync(join(seed, "progress.txt"), "half done\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "progress");
  git(seed, "push", "--quiet", origin, "tendworks/run-earlier");
  // A second line of work on the remote that is not its default branch.
  git(seed, "checkout", "--quiet", "-b", "develop", "main");
  writeFileSync(join(seed, "develop.txt"), "develop\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "develop");
  git(seed, "push", "--quiet", origin, "develop");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  return { origin, workspace };
}

const noSecrets = createSecretResolver("agent", {});

async function prepared(url: string, branch?: string, defaultBranch = "main"): Promise<PreparedWorkspace> {
  const result = await createGitWorkspace({ name: "app", url, defaultBranch }, noSecrets).prepare({ taskId: "task-1", ...(branch === undefined ? {} : { branch }) });
  if ("problem" in result) throw new Error(result.problem);
  return result;
}

async function checkout(workspace: string, url: string, branch?: string, defaultBranch?: string) {
  const { checkout } = await prepared(url, branch, defaultBranch);
  return run(checkout!.command, workspace, checkout!.env);
}

// Each test runs git several times synchronously; on Windows, inside the parallel unit
// suite, that can take longer than the default timeout.
describe("git workspace: checkout", { timeout: 20_000 }, () => {
  it("clones the repository and starts a new branch from the default branch", async () => {
    const { origin, workspace } = remote();

    const result = await checkout(workspace, origin, "tendworks/run-1");

    expect(result.status, result.stderr).toBe(0);
    expect(git(workspace, "branch", "--show-current")).toBe("tendworks/run-1");
    expect(readFileSync(join(workspace, "README.md"), "utf8").trim()).toBe("hello");
  });

  it("starts a new branch from the workspace's default branch, not from the remote's", async () => {
    const { origin, workspace } = remote();

    const result = await checkout(workspace, origin, "tendworks/run-1", "develop");

    expect(result.status, result.stderr).toBe(0);
    expect(git(workspace, "branch", "--show-current")).toBe("tendworks/run-1");
    expect(existsSync(join(workspace, "develop.txt"))).toBe(true);
  });

  it("continues on the branch when the remote already has it, e.g. from an earlier attempt", async () => {
    const { origin, workspace } = remote();

    const result = await checkout(workspace, origin, "tendworks/run-earlier");

    expect(result.status, result.stderr).toBe(0);
    expect(git(workspace, "branch", "--show-current")).toBe("tendworks/run-earlier");
    expect(readFileSync(join(workspace, "progress.txt"), "utf8").trim()).toBe("half done");
  });

  it("stays on the default branch when no branch is asked for", async () => {
    const { origin, workspace } = remote();

    const result = await checkout(workspace, origin, undefined, "develop");

    expect(result.status, result.stderr).toBe(0);
    expect(git(workspace, "branch", "--show-current")).toBe("develop");
  });

  it("keeps a workspace without a branch that is already checked out, e.g. when a chat resumes", async () => {
    const { origin, workspace } = remote();
    await checkout(workspace, origin);
    writeFileSync(join(workspace, "draft.txt"), "uncommitted\n");

    const result = await checkout(workspace, origin);

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(workspace, "draft.txt"))).toBe(true);
  });

  it("keeps a workspace that is already checked out, including uncommitted work", async () => {
    const { origin, workspace } = remote();
    await checkout(workspace, origin, "tendworks/run-1");
    writeFileSync(join(workspace, "draft.txt"), "uncommitted\n");

    const result = await checkout(workspace, origin, "tendworks/run-1");

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(workspace, "draft.txt"))).toBe(true);
  });

  it("fails with git's error output when the repository cannot be cloned", async () => {
    const { workspace } = remote();

    const result = await checkout(workspace, join(workspace, "..", "nowhere.git"), "tendworks/run-1");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/nowhere\.git/);
  });

  it("never reads a value as an option", async () => {
    const { workspace } = remote();

    const result = await checkout(workspace, "--upload-pack=false", "tendworks/run-1");

    expect(result.status).not.toBe(0);
  });

  it("lets git use the credential helper for the repository's host only, kept with the checkout", async () => {
    const { origin, workspace } = remote();
    const { checkout: https } = await prepared("https://git.example:8443/acme/app.git");
    // Cloned from the local remote, with the https workspace's scope, as the sandbox would clone it.
    const command = [...https!.command.slice(0, 4), origin, ...https!.command.slice(5)];

    const result = run(command, workspace);

    expect(result.status, result.stderr).toBe(0);
    expect(git(workspace, "config", "--get", "credential.https://git.example:8443.helper")).toBe("tendworks");
    expect(run(["git", "config", "--local", "--get-regexp","^credential\\..*helper$"], workspace).stdout.trim().split("\n")).toHaveLength(1);
  });
});

describe("git workspace: credentials", () => {
  const credentials = { secretRef: { name: "TENDWORKS_AGENT_APP_TOKEN" } };
  const secrets = createSecretResolver("agent", { TENDWORKS_AGENT_APP_TOKEN: "app-token-value", TENDWORKS_PLATFORM_TOKEN: "platform" });
  const git = (more: Partial<Parameters<typeof createGitWorkspace>[0]> = {}) =>
    createGitWorkspace({ name: "app", url: "https://git.example/acme/app.git", defaultBranch: "main", credentials, ...more }, secrets);

  it("hands the workspace's credential to git's credential helper for the checkout and the session", async () => {
    const result = (await git().prepare({ taskId: "task-1", branch: "tendworks/run-1" })) as PreparedWorkspace;

    const helper = { TENDWORKS_GIT_USERNAME: "x-access-token", TENDWORKS_GIT_PASSWORD: "app-token-value" }; // betterleaks:allow dummy token of the test
    expect(result.checkout?.env).toEqual(helper);
    expect(result.sessionEnv).toEqual(helper);
    expect(result.secrets).toEqual(["app-token-value"]);
  });

  it("exposes the credential to the session under the configured name, and sends the configured user name", async () => {
    const result = (await git({ credentials: { ...credentials, env: "GH_TOKEN", username: "agent" } }).prepare({ taskId: "task-1" })) as PreparedWorkspace;

    expect(result.sessionEnv).toEqual({ TENDWORKS_GIT_USERNAME: "agent", TENDWORKS_GIT_PASSWORD: "app-token-value", GH_TOKEN: "app-token-value" }); // betterleaks:allow dummy token of the test
    expect(result.checkout?.env).not.toHaveProperty("GH_TOKEN");
  });

  it("names a missing secret, and one not meant for agents, but no value", async () => {
    expect(await git({ credentials: { secretRef: { name: "TENDWORKS_AGENT_NOT_SET" } } }).prepare({ taskId: "task-1" })).toEqual({
      problem: "secret TENDWORKS_AGENT_NOT_SET is not set",
    });
    expect(await git({ credentials: { secretRef: { name: "TENDWORKS_PLATFORM_TOKEN" } } }).prepare({ taskId: "task-1" })).toEqual({
      problem: expect.stringContaining("TENDWORKS_PLATFORM_TOKEN is not an agent secret"),
    });
  });

  it("works without a credential, e.g. on a public repository", async () => {
    const result = (await createGitWorkspace({ url: "https://git.example/acme/app.git" }).prepare({ taskId: "task-1" })) as PreparedWorkspace;

    expect(result.checkout?.env).toEqual({});
    expect(result.sessionEnv).toEqual({});
    expect(result.secrets).toEqual([]);
  });

  it("keeps the checkout on a volume of the agent session and says what was checked out", async () => {
    const result = (await git().prepare({ taskId: "task-1", branch: "tendworks/run-1" })) as PreparedWorkspace;

    expect(result.mount).toEqual({ volume: "task-1-workspace" });
    expect(result.checkout?.describes).toEqual({ url: "https://git.example/acme/app.git", name: "app", branch: "tendworks/run-1" });
  });
});

describe("createWorkspaces", () => {
  const kind = (name: string, url = `https://git.example/acme/${name}.git`): Kind.Workspace => ({
    apiVersion: "tendworks.dev/v1",
    kind: "Workspace",
    metadata: { name },
    spec: { git: { url, defaultBranch: "main" } },
  });

  it("finds the configured workspaces by name, and no other", async () => {
    const workspaces = createWorkspaces([kind("app"), kind("docs")], { secrets: noSecrets });

    const docs = (await workspaces("docs")!.prepare({ taskId: "task-1" })) as PreparedWorkspace;
    expect(docs.checkout?.describes).toEqual({ url: "https://git.example/acme/docs.git", name: "docs" });
    expect(workspaces("ghost")).toBeUndefined();
  });
});

describe("workspaceRequestOf", () => {
  const message = (metadata?: Record<string, unknown>) => ({
    messageId: "m-1",
    role: "ROLE_USER" as const,
    parts: [{ text: "work" }],
    ...(metadata ? { metadata } : {}),
  });

  it("reads the workspace a message asks for by name, with the branch to work on", () => {
    const workspace = { name: "app", branch: "tendworks/run-1" };

    expect(workspaceRequestOf(message({ "dev.tendworks/workspace": workspace }))).toEqual({ request: workspace });
  });

  it("reads a workspace without a branch", () => {
    expect(workspaceRequestOf(message({ "dev.tendworks/workspace": { name: "app" } }))).toEqual({ request: { name: "app" } });
  });

  it("is empty for a message without a workspace", () => {
    expect(workspaceRequestOf(message())).toEqual({});
  });

  it.each([
    [{ branch: "x" }],
    [{ name: "", branch: "x" }],
    [{ name: "app", branch: "-x" }],
    [{ name: "app", branch: "a b" }],
    [{ name: "-app" }],
    [{ repository: "https://git.example/acme/app.git" }],
    ["app"],
  ])("names the problem with a malformed workspace %j", (workspace) => {
    expect(workspaceRequestOf(message({ "dev.tendworks/workspace": workspace }))).toEqual({ problem: expect.stringContaining("dev.tendworks/workspace") });
  });
});
