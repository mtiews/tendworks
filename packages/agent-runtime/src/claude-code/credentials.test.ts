import { describe, expect, it } from "vitest";
import { claudeCodeCredentialFromEnv } from "../index.js";

describe("claudeCodeCredentialFromEnv", () => {
  const both = { CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret", ANTHROPIC_API_KEY: "key-secret" };

  it("takes the subscription token when the configuration selects it, even if an API key is set", () => {
    expect(claudeCodeCredentialFromEnv({ ...both, TEND_CLAUDE_CODE_CREDENTIAL: "oauth-token" })).toEqual({
      credential: { kind: "oauth-token", value: "oauth-secret" },
    });
  });

  it("takes the API key when the configuration selects it", () => {
    expect(claudeCodeCredentialFromEnv({ ...both, TEND_CLAUDE_CODE_CREDENTIAL: "api-key" })).toEqual({
      credential: { kind: "api-key", value: "key-secret" },
    });
  });

  it("explains a missing or unknown selection without guessing", () => {
    expect(claudeCodeCredentialFromEnv(both)).toEqual({ problem: expect.stringContaining("TEND_CLAUDE_CODE_CREDENTIAL") });
    expect(claudeCodeCredentialFromEnv({ ...both, TEND_CLAUDE_CODE_CREDENTIAL: "both" })).toEqual({
      problem: expect.stringContaining("oauth-token or api-key"),
    });
  });

  it("explains a selected credential that is empty, naming the variable but never a value", () => {
    const result = claudeCodeCredentialFromEnv({ ANTHROPIC_API_KEY: "key-secret", CLAUDE_CODE_OAUTH_TOKEN: "", TEND_CLAUDE_CODE_CREDENTIAL: "oauth-token" });

    expect(result).toEqual({ problem: expect.stringContaining("CLAUDE_CODE_OAUTH_TOKEN") });
    expect(JSON.stringify(result)).not.toContain("key-secret");
  });
});
