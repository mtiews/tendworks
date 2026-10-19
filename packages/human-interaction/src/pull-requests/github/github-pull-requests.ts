import { MergeRefusedError, type PullRequests } from "../pull-requests.js";

export interface GithubPullRequestsOptions {
  /** Token that may merge pull requests of the repositories. Never logged and never part of an error. */
  token: string;
  fetch?: typeof fetch;
  /** How long one request may take. Defaults to 30 s. */
  timeoutMs?: number;
}

const API = "https://api.github.com";
const PULL_REQUEST_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;

interface GithubPull {
  state?: "open" | "closed";
  merged?: boolean;
  merge_commit_sha?: string | null;
}

/**
 * Pull requests on the GitHub REST API. Merges with "merge a pull request"
 * (PUT /repos/{owner}/{repo}/pulls/{n}/merge, merge commit). When GitHub refuses, the
 * pull request is read once more: already merged counts as success (a repeated merge),
 * closed and conflicts are refused with the reason.
 */
export function createGithubPullRequests({ token, fetch = globalThis.fetch, timeoutMs = 30_000 }: GithubPullRequestsOptions): PullRequests {
  async function call(method: "GET" | "PUT", path: string, url: string): Promise<{ status: number; body: Record<string, unknown> }> {
    let response: Response;
    let body: unknown;
    try {
      response = await fetch(`${API}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "tendworks",
          ...(method === "PUT" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "PUT" ? { body: JSON.stringify({ merge_method: "merge" }) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      body = await response.json().catch(() => undefined);
    } catch (error) {
      throw new Error(`cannot reach GitHub to merge ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { status: response.status, body: body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {} };
  }

  const answered = (status: number, body: Record<string, unknown>, url: string) =>
    `GitHub answered ${status}${typeof body.message === "string" ? `: ${body.message}` : ""} while merging ${url}`;

  return {
    async merge(url) {
      const match = PULL_REQUEST_URL.exec(url);
      if (!match) throw new MergeRefusedError(`not a GitHub pull request URL: ${url}`);
      const path = `/repos/${match[1]}/${match[2]}/pulls/${match[3]}`;

      const merge = await call("PUT", `${path}/merge`, url);
      if (merge.status === 200 && typeof merge.body.sha === "string") return { commit: merge.body.sha };
      if (merge.status === 404) throw new MergeRefusedError(`no pull request at ${url}, or the platform token cannot see it`);
      if (merge.status !== 405 && merge.status !== 409 && merge.status !== 422) throw new Error(answered(merge.status, merge.body, url));

      const read = await call("GET", path, url);
      if (read.status !== 200) throw new Error(answered(read.status, read.body, url));
      const pull = read.body as GithubPull;
      if (pull.merged) return pull.merge_commit_sha ? { commit: pull.merge_commit_sha } : {};
      if (pull.state === "closed") throw new MergeRefusedError(`pull request ${url} is closed`);
      throw new MergeRefusedError(`pull request ${url} is not mergeable: ${typeof merge.body.message === "string" ? merge.body.message : `GitHub answered ${merge.status}`}`);
    },
  };
}
