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
    platform/                # platform library, not a domain: CloudEvent envelope and trace context, secret references, Server-Sent Events
  apps/
    server/                  # walking skeleton: bundles control-plane, trigger-gateway, human-interaction, mcp-platform
    worker/                  # walking skeleton: bundles orchestration, agent-runtime
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
| `server` | control plane API, MCP server for chats (milestone 1b), web UI (milestone 1c), time trigger | yes |
| `worker` | workflow interpreter, agent runtime with ACP | yes |
| `sandbox-claude-code` | sandbox image, started via Docker (isolation class `container`, `gvisor` opt-in) | yes |
| Keycloak, NATS, S3, model gateway, OPA, observability |  | later; transcripts and checkpoints on a local volume, merge policy as a switch; the API is guarded by one bearer token (`TEND_API_TOKEN`) until OIDC (ADR 0014 (interim-bearer-token-on-the-control-plane-api)), from milestone 1b plus a read-only token for chat agents (ADR 0016 (chat-agents-read-the-platform-through-mcp-with-a-read-only-token)) |
| tend CLI | second client on the same API | yes, minimal: tend status, tend run list/get, tend agent list, tend trigger list, tend notification list, tend approval list/approve, tend run logs [--follow], tend chat <profile> [--repo <url>], tend chat list/get/attach/end |
| Docker socket proxy | the only way the sandbox adapter reaches the Docker API; exposes only `/_ping`, `/version`, `/containers`, `/exec`, `/volumes` and `/networks` (writes allowed; networks for creating the sandbox network once), not images, so sandbox images must already be on the host. It filters paths, not request bodies: whoever reaches it can still create a privileged container, so only the worker may reach it | yes |
| web UI | run list, run detail, notifications, chat | milestone 1c |

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
- **Contracts only as far as used.** OpenAPI and JSON Schemas cover only what the current slice uses; types are always generated from them, never written by hand. Contract tests follow in S5 (ADR 0013 (contract-and-port-fitness-functions)): `tests/contract` checks the HTTP APIs and events against their contracts, `tests/architecture` checks product names and ports.
- **Interpreter grows with demand.** `listen` and `switch` are added when the merge gate needs them, test-driven.
- **Event bus with its first consumer.** The control plane reads runs synchronously through the orchestration API (`contracts/openapi/orchestration.yaml`, served by the worker). Run and step events go onto the event bus in the transaction of the run state (ADR 0003, ADR 0005); the first consumer is human interaction, which records a notification for every completed or failed run and every approval request before delivering it. Human interaction publishes `approval.requested` and `approval.decided` the same way; orchestration consumes every other domain's event that names a run and hands it to that run's `listen` tasks.
- **Resume is tested from S1 on**, not at the end.
- **Policies are YAML before they are Rego.** The architecture names Rego evaluated by OPA for policies; the skeleton has no OPA. Until it does, a policy is a configuration document `kind: Policy` (`contracts/schemas/policy.schema.yaml`, `spec.merge: auto | ask`, optionally `spec.workflows`), evaluated by a pure decision function `decide()` in human interaction (`allow | ask`, the strictest applicable policy wins). The function's signature is the seam a policy engine replaces later; the `kind: Policy` documents then become Rego modules with tests.

### Triggers: one firing per issue

A trigger binding starts at most one run per matching issue, also when that run fails, so a persistently failing issue never starts a paid run at every check (ADR 0006 (trigger-gateway-fires-once-per-issue-through-the-public-api)). To retry an issue, start the workflow by hand with the same input, e.g. `curl -X POST localhost:8080/runs -H "authorization: Bearer $TEND_API_TOKEN" -H 'content-type: application/json' -d '{"workflow":"develop-issue","input":{"issue":{...}}}'`; that run is recorded as started `manual`. `tend trigger list` shows each binding's last check (`LAST CHECK`): a check that could not ask its source (rate limit, API error, a secret that is not set) or could not start a run is `failed` with the reason. A suspended binding (`spec.suspend: true`) is never checked on its schedule.

## Claude Code harness

