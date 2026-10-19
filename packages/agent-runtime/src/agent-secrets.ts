/** Prefix of the platform's environment variables that may be handed to agents. */
export const AGENT_SECRET_PREFIX = "TENDWORKS_AGENT_";

/**
 * Resolves the secret references of agent profiles (`spec.env`) against the worker's
 * environment (ADR 0008), but only variables named `TENDWORKS_AGENT_*`: everything an
 * agent gets is visible inside its sandbox, so platform secrets such as the platform's
 * repository token or the database URL can never be handed out, whatever a profile names.
 */
export function agentSecretsFromEnv(env: Record<string, string | undefined>): (name: string) => string | undefined {
  return (name) => (name.startsWith(AGENT_SECRET_PREFIX) && env[name] ? env[name] : undefined);
}
