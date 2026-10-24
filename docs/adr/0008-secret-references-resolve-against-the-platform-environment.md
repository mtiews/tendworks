# Secret references in configuration resolve against the platform's environment

Configuration never holds a secret, only a reference to one: `{ secretRef: { name: <NAME> } }` (`contracts/schemas/trigger-binding.schema.yaml#/$defs/secretRef`). In the laptop profile a name is an environment variable of the bundle that uses it, set from `deploy/.env` through `deploy/compose.yaml` (e.g. `TENDWORKS_PLATFORM_GITHUB_TOKEN` for the server). The first user is the `github` issue tracker of a trigger binding. The reference is resolved on every check, not at startup: a missing secret fails that check with a message naming the secret, never a value, and the next check tries again.

Every reference is resolved by one resolver (`createSecretResolver` in the platform library `@tendworks/platform`) with an explicit allowlist per consumer: workspaces (`spec.credentials`) and agent profiles (`spec.env`), both handed into sandboxes, resolve only `TENDWORKS_AGENT_*`, the platform's integrations (trigger bindings) only `TENDWORKS_PLATFORM_*`. The kind schemas carry the same prefixes as patterns, so a reference outside its allowlist is a configuration error at startup, and the resolver refuses it again at runtime. Nothing looks secrets up in the process environment directly.

## Considered Options

- **Token in plain text in the binding**: lands in Git. Rejected.
- **Fixed variable per integration, no reference**: simpler, but bindings for different repositories could not use different tokens, and the configuration would hide which secret it needs.
- **Reference with name and key** (Kubernetes style): no store with several keys per secret exists yet; `name` alone leaves room to add `key` once a secret store (OpenBao, SOPS) sits behind an adapter.

## Consequences

- No reference can name the database URL or another bundle setting, and an agent profile can never name a platform secret (or a binding an agent secret). Supersedes the earlier acceptance that a binding could name any variable of the server's environment.
- A secret store adapter (OpenBao, SOPS) later replaces the environment behind the same resolver; the allowlists stay.
- Every new secret a binding needs is also an entry in `deploy/.env.example` and the server's environment in `deploy/compose.yaml`.
- Agent secrets need no compose entry (milestone 2): a one-shot compose service without network gets `deploy/.env` as a whole (`env_file`) and writes only its `TENDWORKS_AGENT_*` variables to a file on a volume (`@tendworks/platform/secrets-file`); the worker resolves agent references against that file, read again at every reference, so an operator adds an agent secret with one line in `deploy/.env` and `up -d`. Rejected: `env_file: .env` on the worker (it would hold the platform token), and mounting `deploy/.env` into the worker (it would hold the platform token as a file, and the worker's user cannot read a mode-600 file owned by another host user). Only `deploy/.env` feeds agent secrets, not the shell environment or another `--env-file`.
