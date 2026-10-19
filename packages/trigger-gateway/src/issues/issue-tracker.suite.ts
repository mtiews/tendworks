import { beforeAll, describe, expect, it } from "vitest";
import type { IssueTracker } from "./issue-tracker.js";

/** An issue the setup must create in the repository it returns. */
export interface IssueFixture {
  title: string;
  labels: string[];
  state: "open" | "closed";
}

export interface IssueTrackerSuiteContext {
  tracker: IssueTracker;
  /** Repository (`<owner>/<name>`) that holds exactly the fixtures. */
  repository: string;
}

const FIXTURES: IssueFixture[] = [
  { title: "ready bug", labels: ["ready-for-agent", "bug"], state: "open" },
  { title: "ready feature", labels: ["ready-for-agent"], state: "open" },
  { title: "unlabelled", labels: [], state: "open" },
  { title: "closed ready", labels: ["ready-for-agent"], state: "closed" },
];

/**
 * The behaviour every issue tracker adapter must show. Runs against the real adapter
 * and the fake, so the fake stays a faithful stand-in.
 */
export function describeIssueTracker(name: string, setup: (fixtures: IssueFixture[]) => Promise<IssueTrackerSuiteContext>) {
  describe(`issue tracker: ${name}`, () => {
    let context: IssueTrackerSuiteContext;
    const titles = async (filter: Omit<Parameters<IssueTracker["findIssues"]>[0], "repository">) =>
      (await context.tracker.findIssues({ repository: context.repository, ...filter })).map((issue) => issue.title);

    beforeAll(async () => {
      context = await setup(structuredClone(FIXTURES));
    });

    it("finds the open issues carrying every label of the filter, ordered by number", async () => {
      expect(await titles({ labels: ["ready-for-agent"] })).toEqual(["ready bug", "ready feature"]);
      expect(await titles({ labels: ["ready-for-agent", "bug"] })).toEqual(["ready bug"]);
    });

    it("finds every open issue when the filter names no labels", async () => {
      expect(await titles({})).toEqual(["ready bug", "ready feature", "unlabelled"]);
    });

    it("finds closed issues, or issues in any state, when the filter asks for them", async () => {
      expect(await titles({ labels: ["ready-for-agent"], state: "closed" })).toEqual(["closed ready"]);
      expect(await titles({ labels: ["ready-for-agent"], state: "all" })).toEqual(["ready bug", "ready feature", "closed ready"]);
    });

    it("finds nothing for a label no issue carries", async () => {
      expect(await titles({ labels: ["no-such-label"] })).toEqual([]);
    });

    it("reports each issue with its repository, number, state, labels and a link", async () => {
      const [issue] = await context.tracker.findIssues({ repository: context.repository, labels: ["bug"] });

      expect(issue).toMatchObject({ repository: context.repository, title: "ready bug", state: "open" });
      expect(issue?.labels.sort()).toEqual(["bug", "ready-for-agent"]);
      expect(issue?.number).toBeGreaterThan(0);
      expect(issue?.url).toMatch(/^https?:\/\//);
    });
  });
}
