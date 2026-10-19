# The platform merges pull requests through a gate on the control plane API

Status: accepted; the request shape (`{ pullRequest, policy }`) and the rule that workflows name their policy are superseded by ADR 0012 (the-merge-gate-decides-by-the-run-and-waits-for-approval-requests): the request names the run, and the gate takes the policy from the configuration.

The merge after the agent step is a workflow step the platform performs, never the agent and never inside a sandbox. The platform token (`TENDWORKS_PLATFORM_GITHUB_TOKEN`) lives only in the server bundle (ADR 0008 (secret-references-resolve-against-the-platform-environment), `tests/architecture/secrets.test.ts`), but workflows run in the worker. So the step calls the public control plane API, `POST /pull-requests/merge { pullRequest, policy }` (`contracts/openapi/control-plane.yaml`), with the DSL's built-in `call: http`:

```yaml
- merge:
    call: http
    with:
      method: post
      endpoint: '${ $runtime.metadata.controlPlaneUrl + "/pull-requests/merge" }'
      body: { pullRequest: '${ .pullRequest }', policy: merge-gate }
```

Behind the endpoint, human interaction's merge gate looks up the `Policy` (`contracts/schemas/policy.schema.yaml`, `spec.merge: auto | ask`), evaluates it with a pure decision function (`allow | ask`) and only on `allow` merges through the pull request integration port. The integration is picked by the pull request's host: `github.com` merges on GitHub with the platform token (merge commit), hosts under the reserved `.example` domain merge in a fake where every pull request is open, so fake agent profiles can report pull requests the platform merges. Merging an already merged pull request succeeds, so a retried step is harmless.

## Considered Options

- **Custom function from the runtime's default catalog (`call: merge-pull-request:0.1.0@default`)**: shortest in the workflow, but the DSL leaves custom functions entirely to the runtime; we would need a function catalog and a second call mechanism next to `call: http`. Rejected for now.
- **`call: http` to an absolute URL (`http://server:8080/...`)**: the workflow would name a Compose service. Rejected; the URL comes from `$runtime.metadata`, which the DSL defines for runtime-specific values (the worker sets it from `TEND_CONTROL_PLANE_URL`; the run snapshots it at start).
- **Internal API instead of the public one**: the merge is something every client may ask for (the CLI later too) and the gate is enforced server side whoever asks, so it belongs on the public API like `POST /runs`.
- **Separate decision step plus merge step in the workflow**: needs `switch`, which #15 brings. Keeping the decision inside the merge endpoint means no client, workflow or agent can merge past the policy.
- **Look the pull request up by branch when the agent reported none**: would merge work the agent did not declare finished. Rejected; `pullRequest: null` is answered with 400 "No pull request to merge" and the step fails with that reason.

## Consequences

- The interpreter supports `call: http` (method, endpoint, headers, body; output = response content). A status outside 2xx fails the step with a communication error carrying the endpoint's problem `title`, `detail` and status. The worker's HTTP executor only lets requests go to the control plane's origin, so a workflow cannot reach the sandbox backend from the worker.
- Status mapping: 400 invalid request (no pull request, unknown policy, no integration for the host), 403 policy says `ask`, 409 repository refused (closed, conflicts), 502 repository unreachable or credentials refused.
- With `merge: ask` the step fails with 403 and merges nothing. (Replaced by ADR 0012: the gate opens an approval request, the workflow `listen`s for its decision and asks again; the gate finds the approved request itself.)
- The secret name of the GitHub integration is fixed in the server bundle, not referenced from configuration; a second token or forge needs an integration `kind` with a secret reference.
- The control plane API has no authentication yet, and Docker Desktop lets containers reach the host's localhost, so a sandbox could call the endpoint. With the caller naming the policy it could pass the gate by claiming a lax one; ADR 0012 closes that, and the agent token can merge anyway (accepted risk, ADR 0010 (agent-runtime-prepares-the-workspace-and-collects-reported-artifacts)).
- GitHub recommends its asynchronous merge API (`merge-async`); the synchronous endpoint is enough while the playground has no merge queue.
