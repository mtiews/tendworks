# Workspaces are declared once, by name, with their own credentials

A workspace is a configuration kind (`kind: Workspace`), declared once and referred to by name from trigger bindings, workflows and chats. It is either `git` or `directory`:

- **`git`:** a repository URL on any git host and a default branch. The agent runtime clones it in the sandbox through a generic git credential helper, then checks out or creates the branch the workflow asks for. Its credential is the workspace's own agent secret (`secretRef` to a `TENDWORKS_AGENT_*` variable, ADR 0008). Optionally the session also sees the credential under a name such as `GH_TOKEN`, so that tools like `gh` find it.
- **`directory`:** a host directory bound to `/workspace`. It must lie under one of the roots the operator allows in `TEND_WORKSPACE_ROOTS`. Only one agent session at a time may use a directory.

Agent profiles carry no repository credentials, so one profile works with every workspace. What is specific to a repository (build and test commands, conventions, skills) lives in the repository itself (`README`, `CLAUDE.md`, `AGENTS.md`), not in the platform configuration.

A workspace may enable a workspace assistant (`assistant: { enabled, profile, write }`). By default it is read-only:

- with `write: false`, git uses the credential only for the checkout, and a directory is mounted read-only;
- with `write: true`, the session gets the credential and works on a chat branch `tendworks/chat-<id>`, and a directory is writable.

## Considered Options

- **Repository per agent profile:** one profile per repository, and tokens in profiles; the same profile cannot serve several repositories.
- **Repository from the trigger item:** works only for triggers that carry a repository (issues), not for schedules.
- **Free repository URLs in chats and runs:** any caller could point an agent at any repository; named workspaces limit agents to what the operator configured.

## Consequences

- Adding a repository is one workspace file plus its name in the bindings that should cover it, plus granting the repository in the tokens.
- A directory workspace is only as traceable and recoverable as the directory itself; a git working copy is the recommended content.
- The workspace port has two implementations (git, directory); both appear in the port fitness function.
