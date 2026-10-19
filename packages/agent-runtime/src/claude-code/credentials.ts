/** The one credential Claude Code gets: a subscription OAuth token or an API key, never both. */
export interface ClaudeCodeCredential {
  kind: "oauth-token" | "api-key";
  value: string;
}

/** The variable Claude Code reads each kind of credential from. */
export const CREDENTIAL_VARIABLES: Record<ClaudeCodeCredential["kind"], string> = {
  "oauth-token": "CLAUDE_CODE_OAUTH_TOKEN",
  "api-key": "ANTHROPIC_API_KEY",
};

/**
 * Picks the credential `TEND_CLAUDE_CODE_CREDENTIAL` selects (`oauth-token` from
 * `claude setup-token`, or `api-key`). The other variable is ignored, so an API key that
 * happens to be set can never take precedence over the selected token. Problems name
 * variables, never values.
 */
export function claudeCodeCredentialFromEnv(
  env: Record<string, string | undefined>,
): { credential: ClaudeCodeCredential } | { problem: string } {
  const kind = env.TEND_CLAUDE_CODE_CREDENTIAL;
  if (kind !== "oauth-token" && kind !== "api-key") {
    return {
      problem: `TEND_CLAUDE_CODE_CREDENTIAL must be oauth-token or api-key${kind ? `, got ${JSON.stringify(kind)}` : " but is not set"}`,
    };
  }
  const value = env[CREDENTIAL_VARIABLES[kind]];
  if (!value) return { problem: `TEND_CLAUDE_CODE_CREDENTIAL selects ${kind}, but ${CREDENTIAL_VARIABLES[kind]} is empty` };
  return { credential: { kind, value } };
}