Agent profiles with `harness: claude-code` run Claude Code through `@agentclientprotocol/claude-agent-acp` (pinned in `images/sandbox-claude-code/package-lock.json`) in a sandbox from the profile's sandbox template. The agent runtime attaches to the adapter's stdio through the sandbox API, marks the harness onboarding complete and sets `bypassPermissions` in the session's config before it starts (for a profile with `attribution: false` also an empty `attribution` setting, so Claude Code adds no co-author trailers, generated-with lines or session links to commits and pull requests), records the ACP stream as product-neutral transcript entries and destroys the sandbox when the session ends (ADR 0007 (agent-runtime-records-transcripts-and-cost-from-acp), ADR 0017 (live-agent-output-streams-through-the-api-not-the-event-bus)). A running step names its task and transcript as soon as the agent runtime created the task; the control plane reads the transcript through the agent runtime API (`contracts/openapi/agent-runtime.yaml`, served by the worker), and `tend run logs <id>` prints it. The agent runtime API also serves a transcript live as Server-Sent Events (`GET /tasks/{taskId}/transcript/stream`: one `entry` event per entry with its position as event id, then `end` when the task ends); the control plane passes the stream through unchanged (`GET /runs/{runId}/tasks/{taskId}/transcript/stream`), a client that reconnects with `Last-Event-ID` continues right after that entry, and `tend run logs <id> --follow` streams the steps of a run one after another until the run ends. Live entries come from the worker process that runs the task (in memory, nothing on the event bus); with one worker that is enough (ADR 0017 consequence), and its connections are cut on shutdown so clients reconnect. Chats (ADR 0015 (a-chat-is-an-a2a-task-without-a-run)) use the same path: a profile with `spec.chat` can be chatted with through `POST /chats` (agent runtime API and control plane alike, plus `GET /chats`, `GET /chats/{chatId}`, `POST /chats/{chatId}/messages`, `POST /chats/{chatId}/cancel`, `POST /chats/{chatId}/end` and the chat's transcript and stream); the chat is one A2A task (kind `chat` in `agent_runtime.tasks`) that waits in `input-required` between turns, each turn is one more prompt in the same ACP session, the sandbox stays between turns until the profile's `spec.chat.idleMinutes` pass without a message, then it is destroyed and the volumes stay; the next message resumes the session (`session/resume`) in a new sandbox, as after a restart, and the transcript shows `session-resumed`. On start the worker takes up the chats that have not ended (`AgentRuntime.resumeChats`): a turn a restart interrupted continues in the resumed session (with a `task-resumed` entry), and waiting chats lose their sandbox when their idle time is over. Ending a chat removes sandbox and volumes. A message during a turn is refused with 409; cancelling the turn instead sends ACP `session/cancel` and answers once the turn stopped (`turn-ended` with reason `cancelled`), with the chat waiting for the next message; an agent that does not stop within a grace period loses its harness process, and the next turn resumes the session in a new sandbox. The transcript marks each turn's end with an `input-required` entry and each further message with `message-received`. `chat.started` and `chat.ended` go onto the event bus in the transaction of the task. `tend chat <profile>` sends the lines the operator types and streams the agent's output; `tend chat attach <id>` prints a chat's history and continues it the same way, from any number of clients at once (each sees every entry, any of them can send the next message). Ctrl+C cancels a running turn and leaves the chat open while the agent waits; `/end` ends the chat, end of input leaves it open. `tend chat list`, `tend chat get <id>` (both with `-o yaml|json`) and `tend chat end <id>` complete the set. `tend chat <profile> --repo <url>` (the `repository` field of `POST /chats`) starts the chat with a public repository checked out as its workspace: the first message carries it as task workspace without a branch (ADR 0010), the checkout runs without a token before the first turn and stays on the repository's default branch; the agent runtime refuses anything but an `https`/`http` URL without user name or password with 400, and a checkout that fails fails the chat with git's reason. A chat without a repository starts with an empty workspace. The regular test suites use a scripted ACP agent behind the fake sandbox. The end-to-end suite runs the harness on the real path with a scripted ACP agent image instead of Claude Code (`images/sandbox-scripted-acp`, workflow `restart-scripted`): sandbox through the socket proxy, session volumes, ACP over the attached stdio, and `session/resume` in a new sandbox after a platform restart (`tests/e2e/restart-acp.test.ts`). `pnpm e2e` builds that image; the harness still needs a credential selected (`TEND_CLAUDE_CODE_CREDENTIAL=api-key` with any `ANTHROPIC_API_KEY` will do, as in CI), and the test is skipped without one. The real harness with Claude Code is a manual smoke test:

