# Orchestration keeps its own run record and serves it through an internal API

Orchestration stores every `Run` and `Step` in its own Postgres schema (`orchestration`), written by short, idempotent activities at each step boundary, instead of reading run state from the durable execution engine. The engine's dev mode forgets finished workflow executions after 24 hours, and its data is product-shaped; our record survives that, stays readable while the worker is down, and is exportable as YAML or JSON. The control plane does not import orchestration: it reaches runs through orchestration's internal API (`contracts/openapi/orchestration.yaml`, served by the worker) and passes the configured workflow definition along when it starts a run, so the run executes a snapshot.

Run and step events (`dev.tendworks.run.*`, `dev.tendworks.step.*`) go through orchestration's `EventPublisher` port, inside the transaction that writes the state they describe. Until the event bus exists, the adapter writes them to orchestration's own outbox table (`orchestration.outbox`); the event bus provides a publisher with the same `publish(tx, event)` shape, wired in the worker bundle, because the event-bus package is a domain that orchestration may not import (ADR 0005).

## Considered Options

- **Read run state from the engine (queries or visibility API)**: no extra tables, but runs vanish after the namespace retention and the control plane depends on engine data shapes.
- **Own run record in orchestration's schema** (chosen): a few extra activities; event ids are deterministic (`<runId>:run.started`, `<runId><stepReference>:step.completed`), so a retried activity neither duplicates state nor events.

## Consequences

- One run is one workflow execution; the workflow id is our run id, never the engine's internal id.
- `tend run list` and `GET /runs` read orchestration's record, so they show runs for as long as the database keeps them.
- Changing the interpreter so that it issues different commands breaks replay of runs in flight; accepted for the skeleton.
