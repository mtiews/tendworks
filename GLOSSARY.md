# Tendworks

Self-hosted, use-case-neutral agent platform: agents are started by triggers, run isolated and recoverable in sandboxes, and only call on the human when a policy says so.

## Language

### Execution

**Task**:
A unit of work handed to an agent, by a run's step or by a human in a chat, following the A2A task model.
_Avoid_: job; also never use it for something a human has to do (that is an approval request or a notification)

**Agent session**:
One conversation of a harness with its agent, running in a sandbox on behalf of exactly one task. It survives the loss of its sandbox and can be resumed in a new one.
_Avoid_: conversation, harness session

**Chat**:
An agent session a human starts and leads directly, without a run, workflow or trigger. Any client can attach to it, leave and come back until the human ends it.
_Avoid_: conversation, interactive run, chat run

**Platform assistant**:
The chat profile `assistant`: answers questions about the platform through the platform MCP server, in an empty workspace. `tend chat` without arguments talks to it.

**Workspace assistant**:
A workspace's own chat partner about its contents (`assistant: { enabled, profile, write }`, default profile `workspace-assistant`), started by the workspace's name. Read-only unless the workspace sets `write: true`, then it works on the branch `tendworks/chat-<id>`.
_Avoid_: repository chat, project assistant

**Transcript**:
What happened in one agent session (messages, tool calls and results, turns, resumes), as product-neutral entries numbered by their position. Kept outside the sandbox and readable through the API while the session runs.
_Avoid_: log (except in `tend run logs`), session file, history

**Sandbox**:
An isolated, short-lived environment in which exactly one agent session's harness runs.
_Avoid_: container (that is one isolation class), VM, box

**Sandbox template**:
The declarative recipe a sandbox is created from: image, isolation class, resources and egress allowlist.
_Avoid_: sandbox profile, sandbox config

**Workspace**:
What an agent session works on, declared once by name: a git repository on any host with its own credential, cloned into the sandbox at `/workspace`, or a host directory bound there. Workflows, trigger bindings and chats refer to it by name; agent profiles carry no repository credentials.
_Avoid_: repository (one kind of workspace), project, checkout (what the agent runtime makes of a git workspace)

**Trigger binding**:
Starts a workflow when its trigger fires: one run per workspace it names and per item its trigger source reports, with the input `{ workspace, item }`. An item starts at most one run per binding and workspace. A suspended binding starts nothing.

**Trigger source**:
What fires a trigger binding, selected by its kind: `schedule` (cron or interval; the tick is the item) or `github-issues` (the issues of each workspace's repository). Each reports items with a stable key, a title and a link.

**Isolation class**:
How strongly a sandbox is separated from its host: `container`, `gvisor` or `microvm`. Chosen by the operator per sandbox template.
_Avoid_: security level, sandbox type, runtime

### Human interaction

**Notification**:
A message to the human that needs no decision, e.g. that a run finished. It is recorded before it is delivered, so it is never lost when delivery fails. A finished run's notification carries the run's artifacts.
_Avoid_: alert, task, message (that is an agent's output)

**Notification channel**:
A declared way notifications reach the operator (`kind: NotificationChannel`, ADR 0025): the events it selects and the adapter that delivers them, e.g. Pushover. Each notification goes to every channel that selects it, with a delivery status per channel.
_Avoid_: notifier (that is human interaction's consumer of events), notification delivery (that is the port behind a channel)

**Policy**:
A declarative rule (`kind: Policy`) that decides per action name and workflow whether a workflow's human step proceeds right away (`allow`) or only after an approval request (`ask`) (ADR 0024). A run never picks its policy.
_Avoid_: rule, gate setting, permission

**Approval request**:
A question to the human from a workflow's human step: an action name, links and custom answers, each continuing or stopping the run. Created when no policy allows the action; the run waits until it is decided with one of its answers.
_Avoid_: approval task, confirmation, ticket
