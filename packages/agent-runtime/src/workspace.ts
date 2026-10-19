import type { A2A } from "@tendworks/shared";
import type { ExecRequest } from "./sandboxes.js";

/** Message metadata key of the workspace a task asks for (contracts/schemas/a2a.schema.yaml#/$defs/workspace). */
export const WORKSPACE = "dev.tendworks/workspace";

export type Workspace = A2A.Workspace;

// Same rule as the contract: no leading dash, no whitespace, so no value can pass as an option.
const VALUE = /^[^-\s]\S*$/;

/** The workspace the message that started a task asks for, if any. */
export function workspaceOf(message: A2A.Message): { workspace?: Workspace } | { problem: string } {
  const value = message.metadata?.[WORKSPACE];
  if (value === undefined) return {};
  const { repository, branch } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const valid = (field: unknown): field is string => typeof field === "string" && VALUE.test(field);
  if (!valid(repository) || !valid(branch)) {
    return { problem: `message metadata ${WORKSPACE} must be { repository, branch } with values without whitespace or a leading dash` };
  }
  return { workspace: { repository, branch } };
}

// $1 repository, $2 branch. A workspace that is already a checkout (e.g. kept on a
// volume) stays as it is; otherwise the branch is continued if the remote has it, or
// started from the default branch.
const CHECKOUT = `set -e
if [ ! -e .git ]; then git clone --quiet -- "$1" .; fi
if [ "$(git branch --show-current)" = "$2" ]; then exit 0; fi
if git rev-parse --verify --quiet "refs/remotes/origin/$2" >/dev/null; then
  git checkout --quiet -B "$2" "origin/$2"
else
  git checkout --quiet -b "$2"
fi`;

/** The command that prepares the workspace in the current directory; values are passed as arguments, never as code. */
export function checkoutCommand({ repository, branch }: Workspace): Pick<ExecRequest, "command"> & { command: string[] } {
  return { command: ["sh", "-c", CHECKOUT, "checkout", repository, branch] };
}