1. Build the sandbox image: `docker compose -f deploy/compose.yaml --profile sandbox-images build`.
2. In `deploy/.env` set `TEND_API_TOKEN` (`openssl rand -hex 32`; export it in your shell too, the `tend` CLI and the `curl` calls below send it, also for reading, which needs a token except `GET /status`) and `TEND_API_READ_TOKEN` (another `openssl rand -hex 32`; accepted for reading only) and `TEND_CLAUDE_CODE_CREDENTIAL=oauth-token` with `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), or `TEND_CLAUDE_CODE_CREDENTIAL=api-key` with `ANTHROPIC_API_KEY`. Only the selected one enters the sandbox. Run steps 3 and 4 once with each credential kind (restart the worker after switching): both must complete, and the transcript must show the selected variable's value nowhere. The `developer` profile also passes the agent token in, so set `TENDWORKS_AGENT_GITHUB_TOKEN` (fine-grained, playground repository only, contents and pull requests read/write).
3. `docker compose -f deploy/compose.yaml up -d --build --wait`, then start the example: `curl -X POST localhost:8080/runs -H "authorization: Bearer $TEND_API_TOKEN" -H 'content-type: application/json' -d '{"workflow":"hello-developer"}'`.
4. `tend run get <id>` shows the run completed, the reply `hello from the sandbox`, a non-zero `COST` (an estimate with `oauth-token`, the billed amount with `api-key`; zero means the harness reported none, which is a failure of this test) and the transcript reference; read the transcript with `tend run logs <id>` (through the API, like every client). `docker ps -a --filter label=dev.tendworks.sandbox` lists no leftover sandbox, `docker volume ls --filter label=dev.tendworks.volume` no leftover volume.

The workspace (`/workspace`) and the harness's home and config directory (`/session`) are volumes of the agent session, and the ACP session id is kept with the task, so after a platform restart the harness resumes the session with `session/resume` in a new sandbox (ADR 0009 (agent-sessions-resume-on-their-volumes)). Manual restart smoke test with the real harness, after steps 1–3:

5. Run steps 5–7 automatically with `scripts/smoke/restart-developer.sh` (Git Bash; prints PASS or FAIL), or by hand: start `curl -X POST localhost:8080/runs -H "authorization: Bearer $TEND_API_TOKEN" -H 'content-type: application/json' -d '{"workflow":"restart-developer"}'` and wait until `tend run get <id>` shows the step running and `tend run logs <id>` shows a `session` entry (the agent created `before.txt` and sleeps).
6. `docker compose -f deploy/compose.yaml restart worker`.
7. Within about a minute (the engine's heartbeat timeout) the transcript (`tend run logs <id> -o yaml` shows the entry types) shows `task-resumed` and `session-resumed` with the same session id, not `session-resume-failed`. The run completes with `resumed: 1` and a reply listing `after.txt` and `before.txt`; no sandbox or volume is left over.

Who works right now comes from the agent runtime: `GET /sessions` of the agent runtime API lists the agent sessions whose task has not ended (from `agent_runtime.tasks`, partial index on non-terminal tasks), kind `run-step` with the run and step the step's `SendMessageRequest.metadata` named (kept in the task's metadata), or kind `chat`. `GET /agents` of the control plane puts them under their profile (`sessions`, schema `contracts/schemas/agent-session.schema.yaml`) and lists the profiles without `sessions` when the agent runtime cannot be reached; `tend agent list` shows their number (`?` while unknown), `-o json|yaml` the sessions.

Chat agents read the platform through the platform MCP server (ADR 0016 (chat-agents-read-the-platform-through-mcp-with-a-read-only-token), `packages/mcp-platform`, official MCP TypeScript SDK): the server bundle serves it at `/mcp` on the API's port over Streamable HTTP (stateless, JSON responses) with the read-only tools `list_runs` (newest first, `limit` default 20), `get_run`, `list_triggers` and `list_agents`. It is a client of the public control plane API (in process, generated client) with the bearer token its caller presented; a request without a token, or with one the control plane refuses, gets 401 and nothing else, not even the list of tools. A profile lists it with `spec.mcp: [tendworks]` (the example `assistant` does, `developer` does not); for sessions of such profiles, chats and workflow tasks alike, and only those, the Claude Code harness configures it in ACP `session/new` and `session/resume` (`mcpServers`, HTTP, with an `Authorization: Bearer` header holding the read-only token), never through the sandbox's environment, and redacts the token from transcripts and replies. A session of such a profile fails with a hint when the worker has no `TEND_PLATFORM_MCP_URL` or `TEND_API_READ_TOKEN`, or when the harness does not advertise MCP over HTTP; the server refuses to start without a valid `TEND_API_READ_TOKEN` when a profile lists it. `TEND_PLATFORM_MCP_URL` is the address sandboxes reach the server's published port at: compose defaults it to `http://host.docker.internal:${TEND_PORT}/mcp`, which works on Docker Desktop. On Linux the default does not work: sandboxes do not resolve `host.docker.internal`, and even through the sandbox network's gateway they cannot reach the port, since compose publishes it on `127.0.0.1` only; set `TEND_PLATFORM_MCP_URL` to an address sandboxes can reach.

