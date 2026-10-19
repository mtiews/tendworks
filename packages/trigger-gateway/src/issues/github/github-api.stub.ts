/** An issue or pull request as the stub serves it. */
export interface StubItem {
  number: number;
  title: string;
  state: "open" | "closed";
  labels: string[];
  body?: string | null;
  pullRequest?: boolean;
}

export interface StubGithubApiOptions {
  /** Items per repository (`<owner>/<name>`). */
  repositories: Record<string, StubItem[]>;
  /** The only token the stub accepts. */
  token: string;
  /** Page size cap, smaller than GitHub's 100 so pagination is exercised. */
  maxPageSize?: number;
}

/**
 * A `fetch` that answers like the GitHub REST API's "list repository issues" endpoint
 * (GET /repos/{owner}/{repo}/issues): bearer auth, `state`, `labels` (comma-separated,
 * all must match), `per_page`/`page` with a `Link` header, newest first, and pull
 * requests mixed into the result. Everything else is 404.
 */
export function stubGithubApi({ repositories, token, maxPageSize = 2 }: StubGithubApiOptions): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://api.github.com") throw new TypeError(`fetch failed: unexpected host ${url.host}`);
    if (request.headers.get("authorization") !== `Bearer ${token}`) {
      return json(401, { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" });
    }
    const match = /^\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(url.pathname);
    const repository = match ? `${match[1]}/${match[2]}` : undefined;
    const items = repository ? repositories[repository] : undefined;
    if (request.method !== "GET" || !items) return json(404, { message: "Not Found" });

    const state = url.searchParams.get("state") ?? "open";
    const labels = url.searchParams.get("labels")?.split(",").filter(Boolean) ?? [];
    const perPage = Math.min(Number(url.searchParams.get("per_page") ?? 30), maxPageSize);
    const page = Number(url.searchParams.get("page") ?? 1);
    const matching = items
      .filter((item) => state === "all" || item.state === state)
      .filter((item) => labels.every((label) => item.labels.includes(label)))
      .sort((a, b) => b.number - a.number);
    const pageItems = matching.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    if (page * perPage < matching.length) {
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      headers.link = `<${next}>; rel="next"`;
    }
    return json(
      200,
      pageItems.map((item) => ({
        number: item.number,
        title: item.title,
        state: item.state,
        body: item.body ?? null,
        html_url: `https://github.com/${repository}/${item.pullRequest ? "pull" : "issues"}/${item.number}`,
        labels: item.labels.map((name, id) => ({ id, name, color: "ededed" })),
        ...(item.pullRequest ? { pull_request: { url: `https://api.github.com/repos/${repository}/pulls/${item.number}` } } : {}),
      })),
      headers,
    );
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
