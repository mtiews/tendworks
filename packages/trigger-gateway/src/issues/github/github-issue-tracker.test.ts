import { describe, expect, it } from "vitest";
import { describeIssueTracker } from "../issue-tracker.suite.js";
import { stubGithubApi, type StubItem } from "./github-api.stub.js";
import { createGithubIssueTracker } from "./github-issue-tracker.js";

type Fetch = typeof globalThis.fetch;

const token = "stub-token-0123456789";

describeIssueTracker("github against a stub of the REST API", async (fixtures) => {
  const repository = "acme/playground";
  const items: StubItem[] = fixtures.map((fixture, index) => ({ ...fixture, number: index + 1 }));
  // Pull requests are issues to the REST API, but never to the port.
  items.push({ number: items.length + 1, title: "a pull request", state: "open", labels: ["ready-for-agent", "bug"], pullRequest: true });
  const fetch = stubGithubApi({
    token,
    repositories: {
      [repository]: items,
      "acme/other": [{ number: 1, title: "elsewhere", state: "open", labels: ["ready-for-agent", "bug"] }],
    },
  });
  return { tracker: createGithubIssueTracker({ token, fetch }), repository };
});

describe("github issue tracker failures", () => {
  const filter = { repository: "acme/playground", labels: ["ready-for-agent"] };
  const respond =
    (status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch =>
    async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const failure = async (fetch: Fetch) => {
    const error = await createGithubIssueTracker({ token, fetch })
      .findIssues(filter)
      .then(() => undefined, (error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain(token);
    return (error as Error).message;
  };

  it("rejects with when the rate limit resets once it is exhausted", async () => {
    const reset = Date.parse("2026-10-19T07:00:00Z") / 1000;
    const message = await failure(
      respond(403, { message: "API rate limit exceeded for user." }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }),
    );

    expect(message).toMatch(/rate limit/i);
    expect(message).toContain("2026-10-19T07:00:00.000Z");
  });

  it("rejects with how long to wait when a secondary rate limit asks to retry later", async () => {
    const message = await failure(respond(429, { message: "You have exceeded a secondary rate limit." }, { "retry-after": "60" }));

    expect(message).toMatch(/rate limit/i);
    expect(message).toContain("60 s");
  });

  it("rejects with GitHub's reason when the token is refused or the repository is out of its reach", async () => {
    expect(await failure(stubGithubApi({ token: "another-token", repositories: {} }))).toMatch(/401.*Bad credentials/);
    expect(await failure(stubGithubApi({ token, repositories: {} }))).toMatch(/404.*Not Found.*acme\/playground/);
  });

  it("rejects when GitHub cannot be reached or answers with something other than issues", async () => {
    expect(await failure(async () => Promise.reject(new TypeError("fetch failed")))).toMatch(/cannot reach GitHub.*fetch failed/);
    expect(await failure(async () => new Response("<html>", { status: 200 }))).toMatch(/unexpected answer/);
    expect(await failure(respond(200, { message: "not a list" }))).toMatch(/unexpected answer/);
  });

  it("gives up on a request GitHub does not answer in time", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    const tracker = createGithubIssueTracker({ token, fetch: hanging, timeoutMs: 10 });

    await expect(tracker.findIssues(filter)).rejects.toThrow(/cannot reach GitHub/);
  });

  it("never sends the token to another host than the API's", async () => {
    const hosts: string[] = [];
    const fetch: Fetch = async (input, init) => {
      const request = new Request(input, init);
      hosts.push(new URL(request.url).host);
      return Response.json([], { headers: { link: '<https://elsewhere.example/repos/acme/playground/issues?page=2>; rel="next"' } });
    };

    expect(await failure(fetch)).toMatch(/unexpected answer/);
    expect(hosts).toEqual(["api.github.com"]);
  });
});
