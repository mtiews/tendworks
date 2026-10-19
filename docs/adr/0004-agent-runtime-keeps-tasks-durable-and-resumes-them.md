# The agent runtime keeps its tasks durable and resumes interrupted ones

When the platform restarts while an agent works, the durable execution engine retries the agent call with the same message id (`<runId><stepReference>`, ADR 0002). The agent runtime therefore records every task in its own Postgres schema (`agent_runtime.tasks`, keyed by message id, written before the agent starts) through a `TaskStore` port. A message whose task is already recorded never starts a new task: a finished task is returned as it is; an unfinished task that this process is not working on was interrupted, so the runtime resumes it under the same task id, history and start time, and counts the resumption in the task metadata key `dev.tendworks/resumed`. The fake agent resumes by working only for its remaining time; the Claude Code harness resumes via `session/resume` with the session id kept next to the task (ADR XXXX (agent-sessions-resume-on-their-volumes)).

## Considered Options

- **Deterministic task id, no store**: the id would survive, but the agent would still start over, which is the duplicate work the restart test forbids.
- **Ask the engine whether the call is a retry**: couples the agent runtime to orchestration's engine and still loses the agent's progress.
- **Durable task record in the agent runtime** (chosen): one table, one port with a Postgres adapter and an in-memory fake, and the place where S2 keeps the agent session.

## Consequences

- One task per message, also across restarts; `GetTask` answers from the store.
- Two runtime processes resuming the same unfinished task at once are not prevented yet; the skeleton runs one worker. A lease per task is needed before scaling workers out.
- After a worker dies, the engine notices only after the heartbeat timeout (30 s) and then retries; a restart therefore delays the run by up to that much.
