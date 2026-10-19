# Tendworks – Implementation

This document describes the concrete technical implementation. Concepts, domains and contracts are covered in "Tendworks – Platform Architecture"; what the software factory is meant to do is in "Software Factory on Tendworks". This document covers only technology, code structure and operations.

**Name:** Tendworks (short: Tend) is the platform; domain `tendworks.dev`, `tendai.dev` redirects. The command line is called `tend` (e.g. `tend status`, `tend run list`). The software factory is an application on Tendworks and lives as configuration in its own repo, not in the platform code.

## Technology decisions

| Topic | Decision | Rationale |
| --- | --- | --- |
| Language | TypeScript throughout (Node.js LTS), TypeScript 6 for now | one language for services, UI and adapters; official SDKs for Temporal, A2A and MCP; ACP adapter for Claude Code is written in TypeScript; TypeScript 7 (native compiler) has no stable JS API yet, which code generators such as openapi-typescript need |
| Contracts in code | OpenAPI types generated with openapi-typescript into `packages/shared`, client via openapi-fetch, HTTP server on Hono | generated types keep server and clients on the contract; Hono serves a plain fetch handler, so the API can be tested in-process |
| Tests | Vitest; unit tests per package, end-to-end tests against the compose stack in `tests/e2e` | one runner for both levels |
| Repos | monorepo `tendworks` for code and contracts, separate repo `tendworks-config` for configuration | contracts change in the same pull request as the services; configuration has its own approvals |
| Package management | pnpm workspaces | fast, clean monorepo without an extra build system |
| Boundaries in code | one package per domain, cross-imports forbidden by lint rule (e.g. dependency-cruiser) | domain separation is checked automatically |
| Other languages | via spike behind the same interfaces | either side stays replaceable |
| CLI | tend in TypeScript on an API client generated from the OpenAPI contract; framework commander | same language as the rest; the generated client keeps the CLI from drifting away from the API; later shippable as a single binary; commander over oclif because plugins and auto-update are not needed |
| Harness adapter | Claude Code via `@agentclientprotocol/claude-agent-acp` (stdio), client side `@agentclientprotocol/sdk`; exact versions pinned | official ACP adapter; the ACP session id equals the Claude Code session id, so `session/resume` restores a session as long as the Claude config directory and the workspace survive on a volume; the adapter must run as non-root |

**Development approach:** Contract-first – contracts (OpenAPI, JSON Schema, event types) are written before the implementation, contract tests check each side. Test-driven development where it makes sense (interpreter, policies, adapters, action journal), not dogmatically for all code.

**Agent skills for development:** The `tendworks` repo uses Matt Pocock's skills ([mattpocock/skills](https://github.com/mattpocock/skills)).

- **Setup:** run `setup-matt-pocock-skills` once; issue tracker (GitHub), triage labels (including `ready-for-agent`) and the location of the domain docs are stored as Markdown under `docs/agents/`.
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
    sandbox/                 # sandbox API, backend Docker (runc, optionally gVisor)
    human-interaction/       # approvals, notifications
    event-bus/               # port + Postgres implementation
    mcp-platform/            # read-only MCP server on the control plane API
    shared/                  # only types generated from contracts/
    health/                  # platform library, not a domain: health probes and the runtime health API
  apps/
    server/                  # walking skeleton: bundles control-plane, trigger-gateway, human-interaction
    worker/                  # walking skeleton: bundles orchestration, agent-runtime (mcp-platform from milestone 1b)
    web/                     # web UI: run list, chat
    cli/                     # tend CLI on the generated API client
  images/
    sandbox-claude-code/     # Dockerfile: Claude Code + ACP adapter
  deploy/
    compose.yaml
    .env.example             # laptop profile settings and secrets, copied to deploy/.env
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
| `sandbox-claude-code` | sandbox image, started via Docker (isolation class `container`, `gvisor` opt-in) | yes |
| Keycloak, NATS, S3, model gateway, OPA, observability |  | later; transcripts and checkpoints on a local volume, merge policy as a switch |
| tend CLI | second client on the same API | yes, minimal: tend status, tend run list/get, tend trigger list, tend notification list, tend approval list/approve; tend chat in milestone 1b |
| Docker socket proxy | the only way the sandbox adapter reaches the Docker API; exposes only `/_ping`, `/version`, `/containers` and `/exec` (writes allowed), not images, so sandbox images must already be on the host. It filters paths, not request bodies: whoever reaches it can still create a privileged container, so only the worker may reach it | yes |
| web UI | run list, run detail, notifications, chat | milestone 1b |

## Walking skeleton: build order (milestone 1)

Every slice ends with a working `docker compose up`. Configuration lives in `examples/config/` in this repo, which the control plane reads as a folder; the separate `tendworks-config` repo follows later.

| # | Slice | Proves |
| --- | --- | --- |
| S0 | Scaffold: pnpm workspaces, dependency-cruiser rules, Compose with Postgres and Temporal (dev mode), empty `server` and `worker`, `tend status` | repo structure, domain boundaries |
| S1 | `POST /runs` → minimal workflow interpreter (`do`, `call`) → A2A task → fake agent; `tend run list/get`; restart test for the workflow; durable agent tasks resumed after a restart (ADR 0004) | control plane contract, interpreter, A2A seam, generated client, durable execution |
| S2 | Fake agent replaced by Claude Code via ACP in a `container` sandbox (through the socket proxy); transcript and cost on a local volume; resume via `session/resume`; restart test for the agent session | sandbox API, ACP, agent runtime |
| S3 | Time trigger plus GitHub polling for `ready-for-agent` in the playground repo | trigger gateway, TriggerBinding, integration port |
| S4 | Pull request by the agent, merge as a workflow step behind `merge: auto \| ask`, event bus (Postgres outbox) with its first consumer, persisted notifications and approval requests, fake notification adapter | event bus, human interaction, milestone 1 success criterion |
| S5 | Hardening: contract tests, `gvisor` verified once on a Linux host | fitness functions, isolation opt-in |

Rules for the skeleton:

- **Fakes first.** Each seam gets its fake before its real adapter; the fake stays as the second implementation of the port.
- **Contracts only as far as used.** OpenAPI and JSON Schemas cover only what the current slice uses; types are always generated from them, never written by hand. Contract tests follow in S5.
- **Interpreter grows with demand.** `listen` and `switch` are added when the merge gate needs them, test-driven.
- **Event bus with its first consumer.** Until S4 the control plane reads runs synchronously through the orchestration API (`contracts/openapi/orchestration.yaml`, served by the worker); run and step events wait in orchestration's outbox (ADR 0003).
- **Resume is tested from S1 on**, not at the end.

## Open items

- [x] Define the build order of the walking skeleton
- [x] Write the concrete `compose.yaml`
- [ ] Example configuration for the existing issue agent (trigger, profile, skills, sandbox template)
- [x] Check which ACP adapter is used for Claude Code and how sessions are resumed
- [ ] Create the playground repository and its fine-grained token
- [ ] Design review for milestone 1b (chat session model) once S2 works
