import { beforeEach, describe, expect, it } from "vitest";
import { MergeRefusedError, type PullRequests } from "./pull-requests.js";

/** A pull request the setup must create; it returns their web URLs in the same order. */
export interface PullRequestFixture {
  state: "open" | "closed";
  mergeable: boolean;
  headBranch: string;
  /** Repository of the head branch as `<owner>/<name>` when it is a fork; else the pull request's repository. */
  headRepository?: string;
}

export interface PullRequestsSuiteContext {
  pullRequests: PullRequests;
  urls: string[];
  /** A URL of the integration's host where no pull request exists. */
  missing: string;
  /** The repository (`<owner>/<name>`) the fixtures' pull requests belong to. */
  repository: string;
}

const FIXTURES: PullRequestFixture[] = [
  { state: "open", mergeable: true, headBranch: "tendworks/issue-1-0b6c4c1e" },
  { state: "open", mergeable: false, headBranch: "feature" },
  { state: "closed", mergeable: true, headBranch: "main", headRepository: "someone/fork" },
];

/**
 * The behaviour every pull request integration must show. Runs against the real adapter
 * (on a stub of its API) and the fake, so the fake stays a faithful stand-in.
 */
export function describePullRequests(name: string, setup: (fixtures: PullRequestFixture[]) => Promise<PullRequestsSuiteContext>) {
  describe(`pull requests: ${name}`, () => {
    let context: PullRequestsSuiteContext;
    beforeEach(async () => {
      context = await setup(structuredClone(FIXTURES));
    });

    it("merges an open pull request and reports the merge commit", async () => {
      const result = await context.pullRequests.merge(context.urls[0]!);

      expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    });

    it("succeeds again for a pull request that is already merged, with the same commit", async () => {
      const first = await context.pullRequests.merge(context.urls[0]!);

      const again = await context.pullRequests.merge(context.urls[0]!);

      expect(again.commit).toBe(first.commit);
    });

    it("refuses a pull request with conflicts, naming why", async () => {
      await expect(context.pullRequests.merge(context.urls[1]!)).rejects.toSatisfy(
        (error) => error instanceof MergeRefusedError && /not mergeable/i.test(error.message),
      );
    });

    it("refuses a closed pull request", async () => {
      await expect(context.pullRequests.merge(context.urls[2]!)).rejects.toSatisfy(
        (error) => error instanceof MergeRefusedError && /closed/i.test(error.message),
      );
    });

    it("refuses a pull request that does not exist", async () => {
      await expect(context.pullRequests.merge(context.missing)).rejects.toBeInstanceOf(MergeRefusedError);
    });

    it("describes which repository a pull request belongs to and which branch it merges from", async () => {
      expect(await context.pullRequests.describe(context.urls[0]!)).toEqual({
        repository: context.repository,
        headRepository: context.repository,
        headBranch: "tendworks/issue-1-0b6c4c1e",
      });
    });

    it("describes the head of a pull request from a fork as the fork's", async () => {
      expect(await context.pullRequests.describe(context.urls[2]!)).toEqual({ repository: context.repository, headRepository: "someone/fork", headBranch: "main" });
    });

    it("refuses to describe a pull request that does not exist", async () => {
      await expect(context.pullRequests.describe(context.missing)).rejects.toBeInstanceOf(MergeRefusedError);
    });
  });
}
