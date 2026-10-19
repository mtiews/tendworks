/** A pull request as the stub serves it. */
export interface StubPullRequest {
  number: number;
  state: "open" | "closed";
  merged?: boolean;
  mergeable: boolean;
  /** The branch it merges from; defaults to `feature`. */
  headBranch?: string;
  /** Repository of the head branch (`<owner>/<name>`), e.g. a fork; defaults to the pull request's repository. */
  headRepository?: string;
}

export interface StubGithubApiOptions {
  /** Pull requests per repository (`<owner>/<name>`). */
  repositories: Record<string, StubPullRequest[]>;
  /** The only token the stub accepts. */
  token: string;
}

/**
 * A `fetch` that answers like the GitHub REST API's "merge a pull request"
 * (PUT /repos/{owner}/{repo}/pulls/{n}/merge) and "get a pull request"
 * (GET /repos/{owner}/{repo}/pulls/{n}) endpoints: bearer auth, 405 when the pull
 * request cannot be merged (closed, merged, conflicts), 404 for unknown ones. Merging
 * changes the stub's state. Everything else is 404.
 */
export function stubGithubApi({ repositories, token }: StubGithubApiOptions): typeof fetch & { requests: string[] } {
  const requests: string[] = [];
  const sha = (repository: string, number: number) => Buffer.from(`${repository}#${number}`).toString("hex").padEnd(40, "0").slice(0, 40);
  const stub = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.pathname}`);
    if (url.origin !== "https://api.github.com") throw new TypeError(`fetch failed: unexpected host ${url.host}`);
    if (request.headers.get("authorization") !== `Bearer ${token}`) {
      return json(401, { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" });
    }
    const match = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)(\/merge)?$/.exec(url.pathname);
    const repository = match ? `${match[1]}/${match[2]}` : "";
    const pull = repositories[repository]?.find((item) => item.number === Number(match?.[3]));
    if (!match || !pull) return json(404, { message: "Not Found" });

    if (match[4] && request.method === "PUT") {
      if (pull.state !== "open" || pull.merged || !pull.mergeable) return json(405, { message: "Pull Request is not mergeable" });
      pull.merged = true;
      pull.state = "closed";
      return json(200, { sha: sha(repository, pull.number), merged: true, message: "Pull Request successfully merged" });
    }
    if (!match[4] && request.method === "GET") {
      return json(200, {
        number: pull.number,
        state: pull.state,
        merged: pull.merged ?? false,
        mergeable: pull.mergeable,
        merge_commit_sha: pull.merged ? sha(repository, pull.number) : null,
        html_url: `https://github.com/${repository}/pull/${pull.number}`,
        base: { ref: "main", repo: { full_name: repository } },
        head: { ref: pull.headBranch ?? "feature", repo: { full_name: pull.headRepository ?? repository } },
      });
    }
    return json(404, { message: "Not Found" });
  };
  return Object.assign<typeof fetch, { requests: string[] }>(stub, { requests });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
