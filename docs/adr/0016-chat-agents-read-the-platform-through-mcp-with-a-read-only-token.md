# Chat agents read the platform through MCP with a read-only token

Chat agents get platform context from a read-only MCP server (`packages/mcp-platform`, tools `list_runs`, `get_run`, `list_triggers`, `list_agents`). It is a client of the public control plane API like the CLI: the server bundle serves it as a Streamable HTTP endpoint (`/mcp`) and it calls the control plane API with the token its caller presented. Agents that run in workflows do not get it; agents should not be able to inspect or steer the platform they run on unless the operator gives them that explicitly.

The control plane therefore gets a second token next to `TEND_API_TOKEN` (ADR 0014 (interim-bearer-token-on-the-control-plane-api)): `TEND_API_READ_TOKEN` is accepted for reading operations only and answered with 403 on every operation that changes state. Reading now needs one of the two tokens; only `GET /status` stays open as the liveness check. The read token is not an agent secret a profile can reference (ADR 0008 (secret-references-resolve-against-the-platform-environment)): the agent runtime passes it into the sandbox, together with the MCP server's address, only for sessions whose profile lists the platform MCP server (`mcp: [tendworks]`). The admin token never enters a sandbox.

## Considered Options

- **Reads stay open**: every sandbox, including the developer agent's, can already read all runs through the published port; the separation of chat and workflow agents would exist only in configuration.
- **Restrict the network per profile** so only chat sandboxes reach the server: needs egress control, which belongs to the egress proxy (not in the skeleton).
- **A short-lived token per session**: binds access to one session and expires with it, but needs token issuance that belongs to identity (OIDC); revisit then.
- **Serve the MCP server from the worker**: it is a client of the public API, not part of the agent runtime; in the server it needs no network path of its own.

## Consequences

- Every sandbox still reaches the control plane's published port on the network (`host.docker.internal` on Docker Desktop, the bridge gateway on Linux); the tokens, not the network, are the guard until the egress proxy closes it.
- The `tend` CLI and scripts need a token for reading too.
- One static read token has no identity and is shared by all chat sessions; rotating it means changing `deploy/.env` and restarting server and worker.
