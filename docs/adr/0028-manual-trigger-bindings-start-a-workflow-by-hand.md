# Manual trigger bindings start a workflow by hand

Some workflows run only when the operator decides: an architecture review, a security review, cutting a release. They have no schedule and no event such as a labeled issue. A trigger binding of kind `manual` declares such a workflow and its workspaces like any other binding (ADR 0023), but never fires on its own: the operator fires it through the public API, `POST /triggers/{name}/fire`, which every client uses (`tend`, the web UI).

- **A trigger source without a schedule.** `manual` is a trigger source in its own package behind the trigger source port, deployed with the server bundle. The port's `schedule` is optional; the gateway never checks a source without one and asks it only when its binding is fired. The manual source reports one item per firing: key = the firing time, title `started by hand`, no link. Its settings are an empty object.
- **Firing is a check at now.** The trigger gateway's `fire(binding, { workspace? })` runs the same evaluation as a scheduled check, over all of the binding's workspaces or only the named one: claim per binding, workspace and item, start the run with `{ workspace, item }`, record `trigger.fired`, record the firing as the binding's last check. The run's origin is the existing trigger origin, so its notifications go to the workspace's subscriptions (ADR 0026) and `tend run retry` works unchanged. Each firing is a new item, so firing again starts new runs.
- **Refusals.** An unknown binding is `404`; a suspended binding and one whose source has a schedule (`schedule`, `github-issues`) are `409`; a workspace that is not the binding's is `400`. Firing needs the API token (`403` with the read-only token, ADR 0016); the control plane forwards to the trigger gateway's internal API and answers `503` when it cannot reach it.
- **No guard against concurrent runs.** The gateway does not know about active runs; they belong to orchestration.

## Considered Options

- **`tend run start` on `POST /runs`, with workflows marked as startable and input schemas:** every workflow needs a marker and a schema, a run names no workspace in its origin so its notifications land in the platform scope, and "which workflow may run where" is not in configuration.
- **"Run now" for every binding:** firing a `schedule` or `github-issues` binding by hand blurs what the binding means (a tick that did not happen, issues asked out of turn); left out until there is a need.
- **An MCP tool that fires bindings:** agents would start paid runs by themselves; the platform MCP server stays read-only (ADR 0016).

## Consequences

- Workflows stay unchanged: a workflow used with a schedule can also be fired by hand through a second binding.
- The trigger list's `schedule` and `nextExecutionAt` are optional; a manual binding has neither, and its last check is its last firing.
- Who fired a binding is not recorded until identity (OIDC) arrives; there is one shared API token.
