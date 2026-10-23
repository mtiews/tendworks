# Tendworks – Operator Guide

How to run the current state of Tendworks (walking skeleton milestones 1, 1b and 1c) on your own Linux machine and try it with real workloads. Written for Ubuntu 24.04 LTS with Docker Engine from Docker's apt repository; other Linux distributions with Docker Engine should behave the same, Docker Desktop differs where noted.

The stack is the laptop profile (`deploy/compose.yaml`): one operator, one machine, no identity, no TLS, no egress control. Treat it as a test installation.

## Contents

- [What runs](#what-runs)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [Configuration](#configuration)
- [Secrets](#secrets)
- [Access](#access)
- [Known gaps on Linux](#known-gaps-on-linux)
- [First test workloads](#first-test-workloads)
- [Operations](#operations)
- [Troubleshooting](#troubleshooting)

## What runs

| Service | Role | Published |
| --- | --- | --- |
| `postgres` | state of all domains, event bus | no |
| `temporal` | durable execution engine in dev mode, without its web UI | no |
| `temporal-ui` | the engine's web UI, only with `--profile debug` (no login) | `127.0.0.1:8233` (`TEND_ENGINE_UI_PORT`) |
| `docker-proxy` | the worker's only way to the Docker API, restricted by path (ADR 0001) | no, internal network |
| `server` | control plane API, trigger gateway, human interaction, platform MCP server (`/mcp`), web UI (`/ui/`) | `127.0.0.1:8080` (`TEND_PORT`) |
| `worker` | workflow interpreter, agent runtime; creates sandboxes through the socket proxy | no |
| `mcp-gateway` | MCP-only gateway: forwards `/mcp` to the server and refuses every other path; sandboxes of profiles with `mcp: [tendworks]` reach it on the internal network `<installation>_platform-mcp` (ADR 0019) | no |
| sandboxes | one container per agent session (`<installation>-sandbox-<id>`), created by the worker, on the Docker network `<installation>-sandboxes`; the installation is the compose project name, `tendworks` by default | no |

Sandbox images are never pulled by the platform; you build them once (see [Install](#install)).

Every long-running service has the restart policy `unless-stopped`: it comes back after a crash and after a host reboot (as long as the Docker service starts at boot), unless you stopped it yourself.

## Prerequisites

| What | Why | Notes |
| --- | --- | --- |
| Docker Engine with the compose plugin | runs the whole stack; images build inside Docker (`deploy/Dockerfile` runs `pnpm install` and `pnpm build` itself) | rootful Docker: the socket proxy mounts `/var/run/docker.sock` (`deploy/compose.yaml`). Rootless Docker is not covered by the compose file |
| git | clone the repo | |
| curl | start runs, check `/status` | |
| Node.js 24 and pnpm | only on the host for the `tend` CLI and the smoke test scripts (they call `node`); the stack itself does not need them | `package.json` requires Node ≥ 24 and pins pnpm via `packageManager`; enable it with `corepack enable pnpm` (may need `sudo` with a system-wide Node). Ubuntu's own `nodejs` package is older than 24, so install Node 24 another way |
| GitHub CLI `gh`, logged in | only for the pull request and chat smoke scripts | |
| A GitHub repository to work on | the automated path targets a playground repository | the example binding uses `mtiews/tendworks-playground` |
| Claude Code credential | the `developer` and `assistant` agents run Claude Code | see [Secrets](#secrets) |

**The `docker` group.** Adding your user to `docker` (`sudo usermod -aG docker $USER`, then log in again) lets you run the commands below without `sudo`. Membership is equivalent to root on the host: any member can start a privileged container, read every volume (Postgres data, transcripts, agent workspaces) and read the secrets in the server's and worker's environment with `docker inspect`. Only put the operator in that group.

**Hardware.** The docs give no measured numbers for the laptop profile; how much RAM the core needs without agents is still to be measured (`docs/platform-architecture.md`, scaling). What is fixed:

- Each Claude Code sandbox is limited to 2 CPUs and 4096 MB RAM (`examples/config/sandboxes/claude-code.yaml`); plan for that per concurrent agent session on top of the stack.
- The server and worker images are about 0.9 GB each (issue #48); add the sandbox image and Postgres/Temporal.
- The architecture's rule of thumb for a later two-VM setup (control plane 4 vCPU / 16 GB, worker 8 vCPU / 32 GB for a handful of parallel agents) is a target, not a requirement for this profile.

## Install

All commands run from the repository root; `deploy/.env` is picked up automatically because compose uses `deploy/` as its project directory.

1. **Clone**

   ```sh
   git clone https://github.com/mtiews/tendworks.git
   cd tendworks
   ```

2. **Create `deploy/.env`**

   ```sh
   scripts/setup-env.sh
   ```

   It copies `deploy/.env.example` to `deploy/.env`, fills in a random `TEND_API_TOKEN` and a different random `TEND_API_READ_TOKEN`, makes the file readable by you only (mode 600) and refuses to overwrite an existing `deploy/.env`. It never prints the tokens. Fill in the rest as described in [Secrets](#secrets): at least `TEND_POSTGRES_PASSWORD` (`openssl rand -hex 32`) and a Claude Code credential. There are no default tokens: the server refuses to start without both and names the variable to set.

3. **Build the sandbox image** (the platform never pulls it)

   ```sh
   docker compose -f deploy/compose.yaml --profile sandbox-images build
   ```

   This builds `tendworks/sandbox-claude-code` with the tag pinned in `deploy/compose.yaml` (`x-sandbox-images`; Claude Code, its ACP adapter, git and `gh`). Sandbox templates name it by repository alone (`image: tendworks/sandbox-claude-code`); the worker fills in the pin.

4. **Build and start the stack**

   ```sh
   docker compose -f deploy/compose.yaml up -d --build --wait
   ```

   `--wait` returns when Postgres, Temporal, worker and server report healthy.

5. **Build the `tend` CLI on the host** (optional, but the smoke tests and this guide use it)

   ```sh
   corepack enable pnpm
   pnpm install
   pnpm build
   alias tend='node "$PWD/apps/cli/dist/main.js"'
   export TEND_API_TOKEN=<the value from deploy/.env>
   ```

   `pnpm install` also sets `core.hooksPath` to `.githooks`; the pre-commit hook needs `betterleaks` only if you commit.

6. **Verify**

   | Check | Expected |
   | --- | --- |
   | `curl -s http://localhost:8080/status` | a status document; HTTP 200 when healthy, 503 with the failing component otherwise. The only endpoint without a token |
   | `tend status` | `PLATFORM healthy`, `ACCESS full`, a table of components |
   | `tend agent list`, `tend trigger list` | the profiles and trigger bindings of your configuration |
   | `http://localhost:8080/` in a browser (see [Access](#access)) | redirects to `/ui/` and asks for a token; the API token signs in with full access |

The starter configuration starts no run by itself: its only trigger binding (`playground-ready-for-agent`) is suspended.

## Configuration

Two places, strictly separated:

| | `deploy/.env` | configuration directory |
| --- | --- | --- |
| Holds | secrets, ports, the path of the configuration directory | workflows, agent profiles, trigger bindings, policies, sandbox templates, skills, integrations |
| In Git | never (`.gitignore`, `.dockerignore`) | yes, it is meant to be versioned |
| Read by | compose, into the environment of the services | server and worker at startup, mounted read-only at `/config` |
| Apply a change | `docker compose -f deploy/compose.yaml up -d --wait` (recreates services whose environment changed; `restart` keeps the old environment) | `docker compose -f deploy/compose.yaml restart server worker` |

### Settings in `deploy/.env` besides secrets

`deploy/.env.example` lists every variable `deploy/compose.yaml` reads; those with a default appear commented out (`# TEND_PORT=8080`). Besides the secrets:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TEND_CONFIG_PATH` | `../examples/config` (the starter configuration) | configuration directory on the host; relative paths resolve against `deploy/`, so prefer an absolute path |
| `TEND_PORT` | `8080` | API, UI and MCP port, published on `127.0.0.1` only |
| `TEND_ENGINE_UI_PORT` | `8233` | Temporal's web UI, published on `127.0.0.1` only and only with `--profile debug` |
| `COMPOSE_PROJECT_NAME` | `tendworks` | the installation name; only for parallel stacks. Volume, image, sandbox, session volume and sandbox network names follow it |
| `TEND_PLATFORM_MCP_URL` | `http://mcp-gateway:8080/mcp` | where sandboxes of profiles with `mcp: [tendworks]` reach the platform MCP server: the MCP-only gateway, on Linux and Docker Desktop alike. Leave it empty unless you put your own proxy in the gateway's place |
| `ANTHROPIC_BASE_URL` | empty | optional alternative model endpoint for Claude Code |

### Your own configuration directory

`examples/config` is the starter configuration: the `developer` and `assistant` agents, the `claude-code` sandbox, the workflows `develop-issue`, `hello-developer` and `restart-developer`, the suspended binding `playground-ready-for-agent`, the GitHub pull request integration and two policies (`ask-before-merge` asks before merging `develop-issue`'s pull requests). It holds no fakes; the test fixtures live in `tests/fixtures/config`. Copy it into a repository of your own (the planned `tendworks-config`) and point `TEND_CONFIG_PATH` at the checkout:

```sh
cp -r examples/config ~/tendworks-config      # then git init, commit, push to a private repo
echo "TEND_CONFIG_PATH=$HOME/tendworks-config" >> deploy/.env
docker compose -f deploy/compose.yaml up -d --wait
```

The chat and web UI smoke tests need the scripted test workflow `restart-scripted` from the fixture configuration; see `scripts/smoke/chat-assistant.sh`.

Rules the loader enforces:

- Every `*.yaml`, `*.yml` and `*.md` file below the directory is read, recursively; hidden files and directories (`.git`, `.github`) are skipped, so your configuration repository can carry its own CI. Each YAML file must be a workflow (has `document`) or a known `kind`; anything else stops the server (`neither a workflow nor a document with a kind`).
- `.md` files count only under `agents/`; other Markdown (e.g. `skills/README.md`, `SKILL.md`) is not configuration.
- Names are unique per kind; invalid configuration stops server or worker before they accept requests, with every issue in the log.
- Server and worker run as user `node` (uid 1000 in the Node.js image); the files must be readable by it.
- Secrets never go here, only references ([Secrets](#secrets)).

### Kinds and what you typically change

| Kind | Where | Typical changes | Read by |
| --- | --- | --- | --- |
| Workflow (Serverless Workflow 1.0 subset) | `workflows/*.sw.yaml` | `develop-issue`: the prompt text; new workflows calling `agent://<profile>` | server |
| `AgentProfile` (Markdown with frontmatter; the body is the role description) | `agents/*.md` | `spec.chat.idleMinutes` (1–1440, default 5): how long an idle chat keeps its sandbox; `spec.env` secret references; `spec.skills`; `spec.mcp: [tendworks]`; `spec.attribution: false` | server and worker |
| `TriggerBinding` | `triggers/*.yaml` | `spec.suspend: true/false`; `spec.schedule.every` (`days`, `hours`, `minutes`, `seconds`); `spec.source.issues.repository` (`<owner>/<name>`), `labels`, `state`; `spec.workflow` | server |
| `Policy` | `policies/*.yaml` | `spec.merge: auto \| ask`; `spec.workflows` (omitted: applies to all). The strictest applicable policy wins: the starter's `ask-before-merge` lists `develop-issue`, so you approve every merge yourself; remove it there to let `merge-gate` merge automatically | server |
| `SandboxTemplate` | `sandboxes/*.yaml` | `spec.image` (the deployment's own images by repository alone, the worker fills in the pin from `deploy/compose.yaml`; other images with an exact tag or digest), `spec.isolationClass: container \| gvisor`, `spec.resources.cpus`, `memoryMb` | worker (server validates) |
| Skills | `skills/<name>/SKILL.md` plus files | pinned by copying; profiles list them in `spec.skills` | worker |
| `PullRequestIntegration` | `integrations/pull-requests/*.yaml` | one per host; `github` on `github.com` with the platform token | server |

**Target repository.** The example targets `mtiews/tendworks-playground`. To use your own repository, change `spec.source.issues.repository` in `triggers/playground-ready-for-agent.yaml` and scope both GitHub tokens to that repository. The workflow derives the clone URL from the issue (`https://github.com/<repository>.git`). The smoke scripts take `TEND_PLAYGROUND=<owner>/<name>`.

**Restarts.** `docker compose -f deploy/compose.yaml restart server worker` after any change to the configuration directory is always enough (after a change to `deploy/.env`, use `up -d --wait` instead: `restart` keeps the old environment); running runs resume after a restart (that is the milestone 1 success criterion), and open chats are taken up again by the worker.

## Secrets

All secrets live in `deploy/.env` and reach the services as environment variables through `deploy/compose.yaml`. Configuration only references them (ADR 0008).

### Inventory

| Secret | Purpose | Held by | Minimal scope | Generate | If it leaks |
| --- | --- | --- | --- | --- | --- |
| `TEND_API_TOKEN` | full access to the control plane API: start runs, merge, decide approvals, chat; every read except `GET /status` | server, worker (for workflow `call: http` to the API), you (`tend`, UI, scripts). Never a sandbox | one shared token, no scopes (ADR 0014) | `openssl rand -hex 32`; at least 16 characters | anyone who reaches the port can do everything you can, including approving merges |
| `TEND_API_READ_TOKEN` | read-only API access (403 on writes); the platform MCP server reads with it | server, worker, and the Claude Code session of profiles with `mcp: [tendworks]` (as an MCP header, not as an environment variable); optionally you for a read-only UI | read only; must differ from `TEND_API_TOKEN` | `openssl rand -hex 32`; at least 16 characters | all runs, transcripts, chats, triggers and agents can be read |
| `TEND_POSTGRES_PASSWORD` | database password of user `tend` | postgres, server, worker (in `TEND_DATABASE_URL`) | — | `openssl rand -hex 32` | low while Postgres is not published; full read/write of all platform state for anyone who can reach it |
| `TEND_CLAUDE_CODE_CREDENTIAL` | selects `oauth-token` or `api-key`; only the selected variable enters a sandbox | worker | — | — | not a secret |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code with your subscription | worker → every Claude Code sandbox, in the agent process's environment | — | `claude setup-token` | model usage on your subscription |
| `ANTHROPIC_API_KEY` | Claude Code with an API key, billed per use | worker → every Claude Code sandbox, as above | a key for this purpose only; spend limits in the Anthropic Console | Anthropic Console | spend on your API account |
| `TENDWORKS_AGENT_GITHUB_TOKEN` | the `developer` agent pushes its branch and opens the pull request (`GH_TOKEN` in the sandbox) | worker → sandboxes of profiles that reference it in `spec.env` | fine-grained, only the target repository: Contents read/write, Pull requests read/write | GitHub → Settings → Developer settings → Fine-grained tokens | push to any branch and open, edit or merge pull requests in that repository |
| `TENDWORKS_PLATFORM_GITHUB_TOKEN` | the trigger reads issues; the merge gate merges pull requests | server only, never a sandbox | fine-grained, only the target repository: Issues read, Contents read/write, Pull requests read/write | as above | read issues, push and merge in that repository |

Notes:

- **Credential terms.** `oauth-token` is a subscription token: "single-operator use only under Anthropic's terms" (`deploy/.env.example`). Third-party or shared use requires an API key (`docs/platform-architecture.md`). If anyone else uses your installation, use `api-key`.
- **Agents read their own secrets.** Agents are untrusted, and nothing stops an agent (or code it runs) from reading the credential and `GH_TOKEN` in its environment and sending them anywhere: there is no egress allowlist yet. The target is injection by an egress proxy so sandboxes only see placeholders (`docs/platform-architecture.md`, security). Transcripts and replies redact the values (`***`), which protects the logs, not the secret.
- **Both GitHub tokens** need GitHub's mandatory Metadata read, which fine-grained tokens include. Keep the agent token and the platform token separate: the platform token must never become an agent secret, and the resolver enforces that (below).
- **`hello-developer` needs the agent token too**, although it does not use GitHub: the `developer` profile references it, and a task fails when a referenced secret is not set.

### Secret references (ADR 0008)

Configuration never holds a value, only `{ secretRef: { name: <NAME> } }`. In this profile a name is an environment variable of the bundle that uses it, resolved on every use, not at startup:

| Who references | May resolve | Example |
| --- | --- | --- |
| agent profiles (`spec.env`, handed into sandboxes) | only `TENDWORKS_AGENT_*` | `GH_TOKEN: { secretRef: { name: TENDWORKS_AGENT_GITHUB_TOKEN } }` |
| trigger bindings, pull request integrations | only `TENDWORKS_PLATFORM_*` | `token: { secretRef: { name: TENDWORKS_PLATFORM_GITHUB_TOKEN } }` |

A reference outside its prefix is a configuration error at startup. `TEND_API_TOKEN`, `TEND_API_READ_TOKEN` and the database URL can never be referenced. **A new secret needs a compose change:** compose passes only the variables it lists, so a new `TENDWORKS_AGENT_*` or `TENDWORKS_PLATFORM_*` secret must be added to `deploy/.env` *and* to the `worker` or `server` environment in `deploy/compose.yaml`.

### Handling

- `deploy/.env` belongs to the operator: `chmod 600 deploy/.env`, owned by your user. It is in `.gitignore` and `.dockerignore`, so it is neither committed nor copied into images.
- Never put a secret into the configuration directory or its repository.
- Encrypted secrets in Git (SOPS) and a secret store (OpenBao) are the stated future direction (`docs/platform-architecture.md`, ADR 0008); neither exists yet.
- Don't paste tokens on the command line where shell history keeps them; `export TEND_API_TOKEN=$(grep '^TEND_API_TOKEN=' deploy/.env | cut -d= -f2-)` reads it from the file.

### Rotation

| Secret | Steps |
| --- | --- |
| API token, read token | change `deploy/.env`, `docker compose -f deploy/compose.yaml up -d --wait` (server and worker get the new value), re-export it for `tend`, sign in to the UI again |
| Claude Code credential, agent token | change `deploy/.env`, `up -d --wait` (worker). Sessions interrupted by the recreation resume in a new sandbox |
| platform GitHub token | change `deploy/.env`, `up -d --wait` (server) |
| Postgres password | the Postgres image applies `POSTGRES_PASSWORD` only when it initialises an empty volume, so changing `.env` alone breaks the connection. Change it in the database first (`docker compose -f deploy/compose.yaml exec postgres psql -U tend -d tend -c "ALTER USER tend PASSWORD '<new>'"`), then in `.env`, then `up -d --wait`. Not exercised by the project; test it on a copy first |

### Residual risks the docs name

- **Sandboxes and the API port.** Sandboxes run on their own network without the platform's services, but where the Docker host forwards the published port to them (Docker Desktop via `host.docker.internal`), only the tokens guard the API. On a Linux engine, sandboxes do not reach the port compose publishes on `127.0.0.1` (checked by `tests/e2e/sandbox-access.test.ts`). They still reach everything else the bridge network routes to, including your LAN and the internet.
- **MCP sandboxes reach each other.** Sandboxes of profiles with `mcp: [tendworks]` share the gateway's network `<installation>_platform-mcp` and can reach each other on it; Docker can forbid traffic only between all containers of a network, which would cut off the gateway too (ADR 0019). Other sandboxes stay apart: the sandbox network forbids traffic between its containers, and they never join the gateway's network. Through the gateway, sandboxes reach only `/mcp`, read-only.
- **The agent token could merge.** Without repository rulesets (e.g. a private repository on GitHub's free plan) the agent token can technically merge its own pull request; the platform's merge gate only governs what the platform does (`docs/platform-architecture.md`). Protect the target branch with a ruleset where you can.
- **Token in browser storage.** The web UI keeps the token in `sessionStorage`, or in `localStorage` with "Stay signed in on this device". A script injected into the UI could read it; a strict CSP and sanitised agent output are the guards (ADR 0018). Don't tick "Stay signed in" on a shared browser.
- **Socket proxy.** It filters paths, not request bodies: whoever reaches it can create a privileged container, i.e. become root on the host. Only the worker reaches it (ADR 0001).
- **Isolation class `container`** shares the host kernel; a kernel exploit from a sandbox reaches the host. Put an outer boundary around it (dedicated VM) when agents process untrusted content such as public issues (ADR 0001).
- **Temporal's web UI** has no authentication; while it runs (`--profile debug`, on `127.0.0.1:8233`), every local user of the host can open it. Stop it when you are done: `docker compose -f deploy/compose.yaml stop temporal-ui`.

## Access

The stack publishes the API, UI and MCP endpoint on `127.0.0.1:8080` only (ADR 0018), and the Temporal UI on `127.0.0.1:8233` only while you run it with `docker compose -f deploy/compose.yaml --profile debug up -d temporal-ui`. Reach them from your laptop through an SSH tunnel:

```sh
ssh -L 8080:localhost:8080 <host>                               # API, UI, tend
ssh -L 8080:localhost:8080 -L 8233:localhost:8233 <host>        # plus the Temporal UI (profile debug)
```

Then on the laptop: `http://localhost:8080/` in the browser, and `tend` with its default `TEND_URL=http://localhost:8080` (build it there as in [Install](#install), step 5, or run `tend` on the host over SSH).

**Do not publish the port beyond localhost** (e.g. `0.0.0.0:8080` in compose, a reverse proxy without TLS, a port forward on the router). There is no TLS and no identity: one static bearer token over plain HTTP is all that guards full control of agents, merges and approvals. Remote access waits for TLS and OIDC (ADR 0014, ADR 0018).

## Known gaps on Linux

| Area | State |
| --- | --- |
| Stack, sandboxes, socket proxy, restart and resume | work on a Linux Docker engine: CI runs the full compose stack and the end-to-end tests (scripted ACP agent in real sandboxes, API and browser) on Ubuntu (`.github/workflows/ci.yml`) |
| `developer` agent with real Claude Code, pull request, merge, approval | the manual smoke tests are documented, but the docs do not record a run on a Linux host; expect it to work, verify with the [first workloads](#first-test-workloads) |
| Platform MCP server from sandboxes | works through the MCP-only gateway (ADR 0019): the end-to-end tests on Linux CI call a platform tool from a scripted chat and check that sandboxes reach only `/mcp`. The `assistant` chat with real Claude Code is not yet recorded on a Linux host |
| Chats without the MCP server | the chat mechanics are covered by the end-to-end tests on Linux. A profile with `spec.chat` and without `spec.mcp` chats without the platform's tools (below) |
| `gvisor` isolation class | **not verified** (issue #17). The adapter asks Docker for the runtime `runsc`, which must be installed and registered in the Docker daemon; there are no setup instructions yet |
| Cleanup | session volumes, the sandbox network and old images are never cleaned up automatically (issue #48, see [Reset](#reset)) |
| Approvals vs. pull requests changed on GitHub | a pull request merged or closed on GitHub while its run waits is not reflected on the approval request; reject then ends the run with `merged: false` even though the code is merged (issue #51) |
| Background work of agents | an agent can end its turn with a command still running in the background; the work is lost when the sandbox goes. Mitigated only by the `developer` role description (issue #23) |

A chat profile without the platform MCP server, e.g. `agents/helper.md` in your configuration directory:

```markdown
---
apiVersion: tendworks.dev/v1
kind: AgentProfile
metadata:
  name: helper
spec:
  harness: claude-code
  sandbox: claude-code
  chat:
    idleMinutes: 5
---
You are a helpful assistant working in your workspace. Keep answers short.
```

Restart server and worker, then `tend chat helper` (optionally `--repo https://github.com/<owner>/<public-repo>`).

## First test workloads

The smoke tests in [docs/platform-implementation.md](platform-implementation.md) are the walkthrough; most are scripted in `scripts/smoke/` (bash, print PASS or FAIL). All need the stack up, `deploy/.env` filled in and `TEND_API_TOKEN` exported; the GitHub ones need `gh` logged in. Go in this order:

| # | Workload | How | Needs | On Linux |
| --- | --- | --- | --- | --- |
| 1 | Claude Code answers in a sandbox, cost and transcript visible | `scripts/smoke/hello-developer.sh` (steps 3–4) | sandbox image, Claude credential, agent token | not yet recorded |
| 2 | Restart mid-run resumes the agent session | `scripts/smoke/restart-developer.sh` (steps 5–7) | as 1 | not yet recorded |
| 3 | Labelled issue → pull request → merged with `merge: auto` | open an issue in your target repository, then `scripts/smoke/pull-request-auto.sh <issue>` (steps 8–12) | platform token; `suspend: true` removed from `playground-ready-for-agent`; `develop-issue` removed from `ask-before-merge`; server restarted | not yet recorded |
| 4 | Same with `merge: ask`, across a restart, approve or reject | `scripts/smoke/pull-request-ask.sh <issue> [approve\|reject]` (step 14) | as 3, with `develop-issue` in `ask-before-merge` (as in the starter configuration) | not yet recorded |
| 5 | `assistant` chat answers from the live platform state | `scripts/smoke/chat-assistant.sh` (steps 15–18) | scripted ACP image, the fixture configuration (`restart-scripted`), binding not suspended, read token | not yet recorded; the script checks the MCP gateway from a sandbox first |
| 6 | Web UI with live run, chat, approval, phone width | by hand in the browser (steps 19–23) | as 4 and 5 | not yet recorded |

Before you start:

- **Each labelled issue starts one paid run, once** (ADR 0006). The scripts refuse to run while other open issues carry `ready-for-agent`. A failed issue is not retried automatically; start it again by hand with `POST /runs` (`docs/platform-implementation.md`, "Triggers: one firing per issue").
- The scripts check the configuration the stack mounts: `TEND_CONFIG_PATH` from the shell or `deploy/.env`, else `examples/config` (`scripts/smoke/lib.sh`).
- Revert configuration changes after the tests (binding suspended again, `ask-before-merge` back), or keep them deliberately.
- Watch a run live: `tend run logs <id> --follow`, or the run detail in the UI.

## Operations

### Everyday commands

| Task | Command |
| --- | --- |
| Status | `tend status`, `curl -s localhost:8080/status` |
| Services | `docker compose -f deploy/compose.yaml ps` |
| Logs | `docker compose -f deploy/compose.yaml logs -f server worker` (add `--tail 100`); server logs list the loaded configuration at startup and every notification, since notifications are delivered to the log for now |
| Runs | `tend run list`, `tend run get <id> [-o yaml]`, `tend run logs <id> [--follow]` |
| Start a run by hand | `curl -X POST localhost:8080/runs -H "authorization: Bearer $TEND_API_TOKEN" -H 'content-type: application/json' -d '{"workflow":"hello-developer"}'` |
| Approvals | `tend approval list --pending`, `tend approval approve <id>`, `tend approval reject <id>` |
| Notifications, triggers, agents | `tend notification list`, `tend trigger list` (last check per binding), `tend agent list` (active sessions per profile) |
| Chats | `tend chat <profile>`, `tend chat list`, `tend chat attach <id>`, `tend chat end <id>` |
| Live sandboxes | `docker ps --filter label=dev.tendworks.sandbox` |
| Restart (after a configuration change) | `docker compose -f deploy/compose.yaml restart server worker` |
| Apply a change to `deploy/.env` | `docker compose -f deploy/compose.yaml up -d --wait` (`restart` keeps the old environment) |
| Workflow engine UI (debugging) | `docker compose -f deploy/compose.yaml --profile debug up -d temporal-ui`, afterwards `... stop temporal-ui` |
| Stop / start | `docker compose -f deploy/compose.yaml stop`, `... up -d --wait` |

### Where data lives

| Data | Location | Removed by `down -v` |
| --- | --- | --- |
| platform state (runs, tasks, chats, approvals, notifications, event outbox) | volume `tendworks_postgres-data` | yes |
| workflow execution history | volume `tendworks_temporal-data` | yes |
| transcripts | volume `tendworks_transcripts` | yes |
| agent sessions (workspace, harness home) | volumes `<installation>-volume-<task>-workspace` and `-session`, labels `dev.tendworks.volume`, `dev.tendworks.installation` and `dev.tendworks.owner` (the task); removed when a task or chat ends, kept while a chat is open | **no** |
| sandboxes | containers `<installation>-sandbox-<id>`, labels `dev.tendworks.sandbox`, `dev.tendworks.installation` and `dev.tendworks.owner` | **no** |
| sandbox network | `<installation>-sandboxes`, labels `dev.tendworks.sandbox-network` and `dev.tendworks.installation` | **no** |
| MCP gateway network | `<installation>_platform-mcp` (compose) | yes, once no sandbox is attached ([Reset](#reset)) |
| images | `tendworks-server`, `tendworks-worker`, `tendworks/sandbox-claude-code:<tag>` | **no** |

Names assume the default project name `tendworks`; with another `COMPOSE_PROJECT_NAME`, replace `tendworks` (the installation) accordingly. Several stacks on one Docker engine (e.g. e2e stacks) never see or touch each other's sandboxes and session volumes.

Updating from before `v0.2.0`: sandboxes and session volumes had fixed names (`tendworks-sandbox-*`, `tendworks-volume-*`) and no installation label. With the default project name these are the installation's names, so open chats resume and nothing needs to be done. With another project name, end open chats before the update: afterwards their old volumes are no longer found, the chats start over with an empty workspace, and the old `tendworks-volume-*` volumes stay behind (remove them as under [Reset](#reset)).

Nothing ages out: Postgres, transcripts and the volumes of chats nobody ends grow forever (issue #48). Watch the disk (`docker system df -v`).

### Update

```sh
git pull
docker compose -f deploy/compose.yaml --profile sandbox-images build      # when images/sandbox-claude-code changed
docker compose -f deploy/compose.yaml up -d --build --wait
pnpm install && pnpm build                                                 # for the tend CLI
```

- The sandbox image pin lives only in `deploy/compose.yaml`; a template that names `tendworks/sandbox-claude-code` without a tag follows it. Rebuild the sandbox images when the pin changed.
- Check `git log` for configuration schema changes; an invalid configuration stops the server (see the log).
- Server and worker migrate their database tables at startup, each change in its own transaction, and log `store <domain>: migrated from version <n> to <m>`. Downgrades are not supported; back up first and prefer updating while no run is active.

### Backup and restore

The architecture's backup concept (WAL archiving, S3) is not built yet. For this profile, a cold copy of the volumes is the simple option. The commands are plain Docker and have not been exercised by the project: test a restore before you rely on it.

Postgres and Temporal must be copied together; their states refer to each other (runs live in both).

```sh
docker compose -f deploy/compose.yaml stop
for v in postgres-data temporal-data transcripts; do
  docker run --rm -v tendworks_$v:/data:ro -v "$PWD/backup":/backup postgres:18.6-alpine \
    tar czf /backup/$v.tgz -C /data .
done
docker compose -f deploy/compose.yaml up -d --wait
```

Restore into empty volumes (after `down -v`, or on a new host with the same `deploy/.env`):

```sh
docker compose -f deploy/compose.yaml create        # creates the volumes without starting
for v in postgres-data temporal-data transcripts; do
  docker run --rm -v tendworks_$v:/data -v "$PWD/backup":/backup postgres:18.6-alpine \
    tar xzf /backup/$v.tgz -C /data
done
docker compose -f deploy/compose.yaml up -d --wait
```

Session volumes hold the workspaces and harness state of open chats and interrupted tasks; back them up the same way only if you need to resume those. Also back up `deploy/.env` (securely) and keep your configuration in its own Git repository.

### Reset

```sh
docker compose -f deploy/compose.yaml stop worker
docker rm -f $(docker ps -aq --filter label=dev.tendworks.installation=tendworks --filter label=dev.tendworks.sandbox)
docker compose -f deploy/compose.yaml down -v
docker volume rm $(docker volume ls -q --filter label=dev.tendworks.installation=tendworks --filter label=dev.tendworks.volume)
docker network rm tendworks-sandboxes
```

`down -v` removes the containers, the gateway's network and the volumes `postgres-data`, `temporal-data` and `transcripts`: all runs, chats, approvals, notifications and transcripts. It does **not** remove sandboxes, session volumes, the sandbox network or images (issue #48), hence the other commands. Remove the sandboxes before `down` (with the worker stopped, so it starts none meanwhile): while a sandbox of an MCP profile is still attached to the gateway's network, `down` cannot remove that network and leaves it behind ("Resource is still in use").

Replace `tendworks` with your project name if you set one. Sandboxes and volumes created before `v0.2.0` have no installation label; find them by name (`docker ps -a --filter name=tendworks-sandbox-`, `docker volume ls --filter name=tendworks-volume-`) and check the lists before removing, since other stacks and test runs on the same engine used the same names then.

### Cleaning images

| What | Command |
| --- | --- |
| list | `docker image ls --filter reference='tendworks*' --filter reference='tendworks/*'` |
| old sandbox image after a pin update | `docker image rm tendworks/sandbox-claude-code:<old tag>` |
| test image | `docker image rm tendworks/sandbox-scripted-acp:test` |
| images of other compose projects (e.g. e2e stacks, ~0.9 GB each) | `docker image ls --format '{{.Repository}}:{{.Tag}} {{.Size}}' \| grep -E -- '-(server\|worker):'`, then `docker image rm` |
| build cache | `docker builder prune` |

## Troubleshooting

| Symptom or message | Where | Cause and fix |
| --- | --- | --- |
| `TEND_API_TOKEN is not set; ...` (same for `TEND_API_READ_TOKEN`) | server log, server exits and restarts | no `deploy/.env`, or the token is empty in it; create the file with `scripts/setup-env.sh` (or fill in `openssl rand -hex 32`), then `up -d --wait` |
| `TEND_API_TOKEN must be at least 16 characters; generate one with ...` (same for `TEND_API_READ_TOKEN`) | server log, server exits | token too short; `openssl rand -hex 32`, then `up -d --wait` |
| `TEND_API_READ_TOKEN must differ from TEND_API_TOKEN, or it could change state` | server log, server exits | use two different values |
| `<file>: neither a workflow nor a document with a kind ...`, `unknown kind`, `invalid YAML`, `... calls agent://<x>, but no agent profile '<x>' is configured` | server or worker log, exits | configuration invalid; the log lists every issue. Stray YAML in the configuration directory counts (hidden directories such as `.github/` are skipped) |
| `schema <schema>: migration <n> (<name>) failed: ...` or `... newer than this release knows ...; downgrades are not supported`; `tend status` shows `<schema>-schema` unhealthy | server or worker log; `GET /status` | an update's migration failed and was rolled back, so the store is still at the previous version. The bundle keeps running but only answers `/status` (server) or `/health` (worker), every other request gets 503. Check out the previous tag (its store is unchanged) and `up -d --build`, or fix the cause and `up -d`; the next start retries. A store newer than the release needs the newer tag or the backup |
| `missing environment variable <NAME>` | server or worker log | a bundle setting is missing; only happens with a modified compose file |
| `harness claude-code: TEND_CLAUDE_CODE_CREDENTIAL must be oauth-token or api-key but is not set; its tasks will fail until this is fixed` | worker log, warning at start | set the selector and the matching variable, `up -d --wait` |
| run fails: `no harness credential configured: set TEND_CLAUDE_CODE_CREDENTIAL to oauth-token or api-key and the matching variable in deploy/.env` | `tend run get` | as above |
| `TEND_CLAUDE_CODE_CREDENTIAL selects api-key, but ANTHROPIC_API_KEY is empty` | worker log | fill the selected variable |
| run fails: `agent profile developer: secret TENDWORKS_AGENT_GITHUB_TOKEN is not set` | `tend run get`, worker log warning at start | set the agent token (also needed for `hello-developer`) |
| `... is not an agent secret: agents may only reference TENDWORKS_AGENT_* secrets` (or `platform integrations may only reference TENDWORKS_PLATFORM_*`) | log, run | a reference outside its prefix; rename the variable and add it to compose |
| `tend trigger list` shows `failed ... secret TENDWORKS_PLATFORM_GITHUB_TOKEN is not set` | `LAST CHECK` | the platform token did not reach the server; set it, `up -d --wait` (a plain `restart` keeps the old environment) |
| binding never checks | `tend trigger list` | `spec.suspend: true`; remove it and restart the server |
| issue labelled but no new run | | each issue fires once per binding, also after a failed run (ADR 0006); start it by hand with `POST /runs` |
| run fails at `/do/1/merge`: `No pull request to merge`, `Repository unavailable: GitHub answered 401: Bad credentials ...` | `tend run get` | the agent reported no pull request, or the platform token is invalid or lacks scope |
| `cannot create a sandbox from template claude-code: image tendworks/sandbox-claude-code:<tag> is not on the sandbox host` | run or chat | build the sandbox image (`--profile sandbox-images build`); the tag must match the template |
| `agent profile assistant lists the platform MCP server, but none is configured: set TEND_PLATFORM_MCP_URL and TEND_API_READ_TOKEN for the worker` | chat or run | worker lacks the read token (compose sets the URL); run `scripts/setup-env.sh` or set `TEND_API_READ_TOKEN`, then `up -d --wait` |
| `FAIL: a sandbox cannot use the platform MCP server at ...` | `chat-assistant.sh` | the gateway is not running or `TEND_PLATFORM_MCP_URL` points elsewhere; `docker compose -f deploy/compose.yaml ps mcp-gateway` and `logs mcp-gateway` |
| `Network <installation>_platform-mcp Resource is still in use` | `down` | sandboxes of MCP profiles are still attached to the gateway's network, which stays behind; remove the installation's sandboxes ([Reset](#reset)), then `down` again |
| `the control plane refused the token (HTTP 401); set TEND_API_TOKEN or pass --token` | `tend` | export the value from `deploy/.env` (or pass `--token`) |
| 403 with a reason on a write | `tend`, UI | you used the read-only token |
| `The control plane at http://localhost:8080 does not answer.` | smoke scripts | stack down or server exited; `docker compose ... ps` and `logs server --tail 20`; after code or contract changes rebuild with `up -d --build --wait` |
| `The tend CLI is not built; run pnpm build first.` | `chat-assistant.sh` | `pnpm install && pnpm build` on the host |
| `/ui/` answers 404, log says `web UI: no build at ...` | server log | the image has no UI build; rebuild with `up -d --build` |
| sandboxes or volumes left after tests | `docker ps`, `docker volume ls` | [Reset](#reset); issue #48 |
