import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The test suites run on the fixture configuration: the starter configuration
// (examples/config) with the fakes and scripted profiles of tests/fixtures/config layered
// on top. The starter files are never copied by hand, so the suites always test what an
// operator starts from. A fixture file may only add, never replace a starter file.
//
// As a script it assembles the fixture configuration for the compose stack and runs a
// command with TEND_CONFIG_PATH pointing at it (`pnpm e2e`); without a command it only
// assembles and prints the path:
//   node tests/fixtures/fixture-configuration.ts [command...]

export const STARTER_CONFIGURATION = fileURLToPath(new URL("../../examples/config", import.meta.url));
export const FIXTURES = fileURLToPath(new URL("config", import.meta.url));
/** Where the script assembles the fixture configuration for the compose stack (git-ignored). */
export const ASSEMBLED_CONFIGURATION = fileURLToPath(new URL("assembled-config", import.meta.url));

/** Assembles the fixture configuration into `target`, replacing what was there. */
export function assembleFixtureConfiguration(target: string): string {
  const shadowed = files(FIXTURES).filter((file) => existsSync(join(STARTER_CONFIGURATION, file)));
  if (shadowed.length > 0) throw new Error(`fixture files must not replace starter files: ${shadowed.join(", ")}`);
  rmSync(target, { recursive: true, force: true });
  cpSync(STARTER_CONFIGURATION, target, { recursive: true });
  cpSync(FIXTURES, target, { recursive: true });
  return target;
}

let assembled: string | undefined;

/** The fixture configuration for tests in process, assembled once per test process. */
export function fixtureConfiguration(): string {
  assembled ??= assembleFixtureConfiguration(mkdtempSync(join(tmpdir(), "tend-fixture-config-")));
  return assembled;
}

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

/** The workspace root of the compose stack under test (git-ignored), with the directory workspace `scripted-directory` in it. */
export const WORKSPACE_ROOT = fileURLToPath(new URL("workspace-root", import.meta.url));
export const DIRECTORY_WORKSPACE = join(WORKSPACE_ROOT, "scripted-directory");

/** A host path as the Docker engine knows it: Docker Desktop on Windows sees the drives under /run/desktop/mnt/host. */
function onDockerHost(path: string): string {
  return process.platform === "win32" ? `/run/desktop/mnt/host/${path[0]!.toLowerCase()}${path.slice(2).replaceAll("\\", "/")}` : path;
}

/**
 * Adds the directory workspace `scripted-directory` to an assembled configuration: its path
 * depends on where the repository lies, so no fixture file can name it. Returns the
 * workspace root to set as TEND_WORKSPACE_ROOTS.
 */
function addDirectoryWorkspace(target: string): string {
  mkdirSync(DIRECTORY_WORKSPACE, { recursive: true });
  chmodSync(DIRECTORY_WORKSPACE, 0o777); // the sandbox user writes there
  const root = onDockerHost(WORKSPACE_ROOT);
  writeFileSync(
    join(target, "workspaces", "scripted-directory.yaml"),
    `# A directory workspace for the end-to-end tests, under the stack's workspace root.\napiVersion: tendworks.dev/v1\nkind: Workspace\nmetadata:\n  name: scripted-directory\nspec:\n  directory:\n    path: ${root}/scripted-directory\n`,
  );
  return root;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assembleFixtureConfiguration(ASSEMBLED_CONFIGURATION);
  const workspaceRoot = addDirectoryWorkspace(ASSEMBLED_CONFIGURATION);
  // Compose resolves the path against deploy/, the project directory.
  const configPath = relative(fileURLToPath(new URL("../../deploy", import.meta.url)), ASSEMBLED_CONFIGURATION).split("\\").join("/");
  console.info(`TEND_CONFIG_PATH=${configPath}`);
  console.info(`TEND_WORKSPACE_ROOTS=${workspaceRoot}`);
  const command = process.argv.slice(2).join(" ");
  if (command === "") process.exit(0);
  const { status } = spawnSync(command, { stdio: "inherit", shell: true, env: { ...process.env, TEND_CONFIG_PATH: configPath, TEND_WORKSPACE_ROOTS: workspaceRoot } });
  process.exit(status ?? 1);
}
