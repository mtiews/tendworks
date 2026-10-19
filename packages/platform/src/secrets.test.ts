import { describe, expect, it } from "vitest";
import { createSecretResolver } from "./index.js";

const environment = {
  TENDWORKS_AGENT_GITHUB_TOKEN: "agent-token",
  TENDWORKS_AGENT_EMPTY: "",
  TENDWORKS_PLATFORM_GITHUB_TOKEN: "platform-token",
  TEND_DATABASE_URL: "postgres://tend:secret@postgres/tend",
};

describe("secret references for agents", () => {
  const secrets = createSecretResolver("agent", environment);

  it("resolves secrets meant for agents", () => {
    expect(secrets.resolve("TENDWORKS_AGENT_GITHUB_TOKEN")).toBe("agent-token");
    expect(secrets.problem("TENDWORKS_AGENT_GITHUB_TOKEN")).toBeUndefined();
  });

  it.each(["TENDWORKS_PLATFORM_GITHUB_TOKEN", "TEND_DATABASE_URL"])("never resolves %s, so it cannot reach a sandbox", (name) => {
    expect(secrets.resolve(name)).toBeUndefined();
    expect(secrets.problem(name)).toBe(`${name} is not an agent secret: agents may only reference TENDWORKS_AGENT_* secrets`);
  });

  it.each(["TENDWORKS_AGENT_EMPTY", "TENDWORKS_AGENT_MISSING"])("names an allowed secret %s that is not set, never a value", (name) => {
    expect(secrets.resolve(name)).toBeUndefined();
    expect(secrets.problem(name)).toBe(`secret ${name} is not set`);
  });
});

describe("secret references for platform integrations", () => {
  const secrets = createSecretResolver("platform", environment);

  it("resolves the platform's own secrets", () => {
    expect(secrets.resolve("TENDWORKS_PLATFORM_GITHUB_TOKEN")).toBe("platform-token");
  });

  it.each(["TENDWORKS_AGENT_GITHUB_TOKEN", "TEND_DATABASE_URL"])("never resolves %s, which is not a platform integration secret", (name) => {
    expect(secrets.resolve(name)).toBeUndefined();
    expect(secrets.problem(name)).toBe(`${name} is not a platform secret: platform integrations may only reference TENDWORKS_PLATFORM_* secrets`);
  });
});
