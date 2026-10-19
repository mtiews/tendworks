import { describe, expect, it } from "vitest";
import { createFakePullRequests } from "./pull-requests.js";
import { describePullRequests } from "./pull-requests.suite.js";

describePullRequests("fake", async (fixtures) => {
  const urls = fixtures.map((_, index) => `https://git.example/acme/app/pull/${index + 1}`);
  return {
    pullRequests: createFakePullRequests(fixtures.map((fixture, index) => ({ url: urls[index]!, ...fixture }))),
    urls,
    missing: "https://git.example/acme/app/pull/99",
  };
});

describe("fake pull requests", () => {
  it("treats unlisted pull requests as open and mergeable when asked to, and records merges", async () => {
    const pullRequests = createFakePullRequests([], { openByDefault: true });

    await pullRequests.merge("https://git.example/acme/app/pull/5");
    await pullRequests.merge("https://git.example/acme/app/pull/5");

    expect(pullRequests.merged()).toEqual(["https://git.example/acme/app/pull/5"]);
  });
});
