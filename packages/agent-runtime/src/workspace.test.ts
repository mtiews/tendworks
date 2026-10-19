import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkoutCommand, workspaceOf } from "./workspace.js";

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

function run(command: string[], cwd: string) {
  const result = spawnSync(command[0]!, command.slice(1), { cwd, encoding: "utf8", env: { ...process.env, ...identity } });
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
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  return { origin, workspace };
}

function checkout(workspace: string, repository: string, branch: string) {
  const request = checkoutCommand({ repository, branch });
  return run(request.command, workspace);
}

// Each test runs git several times synchronously; on Windows, inside the parallel unit
// suite, that can take longer than the default timeout.
describe("workspace checkout", { timeout: 20_000 }, () => {
  it("clones the repository and starts a new branch from the default branch", () => {
    const { origin, workspace } = remote();

    const result = checkout(workspace, origin, "tendworks/run-1");

    expect(result.status, result.stderr).toBe(0);
    expect(git(workspace, "branch", "--show-current")).toBe("tendworks/run-1");
    expect(readFileSync(join(workspace, "README.md"), "utf8").trim()).toBe("hello");
  });

  it("continues on the branch when the remote already has it, e.g. from an earlier attempt", () => {
    const { origin, workspace } = remote();

    const result = checkout(workspace, origin, "tendworks/run-earlier");

    expect(result.status, result.stderr).toBe(0);
    expect(git(workspace, "branch", "--show-current")).toBe("tendworks/run-earlier");
    expect(readFileSync(join(workspace, "progress.txt"), "utf8").trim()).toBe("half done");
  });

  it("keeps a workspace that is already checked out, including uncommitted work", () => {
    const { origin, workspace } = remote();
    checkout(workspace, origin, "tendworks/run-1");
    writeFileSync(join(workspace, "draft.txt"), "uncommitted\n");

    const result = checkout(workspace, origin, "tendworks/run-1");

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(workspace, "draft.txt"))).toBe(true);
  });

  it("fails with git's error output when the repository cannot be cloned", () => {
    const { workspace } = remote();

    const result = checkout(workspace, join(workspace, "..", "nowhere.git"), "tendworks/run-1");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/nowhere\.git/);
  });

  it("never reads a value as an option", () => {
    const { workspace } = remote();

    const result = checkout(workspace, "--upload-pack=false", "tendworks/run-1");

    expect(result.status).not.toBe(0);
  });
});

describe("workspaceOf", () => {
  const message = (metadata?: Record<string, unknown>) => ({
    messageId: "m-1",
    role: "ROLE_USER" as const,
    parts: [{ text: "work" }],
    ...(metadata ? { metadata } : {}),
  });

  it("reads the workspace a message asks for", () => {
    const workspace = { repository: "https://git.example/acme/app.git", branch: "tendworks/run-1" };

    expect(workspaceOf(message({ "dev.tendworks/workspace": workspace }))).toEqual({ workspace });
  });

  it("is empty for a message without a workspace", () => {
    expect(workspaceOf(message())).toEqual({});
  });

  it.each([
    [{ repository: "https://git.example/acme/app.git" }],
    [{ repository: "", branch: "x" }],
    [{ repository: "https://git.example/acme/app.git", branch: "-x" }],
    [{ repository: "https://git.example/acme/app.git", branch: "a b" }],
    ["https://git.example/acme/app.git"],
  ])("names the problem with a malformed workspace %j", (workspace) => {
    expect(workspaceOf(message({ "dev.tendworks/workspace": workspace }))).toEqual({ problem: expect.stringContaining("dev.tendworks/workspace") });
  });
});
