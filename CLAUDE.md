# CLAUDE.md — Tendworks

Tendworks (short: Tend) is a self-hosted, use-case-neutral agent platform: agents are started by triggers, run isolated and recoverable in sandboxes, can be controlled via web UI, chat and the `tend` CLI, and only call on the human when a policy says so. Core idea: agents run reliably while the human is away.

**Current state:** the walking skeleton is done: milestones 1 (spec: issue #1), 1b (chat path, spec: issue #24) and 1c (web UI, spec: issue #38). Milestone 2 (clean single-host deployment on Linux, spec: issue #54, ADR 0019–0021) is done and accepted (#66; release `v0.2.0`, notes: `docs/releases/v0.2.0.md`). Milestone 3 (generic platform: workspaces, triggers, notifications; spec: issue #71, ADR 0022–0025) is implemented; its acceptance on the operator's host (#82) is pending, then release `v0.3.0` (notes: `docs/releases/v0.3.0.md`). Milestone 4 (notifications as subscriptions; spec: issue #87, ADR 0026) is implemented; its acceptance on the operator's host is pending, then release `v0.4.0` (notes: `docs/releases/v0.4.0.md`).

## Commands

- `pnpm install` (pnpm via corepack: `corepack enable pnpm`)
- `pnpm check`: generate types from `contracts/`, typecheck, lint (ESLint with type-aware rules), architecture rules (dependency-cruiser), unit and view tests (`tests/web`)
- `pnpm coverage`: unit + integration tests with coverage thresholds (see `vitest.config.ts`); thresholds may only be raised, never lowered without a reason in the pull request
- Pre-commit hook: Betterleaks scans staged changes for secrets (`.githooks/`, installed by `pnpm install`; needs `betterleaks` on PATH). Known dummy values carry `betterleaks:allow` with a reason
- `pnpm e2e`: build and start the compose stack (`deploy/compose.yaml`), then run `tests/e2e` and the browser tests (`tests/browser`, Playwright; `pnpm e2e:browser` alone) against it. Needs `deploy/.env` with tokens: create it once with `scripts/setup-env.sh`, as an operator does (tests read the tokens from it)
- `pnpm --filter @tendworks/web dev`: web UI dev server at `http://localhost:5173/ui/`, proxying the API to the running stack
- `node apps/cli/dist/main.js status` after `pnpm build`: the `tend` CLI against `http://localhost:8080` (override with `--url` or `TEND_URL`)

Types in `packages/shared` are generated from `contracts/` and never committed or edited by hand. Unit tests resolve workspace packages to their TypeScript sources via the `source` export condition, so they need no build.

## Documents (read before changing anything)

| Doc | Content |
| --- | --- |
| [docs/platform-architecture.md](docs/platform-architecture.md) | domains, seams/standards, data model, event catalog, security, scaling, roadmap, decisions |
| [docs/platform-implementation.md](docs/platform-implementation.md) | tech stack, repo structure, walking skeleton components, open items |
| [docs/software-factory.md](docs/software-factory.md) | first application on Tendworks: value stream, roles, quality gates, autonomy levels |
| [docs/operator-guide.md](docs/operator-guide.md) | running Tendworks on your own Linux host: install, configuration, secrets, access, known gaps, operations |
| [docs/sandbox-images.md](docs/sandbox-images.md) | building sandbox images with your own tooling on top of the Tendworks images (example: Flutter/Dart) |

Architecture decisions go to `docs/adr/` as Markdown ADRs. When a decision changes, update the docs in the same change.

## Non-negotiable principles

- **Platform stays generic.** Nothing application-specific (e.g. software factory) goes into platform code; it is configuration in `tendworks-config`.
- **A domain owns its data.** No shared tables, no cross-domain imports. Access only via published API or events.
- **Every boundary is a contract.** Sync: OpenAPI 3.1 + JSON Schema. Async: CloudEvents (AsyncAPI 3). Agent boundary: A2A task model. Harness: ACP. Tools: MCP.
- **Contract-first.** Change `contracts/` first, in the same PR as the services. Contract tests on both sides.
- **Ports and adapters.** Products (Temporal, Postgres, Docker, Claude, NATS …) only behind adapters. Product names never appear in contracts or event types. The one exception is an adapter selector in configuration (e.g. `harness: claude-code`, trigger kind `github-issues`, `integration: pushover`), listed with a reason in `tests/architecture/product-names.ts` (ADR 0013, 0023, 0025); event schemas never have one.
- **Every port has ≥ 2 implementations** (the second may be a fake used in tests).
- **UI and CLI are just clients** of the public control plane API. No private endpoints, no CLI-only endpoints.
- **Everything declarative and human-readable.** Config as YAML with `apiVersion/kind/metadata/spec` envelope (agent profiles: Markdown + frontmatter, skills: `SKILL.md`, policies: Rego + tests). Runtime state must be exportable (`-o yaml|json`).
- **Agents are untrusted.** No real secrets in sandboxes (target: egress proxy injection), egress allowlist, external actions via Action Gateway with action journal; unclassified tools count as irreversible.

## Tech stack

- TypeScript throughout, Node.js LTS
- pnpm workspaces monorepo; one package per domain, cross-imports blocked by lint rule (e.g. dependency-cruiser)
- Temporal (dev mode locally) + own Serverless Workflow 1.0 interpreter (subset: do, call, listen, switch, raise, for, try, wait)
- Postgres for state, Temporal and event bus (outbox + LISTEN/NOTIFY); NATS optional later
- Sandbox: own small sandbox API modeled on OpenSandbox; first backend Docker with isolation class `container` by default, `gvisor` as operator opt-in (ADR 0001)
- `tend` CLI on a client generated from the OpenAPI contract (commander)
- Deployment: Docker Compose (`deploy/compose.yaml`, profiles), Kubernetes later

## Planned repo layout

```text
contracts/   openapi/, events/ (CloudEvent JSON Schemas), schemas/ (per kind)
packages/    control-plane, trigger-gateway, orchestration, agent-runtime, sandbox,
             human-interaction, event-bus, mcp-platform, shared (generated types only),
             health, platform (platform libraries, not domains)
apps/        server, worker, web, cli   (bundles only, no domain logic)
images/      sandbox-claude-code
deploy/      compose.yaml, profiles/
tests/       contract/, e2e/
docs/adr/
```

Domain logic lives in `packages/`; `apps/` only wire packages together.

## Conventions

- **Language: always English** for code, comments, commit messages, docs, ADRs, issues and PRs — even when the conversation with the user is in German.
- Events: CloudEvents with prefix `dev.tendworks.`, extension attributes `runid`, `stepid` and W3C `traceparent`; chat events carry no `runid`/`stepid` and name the chat in `subject` (`chats/<id>`)
- TDD where it pays off: interpreter, policies, adapters, action journal — not dogmatically everywhere
- Pin external versions (harnesses, skills); updates via PR
- Dev skills: Matt Pocock's skills (`grill-me`, `tdd`); setup info lives in `docs/agents/`

## Walking skeleton

1. **Milestone 1 – automated:** GitHub issue labeled `ready-for-agent` (playground repo) → time trigger → workflow → `developer` agent (Claude Code via ACP in a sandbox) → the agent opens a PR and reports it as an artifact → notification. Restarting the platform mid-run must resume the run. Clients: API and `tend` only.
2. **Milestone 1b – chat path:** a chat (API and `tend chat`) starts an agent session without a run (workspace only, no push/PR), with a read-only MCP server on the control plane API (`list_runs`, `get_run`, `list_triggers`, `list_agents`; later `get_run_transcript`); agent output followed live (ADR 0015–0017).
3. **Milestone 1c – web UI:** React + Vite SPA under `/ui/` of the server, signed in with an API token until OIDC (ADR 0018): status, runs with live transcripts, approvals, notifications, chats; localhost only.

After the skeleton, **milestone 2 – clean single-host deployment on Linux** (Ubuntu 24.04, Docker Engine): tagged releases, no default tokens, restart policies, versioned schema migrations per domain, backup and restore scripts, sandboxes named per installation with orphan clean-up, the platform MCP server through an MCP-only gateway (ADR 0019), remote access only through a TLS layer in front of localhost (ADR 0020). The operator guide (`docs/operator-guide.md`) covers its whole lifecycle; each release gets notes in `docs/releases/<tag>.md` naming migrations and configuration changes.

Then **milestone 3 – generic platform**: workspaces declared once by name (`git` on any host with their own credential, or `directory` under operator-allowed roots; ADR 0022), trigger bindings that start a workflow per workspace from pluggable trigger sources (`schedule`, `github-issues`; ADR 0023), no pull request integration in the platform — agents report pull requests as artifacts, a generic human step waits where needed (ADR 0024) — and notification channels with Pushover (ADR 0025); a platform assistant plus optional read-only workspace assistants. Nothing is in production: no migrations, docs describe the target state only; `v0.3.0` needs a fresh installation.

Then **milestone 4 – notifications as subscriptions** (ADR 0026): a notification channel only says how someone is reached; subscriptions send events of a workspace or of the platform (run started, completed, failed, approval requested, platform degraded, recovered) to channels with a priority; the control plane monitors platform health, and an optional heartbeat URL lets an external monitor alarm when the platform is down. `v0.4.0` needs a fresh installation.

Build order (slices S0–S5) and skeleton rules: [docs/platform-implementation.md](docs/platform-implementation.md#walking-skeleton-build-order-milestone-1).

Not in the skeleton: Keycloak, NATS, S3, model gateway, OPA, observability, Action Gateway.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `mtiews/tendworks` (via `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

`needs-triage`, `needs-info`, `specified` (the skills' `ready-for-agent` role), `ready-for-human`, `wontfix`. The literal `ready-for-agent` label is the agent trigger; only the handover rule sets it. See `docs/agents/triage-labels.md`.

### Agent workflow

Specs are worked by Tendworks itself: `/handover <spec>` queues the first ticket, the trigger runs `/implement-issue <ticket>` in a sandbox, and each run hands over the next ticket on the spec's branch and pull request. See `docs/agents/agent-workflow.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
