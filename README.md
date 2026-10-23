# Tendworks

Tendworks (short: Tend) is a self-hosted, use-case-neutral agent platform. Agents are started by triggers and run isolated and recoverable in sandboxes. You control them through the web UI, chat and the `tend` CLI, and they only call on you when a policy says so. The core idea: agents run reliably while you are away.

## Current state

The walking skeleton is done up to milestone 1c, and milestone 2 is implemented (acceptance on Ubuntu pending, then the first release `v0.2.0`):

| Milestone | What works |
| --- | --- |
| 1: automated path | GitHub issue labelled `ready-for-agent` → time trigger → workflow → `developer` agent (Claude Code via ACP in a Docker sandbox) → pull request → merge behind a policy gate (`auto` or `ask`) → notification; runs resume after a platform restart |
| 1b: chat path | chats with an agent through the API and `tend chat`, with a read-only MCP server on the platform for chat agents |
| 1c: web UI | single-page app under `/ui/`: status, runs with live transcripts, approvals, notifications, chats; localhost only, signed in with an API token |
| 2: single-host deployment on Linux | install from a release tag on Ubuntu 24.04 with Docker Engine: no default tokens, restart after reboot, schema migrations, backup and restore scripts, sandboxes per installation with orphan clean-up, the platform MCP server through an MCP-only gateway, access from your devices through a TLS layer such as Tailscale ([release notes](docs/releases/v0.2.0.md)) |

There is no identity (OIDC), no TLS inside the platform, no egress control and no Action Gateway yet. The stack is meant for one operator on one host.

## Documentation

| Document | For |
| --- | --- |
| [docs/operator-guide.md](docs/operator-guide.md) | installing, running and updating Tendworks on your own Linux host: install from a tag, secrets, access from your devices, backup and restore, troubleshooting, acceptance checklist |
| [docs/releases/](docs/releases/) | release notes per tag: migrations, configuration changes, update steps |
| [docs/platform-architecture.md](docs/platform-architecture.md) | domains, seams and standards, data model, security, roadmap |
| [docs/platform-implementation.md](docs/platform-implementation.md) | tech stack, repo structure, walking skeleton, smoke tests, open items |
| [docs/software-factory.md](docs/software-factory.md) | the first application on Tendworks |
| [docs/adr/](docs/adr/) | architecture decisions |
| [GLOSSARY.md](GLOSSARY.md) | domain language |

## Development

Needs Node.js 24 and pnpm (`corepack enable pnpm`).

| Command | Does |
| --- | --- |
| `pnpm install` | installs dependencies and points git at the pre-commit hook (needs `betterleaks` on `PATH`) |
| `pnpm check` | generates types from `contracts/`, typechecks, lints, checks architecture rules, runs unit and view tests |
| `pnpm coverage` | unit and integration tests with coverage thresholds |
| `pnpm build` | builds all packages, the `tend` CLI and the web UI |
| `pnpm e2e` | builds and starts the compose stack, then runs the end-to-end tests (API and browser) against it; needs `deploy/.env` from `scripts/setup-env.sh` |
| `node apps/cli/dist/main.js status` | the `tend` CLI against `http://localhost:8080` (after `pnpm build`) |

Contribution rules (contract-first, ports and adapters, no cross-domain imports) are in [CLAUDE.md](CLAUDE.md).

## License

[Apache License 2.0](LICENSE)
