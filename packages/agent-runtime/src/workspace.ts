import { isAbsolute, relative, sep } from "node:path";
import { enabledAssistant, type SecretResolver, type WorkspaceAssistant } from "@tendworks/platform";
import { resolveWorkspaceDirectory } from "@tendworks/platform/workspace-roots";
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
  /**
   * Whether the session may only read the workspace (e.g. a read-only assistant): a
   * directory is then bound read-only, and a git credential reaches only the checkout.
   */
  readOnly?: boolean;
}

/**
 * What a sandbox mounts at its workspace path: a volume of the agent session, removed with
 * it, or a host directory, bound and never removed.
 */
export type WorkspaceMount = { volume: string } | { hostPath: string; readOnly: boolean };

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
  /**
   * Frees what preparing took for the session (e.g. its claim on a directory); called once
   * the session has ended for good. Preparing again for the same session takes nothing more.
   */
  release?: () => void;
}

/** Why a workspace cannot be prepared; `busy` when another session holds it for now. */
export interface WorkspaceProblem {
  problem: string;
  busy?: true;
}

/**
 * The workspace port (ADR 0022): how a workspace gets into an agent session's sandbox,
 * e.g. a git repository cloned with the workspace's own credential, or a host directory bound into it.
 *
 * @port
 */
export interface Workspace {
  /**
   * Prepares the workspace for one session; a problem (e.g. a secret not set) fails the
   * session, naming it but no value. A `busy` problem passes once another session lets
   * go of the workspace (e.g. a directory in use).
   */
  prepare(session: WorkspaceSession): Promise<PreparedWorkspace | WorkspaceProblem>;
}

/** The workspace of a session that names none: an empty volume. */
export function createEmptyWorkspace(): Workspace {
  return {
    prepare: async ({ taskId }) => ({ mount: { volume: workspaceVolume(taskId) }, sessionEnv: {}, secrets: [], instructions: "" }),
  };
}

/** A git repository as a workspace: the name, `git` settings and credentials of a `Workspace`. */
export interface GitWorkspaceSettings {
  name: string;
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
    async prepare({ taskId, branch, readOnly = false }) {
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
      // Read-only: the credential stays with the checkout, so the session's git finds none and cannot push.
      const readOnlyNote = readOnly
        ? " It is read-only for you: you have no credential for the repository, so you cannot push; changes you make stay in the workspace."
        : "";
      return {
        mount: { volume: workspaceVolume(taskId) },
        checkout: {
          command: ["sh", "-c", CHECKOUT, "checkout", url, credentialScope(url), defaultBranch ?? "", readOnly ? "no-push" : "push", ...(branch === undefined ? [] : [branch])],
          env: credential,
          describes: { url, name, ...(branch === undefined ? {} : { branch }) },
        },
        sessionEnv: readOnly ? {} : { ...credential, ...exposed },
        secrets: credential.TENDWORKS_GIT_PASSWORD === undefined ? [] : [credential.TENDWORKS_GIT_PASSWORD],
        instructions: `Your workspace is a checkout of ${url}${on}.${readOnlyNote}`,
      };
    },
  };
}

/**
 * Which agent session works in which host directory, so that only one does at a time,
 * also when two workspaces name the same directory or one inside the other. Kept in the
 * worker's memory: a worker restart forgets it, and resumed sessions claim again.
 */
export interface DirectoryClaims {
  /** Claims `directory` for `holder`; the holder of a conflicting claim, if there is one (never `holder` itself). */
  claim(directory: string, holder: string): string | undefined;
  release(directory: string, holder: string): void;
}

export function createDirectoryClaims(): DirectoryClaims {
  const claims = new Map<string, string>();
  const overlap = (a: string, b: string) => a === b || isInside(a, b) || isInside(b, a);
  return {
    claim(directory, holder) {
      for (const [claimed, by] of claims) if (by !== holder && overlap(claimed, directory)) return by;
      claims.set(directory, holder);
      return undefined;
    },
    release(directory, holder) {
      if (claims.get(directory) === holder) claims.delete(directory);
    },
  };
}

