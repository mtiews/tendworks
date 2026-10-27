# Tendworks – Status and milestones

What works today, milestone by milestone, and what does not exist yet. The design of each milestone is in its spec issue and the ADRs it names; how to install and run a release is in the [operator guide](operator-guide.md); what changed per release is in [releases/](releases/).

## Milestones

| Milestone | State | What works |
| --- | --- | --- |
| 1: automated path (spec #1) | done | GitHub issue labelled `ready-for-agent` → time trigger → workflow → `developer` agent (Claude Code via ACP in a Docker sandbox) → the agent opens a pull request and reports it, the run ends with it → notification; runs resume after a platform restart |
| 1b: chat path (spec #24) | done | chats with an agent through the API and `tend chat`, with a read-only MCP server on the platform for chat agents |
| 1c: web UI (spec #38) | done | single-page app under `/ui/`: status, runs with live transcripts, approvals, notifications, chats; localhost only, signed in with an API token |
| 2: single-host deployment on Linux (spec #54) | released as `v0.2.0` ([notes](releases/v0.2.0.md)) | install from a release tag on Ubuntu 24.04 with Docker Engine: no default tokens, restart after reboot, schema migrations, backup and restore scripts, sandboxes per installation with orphan clean-up, the platform MCP server through an MCP-only gateway, access from your devices through a TLS layer such as Tailscale |
| 3: generic platform (spec #71) | implemented, acceptance pending (#82), then `v0.3.0` ([notes](releases/v0.3.0.md)) | workspaces declared once by name (a git repository on any host with its own agent token, or a host directory under an allowed root); trigger bindings that start a workflow per workspace on a schedule or for labelled GitHub issues; agents open pull requests and report them as artifacts, the platform merges nothing; a human step with custom answers and policies; notifications to your phone through Pushover with a tap to the pull request; the platform assistant and read-only workspace assistants (`tend chat --workspace <name>`) |
| 4: notifications as subscriptions (spec #87) | implemented, acceptance pending, then `v0.4.0` ([notes](releases/v0.4.0.md)) | notification channels only say how you are reached; subscriptions send a workspace's or the platform's events (run started, completed, failed, approval requested, platform degraded, recovered) to them with a priority; a heartbeat URL lets an external monitor alarm when the platform is down |
| Workflows started by hand (spec #130) | in progress, `v0.5.0` ([draft notes](releases/v0.5.0.md)) | trigger bindings of kind `manual` that start a workflow only when you fire them (`tend trigger fire`, Start in the web UI), and a fixed `spec.input` per binding |

## Not there yet

These are part of the [target architecture](platform-architecture.md) but do not exist yet. The stack is meant for one operator on one host.

| Capability | Today |
| --- | --- |
| Identity (OIDC) | one API token and one read-only token, shared by all clients (ADR 0014) |
| TLS inside the platform | the platform listens on localhost; remote access goes through a TLS layer in front of it (ADR 0020) |
| Secrets via egress proxy | the sandbox holds the workspace's narrowly scoped agent token and the harness credential |
| Egress allowlist | sandboxes can reach any destination |
| Action Gateway with action journal | agents act directly with their workspace credential |
| Policy engine (OPA) | policies of the human step are declarative rules evaluated by the platform itself |
| Evidence bundles, override metrics | not built; the run's artifacts carry the result |
| Further harnesses (Codex, Gemini CLI, …) | Claude Code only, behind the harness port |
| `gvisor` isolation class | available, not verified yet (issue #17) |

The known gaps of the current installation (test coverage, retention, background work of agents, forges) are listed in the [operator guide](operator-guide.md#known-gaps).
