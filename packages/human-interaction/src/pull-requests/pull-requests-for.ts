import type { SecretResolver } from "@tendworks/platform";
import type { PullRequestIntegration } from "@tendworks/shared";
import { createGithubPullRequests } from "./github/github-pull-requests.js";
import { createFakePullRequests, type PullRequests } from "./pull-requests.js";

export interface PullRequestIntegrationsOptions {
  /** The configured integrations (`kind: PullRequestIntegration`), at most one per host. */
  integrations: PullRequestIntegration.PullRequestIntegration[];
  /** Resolves their secret references: only platform secrets (ADR 0008). */
  secrets: SecretResolver;
  /** HTTP client of the real integrations; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/**
 * Picks the integration configured for the host of a pull request's URL. A `github`
 * integration merges with the platform token its secret reference names, resolved on
 * every merge, so a missing token fails only that merge; a `fake` integration serves the
 * pull requests its configuration lists. A host without a configured integration has
 * none, so nothing is merged there.
 */
export function createPullRequestIntegrations({ integrations, secrets, fetch }: PullRequestIntegrationsOptions): (url: string) => PullRequests | undefined {
  const byHost = new Map(integrations.map(({ spec }) => [spec.host, adapterFor(spec, secrets, fetch)]));
  return (url) => {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return undefined;
    }
    return byHost.get(host);
  };
}

function adapterFor(spec: PullRequestIntegration.PullRequestIntegrationSpec, secrets: SecretResolver, fetch?: typeof globalThis.fetch): PullRequests {
  switch (spec.integration) {
    case "fake":
      return createFakePullRequests(spec.fake?.pullRequests ?? []);
    case "github":
      return {
        async merge(url) {
          const name = spec.github!.token.secretRef.name;
          const token = secrets.resolve(name);
          if (!token) throw new Error(secrets.problem(name) ?? `secret ${name} is not set`);
          return createGithubPullRequests({ token, ...(fetch ? { fetch } : {}) }).merge(url);
        },
      };
  }
}
