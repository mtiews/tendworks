import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

// The operator's first step: scripts/setup-env.sh creates deploy/.env (here: a file of the
// test's own) from deploy/.env.example with random tokens.

const script = fileURLToPath(new URL("../../scripts/setup-env.sh", import.meta.url));
const example = readFileSync(new URL("../../deploy/.env.example", import.meta.url), "utf8");

const setupEnv = (envFile: string) =>
  promisify(execFile)("bash", [script, "--env-file", envFile]).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  );
const value = (env: string, name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(env)?.[1];

describe("scripts/setup-env.sh", () => {
  let directory: string;
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("creates the env file from the example with two different random tokens, readable by its owner only", async () => {
    directory = mkdtempSync(join(tmpdir(), "tend-setup-env-"));
    const envFile = join(directory, ".env");

    const { code, stdout, stderr } = await setupEnv(envFile);

    expect(code).toBe(0);
    const env = readFileSync(envFile, "utf8");
    const apiToken = value(env, "TEND_API_TOKEN");
    const readToken = value(env, "TEND_API_READ_TOKEN");
    expect(apiToken).toMatch(/^[0-9a-f]{64}$/);
    expect(readToken).toMatch(/^[0-9a-f]{64}$/);
    expect(readToken).not.toBe(apiToken);
    // Everything else is the example as it is, for the operator to fill in.
    const withoutTokens = (text: string) => text.replace(/^(TEND_API_TOKEN|TEND_API_READ_TOKEN)=.*$/gm, "$1=");
    expect(withoutTokens(env)).toBe(example);
    // Tokens never appear in the output.
    expect(stdout + stderr).not.toContain(apiToken);
    expect(stdout + stderr).not.toContain(readToken);
    // Windows has no Unix file modes; the stack's target is Linux.
    if (process.platform !== "win32") expect(statSync(envFile).mode & 0o777).toBe(0o600);
  });

  it("refuses to overwrite an existing env file", async () => {
    directory = mkdtempSync(join(tmpdir(), "tend-setup-env-"));
    const envFile = join(directory, ".env");
    await setupEnv(envFile);
    const before = readFileSync(envFile, "utf8");

    const { code, stderr } = await setupEnv(envFile);

    expect(code).not.toBe(0);
    expect(stderr).toContain("already exists");
    expect(readFileSync(envFile, "utf8")).toBe(before);
  });
});
