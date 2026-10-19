# Producers publish into the event bus's table inside their own transaction

The event bus owns one event table (`event_bus.events`) and a position per subscription. A producer hands its open transaction to `EventBus.publish(tx, event)`, which inserts the event there, so state and event commit together; there is no per-domain outbox table and no relay process. This needs producer and event bus on the same Postgres database, which holds for the laptop profile. A domain still never names the table: it only knows its own publisher port (orchestration's `EventPublisher`), and the bundle (worker, server) passes the bus in. A new producer, e.g. the trigger gateway with `trigger.fired`, plugs in the same way.

## Considered Options

- **Outbox table per domain plus a relay** that copies rows onto the bus: works across databases, but adds a process per producer and a second delivery hop for no gain while everything shares one database.
- **Shared event table, written in the producer's transaction** (chosen).

## Consequences

- `publish` takes a transaction-scoped advisory lock until commit, so event positions become visible in commit order and a subscriber reading "after my last position" never skips an event that committed late. All publishers are serialised; fine at the expected load.
- Delivery is at least once and in order per subscription; a handler that throws gets the same event again with backoff, so consumers are idempotent (human interaction keys a notification on its event). A permanently failing handler blocks its subscription; there is no dead-letter yet.
- One active consumer per subscription across instances (`for update skip locked` on the subscription row). NOTIFY only wakes subscribers; a periodic poll covers lost notifications.
- Moving a producer to its own database brings back the relay option; NATS would replace the adapter behind the same port.
- `orchestration.outbox` (ADR 0003) stays as the run store's default publisher for tests, but the worker no longer writes to it.
