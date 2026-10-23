import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// The server refuses to start without proper tokens and names the variable to set. Each case
// starts a one-off server container of the stack's image with the tokens overridden; the
// running stack is not touched.

const composeFile = fileURLToPath(new URL("../../deploy/compose.yaml", import.meta.url));
const strong = "0123456789abcdef0123456789abcdef"; // betterleaks:allow test token for a refused start
const other = "fedcba9876543210fedcba9876543210"; // betterleaks:allow test token for a refused start

const startServer = (apiToken: string, readToken: string) =>
  promisify(execFile)(
    "docker",
    ["compose", "-f", composeFile, "run", "--rm", "--no-deps", "-T", "-e", `TEND_API_TOKEN=${apiToken}`, "-e", `TEND_API_READ_TOKEN=${readToken}`, "server"],
    { timeout: 60_000 },
  ).then(
    ({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }),
    (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, output: error.stdout + error.stderr }),
  );

describe("starting the server", () => {
  it("is refused without tokens; the log names both variables", { timeout: 60_000 }, async () => {
    const { code, output } = await startServer("", "");

    expect(code).not.toBe(0);
    expect(output).toContain("TEND_API_TOKEN is not set");
    expect(output).toContain("TEND_API_READ_TOKEN is not set");
  });

  it("is refused with a weak token; the log names its variable", { timeout: 60_000 }, async () => {
    const { code, output } = await startServer(strong, "short");

    expect(code).not.toBe(0);
    expect(output).toContain("TEND_API_READ_TOKEN must be at least 16 characters");
  });

  it("is refused with equal tokens", { timeout: 60_000 }, async () => {
    const { code, output } = await startServer(other, other);

    expect(code).not.toBe(0);
    expect(output).toContain("TEND_API_READ_TOKEN must differ from TEND_API_TOKEN");
  });
});
