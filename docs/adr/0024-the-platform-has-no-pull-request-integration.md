# The platform has no pull request integration; runs report artifacts and humans act through a generic step

The platform performs no forge actions: it neither merges nor knows pull requests. A coding agent opens its pull request itself, using its workspace credential, and reports it as an artifact (name and link, ADR 0010). The run ends there. Its notification carries the artifacts, so a tap opens the pull request. The human reviews and merges in the forge.

For workflows that continue after a human action, a generic workflow step asks a question and waits:

- it creates an approval request with a free action name, a question, links and custom answers, e.g. "Merged – continue" or "Cancel", each mapped to continue or stop;
- it then waits for the decision event.

Policies (`kind: Policy`) decide per action name and workflow between `ask` and `allow`; with `allow` the step proceeds without a request. These are the autonomy levels of later milestones.

## Considered Options

- **A merge gate on the control plane with a forge adapter:** pull request concepts across the API, approvals and policies, and a forge token on the server; a use case inside the generic platform.
- **A separate forge connector service merging on approval:** keeps the platform generic, but adds a deployable, its own state and a second place to configure.
- **A waiting step after every pull request:** the same decision in two places (forge and platform); a run waits for a click that adds nothing when no step follows the merge.

## Consequences

- No forge write token on the platform side; the agent token per workspace is the only one that writes.
- On a private repository on a free plan the agent token can still merge (accepted risk, `docs/github-agent-access.md`).
- Deeper forge integration later builds on artifacts, notifications and the human step, without changes to their contracts.
- ADR 0011 and ADR 0012 are superseded.
