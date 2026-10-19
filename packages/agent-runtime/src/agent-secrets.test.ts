import { describe, expect, it } from "vitest";
import { agentSecretsFromEnv } from "./index.js";

describe("agentSecretsFromEnv", () => {
  const env = {
    TENDWORKS_AGENT_GITHUB_TOKEN: "agent-token",
    TENDWORKS_AGENT_EMPTY: "",
    TENDWORKS_PLATFORM_GITHUB_TOKEN: "platform-token",
    TEND_DATABASE_URL: "postgres://tend:secret@postgres/tend",
  };

  it("resolves secrets meant for agents", () => {
    expect(agentSecretsFromEnv(env)("TENDWORKS_AGENT_GITHUB_TOKEN")).toBe("agent-token");
  });

  it.each(["TENDWORKS_PLATFORM_GITHUB_TOKEN", "TEND_DATABASE_URL", "TENDWORKS_AGENT_EMPTY", "TENDWORKS_AGENT_MISSING"])(
    "never resolves %s, so it cannot reach a sandbox",
    (name) => {
      expect(agentSecretsFromEnv(env)(name)).toBeUndefined();
    },
  );
});
