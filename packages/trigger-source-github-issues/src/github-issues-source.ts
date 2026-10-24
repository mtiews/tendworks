import type { TriggerBinding, Workspace } from "@tendworks/shared";
import type { TriggerItem, TriggerSource, TriggerSourceContext } from "@tendworks/trigger-gateway/source";
import { createGithubIssueTracker } from "./github-issue-tracker.js";

export interface GithubIssuesSourceOptions {
  /** HTTP client for the GitHub API; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/**
 * Trigger source of kind `github-issues` (ADR 0023): at every interval it asks GitHub for
 * the matching issues of each workspace's repository, with the binding's read-only
 * platform token, never a workspace's agent credential, and only reads. Pull requests are
 * left out. Each issue is an item keyed by `<owner>/<name>#<number>`, with its title, link
 * and body.
 *
 * Throws at creation, so the platform refuses the configuration, for a binding without
 * workspaces or with a workspace that is not a git repository on github.com. The token is
 * resolved on every check, so a missing secret fails that check (naming the secret, never
 * a value) instead of the start.
 */
export function createGithubIssuesSource(
  settings: TriggerBinding.GithubIssuesTrigger,
  { secrets, workspaces }: TriggerSourceContext,
  { fetch }: GithubIssuesSourceOptions = {},
): TriggerSource {
  if (workspaces.length === 0) throw new Error("github-issues reads the issues of the binding's workspaces' repositories, but the binding names no workspace");
  const repositories = new Map(workspaces.map((workspace) => [workspace.metadata.name, repositoryOf(workspace)]));
  return {
    schedule: { every: structuredClone(settings.every) },
    async items({ workspace }) {
      if (!workspace) throw new Error("github-issues is checked per workspace, but this check names none");
      const repository = repositories.get(workspace.metadata.name);
      if (!repository) throw new Error(`workspace '${workspace.metadata.name}' is not one of the binding's workspaces`);
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

const ONLY_GITHUB = "github-issues reads issues on github.com only";

/** `<owner>/<name>` of a git workspace on github.com. */
function repositoryOf(workspace: Workspace.Workspace): string {
  const name = workspace.metadata.name;
  // Other workspace kinds (a directory) have no repository.
  const git = (workspace.spec as { git?: Workspace.GitWorkspace }).git;
  if (!git) throw new Error(`workspace '${name}' is not a git repository; ${ONLY_GITHUB}`);
  const match = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(git.url);
  if (!match) throw new Error(`workspace '${name}' is not a repository on github.com (${git.url}); ${ONLY_GITHUB}`);
  return `${match[1]}/${match[2]}`;
}
