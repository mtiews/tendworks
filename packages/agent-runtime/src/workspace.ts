import type { SecretResolver } from "@tendworks/platform";
import type { A2A, Workspace as Kind } from "@tendworks/shared";
import type { TranscriptRecord } from "./transcripts/transcript-store.js";

/** Message metadata key of the workspace a task asks for (contracts/schemas/a2a.schema.yaml#/$defs/workspace). */
export const WORKSPACE = "dev.tendworks/workspace";

/** What the message that starts a task asks for: a configured workspace by name, and the branch to work on. */
export type WorkspaceRequest = A2A.Workspace;

/** What one agent session asks of its workspace. */
export interface WorkspaceSession {
  /** The task whose agent session the workspace is prepared for; names its volume. */
  taskId: string;
  /** The branch to work on; without it the workspace stays on its default branch. */
  branch?: string;
}

/** What a sandbox mounts at its workspace path: a volume of the agent session, removed with it. */
export interface WorkspaceMount {
  volume: string;
}

/** What was checked out, as the transcript records it (contracts/schemas/transcript-entry.schema.yaml#/$defs/checkedOutWorkspace). */
export type CheckedOutWorkspace = Extract<TranscriptRecord, { type: "workspace-checkout" }>["workspace"];

/** A workspace prepared for one agent session: what its sandbox mounts, runs and passes on. */
export interface PreparedWorkspace {
  mount: WorkspaceMount;
  /**
   * Run in the workspace once the sandbox is up, before the agent starts, with `env`
   * (e.g. a credential only the checkout gets); none when there is nothing to fetch.
   * It keeps a workspace that is already prepared as it is.
   */
  checkout?: { command: string[]; env: Record<string, string>; describes: CheckedOutWorkspace };
  /** Environment of the agent session itself; apart from the checkout's, so a credential can stay with the checkout. */
  sessionEnv: Record<string, string>;
  /** Secret values that must never appear in what the session reports. */
  secrets: string[];
  /** What the agent is told about its workspace; empty when there is nothing to say. */
  instructions: string;
}

/**
 * The workspace port (ADR 0022): how a workspace gets into an agent session's sandbox,
 * e.g. a git repository cloned with the workspace's own credential.
 *
 * @port
 */
export interface Workspace {
  /** Prepares the workspace for one session; a problem (e.g. a secret not set) fails the session, naming it but no value. */
  prepare(session: WorkspaceSession): Promise<PreparedWorkspace | { problem: string }>;
}

/** The workspace of a session that names none: an empty volume. */
export function createEmptyWorkspace(): Workspace {
  return {
    prepare: async ({ taskId }) => ({ mount: { volume: workspaceVolume(taskId) }, sessionEnv: {}, secrets: [], instructions: "" }),
  };
}

/** A git repository as a workspace: the `git` settings and credentials of a `Workspace`, or a public repository by URL alone. */
export interface GitWorkspaceSettings {
  /** The configured workspace's name; absent for a repository given by URL alone. */
  name?: string;
  url: string;
  /** The branch new branches start from and the one checked out without a branch; the remote's default branch when absent. */
  defaultBranch?: string;
  credentials?: Kind.WorkspaceCredentials;
}

/** For a repository without a credential: resolves nothing. */
const NO_SECRETS: SecretResolver = { resolve: () => undefined, problem: (name) => `secret ${name} is not set` };

/** The user name git sends with a token unless the workspace names one. */
const DEFAULT_USERNAME = "x-access-token";

/**
 * A git workspace: cloned into a volume of the session, then on the branch the session
 * asks for. The credential reaches git through the sandbox image's generic credential
 * helper (`git-credential-tendworks`, any host), configured for the repository's host
 * only and fed from `TENDWORKS_GIT_USERNAME`/`TENDWORKS_GIT_PASSWORD`. The secret is
 * resolved for every session, so a secret set later needs no restart.
 */
