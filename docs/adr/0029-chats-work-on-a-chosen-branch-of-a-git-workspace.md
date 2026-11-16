# Chats work on a chosen branch of a git workspace

A workspace assistant's chat (ADR 0022) worked on a fixed branch: `tendworks/chat-<chat id>` when it may write, the default branch when it may only read. Workflows already name their branch (`{ name, branch?, write? }`, ADR 0010); chats could not, so a prototype could not get a meaningful branch name, could not continue in a later chat, and an existing branch could not be discussed in a read-only chat. `POST /chats` takes an optional `branch` together with `workspace`.

- **Writing chats on listed prefixes only.** A workspace's `assistant.branchPrefixes` lists the prefixes of the branches a writing chat may be started on, e.g. `prototype/`; the default is none. Without `branch` a writing chat stays on its own `tendworks/chat-<chat id>`. There is no wildcard prefix, and the workspace's default branch is never allowed, also when a prefix would match it.
- **Read-only chats on any existing branch.** Prefixes restrict writing chats only: a read-only chat may check out any branch the remote already has (e.g. a workflow's issue branch, for a review). It never creates one: a branch the remote does not have fails the checkout, and with it the chat, with git's reason. Without `branch` it stays on the default branch. Until the checkout supports this, the agent runtime refuses `branch` on a read-only chat with `400`, so the behaviour is never undefined.
- **Checks at the start, in the agent runtime.** `branch` with `agent` instead of `workspace` is an invalid body (`400`). The agent runtime refuses with `400 Branch not allowed` and the reason: `branch` on a directory workspace, which has no branches; a name that is not a valid branch (the same rule as for a workflow's branch: no whitespace, no leading dash); a writing chat on a branch under no listed prefix, or on the default branch. The control plane only checks the body's shape and passes the agent runtime's reason on.
- **The branch is a fact of the chat**, kept with `workspace` and `write` when it starts (`chat.branch`), so a chat resumed in a new sandbox, e.g. after its idle time or a restart, checks out the same branch (ADR 0009). A changed `branchPrefixes` affects new chats only.
- **Continue or start.** A writing chat continues the branch when the remote has it and starts it from the default branch otherwise, with the same checkout as a workflow's branch.
- **No locks.** Several chats, and runs, may work on the same branch at once; coordinating them is up to the operator.

## Considered Options

- **Free branch names for writing chats:** a writing chat could push to any branch the token reaches, including release branches; listed prefixes keep writing chats where the operator meant them to be.
- **Wildcard or pattern prefixes:** more expressive, but a pattern is easier to get wrong than a list of prefixes; left out until there is a need.
- **Locks per branch:** would block a legitimate second chat on a prototype, and the platform cannot see a branch's other writers (people, runs) anyway.

## Consequences

- Tokens cannot be scoped to branches on most hosts: a writing assistant's token can push to every branch it reaches. The prefixes guard against mistakes in the platform, not against the agent; protect the branches that matter (the default branch, release branches) through the repository's rules.
- `GET /workspaces` shows each assistant's `branchPrefixes`, so clients can offer them (`tend chat --branch`, the web UI's new chat dialog).
- Chats with a profile (an empty workspace) and on directory workspaces have no branch choice.
