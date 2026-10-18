# Tendworks – Implementation

This document describes the concrete technical implementation. Concepts, domains and contracts are covered in "Tendworks – Platform Architecture"; what the software factory is meant to do is in "Software Factory on Tendworks". This document covers only technology, code structure and operations.

**Name:** Tendworks (short: Tend) is the platform; domain `tendworks.dev`, `tendai.dev` redirects. The command line is called `tend` (e.g. `tend status`, `tend run list`). The software factory is an application on Tendworks and lives as configuration in its own repo, not in the platform code.

## Technology decisions

| Topic | Decision | Rationale |
| --- | --- | --- |
| Language | TypeScript throughout (Node.js LTS) | one language for services, UI and adapters; official SDKs for Temporal, A2A and MCP; ACP adapter for Claude Code is written in TypeScript |
| Repos | monorepo `tendworks` for code and contracts, separate repo `tendworks-config` for configuration | contracts change in the same pull request as the services; configuration has its own approvals |
| Package management | pnpm workspaces | fast, clean monorepo without an extra build system |
| Boundaries in code | one package per domain, cross-imports forbidden by lint rule (e.g. dependency-cruiser) | domain separation is checked automatically |
| Other languages | via spike behind the same interfaces | either side stays replaceable |
| CLI | tend in TypeScript on an API client generated from the OpenAPI contract; framework e.g. oclif or commander, to be decided | same language as the rest; the generated client keeps the CLI from drifting away from the API; later shippable as a single binary |

**Development approach:** Contract-first – contracts (OpenAPI, JSON Schema, event types) are written before the implementation, contract tests check each side. Test-driven development where it makes sense (interpreter, policies, adapters, action journal), not dogmatically for all code.

**Agent skills for development:** The `tendworks` repo uses Matt Pocock's skills ([mattpocock/skills](https://github.com/mattpocock/skills)).

- **Setup:** run `setup-matt-pocock-skills` once; issue tracker (GitHub), triage labels (including "Ready for Agent") and the location of the domain docs are stored as Markdown under `docs/agents/`.
- **grill-me:** challenge a task before implementing it; a small-scale version of the factory's requirement validation.
- **tdd:** enforces red-green-refactor; the repo defines which packages it applies to (e.g. interpreter, policies, adapters, action journal), so TDD is not applied dogmatically to all code.
- **Versioning:** skills pinned to a fixed version, updates deliberately via pull request.
- **Dogfooding:** the existing issue agent can already contribute to the platform itself using these skills.

## Repo structure `tendworks` (first draft)

```text
tendworks/
  contracts/                 # contracts, language-neutral
    openapi/control-plane.yaml
    openapi/sandbox.yaml
    events/                  # CloudEvent types as JSON Schema
    schemas/                 # JSON Schemas per kind (Workflow, AgentProfile, ...)
  packages/
    control-plane/           # API, reads configuration from Git or a folder
    trigger-gateway/         # time triggers, webhooks later
    orchestration/           # Serverless Workflow interpreter on Temporal
    agent-runtime/           # A2A task model, ACP adapter, action journal
    sandbox/                 # sandbox API, backend Docker + gVisor
    human-interaction/       # approvals, notifications
    event-bus/               # port + Postgres implementation
    mcp-platform/            # read-only MCP server on the control plane API
    shared/                  # only types generated from contracts/
  apps/
    server/                  # walking skeleton: bundles control-plane, trigger-gateway, human-interaction
    worker/                  # walking skeleton: bundles orchestration, agent-runtime, mcp-platform
    web/                     # web UI: run list, chat
    cli/                     # tend CLI on the generated API client
  images/
    sandbox-claude-code/     # Dockerfile: Claude Code + ACP adapter
  deploy/
    compose.yaml
    profiles/laptop.env
  tests/
    contract/
    e2e/
  docs/adr/
```

Packages under `packages/` map to the domains; apps under `apps/` are only bundles for operations and can be split later without moving code.

## Minimal walking skeleton: components

| Component | Role | In the walking skeleton |
| --- | --- | --- |
| Postgres | state, events, database for Temporal | yes |
| Temporal (dev mode) | durable execution of runs | yes |
| `server` | control plane API, web UI, time trigger | yes |
| `worker` | workflow interpreter, agent runtime with ACP, MCP server for the chat | yes |
| `sandbox-claude-code` | sandbox image, started via Docker with gVisor | yes |
| Keycloak, NATS, S3, model gateway, OPA, observability |  | later; transcripts and checkpoints on a local volume, merge policy as a switch |
| tend CLI | second client on the same API | yes, minimal: tend status, tend run list/get, tend trigger list, tend chat |

## Open items

- [ ] Define the build order of the walking skeleton
- [ ] Write the concrete `compose.yaml`
- [ ] Example configuration for the existing issue agent (trigger, profile, skills, sandbox template)
- [ ] Check which ACP adapter is used for Claude Code and how sessions are resumed