### Smoke test scripts

The manual smoke tests below are automated in `scripts/smoke/` (bash; on Windows Git Bash). Each prints its checks and ends with PASS or FAIL. They need the stack running with `deploy/.env` set up and `TEND_API_TOKEN` exported (they send it with every request, since reading needs a token too, and stop early when the control plane refuses it); the GitHub ones also need `gh` logged in.

| Script | Steps | Acceptance (#18) |
| --- | --- | --- |
| `hello-developer.sh` | 3–4 | run status, transcript and cost visible |
| `restart-developer.sh` | 5–7 | restarting the platform mid-run resumes the run |
| `pull-request-auto.sh <issue>` | 8–12 | labelled issue → merged pull request with `merge: auto` |
| `pull-request-ask.sh <issue> [approve|reject]` | 14 | `merge: ask`: waits across a restart, merges after approval (or not after rejection) |

The pull request scripts label the issue `ready-for-agent` themselves and refuse to run while other open playground issues carry the label, since each would start its own run. Configuration changes they need (binding not suspended, `develop-issue` in or out of `ask-before-merge`) stay manual; the scripts check them and say what to change.

### Pull request smoke test

The `develop-issue` workflow hands an issue to the `developer` agent. The runtime checks the issue's repository out in the workspace on a branch fixed by the run, copies the profile's skills into the sandbox, passes the agent token in as `GH_TOKEN` and appends the role description to the harness's system prompt; the agent pushes the branch, opens the pull request and records it, so the run's output shows it (ADR 0010 (agent-runtime-prepares-the-workspace-and-collects-reported-artifacts)). The regular suites cover this with the scripted agent and a local bare repository; against the playground repository, after steps 1–3:

8. Open an issue in `mtiews/tendworks-playground` with a small, clear change, e.g. "Add a file GREETING.md that says hello".
9. Start a run for it by hand: `curl -X POST localhost:8080/runs -H "authorization: Bearer $TEND_API_TOKEN" -H 'content-type: application/json' -d '{"workflow":"develop-issue","input":{"issue":{"repository":"mtiews/tendworks-playground","number":<n>,"title":"<title>","body":"<body>","url":"https://github.com/mtiews/tendworks-playground/issues/<n>"}}}'`. Or let the time trigger find it: the binding `examples/config/triggers/playground-ready-for-agent.yaml` is shipped suspended; set `TENDWORKS_PLATFORM_GITHUB_TOKEN`, remove `suspend: true`, restart the server and label the issue `ready-for-agent`. `tend trigger list` shows its last check; `failed ... secret TENDWORKS_PLATFORM_GITHUB_TOKEN is not set` means the token did not reach the server. The run's `STARTED BY` names the binding and the issue.

10. `tend run get <id>` shows the run completed, with `pullRequest` and `branch` (`tendworks/issue-<n>-<first 8 characters of the run id>`) under OUTPUT. The pull request on GitHub comes from that branch, describes the change and references the issue. The transcript has a `workspace-checkout` entry with exit code 0 and an `artifacts` entry; no token appears in the transcript or the run.
11. Retry: restart the worker while the agent works (step 6). The resumed session continues on the same branch, and no second pull request appears.

After the agent step the platform merges the pull request as the workflow's `merge` step: the worker calls the control plane's `POST /pull-requests/merge { run, pullRequest }`, whose merge gate checks orchestration's record of the run (running, reported this pull request), decides by the policies that apply to the workflow (`examples/config/policies/`; `merge-gate` applies to all with `merge: auto`, the strictest applicable policy wins) and merges with `TENDWORKS_PLATFORM_GITHUB_TOKEN`, which only the server holds (ADR 0011 (the-platform-merges-through-a-gate-on-the-control-plane-api), ADR 0012 (the-merge-gate-decides-by-the-run-and-waits-for-approval-requests)). The regular suites merge in the fake integration (`fake-develop-and-merge`); against the playground repository, with `TENDWORKS_PLATFORM_GITHUB_TOKEN` set (fine-grained, playground only: contents and pull requests read/write, issues read):

12. In step 10, `tend run get <id>` additionally shows the `merge` step completed and `merged: true` and the merge `commit` under OUTPUT; on GitHub the pull request is merged by the platform token's owner, not by the agent. The server log names no token.
13. Failure: run `develop-issue` for an issue the agent cannot finish, or set the token to an invalid value and restart the server. The run fails at `/do/1/merge` with a readable title and detail (e.g. "No pull request to merge", "Repository unavailable: GitHub answered 401: Bad credentials ..."); nothing is merged.
14. Approval: add `develop-issue` to `workflows` of `examples/config/policies/ask-before-merge.yaml` and restart the server. After the agent step the run waits: `tend status` shows `PENDING APPROVALS 1`, `tend notification list` an `approval.requested` notification, `tend approval list --pending` the request with the pull request in its question, and the pull request stays open. A platform restart (`docker compose -f deploy/compose.yaml restart server worker`) changes nothing. `tend approval approve <id>` lets the run merge and complete (`decision: ask`, `approval: approve` under OUTPUT); `tend approval reject <id>` ends the run without a merge (`merged: false`). The regular suites cover both with `fake-develop-and-ask`.

## Quality gates

| Gate | Where | Enforced by |
| --- | --- | --- |
| Type check (strict), generated contract types | `pnpm check` | CI, required status check on `main` |
| Lint: ESLint with type-aware rules (`no-floating-promises`, `no-misused-promises`, exhaustive switches) | `pnpm check` | CI |
| Architecture rules: domain boundaries (dependency-cruiser), product names, ≥ 2 implementations per port | `pnpm check` | CI |
| Contract tests: OpenAPI requests/responses, CloudEvent schemas | `pnpm check` | CI |
| Unit, integration and end-to-end tests | `pnpm check`, `pnpm coverage`, `pnpm e2e` | CI |
| Coverage thresholds (global and per package, measured over unit + integration tests) | `pnpm coverage` | CI; thresholds only go up |
| Secret scanning of staged changes (Betterleaks) | pre-commit hook | locally, against accidents (`--no-verify` skips it); GitHub secret scanning with push protection on the server |
| Changes reach `main` only through a pull request with green CI, no force push, no deletion | repository ruleset | GitHub, no bypass |

## Open items

- [x] Define the build order of the walking skeleton
- [x] Write the concrete `compose.yaml`
- [x] Example configuration for the existing issue agent (profile, skills, sandbox template, workflow `develop-issue`, the suspended playground trigger binding `playground-ready-for-agent`)
- [x] Check which ACP adapter is used for Claude Code and how sessions are resumed
- [ ] Create the playground repository and its fine-grained token
- [x] Design review for milestone 1b (chat session model) once S2 works (ADR 0015, ADR 0016, ADR 0017)
- [ ] Design review for milestone 1c (web UI)
