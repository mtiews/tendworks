import { beforeEach, describe, expect, it } from "vitest";
import { MergeRefusedError, type PullRequests } from "./pull-requests.js";

/** A pull request the setup must create; it returns their web URLs in the same order. */
export interface PullRequestFixture {
  state: "open" | "closed";
  mergeable: boolean;
}

export interface PullRequestsSuiteContext {
  pullRequests: PullRequests;
  urls: string[];
  /** A URL of the integration's host where no pull request exists. */
  missing: string;
}

const FIXTURES: PullRequestFixture[] = [
  { state: "open", mergeable: true },
  { state: "open", mergeable: false },
  { state: "closed", mergeable: true },
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
  });
}
