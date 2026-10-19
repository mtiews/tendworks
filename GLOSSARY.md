# Tendworks

Self-hosted, use-case-neutral agent platform: agents are started by triggers, run isolated and recoverable in sandboxes, and only call on the human when a policy says so.

## Language

### Execution

**Task**:
A unit of work the orchestration hands to an agent, following the A2A task model.
_Avoid_: job; also never use it for something a human has to do (that is an approval request or a notification)

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
A declarative rule (`kind: Policy`) that decides whether a gated action, such as merging a pull request, is performed right away (`allow`) or only after an approval request (`ask`).
_Avoid_: rule, gate setting, permission

**Approval request**:
A question to the human with options, created when a policy decides a gate applies; the run waits for its decision.
_Avoid_: approval task, confirmation, ticket
