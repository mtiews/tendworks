# Sandboxes reach the platform MCP server through an MCP-only gateway

Chat agents whose profile lists the platform MCP server (`spec.mcp: [tendworks]`, ADR 0016) reach it through a dedicated gateway service in its own Docker network. The gateway forwards only the `/mcp` path to the server and refuses every other path. Only sandboxes of such profiles are attached to the gateway's network, in addition to the sandbox network. The gateway's network needs traffic between its containers, so the sandboxes on it can reach each other there (#64, see Consequences). The sandbox network keeps inter-container traffic disabled, so on it sandboxes cannot reach each other, and no sandbox reaches the platform's other services. The default `TEND_PLATFORM_MCP_URL` points at the gateway and is the same on Linux and Docker Desktop. The read-only token stays the guard at the server.

Until now sandboxes reached the server through `host.docker.internal` and the API's published port. That works on Docker Desktop only: on a Linux engine sandboxes get no such name, and the port is published on `127.0.0.1`, which the sandbox bridge cannot reach (#50).

## Considered Options

- **Attach the server to the sandbox network under an alias**: does not work. The sandbox adapter creates that network with inter-container traffic disabled (`enable_icc: false`), so no sandbox can reach a container on it.
- **Enable inter-container traffic on the sandbox network**: sandboxes could then reach each other.
- **Publish the API on the sandbox bridge's gateway address and give sandboxes `host.docker.internal`**: every sandbox reaches the whole API, not just `/mcp`, and the bridge address is assigned by Docker.
- **A separate MCP server process with its own port**: one more service with its own copy of the platform client; the gateway only routes and has no logic.

## Consequences

- One more service in the compose stack (a small pinned reverse proxy). Its product name appears only in the deployment files, not in contracts.
- Sandboxes of profiles without the platform MCP server reach neither the gateway nor the server through it.
- MCP profiles no longer need the API's published port. That is a step towards closing the residual risk that sandboxes reach the API's port on Docker Desktop (see "Residual risk" in the implementation document).
- The sandbox adapter must attach a sandbox to a second network on request. The agent runtime asks for it only for profiles that list the platform MCP server. The adapter accepts only networks the deployment allowed it, so no profile or request can put a sandbox on a platform network.
- Residual risk, accepted by the operator (issue #64): all sandboxes of MCP profiles share one gateway network and can reach each other on it. Docker can forbid traffic between containers only for a whole network, which would also cut them off from the gateway; a network per sandbox would need the gateway attached to each. Sandboxes of other profiles never join it, and the sandbox network keeps traffic between sandboxes forbidden, so spec #54's story 38 holds for them and is relaxed for MCP profiles.
- While a sandbox is attached to the gateway's network, `docker compose down` cannot remove the network and leaves it behind; operators remove the installation's sandboxes first.
