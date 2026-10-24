# The trigger gateway fires once per item, binding and workspace, and starts runs through the public API

A trigger binding asks its trigger source (ADR 0023) at the executions of the source's schedule and starts one run per workspace and item, e.g. per matching issue. The rule is one firing per item, binding and workspace, for good: also when the run fails, the item never fires again for that binding and workspace. An operator retries by starting the workflow with the same input through `POST /runs` (recorded as started `manual`). The trigger gateway owns its record of fired triggers in its own schema (`trigger_gateway.firings`, keyed by binding, workspace and item key). Before starting a run it claims the key; when the run cannot be started it releases the claim so the next check retries; once a run exists the key stays fired for good, and the firing is recorded with its `trigger.fired` event in one transaction through its `EventPublisher` port (the server passes the event bus in, ADR 0005). `trigger.fired` carries `runid` = the run it started, so the event envelope stays unchanged.

Runs are started through the public control plane API (`POST /runs`), the same way any client starts them; inside the server bundle the call is an in-process fetch. The control plane lists triggers through the gateway's internal API (`contracts/openapi/trigger-gateway.yaml`).

Executions fall on multiples of the source's interval since the Unix epoch, or on the times of its cron expression in UTC, so the next execution needs no stored state and every instance agrees on it.

Every check records how it went per binding (`trigger_gateway.evaluations`, the last one only): `succeeded` with the number of runs it started, or `failed` with the reason when the source could not be asked for a workspace (rate limit, API error, a secret that is not set) or an item's run could not be started. `GET /triggers` and `tend trigger list` show it as `lastEvaluation`, so a binding that silently never fires is visible without reading the server log.

## Considered Options

- **Re-fire when the previous run failed**: closer to "an active or completed run blocks a second one", but with a real agent a persistently failing issue would start a paid run at every execution. Rejected; an operator retries with `POST /runs` (a `tend run start` or `tend trigger fire` can wrap it later).
- **Dedup per issue across all bindings**: blocks legitimate second workflows on the same issue (e.g. triage and implement). Rejected; dedup is per binding.
- **Start runs through orchestration's internal API**: skips configuration lookup and validation in the control plane and would be a private path. Rejected.

## Consequences

- An item never starts a second run for the same binding and workspace, also across restarts and several server instances (the claim is an insert on the primary key).
- A crash between starting the run and recording the firing leaves a claim without a run id: the item does not fire again and no `trigger.fired` is recorded for that run. Closing the gap needs an idempotency key on `POST /runs`.
- A firing starts a trace: the gateway passes its `traceparent` header on `POST /runs`, the control plane hands it on to orchestration, which records it on the run, so `trigger.fired`, the run and step events and the approval events of the run share one trace. A run started without a `traceparent` starts its own.
