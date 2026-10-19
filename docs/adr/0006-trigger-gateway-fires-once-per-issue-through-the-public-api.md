# The trigger gateway fires once per issue and binding, and starts runs through the public API

A time trigger asks its binding's issue tracker (integration port; `fake` or `github`) at fixed executions and starts one run per matching issue. The trigger gateway owns its record of fired triggers in its own schema (`trigger_gateway.firings`, keyed by binding and issue). Before starting a run it claims the key; when the run cannot be started it releases the claim so the next check retries; once a run exists the key stays fired for good, and the firing is recorded with its `trigger.fired` event in one transaction through its `EventPublisher` port (the server passes the event bus in, ADR 0005). `trigger.fired` carries `runid` = the run it started, so the event envelope stays unchanged.

Runs are started through the public control plane API (`POST /runs`), the same way any client starts them; inside the server bundle the call is an in-process fetch. The control plane lists triggers through the gateway's internal API (`contracts/openapi/trigger-gateway.yaml`).

Executions fall on multiples of the binding's interval since the Unix epoch, so the next execution needs no stored state and every instance agrees on it.

## Considered Options

- **Re-fire when the previous run failed**: closer to "an active or completed run blocks a second one", but with a real agent a persistently failing issue would start a paid run at every execution. Rejected for now; an operator re-triggers by hand once `tend trigger fire` exists.
- **Dedup per issue across all bindings**: blocks legitimate second workflows on the same issue (e.g. triage and implement). Rejected; dedup is per binding.
- **Start runs through orchestration's internal API**: skips configuration lookup and validation in the control plane and would be a private path. Rejected.

## Consequences

- An issue never starts a second run for the same binding, also across restarts and several server instances (the claim is an insert on the primary key).
- A crash between starting the run and recording the firing leaves a claim without a run id: the issue does not fire again and no `trigger.fired` is recorded for that run. Closing the gap needs an idempotency key on `POST /runs`.
- The run gets its own trace (orchestration creates the traceparent); `trigger.fired` and the run are linked by `runid` only until `POST /runs` accepts a traceparent.
