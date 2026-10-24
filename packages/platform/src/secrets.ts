/**
 * Who resolves a secret reference: `agent` for what agent profiles pass into sandboxes,
 * `platform` for the platform's own integrations (trigger bindings, notification
 * channels). Each may only reach the secrets meant for it.
 */
export type SecretConsumer = "agent" | "platform";

/** The allowlist per consumer: the prefix of the secret names it may resolve (ADR 0008). */
export const SECRET_PREFIXES: Record<SecretConsumer, string> = {
  agent: "TENDWORKS_AGENT_",
  platform: "TENDWORKS_PLATFORM_",
};

const DESCRIPTIONS: Record<SecretConsumer, [kind: string, consumers: string]> = {
  agent: ["an agent secret", "agents"],
  platform: ["a platform secret", "platform integrations"],
};

/** Resolves secret references (`{ secretRef: { name } }`) of one consumer. */
export interface SecretResolver {
  /** The secret's value; undefined when it is not set or not meant for this consumer. */
  resolve(name: string): string | undefined;
  /** Why `name` does not resolve, naming the secret but never a value; undefined when it does. */
  problem(name: string): string | undefined;
}

/** Where secrets are looked up: an environment, or a function asked again at every reference. */
export type SecretEnvironment = Record<string, string | undefined> | (() => Record<string, string | undefined>);

/**
 * Secret references of `consumer`, resolved against `environment` (in the laptop profile
 * the bundle's environment, filled from `deploy/.env`). Only names with the consumer's
 * prefix resolve, so a reference can never hand out the database URL, and a secret
 * meant for the platform never reaches a sandbox, whatever configuration names.
 * Given a function, every reference asks it again, so a secret added later resolves
 * without a restart.
 */
export function createSecretResolver(consumer: SecretConsumer, environment: SecretEnvironment): SecretResolver {
  const prefix = SECRET_PREFIXES[consumer];
  const allowed = (name: string) => name.startsWith(prefix) && name.length > prefix.length;
  const lookup = (name: string) => (typeof environment === "function" ? environment() : environment)[name] || undefined;
  return {
    resolve: (name) => (allowed(name) ? lookup(name) : undefined),
    problem(name) {
      if (!allowed(name)) {
        const [kind, consumers] = DESCRIPTIONS[consumer];
        return `${name} is not ${kind}: ${consumers} may only reference ${prefix}* secrets`;
      }
      return lookup(name) ? undefined : `secret ${name} is not set`;
    },
  };
}