export function createGitWorkspace({ name, url, defaultBranch, credentials }: GitWorkspaceSettings, secrets: SecretResolver = NO_SECRETS): Workspace {
  return {
    async prepare({ taskId, branch }) {
      let credential: Record<string, string> = {};
      let exposed: Record<string, string> = {};
      if (credentials) {
        const secret = credentials.secretRef.name;
        const value = secrets.resolve(secret);
        if (!value) return { problem: secrets.problem(secret) ?? `secret ${secret} is not set` };
        credential = { TENDWORKS_GIT_USERNAME: credentials.username ?? DEFAULT_USERNAME, TENDWORKS_GIT_PASSWORD: value };
        exposed = credentials.env === undefined ? {} : { [credentials.env]: value };
      }
      const on = branch === undefined ? "" : ` on branch ${branch}`;
      return {
        mount: { volume: workspaceVolume(taskId) },
        checkout: {
          command: ["sh", "-c", CHECKOUT, "checkout", url, credentialScope(url), defaultBranch ?? "", ...(branch === undefined ? [] : [branch])],
          env: credential,
          describes: { url, ...(name === undefined ? {} : { name }), ...(branch === undefined ? {} : { branch }) },
        },
        sessionEnv: { ...credential, ...exposed },
        secrets: credential.TENDWORKS_GIT_PASSWORD === undefined ? [] : [credential.TENDWORKS_GIT_PASSWORD],
        instructions: `Your workspace is a checkout of ${url}${on}.`,
      };
    },
  };
}

/** The configured workspaces by name, each behind the implementation its kind selects. */
export function createWorkspaces(definitions: readonly Kind.Workspace[], { secrets }: { secrets: SecretResolver }): (name: string) => Workspace | undefined {
  const byName = new Map(
    definitions.map(({ metadata: { name }, spec }) => [name, createGitWorkspace({ name, ...spec.git, ...(spec.credentials ? { credentials: spec.credentials } : {}) }, secrets)]),
  );
  return (name) => byName.get(name);
}

/** The volume a session's own workspace lives on, named after its task; removed with the session. */
export function workspaceVolume(taskId: string): string {
  return `${taskId}-workspace`;
}

/** Where git may use the credential helper: the repository's scheme, host and port; nowhere for other URLs (e.g. `file:`). */
function credentialScope(url: string): string {
  try {
    const { protocol, origin } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? origin : "";
  } catch {
    return "";
  }
}

// $1 URL, $2 credential scope (empty: none), $3 default branch (empty: the remote's),
// $4 branch (optional). A workspace that is already a checkout (e.g. kept on a volume)
// stays as it is; otherwise the branch is continued if the remote has it, or started from
// the default branch. Without a branch the checkout stays on the default branch.
const CHECKOUT = `set -e
url=$1 scope=$2 base=$3
if [ $# -ge 4 ]; then branch=$4; else branch=; fi
if [ ! -e .git ]; then
  set -- clone --quiet
  if [ -n "$scope" ]; then set -- "$@" -c "credential.$scope.helper=tendworks"; fi
  if [ -n "$base" ]; then set -- "$@" --branch "$base"; fi
  git "$@" -- "$url" .
fi
if [ -z "$branch" ] || [ "$(git branch --show-current)" = "$branch" ]; then exit 0; fi
if git rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null; then
  git checkout --quiet -B "$branch" "origin/$branch"
elif [ -n "$base" ]; then
  git checkout --quiet -b "$branch" "origin/$base"
else
  git checkout --quiet -b "$branch"
fi`;

/** The workspace the message that started a task asks for, if any. */
export function workspaceRequestOf(message: A2A.Message): { request?: WorkspaceRequest } | { problem: string } {
  const value = message.metadata?.[WORKSPACE];
  if (value === undefined) return {};
  const { name, branch, ...rest } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const valid = typeof name === "string" && NAME.test(name) && (branch === undefined || (typeof branch === "string" && BRANCH.test(branch)));
  if (!valid || Object.keys(rest).length > 0) {
    return { problem: `message metadata ${WORKSPACE} must be { name, branch? } with the name of a configured workspace and a branch without whitespace or a leading dash` };
  }
  return { request: { name, ...(branch === undefined ? {} : { branch }) } };
}

// Same rules as the contract: no value can pass as an option.
const NAME = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const BRANCH = /^[^-\s]\S*$/;
