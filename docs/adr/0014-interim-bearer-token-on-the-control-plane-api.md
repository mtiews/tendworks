# Operations that change state need a bearer token on the control plane API, until OIDC

> Amended by ADR 0016 (chat-agents-read-the-platform-through-mcp-with-a-read-only-token): reading needs a token too (this one or the read-only token), except `GET /status`.

Until identity (OIDC, Keycloak) arrives, the public control plane API protects every operation that changes state with one shared API token: `POST /runs`, `POST /pull-requests/merge` and `POST /approval-requests/{id}/decision` need `Authorization: Bearer <TEND_API_TOKEN>` and answer 401 with `WWW-Authenticate: Bearer` otherwise; reading stays open. The contract declares it as the `apiToken` security scheme (`contracts/openapi/control-plane.yaml`). The server refuses to start without a token of at least 16 characters and compares digests in constant time.

The token comes from `deploy/.env` (`TEND_API_TOKEN`). The laptop profile falls back to a well-known default (`deploy/compose.yaml`) so `docker compose up` works without setup; that default is only acceptable while nothing but the operator reaches the published port on localhost. The clients send it: the `tend` CLI (`--token` or `TEND_API_TOKEN`), the trigger gateway's in-process run starter, and the worker's `call: http` executor, which adds it to every request to the control plane, so it never appears in a workflow definition and a workflow cannot replace it.

Sandboxes never get the token: it is not an agent secret (only `TENDWORKS_AGENT_*` resolve for agent profiles, ADR 0008 (secret-references-resolve-against-the-platform-environment)), which `tests/architecture/secrets.test.ts` checks against the worker's environment. Sandboxes also run on a Docker network of their own (`<installation>-sandboxes`, named after the installation and created by the sandbox adapter as a bridge without traffic between its containers), not on the compose stack's networks, so they cannot reach the server, worker, store or socket proxy by name.

## Considered Options

- **Wait for OIDC**: leaves the residual risk of ADR 0012 open: anything that reaches the port, including an agent in a sandbox on Docker Desktop, can approve its own approval request.
- **Separate tokens for humans and the worker**: lets the merge endpoint tell a workflow from a human, but the gate already decides by the run's records, and a second secret doubles the setup for no gain before identities exist.
- **Protect reads too**: run data is not secret on a single-operator laptop, and open reads keep `GET /status` usable as the compose health check. Revisit with OIDC.
- **Sandboxes on an `internal` network**: would cut them off from GitHub and the model API; egress control belongs to the egress proxy (not in the skeleton).

## Consequences

- An agent can no longer start runs, merge or decide approval requests through the API without the token, which it never gets. The token, not the network, is the guard: on Docker Desktop `host.docker.internal` still forwards to the host's localhost, so a sandbox reaches the published port and only the token stops it.
- The socket proxy now also opens `/networks/**` for creating the sandbox network. Whoever reaches the proxy could already create containers on any network, so this adds little; the proxy stays reachable only from the worker.
- One shared token has no identity: the API cannot say who decided an approval request. OIDC replaces the scheme; the contract's `security` entries stay and change the scheme they name.
- Rotating the token means changing `deploy/.env` and restarting server and worker.
