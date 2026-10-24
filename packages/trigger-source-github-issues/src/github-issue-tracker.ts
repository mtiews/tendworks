import type { Issue, IssueTracker } from "./issue-tracker.js";

export interface GithubIssueTrackerOptions {
  /** Token that may read the repositories' issues. Never logged and never part of an error. */
  token: string;
  fetch?: typeof fetch;
  /** How long one request may take before the check gives up. Defaults to 30 s. */
  timeoutMs?: number;
}

const API = "https://api.github.com";
/** 100 pages of 100 issues; a filter matching more is a misconfiguration, not a backlog. */
const MAX_PAGES = 100;

interface GithubIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  body?: string | null;
  html_url: string;
  labels: (string | { name?: string })[];
  pull_request?: unknown;
}

/**
 * Issue tracker on the GitHub REST API ("list repository issues"). Pull requests, which
 * the API lists as issues, are left out. Every failure (rate limit, refused token,
 * unreachable API, unexpected answer) rejects with an error that names the cause, so
 * the check that asked counts as failed and the next one tries again.
 */
export function createGithubIssueTracker({ token, fetch = globalThis.fetch, timeoutMs = 30_000 }: GithubIssueTrackerOptions): IssueTracker {
  async function get(url: URL, repository: string): Promise<{ items: GithubIssue[]; next: URL | undefined }> {
    let response: Response;
    let body: unknown;
    try {
      response = await fetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "tendworks",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      body = await response.json().catch(() => undefined);
    } catch (error) {
      throw new Error(`cannot reach GitHub to list issues of ${repository}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!response.ok) throw failure(repository, response, body);
    if (!Array.isArray(body)) throw new Error(`unexpected answer from GitHub while listing issues of ${repository}: not a list of issues`);
    const next = nextPage(response.headers.get("link"));
    if (next && next.origin !== API) {
      throw new Error(`unexpected answer from GitHub while listing issues of ${repository}: next page on ${next.host}`);
    }
    return { items: body as GithubIssue[], next };
  }

  return {
    async findIssues({ repository, labels = [], state = "open" }) {
      const [owner, name] = repository.split("/");
      const url = new URL(`${API}/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}/issues`);
      url.searchParams.set("state", state);
      if (labels.length > 0) url.searchParams.set("labels", labels.join(","));
      url.searchParams.set("per_page", "100");

      const issues: Issue[] = [];
      let next: URL | undefined = url;
      for (let pages = 0; next; pages++) {
        if (pages === MAX_PAGES) throw new Error(`more than ${MAX_PAGES * 100} issues of ${repository} match; narrow the filter`);
        const page: { items: GithubIssue[]; next: URL | undefined } = await get(next, repository);
        for (const item of page.items) {
          if (item.pull_request) continue;
          const issue: Issue = {
            repository,
            number: item.number,
            title: item.title,
            state: item.state,
            labels: item.labels.map((label) => (typeof label === "string" ? label : (label.name ?? ""))),
            url: item.html_url,
          };
          if (item.body) issue.body = item.body;
          // GitHub has no syntax for a label containing a comma; check every label here too.
          if (labels.every((label) => issue.labels.includes(label))) issues.push(issue);
        }
        next = page.next;
      }
      return issues.sort((a, b) => a.number - b.number);
    },
  };
}

/** Why GitHub refused a request, from its answer only, never from the request. */
function failure(repository: string, response: Response, body: unknown): Error {
  const what = `while listing issues of ${repository}`;
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if ((response.status === 403 || response.status === 429) && response.headers.get("x-ratelimit-remaining") === "0" && reset) {
    return new Error(`GitHub rate limit exhausted ${what}; it resets at ${new Date(reset * 1000).toISOString()}`);
  }
  const retryAfter = response.headers.get("retry-after");
  if ((response.status === 403 || response.status === 429) && retryAfter) {
    return new Error(`GitHub secondary rate limit hit ${what}; retry after ${retryAfter} s`);
  }
  const message = typeof body === "object" && body && "message" in body && typeof body.message === "string" ? `: ${body.message}` : "";
  return new Error(`GitHub answered ${response.status}${message} ${what}`);
}

/** The `rel="next"` target of a `Link` header. */
function nextPage(link: string | null): URL | undefined {
  const target = link?.split(",").find((part) => /;\s*rel="next"/.test(part));
  const href = target && /<([^>]+)>/.exec(target)?.[1];
  return href ? new URL(href) : undefined;
}
