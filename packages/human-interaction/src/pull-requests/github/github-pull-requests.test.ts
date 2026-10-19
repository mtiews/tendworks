import { describe, expect, it } from "vitest";
import { MergeRefusedError } from "../pull-requests.js";
import { describePullRequests } from "../pull-requests.suite.js";
import { stubGithubApi } from "./github-api.stub.js";
import { createGithubPullRequests } from "./github-pull-requests.js";

const TOKEN = "platform-token";

describePullRequests("github (stubbed API)", async (fixtures) => {
  const fetch = stubGithubApi({
    token: TOKEN,
    repositories: { "acme/app": fixtures.map((fixture, index) => ({ number: index + 1, ...fixture })) },
  });
  return {
    pullRequests: createGithubPullRequests({ token: TOKEN, fetch }),
    urls: fixtures.map((_, index) => `https://github.com/acme/app/pull/${index + 1}`),
    missing: "https://github.com/acme/app/pull/99",
    repository: "acme/app",
  };
});

describe("github pull requests", () => {
  const fetch = () => stubGithubApi({ token: TOKEN, repositories: { "acme/app": [{ number: 1, state: "open", mergeable: true }] } });

  it("merges through the repository's merge endpoint with the token it was given", async () => {
    const api = fetch();

    await createGithubPullRequests({ token: TOKEN, fetch: api }).merge("https://github.com/acme/app/pull/1");

    expect(api.requests).toEqual(["PUT /repos/acme/app/pulls/1/merge"]);
  });

  it("fails without leaking the token when GitHub refuses the credentials", async () => {
    const merging = createGithubPullRequests({ token: "wrong-token", fetch: fetch() }).merge("https://github.com/acme/app/pull/1");

    await expect(merging).rejects.toThrow("GitHub answered 401: Bad credentials while merging https://github.com/acme/app/pull/1");
    await expect(merging).rejects.not.toBeInstanceOf(MergeRefusedError);
    await expect(merging).rejects.not.toThrow("wrong-token");
  });

  it("fails naming the cause when GitHub cannot be reached", async () => {
    const pullRequests = createGithubPullRequests({
      token: TOKEN,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });

    await expect(pullRequests.merge("https://github.com/acme/app/pull/1")).rejects.toThrow(
      "cannot reach GitHub to merge https://github.com/acme/app/pull/1: fetch failed",
    );
  });

  it("refuses a URL that is not a GitHub pull request", async () => {
    await expect(createGithubPullRequests({ token: TOKEN, fetch: fetch() }).merge("https://github.com/acme/app/issues/1")).rejects.toThrow(
      "not a GitHub pull request URL: https://github.com/acme/app/issues/1",
    );
  });
});
