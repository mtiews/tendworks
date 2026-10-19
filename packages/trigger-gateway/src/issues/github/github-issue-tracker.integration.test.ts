import { describe, expect, it } from "vitest";
import { describeIssueTracker } from "../issue-tracker.suite.js";
import { createGithubIssueTracker } from "./github-issue-tracker.js";

// Opt-in: runs against the real GitHub API only with a token, and never writes.
//   TENDWORKS_PLATFORM_GITHUB_TOKEN   token that may read the repositories' issues
//   TEND_GITHUB_PLAYGROUND_REPOSITORY the playground (default mtiews/tendworks-playground)
//   TEND_GITHUB_SUITE_REPOSITORY      a repository holding exactly the shared suite's
//                                     fixtures (see issue-tracker.suite.ts); the playground
//                                     cannot, since the agent would pick its open issues.
const token = process.env.TENDWORKS_PLATFORM_GITHUB_TOKEN;
const playground = process.env.TEND_GITHUB_PLAYGROUND_REPOSITORY || "mtiews/tendworks-playground";
const suiteRepository = process.env.TEND_GITHUB_SUITE_REPOSITORY;

describe.skipIf(!token)("github issue tracker against the playground repository", () => {
  const tracker = createGithubIssueTracker({ token: token ?? "" });

  it("finds the open issues labelled ready-for-agent, ordered by number, as links to the repository", async () => {
    const issues = await tracker.findIssues({ repository: playground, labels: ["ready-for-agent"] });

    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue).toMatchObject({ repository: playground, state: "open" });
      expect(issue.labels).toContain("ready-for-agent");
      expect(issue.url).toBe(`https://github.com/${playground}/issues/${issue.number}`);
    }
    expect(issues.map((issue) => issue.number)).toEqual(issues.map((issue) => issue.number).sort((a, b) => a - b));
  });

  it("finds nothing for a label no issue carries", async () => {
    expect(await tracker.findIssues({ repository: playground, labels: ["tendworks-no-such-label"] })).toEqual([]);
  });

  it("rejects, without the token, for a repository it cannot see", async () => {
    const error = await tracker.findIssues({ repository: "mtiews/tendworks-no-such-repository" }).catch((error: unknown) => error);

    expect(String(error)).toMatch(/GitHub answered 404/);
    expect(String(error)).not.toContain(token);
  });
});

if (token && suiteRepository) {
  describeIssueTracker(`github against ${suiteRepository}`, async () => ({
    tracker: createGithubIssueTracker({ token }),
    repository: suiteRepository,
  }));
}
