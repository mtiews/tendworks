# Tendworks – Operator Guide

How to install, run and maintain Tendworks on your own Linux host: a single-host deployment for one operator. Written for **Ubuntu 24.04 LTS (x86-64) with Docker Engine** from Docker's apt repository; other Linux distributions with Docker Engine should behave the same, Docker Desktop differs where noted.

The stack (`deploy/compose.yaml`) has no identity (OIDC), no TLS of its own and no egress control: one operator, one host, the API bound to localhost. Read the [release notes](releases/) of the version you install.

## Contents

- [What runs](#what-runs)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [Configuration](#configuration)
- [Secrets](#secrets)
- [Before the first real run: GitHub access](#before-the-first-real-run-github-access)
- [Access from your devices](#access-from-your-devices)
- [Known gaps](#known-gaps)
- [First test workloads](#first-test-workloads)
- [Operations](#operations)
- [Troubleshooting](#troubleshooting)
- [Acceptance checklist](#acceptance-checklist)

## What runs

| Service | Role | Published |
| --- | --- | --- |
| `postgres` | state of all domains, event bus | no |
| `temporal` | durable execution engine in dev mode, without its web UI | no |
| `temporal-ui` | the engine's web UI, only with `--profile debug` (no login) | `127.0.0.1:8233` (`TEND_ENGINE_UI_PORT`) |
| `docker-proxy` | the worker's only way to the Docker API, restricted by path (ADR 0001) | no, internal network |
| `server` | control plane API, trigger gateway, human interaction, platform MCP server (`/mcp`), web UI (`/ui/`) | `127.0.0.1:8080` (`TEND_PORT`) |
| `worker` | workflow interpreter, agent runtime; creates sandboxes through the socket proxy and cleans up orphaned ones | no |
| `agent-secrets` | runs once on `up` and ends (`Exited (0)` in `docker compose ps -a` is normal): hands the worker the `TENDWORKS_AGENT_*` lines of `deploy/.env`, without network ([Secret references](#secret-references-adr-0008)) | no |
| `mcp-gateway` | MCP-only gateway: forwards `/mcp` to the server and refuses every other path; only sandboxes of profiles with `mcp: [tendworks]` reach it, on the internal network `<installation>_platform-mcp` (ADR 0019) | no |
| sandboxes | one container per agent session (`<installation>-sandbox-<id>`), created by the worker on the Docker network `<installation>-sandboxes` | no |

- **Installation** = the compose project name, `tendworks` by default. It prefixes containers, volumes, networks and images, so several stacks on one Docker engine never touch each other's sandboxes and session volumes.
- **Restart policy** `unless-stopped` on every long-running service: the stack comes back after a crash and after a host reboot, unless you stopped it yourself. Runs that were working continue.
- **Sandbox images** are never pulled by the platform; you build them once ([Install](#install)).

## Prerequisites

| What | Why | Notes |
| --- | --- | --- |
| Ubuntu 24.04 LTS, x86-64 | the tested target | **not supported yet:** ARM hosts, rootless Docker, several hosts, Kubernetes |
| Docker Engine with the compose plugin, rootful, from [Docker's apt repository](https://docs.docker.com/engine/install/ubuntu/) | runs the whole stack; images build inside Docker (`deploy/Dockerfile` runs `pnpm install` and `pnpm build` itself) | `docker compose version` must work: Ubuntu's own `docker.io` package and the snap bring no compose plugin, so remove them and install `docker-ce` with `docker-compose-plugin` from Docker's repository. The socket proxy mounts `/var/run/docker.sock`. The Docker service must start at boot (`systemctl is-enabled docker` says `enabled`, the package's default) |
| git | install and update from release tags | |
| curl | `/status`, starting runs by hand | |
| Node.js 24 and pnpm | only on the host for the `tend` CLI and the smoke scripts; the stack does not need them | `corepack enable pnpm` (may need `sudo` with a system-wide Node). Ubuntu's own `nodejs` package is older than 24, so install Node 24 another way |
| GitHub CLI `gh`, logged in | only for the pull request and chat smoke scripts | |
| A GitHub repository for the agent | `develop-issue` works on it | the starter binding targets `mtiews/tendworks-playground`; change it ([Target repository](#kinds-and-what-you-typically-change)) |
| Claude Code credential | the `developer` and `assistant` agents run Claude Code | [Secrets](#secrets) |
| Tailscale (recommended) or a reverse proxy with your own domain | access from your phone and laptop | [Access from your devices](#access-from-your-devices) |

**The `docker` group.** Adding your user to `docker` (`sudo usermod -aG docker $USER`, then log in again) lets you run the commands below without `sudo`. Membership is equivalent to root on the host: any member can start a privileged container, read every volume (store, transcripts, agent workspaces, the agent secrets file) and read the secrets in the services' environment with `docker inspect`. Only put the operator in that group.

**Hardware.** No measured numbers yet (`docs/platform-architecture.md`, scaling). What is fixed:

- Each Claude Code sandbox is limited to 2 CPUs and 4096 MB RAM (`examples/config/sandboxes/claude-code.yaml`); plan for that per concurrent agent session on top of the stack.
- The server and worker images are about 0.9 GB each; add the sandbox image, Postgres and Temporal.

## Install

All commands run from the repository root. Compose uses `deploy/` as its project directory, so it picks up `deploy/.env` by itself.

1. **Check out a release tag**

   ```sh
   git clone --branch v0.2.0 https://github.com/mtiews/tendworks.git
   cd tendworks
   ```

   A tag says exactly which version runs (`git describe --tags`). Its release notes are in `docs/releases/`.

2. **Create `deploy/.env`**

   ```sh
   scripts/setup-env.sh
   ```

   Copies `deploy/.env.example` to `deploy/.env`, fills in a random `TEND_API_TOKEN`, a different random `TEND_API_READ_TOKEN` and a random store password `TEND_POSTGRES_PASSWORD`, sets mode 600 and refuses to overwrite an existing file. It never prints them. There are no defaults: the server refuses to start without both tokens, server and worker refuse to start without the store password, and each names the variable to set. The store takes its password only when it is created; changing it later needs the [rotation](#rotation) steps.

3. **Fill in the rest of `deploy/.env`** ([Secrets](#secrets)) **before the first start**:
   - `TEND_CLAUDE_CODE_CREDENTIAL` and the matching `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`.
   - `TENDWORKS_AGENT_GITHUB_TOKEN` and `TENDWORKS_PLATFORM_GITHUB_TOKEN`, as in [GitHub access](#before-the-first-real-run-github-access).

4. **Set up your own configuration** (directory or repository, [below](#your-own-configuration))

   ```sh
   cp -r examples/config ~/tendworks-config      # then git init, commit, push to a private repository
   echo "TEND_CONFIG_PATH=$HOME/tendworks-config" >> deploy/.env
   ```

5. **Build the sandbox image** (the platform never pulls it)

   ```sh
   docker compose -f deploy/compose.yaml --profile sandbox-images build
   ```

   Builds `tendworks/sandbox-claude-code` with the tag pinned in `deploy/compose.yaml` (`x-sandbox-images`).

6. **Build and start the stack**

   ```sh
   docker compose -f deploy/compose.yaml up -d --build --wait
   ```

   `--wait` returns when the services are up. It does not mean healthy: check step 8.

7. **Build the `tend` CLI on the host** (the smoke scripts and this guide use it)

   ```sh
   corepack enable pnpm
   pnpm install
   pnpm build
   alias tend='node "$PWD/apps/cli/dist/main.js"'
   export TEND_API_TOKEN=$(grep '^TEND_API_TOKEN=' deploy/.env | cut -d= -f2-)
   ```

   `pnpm install` also points git at the pre-commit hook in `.githooks`; it needs `betterleaks` only if you commit.

8. **Verify**

   | Check | Expected |
   | --- | --- |
   | `curl -s http://localhost:8080/status` | HTTP 200 and `"status":"healthy"`; 503 names the failing component. The only endpoint without a token |
   | `tend status` | `PLATFORM healthy`, `ACCESS full`, the components `store`, `execution-engine`, `sandbox-backend`, `sandbox-cleanup` |
   | `tend agent list`, `tend trigger list` | the profiles and trigger bindings of your configuration |
   | `http://localhost:8080/` in a browser on the host, or [from your devices](#access-from-your-devices) | redirects to `/ui/` and asks for a token; the API token signs in with full access |

   The starter configuration starts no run by itself: its only trigger binding is suspended.

## Configuration

Two places, strictly separated:

| | `deploy/.env` | configuration directory |
| --- | --- | --- |
| Holds | secrets, ports, the installation name, the path of the configuration directory | workflows, agent profiles, trigger bindings, sandbox templates, skills |
| In Git | never (`.gitignore`, `.dockerignore`) | yes, in a repository of its own |
| Read by | compose, into the services' environment | server and worker at startup, mounted read-only at `/config` |
| Apply a change | `docker compose -f deploy/compose.yaml up -d --wait` (recreates the services whose environment changed; `restart` keeps the old environment) | `docker compose -f deploy/compose.yaml restart server worker` |

Running runs resume after either, and the worker takes up open chats again.

### Settings in `deploy/.env` besides secrets

`deploy/.env.example` lists every variable `deploy/compose.yaml` reads; those with a default are commented out (`# TEND_PORT=8080`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `TEND_CONFIG_PATH` | `../examples/config` (the starter) | configuration directory on the host; relative paths resolve against `deploy/`, so use an absolute path |
| `TEND_PORT` | `8080` | API, UI and MCP port, published on `127.0.0.1` only |
| `TEND_ENGINE_UI_PORT` | `8233` | the engine's web UI, on `127.0.0.1` only and only with `--profile debug` |
| `COMPOSE_PROJECT_NAME` | `tendworks` | the installation name; change it only for a second stack on the same engine (with other ports) |
| `TEND_PLATFORM_MCP_URL` | `http://mcp-gateway:8080/mcp` | where sandboxes of profiles with `mcp: [tendworks]` reach the platform MCP server: the MCP-only gateway, on Linux and Docker Desktop alike. Leave it unset |
| `ANTHROPIC_BASE_URL` | empty | optional alternative model endpoint for Claude Code |
| `TEND_WORKSPACE_ROOTS` | empty (no directory workspaces) | absolute host directory that directory workspaces must lie under ([Directory workspaces](#directory-workspaces)) |

`TEND_SANDBOX_IMAGES` and `TEND_INSTALLATION` are set by compose itself; don't set them.

### Your own configuration

`examples/config` is the starter configuration, without test fakes:

- agents `developer` and `assistant`, sandbox template `claude-code`, skill `tdd`;
- workflows `develop-issue`, `hello-developer`, `restart-developer`;
- trigger binding `playground-ready-for-agent`, suspended.

The platform performs no GitHub action besides reading issues: the developer agent opens the pull request itself and reports it, the run ends with it, and you review and merge it in GitHub (ADR 0024).

Copy it into a repository of your own (the planned `tendworks-config`), point `TEND_CONFIG_PATH` at the checkout ([Install](#install), step 4) and change it there; a platform update never touches it. Compare with the new `examples/config` when release notes name configuration changes.

Rules the loader enforces:

- Every `*.yaml`, `*.yml` and `*.md` file below the directory is read, recursively. Hidden files and directories (`.git`, `.github`) are skipped, so the repository can carry its own CI. Each YAML file must be a workflow (has `document`) or a known `kind`; anything else stops the server (`neither a workflow nor a document with a kind`).
- `.md` files count only under `agents/`; other Markdown (e.g. `skills/README.md`, `SKILL.md`) is not configuration.
- Names are unique per kind; invalid configuration stops server or worker before they accept requests, with every issue in the log.
- Server and worker run as user `node` (uid 1000); the files must be readable by it.
- Secrets never go here, only references ([Secrets](#secrets)).

### Kinds and what you typically change

| Kind | Where | Typical changes | Read by |
| --- | --- | --- | --- |
| Workflow (Serverless Workflow 1.0 subset) | `workflows/*.sw.yaml` | `develop-issue`: the prompt text; new workflows calling `agent://<profile>`; a human step `call: approval` (`action`, `question`, `links`, `answers` with `outcome: continue \| stop`) where a workflow waits for you | server |
| `Policy` | `policies/*.yaml` | `spec.actions.<action>: allow \| ask` for the human steps of `spec.workflows` (all workflows without it); the strictest applicable policy wins, and without one the step asks | server |
| `AgentProfile` (Markdown with frontmatter; the body is the role description) | `agents/*.md` | `spec.chat.idleMinutes` (1–1440, default 5): how long an idle chat keeps its sandbox; `spec.env` secret references; `spec.skills`; `spec.mcp: [tendworks]`; `spec.attribution: false` | server and worker |
| `NotificationChannel` | `notifications/*.yaml` | `spec.events` (out of `approval.requested`, `run.failed`, `run.completed`); `spec.integration: pushover` with `spec.pushover.token` and `user` as references to `TENDWORKS_PLATFORM_PUSHOVER_TOKEN` and `TENDWORKS_PLATFORM_PUSHOVER_USER` in `deploy/.env`, optional `priority` (-2 to 1); several channels, e.g. failures with `priority: 1`. A run's first artifact (its pull request) is the message's link | server |
| `Workspace` | `workspaces/*.yaml` | either `spec.directory.path` (a host directory under `TEND_WORKSPACE_ROOTS`, [Directory workspaces](#directory-workspaces)) or `spec.git.url` (any host; `https://` or `http://` without credentials in it) and `spec.git.defaultBranch`; `spec.credentials.secretRef` (an agent secret), `username` (default `x-access-token`) and `env` (e.g. `GH_TOKEN`: the session sees the credential under that name too) | server and worker |
| `TriggerBinding` | `triggers/*.yaml` | `spec.workflow`; `spec.workspaces`: names of workspaces, one run per workspace (none: runs without a workspace); `spec.suspend: true/false`; `spec.trigger` with exactly one kind: `schedule` (`cron: '0 2 * * *'`, UTC, or `every` with `days`, `hours`, `minutes`, `seconds`) or `github-issues` (`labels`, `state`, `every`, `token`; reads the issues of each workspace's repository on github.com, pull requests left out, with the read-only issues token; a binding without workspaces or with a workspace that is not a git repository on github.com stops the server). The workflow gets `{ workspace, item }` | server |
| `SandboxTemplate` | `sandboxes/*.yaml` | `spec.image` (the deployment's own images by repository alone, e.g. `tendworks/sandbox-claude-code`: the worker fills in the pin from `deploy/compose.yaml`; other images with an exact tag or digest), `spec.isolationClass: container \| gvisor`, `spec.resources.cpus`, `memoryMb`. Images with your own tooling: [sandbox images](sandbox-images.md) | worker (server validates) |
| Skills | `skills/<name>/SKILL.md` plus files | pinned by copying; profiles list them in `spec.skills` | worker |

**Target repository.** The starter targets `mtiews/tendworks-playground`, declared once as the workspace `playground` (`workspaces/playground.yaml`, ADR 0022). For your own repository, declare a workspace with its clone URL and its own agent token, add its name to `spec.workspaces` of the trigger binding, and scope the tokens to it. Agent profiles carry no repository token; a workflow or binding that names an unknown workspace is refused at startup. The smoke scripts take `TEND_PLAYGROUND=<owner>/<name>`.

### Directory workspaces

A directory workspace lets agents work on a directory of the host, e.g. a working copy (ADR 0022):

```yaml
apiVersion: tendworks.dev/v1
kind: Workspace
metadata:
  name: app
spec:
  directory:
    path: /srv/tendworks/workspaces/app
```

1. Put the directories under one root and set it in `deploy/.env`: `TEND_WORKSPACE_ROOTS=/srv/tendworks/workspaces`. The stack mounts the root read-only into server and worker at the same path; sandboxes only ever get the workspace's own directory.
2. Let the sandbox user (uid 1000) write there: `sudo chown -R 1000:1000 /srv/tendworks/workspaces/app` (or group access).
3. `docker compose -f deploy/compose.yaml up -d --wait`.

What the platform enforces:

- The path must lie strictly under the root, also after resolving `..` and symbolic links; the root itself is refused. Anything else stops server and worker at startup (`workspace 'app': directory … is not under a workspace root`), and a link changed later fails the session before its sandbox starts.
- Only one agent session at a time works in a directory, or in a directory inside or around it; a second one fails with `directory … is in use by another agent session (task …)`. The worker keeps these claims in memory, so a restart frees them.
- Read-write by default; sessions that may only read (e.g. a read-only assistant) get it read-only.
- The platform never deletes or cleans the directory: it is as recoverable as you keep it (a git working copy is a good choice).

The compose stack supports one root, since it mounts the variable as one directory. Server and worker accept several roots separated by `:`, for a deployment that mounts each of them read-only at the same path.

## Secrets

All secrets live in `deploy/.env`. Configuration only references them (ADR 0008).

### Inventory

| Secret | Purpose | Held by | Minimal scope | Generate | If it leaks |
| --- | --- | --- | --- | --- | --- |
| `TEND_API_TOKEN` | full access to the control plane API: start runs, decide approvals, chat; every read except `GET /status` | server, worker (for workflow `call: http` and `call: approval` to the API), you (`tend`, UI, scripts). Never a sandbox | one shared token, no scopes (ADR 0014) | `scripts/setup-env.sh`; at least 16 characters | anyone who reaches the API can do everything you can, including deciding approvals |
| `TEND_API_READ_TOKEN` | read-only API access (403 on writes); the platform MCP server reads with it | server, worker, and the Claude Code session of profiles with `mcp: [tendworks]` (as an MCP header, not as an environment variable); optionally you for a read-only UI | read only; must differ from `TEND_API_TOKEN` | `scripts/setup-env.sh`; at least 16 characters | all runs, transcripts, chats, triggers and agents can be read |
| `TEND_POSTGRES_PASSWORD` | database password of user `tend`; no default, server and worker refuse to start without it | postgres, server, worker (which encode it into their connection) | — | `scripts/setup-env.sh` (or `openssl rand -hex 32`) | low while the store is not published; full read/write of all platform state for anyone who reaches it |
| `TEND_CLAUDE_CODE_CREDENTIAL` | selects `oauth-token` or `api-key`; only the selected variable enters a sandbox | worker | — | — | not a secret |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code with your subscription | worker → every Claude Code sandbox, in the agent process's environment | — | `claude setup-token` | model usage on your subscription |
| `ANTHROPIC_API_KEY` | Claude Code with an API key, billed per use | worker → every Claude Code sandbox, as above | a key for this purpose only; spend limits in the Anthropic Console | Anthropic Console | spend on your API account |
| `TENDWORKS_AGENT_GITHUB_TOKEN` | credential of the `playground` workspace: git clones and pushes with it, the `developer` agent opens the pull request with it (`GH_TOKEN` in the sandbox) | `agent-secrets` file → worker → sandboxes of tasks in that workspace | [GitHub access](#before-the-first-real-run-github-access) | fine-grained token | push to any branch and open, edit or merge pull requests in its repositories |
| `TENDWORKS_PLATFORM_GITHUB_TOKEN` | the trigger reads issues | server only, never a sandbox | as above | fine-grained token, issues read only | read issues in its repositories |

Notes:

- **Credential terms.** `oauth-token` is a subscription token, for single-operator use only under Anthropic's terms. If anyone else uses your installation, use `api-key`.
- **Agents read their own secrets.** Nothing stops an agent (or code it runs) from reading the credential and the workspace's credential (`TENDWORKS_GIT_PASSWORD`, and `GH_TOKEN` where the workspace exposes it) in its environment and sending them anywhere: there is no egress allowlist yet. Transcripts and replies redact the values (`***`), which protects the logs, not the secret.
- **A task needs the secrets of its profile and its workspace only**: `hello-developer` works without a workspace and needs no repository token; a task in a workspace whose secret is not set fails, naming it.

### Secret references (ADR 0008)

Configuration never holds a value, only `{ secretRef: { name: <NAME> } }`, resolved at every use:

| Who references | May resolve | Example |
| --- | --- | --- |
| workspaces (`spec.credentials`, handed into sandboxes) | only `TENDWORKS_AGENT_*` | `credentials: { secretRef: { name: TENDWORKS_AGENT_GITHUB_TOKEN }, env: GH_TOKEN }` |
| agent profiles (`spec.env`, handed into sandboxes) | only `TENDWORKS_AGENT_*` | `API_KEY: { secretRef: { name: TENDWORKS_AGENT_SEARCH_KEY } }` |
| trigger bindings | only `TENDWORKS_PLATFORM_*` | `token: { secretRef: { name: TENDWORKS_PLATFORM_GITHUB_TOKEN } }` |

A reference outside its prefix is a configuration error at startup. `TEND_API_TOKEN`, `TEND_API_READ_TOKEN` and the database URL can never be referenced.

**Adding an agent secret:**

1. Add `TENDWORKS_AGENT_<NAME>=<value>` to `deploy/.env`.
2. Reference it in the workspace's `spec.credentials` or the profile's `spec.env`.
3. `docker compose -f deploy/compose.yaml up -d --wait` (and `restart server worker` for the configuration change).

No compose edit: the one-shot service `agent-secrets` gets `deploy/.env` as a whole, has no network, writes only its `TENDWORKS_AGENT_*` variables to `agent-secrets.json` (mode 600) on the volume `<installation>_agent-secrets` and ends. The worker reads that file at every reference and never sees the platform's secrets. Only `deploy/.env` counts: not variables exported in your shell, not a file given with `--env-file`. A new `TENDWORKS_PLATFORM_*` secret still needs a line in the `server` environment of `deploy/compose.yaml`.

### Handling

- `deploy/.env` belongs to the operator: mode 600, owned by your user (`scripts/setup-env.sh` does both). Back it up yourself, securely; [backups](#backup-and-restore) don't contain it.
- Never put a secret into the configuration directory or its repository.
- Don't paste tokens on the command line where shell history keeps them; read them from the file (`$(grep '^TEND_API_TOKEN=' deploy/.env | cut -d= -f2-)`).
- Encrypted secrets in Git (SOPS) and a secret store (OpenBao) are the stated future direction; neither exists yet.

### Rotation

| Secret | Steps |
| --- | --- |
| API token, read token | change `deploy/.env`, `up -d --wait` (server and worker get the new value), re-export it for `tend`, sign in again on every device |
| Claude Code credential, agent secrets | change `deploy/.env`, `up -d --wait`. Agent secrets need no worker restart; a recreated worker resumes interrupted sessions in a new sandbox |
| platform GitHub token | change `deploy/.env`, `up -d --wait` (server) |
| Postgres password | the store applies `POSTGRES_PASSWORD` only when it initialises an empty volume, so changing `.env` alone breaks the connection. Change it in the database first with `ALTER USER` (`docker compose -f deploy/compose.yaml exec postgres psql -U tend -d tend -c "ALTER USER tend PASSWORD '<new>'"`, a value without `'`, e.g. `openssl rand -hex 32`), then in `.env`, then `up -d --wait`. A store created before `v0.2.0` without a password set has the password `tend`. Not exercised by the project; test it on a copy first |

Rotate the API token at once when a device that was signed in is lost.

### Residual risks

- **Agent secrets on a volume.** The `TENDWORKS_AGENT_*` values sit in plain text as a file (mode 600) on the volume `<installation>_agent-secrets` until `down -v` removes it; each `up` rewrites it. A line you delete from `deploy/.env` is gone from the file after the next `up -d`; the old file content stays readable to anyone with Docker access until then.
- **Sandboxes and the API port.** On a Linux engine, sandboxes don't reach the port compose publishes on `127.0.0.1` (checked by `tests/e2e/sandbox-access.test.ts`). On Docker Desktop they reach it through `host.docker.internal`, and only the tokens guard the API. Sandboxes still reach everything else the bridge routes to, including your LAN and the internet.
- **MCP sandboxes reach each other.** Sandboxes of profiles with `mcp: [tendworks]` share the gateway's network and can reach each other on it (ADR 0019). Other sandboxes stay apart. Through the gateway, sandboxes reach only `/mcp`, read-only.
- **The agent token can merge** on repositories without rulesets ([GitHub access](#before-the-first-real-run-github-access)); only its role description tells the agent not to.
- **Token in the browser.** The web UI keeps the token in `sessionStorage`, or in `localStorage` with "Stay signed in on this device" (ADR 0018). Don't tick that on a shared browser.
- **Socket proxy.** It filters paths, not request bodies: whoever reaches it can create a privileged container, i.e. become root on the host. Only the worker reaches it (ADR 0001).
- **Isolation class `container`** shares the host kernel. Put an outer boundary around it (dedicated VM) when agents process untrusted content such as public issues, or verify [gVisor](#optional-gvisor).
- **The engine's web UI** has no login; while it runs (`--profile debug`), every local user of the host can open it. Stop it when you are done.

## Before the first real run: GitHub access

Before any run on a real repository, follow [docs/github-agent-access.md](github-agent-access.md): exactly two kinds of fine-grained token with the narrowest permissions (a read-only issues token for the `github-issues` trigger, an agent token per workspace), and a release process the agent token cannot start. Then check the agent token:

```sh
scripts/check-github-agent-access.sh --repo OWNER/NAME --env-file deploy/.env                # read-only checks
scripts/check-github-agent-access.sh --repo OWNER/NAME --env-file deploy/.env --write-tests  # also push tests, cleans up
```

Every check must pass before you remove `suspend: true` from a binding. Later, `scripts/check-github-agent-access.sh --repo OWNER/NAME --audit 30` lists commits on `main` without a merged pull request.

## Access from your devices

The server binds to `127.0.0.1` only. Reach the UI, API and `tend` from other devices **only through a TLS layer in front of that port on the same host** (ADR 0020). Never publish the port as plain HTTP on the network (`0.0.0.0:8080` in compose, a proxy without TLS, a router port forward): the API token in every request is all that guards full control of agents and approvals. The token stays the sign-in until OIDC.

### Recommended: Tailscale

HTTPS with a certificate your devices trust, reachable only from your tailnet, no port opened on your network, no change to the platform.

1. [Install Tailscale](https://tailscale.com/download/linux) on the host and on your phone and laptop, signed in to the same tailnet.
2. In the tailnet's admin console, enable MagicDNS and HTTPS certificates.
3. On the host:

   ```sh
   sudo tailscale serve --bg 8080
   tailscale serve status        # shows https://<host>.<tailnet>.ts.net
   ```

4. Open `https://<host>.<tailnet>.ts.net/` on the phone and sign in with the API token. From a laptop on the tailnet: `TEND_URL=https://<host>.<tailnet>.ts.net tend status`.

Use `tailscale serve`, never `tailscale funnel`: Funnel publishes the port to the internet. Stop serving with `sudo tailscale serve reset`.

### Alternative: a reverse proxy with your own domain

Without a third party: a reverse proxy on the host (e.g. Caddy or nginx) that terminates TLS for a name in your own domain and forwards to `http://127.0.0.1:8080`.

- Use a certificate your devices trust without extra steps, e.g. from Let's Encrypt with the DNS challenge, so the name need not be reachable from the internet. A private CA needs its root certificate on every device.
- Listen only on the LAN interface; no port forward on the router.
- Pass long-lived responses through unbuffered: transcripts and chats stream as Server-Sent Events (`.../stream`).
- Everyone on your LAN reaches the sign-in page; with Tailscale only your devices do.

### Alternative: an SSH tunnel

Without any extra service: forward the port over SSH, which encrypts the traffic while the server stays on `127.0.0.1`. From a laptop: `ssh -L 8080:localhost:8080 <host>`, then `http://localhost:8080/`. On a phone, an SSH client with port forwarding does the same (for example ConnectBot on Android: a local port forward `8080` → `localhost:8080`, then `http://localhost:8080/` in the phone's browser). The tunnel must be up while you use the UI.

### Locally and for the engine's UI

On the host itself, `http://localhost:8080/` works as is. The engine's UI is for debugging only, through an SSH tunnel:

```sh
docker compose -f deploy/compose.yaml --profile debug up -d temporal-ui
ssh -L 8233:localhost:8233 <host>        # on the laptop, then http://localhost:8233
docker compose -f deploy/compose.yaml stop temporal-ui
```

## Known gaps

| Area | State |
| --- | --- |
| Stack, sandboxes, MCP gateway, token checks, clean-up, installation names, backup and restore | covered by the end-to-end tests on Ubuntu CI (`.github/workflows/ci.yml`, scripted agent in real sandboxes) |
| Real Claude Code, pull request, `assistant` chat on a Linux host | documented smoke tests; recorded on Linux with the milestone 2 [acceptance](#acceptance-checklist) |
| `gvisor` isolation class | not verified yet (issue #17); [optional step](#optional-gvisor) |
| Background work of agents | an agent can end its turn with a command still running in the background; the work is lost when the sandbox goes (issue #23) |
| Retention | nothing ages out: store, transcripts and the volumes of chats nobody ends grow forever (follow-up of issue #48). Watch the disk (`docker system df -v`) |
| Notifications | delivered only to the configured notification channels (Pushover, or `fake` to the server log); without one they are only recorded. `tend notification list` shows the delivery status per channel |

A chat profile without the platform MCP server, e.g. `agents/helper.md` in your configuration:

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

### Optional: gVisor

The adapter runs sandboxes of templates with `spec.isolationClass: gvisor` with the Docker runtime `runsc` (ADR 0001).

1. Install `runsc` as in [gVisor's installation guide](https://gvisor.dev/docs/user_guide/install/) and register it with Docker (`sudo runsc install`, then `sudo systemctl restart docker`; the stack comes back by itself).
2. Check Docker: `docker run --rm --runtime=runsc busybox dmesg` prints gVisor's kernel messages.
3. Add a template to your configuration, e.g. `sandboxes/claude-code-gvisor.yaml` with `spec.isolationClass: gvisor`, point a profile's `spec.sandbox` at it and restart server and worker.
4. Run `hello-developer` with that profile; while it works, `docker inspect --format '{{.HostConfig.Runtime}}' <sandbox>` says `runsc`. Without the runtime the run fails with `isolation class gvisor needs the runsc runtime on the sandbox host`.

## First test workloads

The smoke tests in [docs/platform-implementation.md](platform-implementation.md) are the walkthrough; most are scripted in `scripts/smoke/` (bash, PASS or FAIL). They need the stack up, `deploy/.env` filled in and `TEND_API_TOKEN` exported; the GitHub ones need `gh` logged in. The scripts check the configuration the stack mounts (`TEND_CONFIG_PATH` from the shell or `deploy/.env`, else `examples/config`).

| # | Workload | How | Needs |
| --- | --- | --- | --- |
| 1 | Claude Code answers in a sandbox, cost and transcript visible | `scripts/smoke/hello-developer.sh` | sandbox image, Claude credential, agent token |
| 2 | Restart mid-run resumes the agent session | `scripts/smoke/restart-developer.sh` | as 1 |
| 3 | Labelled issue → the agent opens a pull request → the run completes with it; the pull request stays open for you | `scripts/smoke/pull-request.sh <issue>` | platform token (issues read), agent token; `suspend: true` removed from the binding; server restarted |
| 4 | `assistant` chat answers from the live state | `tend chat assistant` or the UI; the full script `scripts/smoke/chat-assistant.sh` needs the fixture configuration (implementation doc, step 16) | read token |
| 5 | Web UI with live run, chat, phone width | by hand in the browser (implementation doc, steps 19–23) | as 3 and 4 |

- **Each labelled issue starts one paid run, once** (ADR 0006). The scripts refuse to run while other open issues carry `ready-for-agent`. A failed issue is not retried; start it again by hand with `POST /runs` (implementation doc, "Triggers: one firing per issue").
- Revert configuration changes after the tests, or keep them deliberately.
- Watch a run live: `tend run logs <id> --follow`, or the run detail in the UI.

## Operations

### Everyday commands

| Task | Command |
| --- | --- |
| Status | `tend status`, `curl -s localhost:8080/status` |
| Services | `docker compose -f deploy/compose.yaml ps` (`-a` shows `agent-secrets` as `Exited (0)`) |
| Logs | `docker compose -f deploy/compose.yaml logs -f server worker` (add `--tail 100`); the server log lists the loaded configuration at startup and every notification |
| Runs | `tend run list`, `tend run get <id> [-o yaml]`, `tend run logs <id> [--follow]` |
| Start a run by hand | `curl -X POST localhost:8080/runs -H "authorization: Bearer $TEND_API_TOKEN" -H 'content-type: application/json' -d '{"workflow":"hello-developer"}'` |
| Approvals | `tend approval list --pending`, `tend approval get <id>` (question, links, answers), `tend approval answer <id> "<answer>"` |
| Notifications, triggers, agents | `tend notification list`, `tend trigger list` (last check per binding), `tend agent list` (active sessions per profile) |
| Chats | `tend chat <profile>`, `tend chat list`, `tend chat attach <id>`, `tend chat end <id>` |
| Live sandboxes | `docker ps --filter label=dev.tendworks.installation=tendworks --filter label=dev.tendworks.sandbox` |
| After a configuration change | `docker compose -f deploy/compose.yaml restart server worker` |
| After a change to `deploy/.env` | `docker compose -f deploy/compose.yaml up -d --wait` |
| Stop / start | `docker compose -f deploy/compose.yaml stop`, `... up -d --wait` (a stopped stack stays down after a reboot) |

### Where data lives

| Data | Location | Backup | Removed by `down -v` |
| --- | --- | --- | --- |
| platform state (runs, tasks, chats, approvals, notifications, event outbox; each domain's `schema_migrations`) | volume `tendworks_postgres-data` | yes | yes |
| workflow execution history | volume `tendworks_temporal-data` | yes | yes |
| transcripts | volume `tendworks_transcripts` | yes | yes |
| agent secrets (from `deploy/.env`) | volume `tendworks_agent-secrets` | no (recreated on `up`) | yes |
| agent sessions (workspace, harness home) | volumes `tendworks-volume-<task>-workspace` and `-session`, labels `dev.tendworks.installation`, `dev.tendworks.volume`, `dev.tendworks.owner` (the task); removed when a task or chat ends, kept while a chat is open | no | **no** ([clean-up](#clean-up-of-sandboxes-and-session-volumes)) |
| sandboxes | containers `tendworks-sandbox-<id>`, labels `dev.tendworks.installation`, `dev.tendworks.sandbox`, `dev.tendworks.owner` | no | **no** ([clean-up](#clean-up-of-sandboxes-and-session-volumes)) |
| sandbox network | `tendworks-sandboxes`, labels `dev.tendworks.installation`, `dev.tendworks.sandbox-network` | no | **no** |
| MCP gateway network | `tendworks_platform-mcp` | no | yes, once no sandbox is attached ([Reset](#reset)) |
| images | `tendworks-server`, `tendworks-worker`, `tendworks-agent-secrets`, `tendworks/sandbox-claude-code:<tag>` | no | **no** |

Names assume the installation `tendworks`; with another `COMPOSE_PROJECT_NAME`, replace it.

### Clean-up of sandboxes and session volumes

When the worker starts and every 5 minutes, it removes the sandboxes and session volumes of its installation that belong to no live task and no open chat: leftovers of failed removals, of a worker that died, or of a store that was reset or restored.

- It removes only what carries both its installation's label (`dev.tendworks.installation`) and an owner label (`dev.tendworks.owner`, the task). Resources from before `v0.2.0` have neither and are never removed automatically, since other stacks on the engine used the same names; review and remove them by hand ([Reset](#reset)). Sandboxes go before their volumes.
- It removes an orphan only once it is 10 minutes old (`sandbox clean-up: keeping ... until it is 10 minutes old` until then), so it never races a task that is just starting.
- A pass that cannot read the live tasks and chats (e.g. the store is unreachable) removes nothing; it is reported like a failed removal and retried.
- It keeps everything of running tasks and open chats, including the volumes of an idle chat and of a run's task that waits to be resumed.
- Each removal is logged: `sandbox clean-up: removed sandbox <id> of <task>, ...` (`docker compose -f deploy/compose.yaml logs worker`).
- A failed removal is logged (`sandbox clean-up: cannot remove ...`), and `/status` shows `sandbox-cleanup` unhealthy until a later pass succeeds. A removal that fails while a task or chat ends is recorded as an `error` entry in its transcript.
- It never removes networks, images or store data.

### Update

Downgrades are not supported; the way back is the backup taken before the update.

1. Read the release notes of the new tag (`docs/releases/<tag>.md`, also on the GitHub release): migrations, configuration changes, steps.
2. Back up, preferably while no run is active:

   ```sh
   scripts/backup.sh --output-dir /mnt/backup
   ```

3. Check out the new tag and rebuild:

   ```sh
   git fetch --tags
   git checkout <tag>
   docker compose -f deploy/compose.yaml --profile sandbox-images build    # when the sandbox image pin changed
   docker compose -f deploy/compose.yaml up -d --build --wait
   pnpm install && pnpm build                                              # the tend CLI
   ```

4. Check: `tend status` is healthy, and the logs show `store <domain>: migrated from version <n> to <m>` for each migration of the release.

- Your configuration is not touched; apply configuration changes the notes name in your own repository. An invalid configuration stops the server (see the log).
- A template that names `tendworks/sandbox-claude-code` without a tag follows the pin in `deploy/compose.yaml`.
- **Migrations:** each domain migrates its own tables at startup, each migration in its own transaction under a lock, so concurrent starts migrate once. A failed migration is rolled back; the bundle then stops working but keeps running ([ADR 0021](adr/0021-a-failed-migration-stops-the-bundle-not-the-process.md)): the server answers only `GET /status` (every other path 503 `Platform stopped`), the worker only `/health` (every other path 503 `Worker stopped`, so API requests that need the worker, such as runs and chats, fail with 503), and `/status` shows the component `<schema>-schema` unhealthy with the error. The other bundle keeps running. `up --wait` does not notice this, hence step 4. Then:
  - fix the cause the log names and `up -d` again (the next start retries), or
  - go back: stop the stack, `down -v`, check out the previous tag, [restore](#backup-and-restore) the backup of step 2 and start. Checking out the previous tag alone is not enough when another domain already migrated: the old release refuses a store newer than it knows.

### Backup and restore

`scripts/backup.sh` writes one archive `<installation>-backup-<UTC time>.tar.gz` (mode 600) into `backups/` of the checkout, or into `--output-dir`. It holds a dump of the store, the engine's state and the transcripts, taken together while server, worker and engine are stopped (usually under a minute); the stack is started again afterwards. Runs that were working at backup time continue after a restore.

```sh
scripts/backup.sh                            # archive in backups/
scripts/backup.sh --output-dir /mnt/backup   # elsewhere; keep a copy off the host
```

Restore into a stack without data, after a [reset](#reset) or on a new host with the same `deploy/.env` and configuration (images built as under [Install](#install)):

```sh
scripts/restore.sh backups/tendworks-backup-<time>.tar.gz
docker compose -f deploy/compose.yaml up -d --wait
```

- The restore refuses a running stack and a stack that holds data, and leaves the stack stopped.
- A backup of an older release is migrated on start; one of a newer release is refused by the server.
- Both scripts take `--env-file` and `--project-name` and follow `COMPOSE_PROJECT_NAME`, like compose.
- **Not in a backup:** `deploy/.env`, your configuration (keep it in its own repository) and session volumes (an agent's workspace and conversation). Where they are gone after a restore (after a [reset](#reset), on a new host):
  - a run that was working continues; its working step's agent starts a new session from the step's message, in an empty workspace (checked out again if the step names a repository);
  - an open chat stays open with its transcript; its next turn (or the turn that was interrupted) starts a new agent session without the earlier conversation, in an empty workspace (checked out again if the chat names a repository).
  - session volumes still on the engine (a restore on the same host without a reset of them) are used as they are.
- **Archives are sensitive:** they hold chat content, run inputs and transcripts (no tokens from `deploy/.env`). Keep them mode 600 and encrypt copies off the host.
- Schedule backups yourself, e.g. a nightly cron job with `--output-dir`; nothing prunes old archives.

### Reset

Deletes all platform data of the installation and leaves nothing behind:

```sh
docker compose -f deploy/compose.yaml stop worker
docker rm -f $(docker ps -aq --filter label=dev.tendworks.installation=tendworks --filter label=dev.tendworks.sandbox)
docker compose -f deploy/compose.yaml down -v
docker volume rm $(docker volume ls -q --filter label=dev.tendworks.installation=tendworks --filter label=dev.tendworks.volume)
docker network rm tendworks-sandboxes
```

- `down -v` removes the containers, the gateway's network and the volumes `postgres-data`, `temporal-data`, `transcripts` and `agent-secrets`: all runs, chats, approvals, notifications and transcripts.
- It does **not** remove sandboxes, session volumes, the sandbox network or images, hence the other commands. A stack started again on an empty store would remove leftover sandboxes and session volumes with its clean-up, but a reset should not depend on that.
- Remove the sandboxes before `down`, with the worker stopped so it starts none meanwhile: while a sandbox of an MCP profile is attached to the gateway's network, `down` leaves that network behind ("Resource is still in use").
- Replace `tendworks` with your installation name if you set one.
- **Resources from before `v0.2.0`** have no installation label, so neither the clean-up nor the commands above touch them. Stop every stack older than `v0.2.0` on the engine first, list them, check the list (other stacks used the same names then), and remove what you reviewed:

  ```sh
  docker ps -a --filter label=dev.tendworks.sandbox --format '{{.Names}}\t{{.Label "dev.tendworks.installation"}}\t{{.Status}}' | awk -F'\t' '$2 == ""'
  docker volume ls --filter label=dev.tendworks.volume --format '{{.Name}}\t{{.Label "dev.tendworks.installation"}}' | awk -F'\t' '$2 == ""'
  docker rm -f <sandbox names you reviewed>
  docker volume rm <volume names you reviewed>
  ```

### Cleaning images

| What | Command |
| --- | --- |
| list | `docker image ls --filter reference='tendworks*' --filter reference='tendworks/*'` |
| old sandbox image after a pin update | `docker image rm tendworks/sandbox-claude-code:<old tag>` |
| test image | `docker image rm tendworks/sandbox-scripted-acp:test` |
| images of other compose projects (e.g. e2e stacks, ~0.9 GB each) | `docker image ls --format '{{.Repository}}:{{.Tag}} {{.Size}}' \| grep -E -- '-(server\|worker\|agent-secrets):'`, then `docker image rm` |
| build cache | `docker builder prune` |

## Troubleshooting

| Symptom or message | Where | Cause and fix |
| --- | --- | --- |
| `TEND_API_TOKEN is not set; ...` (same for `TEND_API_READ_TOKEN`) | server log, server exits and restarts | no `deploy/.env`, or the token is empty; `scripts/setup-env.sh` (or `openssl rand -hex 32`), then `up -d --wait` |
| `TEND_API_TOKEN must be at least 16 characters; ...` (same for `TEND_API_READ_TOKEN`) | server log | token too short; `openssl rand -hex 32`, then `up -d --wait` |
| `TEND_API_READ_TOKEN must differ from TEND_API_TOKEN, ...` | server log | use two different values |
| `TEND_POSTGRES_PASSWORD is not set; ...` | server or worker log, exits and restarts | add it to `deploy/.env` (`openssl rand -hex 32` for a new store; for a store created before `v0.2.0` without one: `tend`, or change it, [Rotation](#rotation)), then `up -d --wait` |
| `password authentication failed for user "tend"` | server or worker log | `TEND_POSTGRES_PASSWORD` differs from the store's password, which the store took when it was created; set the old one or change it with `ALTER USER` ([Rotation](#rotation)) |
| `<file>: neither a workflow nor a document with a kind ...`, `unknown kind`, `invalid YAML`, `... calls agent://<x>, but no agent profile '<x>' is configured` | server or worker log, exits | configuration invalid; the log lists every issue. Stray YAML counts (hidden directories such as `.github/` are skipped) |
| `invalid configuration: trigger binding '<x>': github-issues reads ... but the binding names no workspace`, `... workspace '<y>' is not a repository on github.com (...)` or `... is not a git repository` | server log, exits | a `github-issues` binding needs workspaces, each a git workspace whose `url` is `https://github.com/<owner>/<name>`; fix `spec.workspaces`, `restart server` |
| `schema <schema>: migration <n> (<name>) failed: ...` or `... newer than this release knows ...; downgrades are not supported`; `/status` shows `<schema>-schema` unhealthy; every other request answers 503 `Platform stopped` (server) or `Worker stopped` (worker) | server or worker log, `/status` | see [Update](#update), migrations: fix and `up -d`, or go back with the backup |
| `missing environment variable <NAME>` | server or worker log | a bundle setting is missing; only happens with a modified compose file |
| `harness claude-code: TEND_CLAUDE_CODE_CREDENTIAL must be oauth-token or api-key but is not set; ...` | worker log, warning at start | set the selector and the matching variable, `up -d --wait` |
| run fails: `no harness credential configured: ...` | `tend run get` | as above |
| `TEND_CLAUDE_CODE_CREDENTIAL selects api-key, but ANTHROPIC_API_KEY is empty` | worker log | fill the selected variable |
| run fails: `workspace: secret TENDWORKS_AGENT_GITHUB_TOKEN is not set` | `tend run get`, worker log warning | add the line to `deploy/.env` (not your shell), `up -d --wait` |
| run fails: `no workspace 'NAME' is configured` | `tend run get` | the run's input names a workspace no `Workspace` document declares: add it or fix the name, `restart server worker` |
| `... is not an agent secret: agents may only reference TENDWORKS_AGENT_* secrets` (or `platform integrations may only reference TENDWORKS_PLATFORM_*`) | log, run | a reference outside its prefix; rename the variable |
| `tend trigger list` shows `failed ... secret TENDWORKS_PLATFORM_GITHUB_TOKEN is not set` | `LAST CHECK` | the token did not reach the server; set it, `up -d --wait` (`restart` keeps the old environment) |
| binding never checks | `tend trigger list` | `spec.suspend: true`; remove it and restart the server |
| issue labelled but no new run | | each issue fires once per binding, also after a failed run (ADR 0006); start it by hand with `POST /runs` |
| run completes without `pullRequest` in its output | `tend run get`, `tend run logs <id>` | the agent opened or reported no pull request, e.g. the agent token lacks Contents or Pull requests write access |
| `cannot create a sandbox from template claude-code: image tendworks/sandbox-claude-code:<tag> is not on the sandbox host` | run or chat | build the sandbox image (`--profile sandbox-images build`) |
| `isolation class gvisor needs the runsc runtime on the sandbox host` | run or chat | [install gVisor](#optional-gvisor) or use isolation class `container` |
| `agent profile assistant lists the platform MCP server, but none is configured: ...` | chat or run | the worker lacks the read token; set `TEND_API_READ_TOKEN`, `up -d --wait` |
| the `assistant` cannot reach its tools; `FAIL: a sandbox cannot use the platform MCP server at ...` | chat, `chat-assistant.sh` | `docker compose -f deploy/compose.yaml ps mcp-gateway` and `logs mcp-gateway`; remove a custom `TEND_PLATFORM_MCP_URL` (e.g. an old `host.docker.internal` value) from `deploy/.env`, `up -d --wait` |
| `Network <installation>_platform-mcp Resource is still in use` | `down` | sandboxes of MCP profiles are still attached; remove the installation's sandboxes ([Reset](#reset)), then `down` again |
| `the control plane refused the token (HTTP 401); ...` | `tend` | export the value from `deploy/.env` (or pass `--token`) |
| 403 with a reason on a write | `tend`, UI | you used the read-only token |
| `The control plane at http://localhost:8080 does not answer.` | smoke scripts, `tend` | stack down or server exited; `docker compose ... ps` and `logs server --tail 20` |
| UI not reachable from the phone | browser | `tailscale serve status` on the host; the phone signed in to the tailnet; HTTPS certificates enabled in the tailnet |
| `/ui/` answers 404, log says `web UI: no build at ...` | server log | the image has no UI build; `up -d --build` |
| stack down after a reboot | `docker compose ps` | Docker not enabled at boot (`sudo systemctl enable docker`), or you stopped the stack before (`stop` survives a reboot); `up -d --wait` |
| `sandbox clean-up: cannot remove ...`; `sandbox-cleanup` unhealthy | worker log, `/status` | the sandbox backend refused a removal (e.g. a volume mounted by a container outside the platform); remove what holds it (`docker inspect`); the next pass retries within 5 minutes, or restart the worker |
| sandboxes or volumes left after tests | `docker ps -a`, `docker volume ls` | a running stack of that installation removes its own; for a stack that is gone, [Reset](#reset) |
| restore: `the stack is running` or refused over data | `scripts/restore.sh` | `docker compose -f deploy/compose.yaml stop`, then [Reset](#reset), then restore again |

## Acceptance checklist

Milestone 2 is accepted on the operator's Ubuntu host by following only this guide (success criterion in `docs/platform-architecture.md`, issue #66). Record each result in #66.

| # | Check | How | Passes when |
| --- | --- | --- | --- |
| 1 | Fresh installation | [Install](#install) from the release candidate tag, with `scripts/setup-env.sh` and your own configuration directory | `tend status` healthy; `scripts/smoke/hello-developer.sh` PASS |
| 2 | GitHub access, then `develop-issue` on a private repository | [GitHub access](#before-the-first-real-run-github-access), then `scripts/smoke/pull-request.sh <issue>` or the binding with the issue labelled | the check script passes for the narrowed agent token; the run completes with the pull request the agent opened, and the pull request is open for you to merge |
| 3 | `assistant` chat from live state | `tend chat assistant` or the UI, while a run works: "Is an agent running right now?", "Were the last runs successful?", "When does the developer agent run next?" | each answer comes with a `tendworks` tool call and matches `tend run list`, `tend agent list`, `tend trigger list` |
| 4 | Web UI on the phone over HTTPS | [Tailscale](#recommended-tailscale) | sign-in, status, a run's live transcript and a chat work at phone width; `http://` is never used |
| 5 | Host reboot during a run | start `restart-developer`, `sudo reboot` while it works | the stack comes back by itself and the run completes with `resumed: 1` |
| 6 | Update | [Update](#update) to the next tag | `tend status` healthy, migrations logged, runs, chats and transcripts kept |
| 7 | Backup and restore | `scripts/backup.sh`, [Reset](#reset), `scripts/restore.sh <archive>`, `up -d --wait` | runs, chats and transcripts are back |
| 8 | Nothing left behind | `scripts/check-github-agent-access.sh --repo OWNER/NAME --audit 30`; after all runs and chats ended, `docker ps -a --filter label=dev.tendworks.sandbox`, `docker volume ls --filter label=dev.tendworks.volume` | no direct pushes to `main`; no sandbox or session volume without a live task or open chat; `sandbox-cleanup` healthy |
| 9 | Optional: gVisor (#17) | [Optional: gVisor](#optional-gvisor) | the run completes in a `runsc` sandbox |
