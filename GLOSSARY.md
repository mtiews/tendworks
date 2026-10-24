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

**Transcript**:
What happened in one agent session (messages, tool calls and results, turns, resumes), as product-neutral entries numbered by their position. Kept outside the sandbox and readable through the API while the session runs.
_Avoid_: log (except in `tend run logs`), session file, history

**Sandbox**:
An isolated, short-lived environment in which exactly one agent session's harness runs.
_Avoid_: container (that is one isolation class), VM, box

**Sandbox template**:
The declarative recipe a sandbox is created from: image, isolation class, resources and egress allowlist.
_Avoid_: sandbox profile, sandbox config

**Isolation class**:
How strongly a sandbox is separated from its host: `container`, `gvisor` or `microvm`. Chosen by the operator per sandbox template.
_Avoid_: security level, sandbox type, runtime

### Human interaction

**Notification**:
A message to the human that needs no decision, e.g. that a run finished. It is recorded before it is delivered, so it is never lost when delivery fails.
_Avoid_: alert, task, message (that is an agent's output)

**Policy**:
A declarative rule (`kind: Policy`) that decides per action name and workflow whether a workflow's human step proceeds right away (`allow`) or only after an approval request (`ask`) (ADR 0024). A run never picks its policy.
_Avoid_: rule, gate setting, permission

**Approval request**:
A question to the human with options, created when a policy decides a gate applies; the run waits for its decision.
_Avoid_: approval task, confirmation, ticket
