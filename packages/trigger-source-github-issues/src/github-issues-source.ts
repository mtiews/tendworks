import type { TriggerBinding, Workspace } from "@tendworks/shared";
import type { TriggerItem, TriggerSource, TriggerSourceContext } from "@tendworks/trigger-gateway/source";
import { createGithubIssueTracker } from "./github-issue-tracker.js";

export interface GithubIssuesSourceOptions {
  /** HTTP client for the GitHub API; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/**
 * Trigger source of kind `github-issues` (ADR 0023): at every interval it asks GitHub for
 * the matching issues of each git workspace's repository, with the binding's read-only
 * platform token, never a workspace's agent credential. Each issue is an item keyed by
 * `<owner>/<name>#<number>`. The token is resolved on every check, so a missing secret
 * fails that check (naming the secret, never a value) instead of the start.
 */
export function createGithubIssuesSource(
  settings: TriggerBinding.GithubIssuesTrigger,
  { secrets }: TriggerSourceContext,
  { fetch }: GithubIssuesSourceOptions = {},
): TriggerSource {
  return {
    schedule: { every: structuredClone(settings.every) },
    async items({ workspace }) {
      const repository = repositoryOf(workspace);
      const name = settings.token.secretRef.name;
      const token = secrets.resolve(name);
      if (!token) throw new Error(secrets.problem(name) ?? `secret ${name} is not set`);
      const issues = await createGithubIssueTracker({ token, ...(fetch ? { fetch } : {}) }).findIssues({
        repository,
        ...(settings.labels ? { labels: settings.labels } : {}),
        ...(settings.state ? { state: settings.state } : {}),
      });
      return issues.map(({ repository, number, title, url, ...issue }): TriggerItem => ({ key: `${repository}#${number}`, title, url, repository, number, ...issue }));
    },
  };
}

/** `<owner>/<name>` of a git workspace on github.com. */
function repositoryOf(workspace: Workspace.Workspace | undefined): string {
  if (!workspace) throw new Error("github-issues reads the repositories of the binding's workspaces, but the binding names none");
  const url = workspace.spec.git.url;
  const match = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) throw new Error(`workspace '${workspace.metadata.name}' is not a repository on github.com (${url})`);
  return `${match[1]}/${match[2]}`;
}
