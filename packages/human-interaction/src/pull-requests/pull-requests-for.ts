import { createGithubPullRequests } from "./github/github-pull-requests.js";
import { createFakePullRequests, type PullRequests } from "./pull-requests.js";

/** The variable of the platform's environment that holds its GitHub token (ADR 0008). */
export const PLATFORM_GITHUB_TOKEN = "TENDWORKS_PLATFORM_GITHUB_TOKEN";

export interface PullRequestIntegrationsOptions {
  /** The platform's GitHub token, read on every merge so a missing one fails only that merge. */
  githubToken: () => string | undefined;
  /** HTTP client of the real integrations; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/**
 * Picks the integration by the pull request's host: `github.com` is merged on GitHub
 * with the platform token; hosts under the reserved `.example` domain (RFC 2606), which
 * can never be real, are merged in a fake where every pull request is open and
 * mergeable, so fake agent profiles can report pull requests the platform merges.
 */
export function createPullRequestIntegrations({ githubToken, fetch }: PullRequestIntegrationsOptions): (url: string) => PullRequests | undefined {
  const fake = createFakePullRequests([], { openByDefault: true });
  const github: PullRequests = {
    async merge(url) {
      const token = githubToken();
      if (!token) throw new Error(`secret ${PLATFORM_GITHUB_TOKEN} is not set`);
      return createGithubPullRequests({ token, ...(fetch ? { fetch } : {}) }).merge(url);
    },
  };
  return (url) => {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return undefined;
    }
    if (host === "github.com") return github;
    if (host.endsWith(".example")) return fake;
    return undefined;
  };
}