function isInside(path: string, directory: string): boolean {
  const rest = relative(directory, path);
  return rest !== "" && rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

export interface DirectoryWorkspaceSettings {
  name: string;
  /** The `directory.path` of the `Workspace`, on the sandbox host, which the worker sees at the same path. */
  path: string;
}

/**
 * A directory workspace: a host directory under one of the operator's roots, bound at the
 * workspace path read-write, or read-only when the session asks. Before every session the
 * path is resolved again (a symbolic link may have changed since the configuration loaded)
 * and its real path is bound. Only one session at a time works in a directory; a second
 * one fails, naming the session that holds it.
 */
export function createDirectoryWorkspace(
  { name, path }: DirectoryWorkspaceSettings,
  { roots, claims = createDirectoryClaims() }: { roots: readonly string[]; claims?: DirectoryClaims },
): Workspace {
  return {
    async prepare({ taskId, readOnly = false }) {
      const resolved = resolveWorkspaceDirectory(path, roots);
      if ("problem" in resolved) return resolved;
      const { directory } = resolved;
      const holder = claims.claim(directory, taskId);
      if (holder !== undefined) {
        return { problem: `directory ${path} is in use by another agent session (task ${holder}); only one session at a time works in a directory`, busy: true };
      }
      return {
        mount: { hostPath: directory, readOnly },
        sessionEnv: {},
        secrets: [],
        instructions: `Your workspace is the directory ${name}${readOnly ? ", read-only: you cannot change its files" : ""}.`,
        release: () => claims.release(directory, taskId),
      };
    },
  };
}

/** The configured workspaces by name, each behind the implementation its kind selects; directories share one set of claims. */
export function createWorkspaces(
  definitions: readonly Kind.Workspace[],
  { secrets, roots = [] }: { secrets: SecretResolver; roots?: readonly string[] },
): (name: string) => Workspace | undefined {
  const claims = createDirectoryClaims();
  const byName = new Map(
    definitions.map(({ metadata: { name }, spec }): [string, Workspace] => {
      if (spec.directory) return [name, createDirectoryWorkspace({ name, path: spec.directory.path }, { roots, claims })];
      if (!spec.git) throw new Error(`workspace ${name} is neither git nor directory`);
      return [name, createGitWorkspace({ name, ...spec.git, ...(spec.credentials ? { credentials: spec.credentials } : {}) }, secrets)];
    }),
  );
  return (name) => byName.get(name);
}

/** The enabled assistants of the configured workspaces by workspace name, defaults filled in; undefined for a workspace without one. */
export function workspaceAssistants(definitions: readonly Kind.Workspace[]): (workspace: string) => WorkspaceAssistant | undefined {
  const byName = new Map(
    definitions.flatMap(({ metadata: { name }, spec }): [string, WorkspaceAssistant][] => {
      const assistant = enabledAssistant(spec.assistant);
      return assistant ? [[name, assistant]] : [];
    }),
  );
  return (workspace) => byName.get(workspace);
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
// $4 `push` or `no-push`, $5 branch (optional). A workspace that is already a checkout
// (e.g. kept on a volume) stays as it is; otherwise the branch is continued if the remote
// has it, or started from the default branch. Without a branch the checkout stays on the
// default branch. `no-push` (a read-only session) points the remote's push URL nowhere, so
// a push fails even where the remote needs no credential; the boundary for a remote that
// needs one is that the session never gets it, since the agent can change its own .git/config.
const CHECKOUT = `set -e
url=$1 scope=$2 base=$3 push=$4
if [ $# -ge 5 ]; then branch=$5; else branch=; fi
if [ ! -e .git ]; then
  set -- clone --quiet
  if [ -n "$scope" ]; then set -- "$@" -c "credential.$scope.helper=tendworks"; fi
  if [ -n "$base" ]; then set -- "$@" --branch "$base"; fi
  git "$@" -- "$url" .
fi
if [ "$push" = no-push ]; then git config remote.origin.pushurl no-push://read-only-workspace; fi
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
