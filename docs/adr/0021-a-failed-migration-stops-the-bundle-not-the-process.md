# A failed schema migration stops the bundle, not the process

When a schema migration fails at start, the bundle (server or worker) does not exit. It stays up in a stopped mode that answers only its status endpoint: the server `GET /status`, the worker `GET /health`, both naming the failed migration as the unhealthy component `<schema>-schema`. Every other request gets 503 (`Platform stopped`, `Worker stopped`) with a generic detail; the reason, which may carry the store's error text, appears only in the status. Each domain migrates its own schema independently, so a failure stops only the bundle that runs it: the other bundle keeps running, and runs that need the stopped one fail visibly instead of hanging. There is no automatic rollback across domains or downgrade; the way back is the backup taken before the update.

Every long-running service has the restart policy `unless-stopped` (milestone 2). A bundle that exits on a failed migration would restart into the same failure again and again, and with the server down nothing would show the operator why.

## Considered Options

- **Exit with an error**: compose restarts it in a loop; the reason is only in the log, and `GET /status` is unreachable while the server is down.
- **Start anyway and serve on the old schema**: code of the new release would run against a store it does not expect.
- **One migration over all domains in one transaction**: needs one owner of every schema, against "a domain owns its data".

## Consequences

- `docker compose up --wait` succeeds while a bundle is stopped, since its health check only asks whether it answers; the operator guide's update steps check `tend status` afterwards.
- The internal contracts of the worker (orchestration, agent runtime) document the stopped 503 on every operation, as the control plane contract does for the server.
- A stopped bundle retries the migration only when it is started again (after the cause is fixed, or after a restore).
- Domains of the other bundle may already be at the new version. Checking out the previous release alone is then not enough, since it refuses a store newer than it knows; the backup is the way back.
