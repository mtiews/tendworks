import { createGithubIssueTracker } from "./github/github-issue-tracker.js";
import { createFakeIssueTracker, type IssueSource, type IssueTracker } from "./issue-tracker.js";

export interface IssueTrackerForOptions {
  /**
   * The platform's secrets by name, which secret references resolve against. Defaults to
   * the process environment (filled from `deploy/.env` in the laptop profile).
   */
  secrets?: Record<string, string | undefined>;
  /** HTTP client of the real integrations; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/**
 * The issue tracker a binding's source names. Secrets are resolved on every check, so a
 * missing one fails that check (naming the secret, never a value) instead of the start.
 */
export function issueTrackerFor(source: IssueSource, { secrets = process.env, fetch }: IssueTrackerForOptions = {}): IssueTracker {
  switch (source.integration) {
    case "fake":
      return createFakeIssueTracker(source.fake?.issues);
    case "github":
      return {
        async findIssues(filter) {
          const name = source.github?.token.secretRef.name;
          const token = name ? secrets[name] : undefined;
          if (!token) throw new Error(name ? `secret ${name} is not set` : "the github source names no token");
          return createGithubIssueTracker({ token, ...(fetch ? { fetch } : {}) }).findIssues(filter);
        },
      };
  }
}
