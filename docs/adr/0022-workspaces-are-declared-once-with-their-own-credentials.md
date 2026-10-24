# Workspaces are declared once, by name, with their own credentials

A workspace is a configuration kind (`kind: Workspace`), declared once and referred to by name from trigger bindings, workflows and chats. It is either `git` or `directory`:

- **`git`:** a repository URL on any git host and a default branch. The agent runtime clones it in the sandbox through a generic git credential helper, then checks out or creates the branch the workflow asks for. Its credential is the workspace's own agent secret (`secretRef` to a `TENDWORKS_AGENT_*` variable, ADR 0008). Optionally the session also sees the credential under a name such as `GH_TOKEN`, so that tools like `gh` find it.
- **`directory`:** a host directory bound to `/workspace`, read-write or read-only as the session asks. It must lie strictly under one of the roots the operator allows in `TEND_WORKSPACE_ROOTS` (absolute host paths, separated by `:`). Only one agent session at a time may use a directory.
  - **Root check in our code:** the socket proxy filters paths, not request bodies (ADR 0001), so the platform itself refuses everything else. The roots are mounted read-only into server and worker at the same path as on the host, so `..` and symbolic links resolve against the real file system there. The check runs when the configuration loads (server and worker refuse to start) and again before every session, which binds the resolved real path. The sandbox adapter binds host directories only from under the roots, lexically, as the last line.
  - **One session per directory:** the worker claims the real path for the session while preparing it and frees it when the session ends (an idle chat frees it with its sandbox, see below); a claim on a directory also blocks the directories inside it and around it. The claims live in the worker's memory: a restart forgets them, and resumed sessions claim again.
  - A bound directory is never a volume: nothing in the platform creates, lists or deletes it.

Agent profiles carry no repository credentials, so one profile works with every workspace. What is specific to a repository (build and test commands, conventions, skills) lives in the repository itself (`README`, `CLAUDE.md`, `AGENTS.md`), not in the platform configuration.

A workspace may enable a workspace assistant (`assistant: { enabled, profile, write }`): a chat (ADR 0015) about its contents, started by the workspace's name only (`POST /chats` with `workspace`, `tend chat --workspace <name>`, the web UI's new chat dialog, which lists the platform assistant and every workspace with an assistant from `GET /workspaces`). The default profile is `workspace-assistant`, which the starter configuration ships without the platform MCP server; a workspace may name any other chat profile, and the configuration refuses one that is not configured or allows no chats. A chat with a workspace without an enabled assistant is refused. By default the assistant is read-only:

- with `write: false`, git uses the credential only for the checkout: neither the session's environment nor its credential helper has it afterwards, so a push to a remote that needs it fails. The checkout also points the remote's push URL nowhere, so a push fails where the remote needs no credential too; that is a guard against mistakes, not a boundary, since the agent can change its own `.git/config`. A directory is mounted read-only. The agent is told which applies;
- with `write: true`, the session gets the credential like a workflow's and works on a chat branch `tendworks/chat-<id>`, and a directory is writable.

The write mode is kept with the chat when it starts; changing `assistant.write` affects new chats only.

**Idle chats and directory claims:** a chat on a directory workspace holds the directory's claim only while it has a sandbox. When it goes idle and its sandbox goes, the claim is freed, so a run can use the directory meanwhile; the chat's next turn claims it again. If another session holds it then, the turn does not run and the chat stays open, answering that the workspace is busy; the operator sends the message again later.

## Considered Options

- **Repository per agent profile:** one profile per repository, and tokens in profiles; the same profile cannot serve several repositories.
- **Repository from the trigger item:** works only for triggers that carry a repository (issues), not for schedules.
- **Free repository URLs in chats and runs:** any caller could point an agent at any repository; named workspaces limit agents to what the operator configured.

## Consequences

- Adding a repository is one workspace file plus its name in the bindings that should cover it, plus granting the repository in the tokens.
- A directory workspace is only as traceable and recoverable as the directory itself; a git working copy is the recommended content.
- The sandbox writes into the host directory as the sandbox user (uid 1000 by default), so the operator grants that user access to it.
- The compose stack mounts one root (compose cannot turn a list into mounts); other deployments mount each root. Between the last check and Docker binding the path, a process on the host could still swap a link; agents cannot, because no session runs in an overlapping directory meanwhile.
- The workspace port has two implementations (git, directory); both appear in the port fitness function.
