# Trigger bindings start a workflow per workspace from pluggable trigger sources

A trigger binding names a workflow, a trigger and a list of workspaces (ADR 0022). When the trigger fires, the trigger gateway starts one run per workspace, or per item and workspace for triggers that produce items. The workflow receives `{ workspace, item }` as input and decides the branch itself: one per issue for development, the default branch for a scan. A binding without workspaces starts runs without one.

Trigger kinds:

- **`schedule`:** cron or interval; the tick is the item.
- **`github-issues`:** labels, state, interval and a read-only platform token. The source reads the issues of each git workspace's repository. It never uses the workspace's agent credential, so the server holds no agent secrets.

Trigger sources sit behind a port in the trigger gateway. A source returns items with a stable key, a title and a link. It is created with the binding's settings and workspaces when the platform starts, and refuses a binding it cannot serve with the reason, which stops the start like any invalid configuration: `github-issues` refuses a binding without workspaces and any workspace that is not a git repository on GitHub. Deduplication ("once per item") is generic: the gateway persists the key per binding and workspace.

Source implementations live in their own packages outside the domain packages. They are built into the same server bundle and selected by the trigger kind. A source can later move to its own repository, or out of process, without a change to the gateway.

## Considered Options

- **The repository as part of the issue source:** schedules have no repository, and every repository needs its own binding.
- **One generic "issue tracker" source with forge adapters inside the gateway:** forge code mixes with the domain, and new kinds of triggers don't fit an issue shape.
- **Sources as separate services calling the public API:** clean, but one more deployable and its own state; not needed while sources run with the platform.

## Consequences

- One binding covers many repositories; a repository is added by naming its workspace.
- New trigger kinds (webhooks later) are new source packages behind the same port.
- Product names appear only in the trigger kind selector of the binding schema.
