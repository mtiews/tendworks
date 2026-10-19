# Live agent output streams through the API, not the event bus

What an agent does while it works (message chunks, tool calls and their results, end of turn, resume) is described by one product-neutral schema of transcript entries. The harness adapter maps its protocol (ACP) onto it; the transcript store keeps the entries (ADR 0007 (agent-runtime-records-transcripts-and-cost-from-acp)). Clients read them in two ways with the same schema: as history (`GET` on a chat's or a step's transcript) and live as Server-Sent Events, which the agent runtime API serves and the control plane passes through. An entry's position in the transcript is its SSE event id, so a client that reconnects with `Last-Event-ID` misses nothing. This holds for chats and for the agent steps of runs alike.

The event bus carries only lifecycle events of agent sessions and chats, not their output; `agent.message` leaves the event catalog as a per-chunk event.

## Considered Options

- **Every chunk as a CloudEvent on the event bus** (as the event catalog first planned): every chunk becomes a row in the outbox table and a notification on the Postgres bus, in the transaction of the agent runtime's state, for data that the transcript already persists.
- **WebSocket**: both directions on one connection, but harder to describe in OpenAPI, to authenticate with the bearer token and to resume; messages to an agent are rare enough to be plain POSTs.
- **Polling the transcript**: simple, but late and wasteful for a chat.

## Consequences

- The control plane holds a long-lived connection per watching client and one to the worker per stream.
- With several workers the control plane must reach the worker that runs a session, or the transcript store moves behind a shared API or object storage.
- A consumer that wants to react to agent output (e.g. a future meta-agent) reads the stream through the API instead of subscribing to the bus.
