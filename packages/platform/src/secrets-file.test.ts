import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSecretResolver } from "./index.js";
import { exportSecrets, readSecretsFile } from "./secrets-file.js";

const file = () => join(mkdtempSync(join(tmpdir(), "tend-secrets-file-")), "agent-secrets.json");

const environment = {
  TENDWORKS_AGENT_PLAYGROUND_TOKEN: "agent-token",
  TENDWORKS_AGENT_NEW_TOKEN: "new-token",
  TENDWORKS_PLATFORM_GITHUB_TOKEN: "platform-token",
  TEND_API_TOKEN: "api-token",
};

describe("a secrets file", () => {
  it("holds only the consumer's secrets, so the platform's never reach the bundle reading it", () => {
    const path = file();
    exportSecrets("agent", environment, path);

    expect(readSecretsFile(path)).toEqual({ TENDWORKS_AGENT_PLAYGROUND_TOKEN: "agent-token", TENDWORKS_AGENT_NEW_TOKEN: "new-token" });
    expect(readFileSync(path, "utf8")).not.toContain("platform-token");
    expect(readFileSync(path, "utf8")).not.toContain("api-token");
  });

  it("is replaced as a whole, so a secret removed from the environment goes too", () => {
    const path = file();
    exportSecrets("agent", environment, path);
    exportSecrets("agent", { TENDWORKS_AGENT_NEW_TOKEN: "newer-token" }, path);

    expect(readSecretsFile(path)).toEqual({ TENDWORKS_AGENT_NEW_TOKEN: "newer-token" });
  });

  it.skipIf(process.platform === "win32")("is readable by its owner only", () => {
    const path = file();
    exportSecrets("agent", environment, path);

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("is readable by its owner only even when a temporary file of an earlier, interrupted export is left", () => {
    const path = file();
    // Left behind by an exporter of the same process id that died before renaming it.
    writeFileSync(`${path}.${process.pid}.tmp`, "stale", { mode: 0o644 });

    exportSecrets("agent", environment, path);

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readSecretsFile(path)).toEqual({ TENDWORKS_AGENT_PLAYGROUND_TOKEN: "agent-token", TENDWORKS_AGENT_NEW_TOKEN: "new-token" });
  });

  it("reads as empty while it does not exist yet", () => {
    expect(readSecretsFile(file())).toEqual({});
  });

  it("feeds a resolver that sees secrets exported after it was created", () => {
    const path = file();
    const secrets = createSecretResolver("agent", () => readSecretsFile(path));
    expect(secrets.resolve("TENDWORKS_AGENT_NEW_TOKEN")).toBeUndefined();

    exportSecrets("agent", environment, path);

    expect(secrets.resolve("TENDWORKS_AGENT_NEW_TOKEN")).toBe("new-token");
  });
});
