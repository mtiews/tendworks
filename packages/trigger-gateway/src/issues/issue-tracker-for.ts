import type { SecretResolver } from "@tendworks/platform";
import { createGithubIssueTracker } from "./github/github-issue-tracker.js";
import { createFakeIssueTracker, type IssueSource, type IssueTracker } from "./issue-tracker.js";

export interface IssueTrackerForOptions {
  /** Resolves the secret references of sources: only platform secrets (ADR 0008). */
  secrets: SecretResolver;
  /** HTTP client of the real integrations; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/**
 * The issue tracker a binding's source names. Secrets are resolved on every check, so a
 * missing one fails that check (naming the secret, never a value) instead of the start.
 */
export function issueTrackerFor(source: IssueSource, { secrets, fetch }: IssueTrackerForOptions): IssueTracker {
  switch (source.integration) {
    case "fake":
      return createFakeIssueTracker(source.fake?.issues);
    case "github":
      return {
        async findIssues(filter) {
          const name = source.github?.token.secretRef.name;
          if (!name) throw new Error("the github source names no token");
          const token = secrets.resolve(name);
          if (!token) throw new Error(secrets.problem(name) ?? `secret ${name} is not set`);
          return createGithubIssueTracker({ token, ...(fetch ? { fetch } : {}) }).findIssues(filter);
        },
      };
  }
}
