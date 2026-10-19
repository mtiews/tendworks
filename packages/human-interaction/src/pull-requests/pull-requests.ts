import type { PullRequestIntegration } from "@tendworks/shared";

/**
 * Integration port to the repository host's pull requests. The platform merges through
 * it with its own credentials, never an agent's.
 *
 * @port
 */
export interface PullRequests {
  /**
   * Merges the pull request at `url` (its web URL). Resolves once it is merged, also
   * when it already was, so a repeated merge is harmless. Rejects with a
   * {@link MergeRefusedError} when the repository refuses (closed, conflicts, not
   * found) and with any other error when it cannot be asked (unreachable, credentials).
   */
  merge(url: string): Promise<MergeResult>;
}

export interface MergeResult {
  /** The merge commit, when the repository reports one. */
  commit?: string;
}

/** The repository refused to merge; retrying the same request will not help. */
export class MergeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeRefusedError";
  }
}

/** A pull request as the fake serves it (`kind: PullRequestIntegration`, `integration: fake`). */
export type FakePullRequest = PullRequestIntegration.FakePullRequest;

/**
 * Pull requests in memory, for tests and demos: those listed, open unless they say
 * otherwise; others are not found. Merge commits are derived from the URL.
 */
export function createFakePullRequests(pullRequests: FakePullRequest[] = []): PullRequests & { merged(): string[] } {
  const known = new Map(pullRequests.map((pullRequest) => [pullRequest.url, { ...pullRequest, state: pullRequest.state ?? "open" }]));
  const merged: string[] = [];
  return {
    async merge(url) {
      const pullRequest = known.get(url);
      if (!pullRequest) throw new MergeRefusedError(`no pull request at ${url}`);
      if (pullRequest.state === "closed") throw new MergeRefusedError(`pull request ${url} is closed`);
      if (pullRequest.state === "open") {
        if (pullRequest.mergeable === false) throw new MergeRefusedError(`pull request ${url} is not mergeable: it has conflicts`);
        pullRequest.state = "merged";
        merged.push(url);
      }
      return { commit: fakeCommit(url) };
    },
    merged: () => [...merged],
  };
}

function fakeCommit(url: string): string {
  let hash = 0;
  for (const char of url) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(16).padStart(8, "0").repeat(5);
}
