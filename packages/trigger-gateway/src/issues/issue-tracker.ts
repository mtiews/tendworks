import type { TriggerBinding } from "@tendworks/shared";

export type Issue = TriggerBinding.Issue;
export type IssueFilter = TriggerBinding.IssueFilter;
export type IssueSource = TriggerBinding.IssueSource;

/**
 * Integration port to an issue tracker. The trigger gateway asks it on every scheduled
 * check for the issues matching a binding's filter.
 *
 * @port
 */
export interface IssueTracker {
  /**
   * Issues of `filter.repository` that carry every label in `filter.labels` and are in
   * `filter.state` (default `open`; `all` for both), ordered by number.
   */
  findIssues(filter: IssueFilter): Promise<Issue[]>;
}

/** Issue tracker that serves a fixed list of issues, for tests and demos. */
export function createFakeIssueTracker(issues: Issue[] = []): IssueTracker {
  return {
    async findIssues({ repository, labels = [], state = "open" }) {
      return issues
        .filter((issue) => issue.repository === repository)
        .filter((issue) => state === "all" || issue.state === state)
        .filter((issue) => labels.every((label) => issue.labels.includes(label)))
        .sort((a, b) => a.number - b.number)
        .map((issue) => structuredClone(issue));
    },
  };
}
