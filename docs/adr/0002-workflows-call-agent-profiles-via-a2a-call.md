# Workflows call agent profiles with the built-in `call: a2a`

A workflow hands a task to an agent profile with the DSL's built-in `call: a2a` (Serverless Workflow 1.0.3), method `message/send`, and names the profile as `agentCard.endpoint: agent://<profile>`. The interpreter resolves the profile name and sends the message through its agent task port, which follows the A2A 1.0 wire model (`contracts/schemas/a2a.yaml`). We only accept the subset of the DSL the interpreter executes (`contracts/schemas/serverless-workflow.yaml`), so unsupported tasks fail validation before a run starts instead of failing mid-run.

## Considered Options

- **Custom function (`call: developer`)**: shorter, but hides that this is the A2A boundary and needs a function catalog.
- **Built-in `call: a2a` with `agent://<profile>`** (chosen): standard task, the A2A boundary stays visible in the workflow. A bare profile name is not a valid endpoint in the official schema; the `agent://` scheme is our convention. When agent profiles get real A2A endpoints, the endpoint becomes a URL without changing the task shape.

## Consequences

- The DSL describes A2A in its 0.3 names (`message/send`, parts with `kind`, role `user`); the interpreter translates them to A2A 1.0 (`{ text }`, `{ data }`, `ROLE_USER`). The raw output of the call is the A2A 1.0 `Task`, so expressions read e.g. `.status.state == "TASK_STATE_COMPLETED"`.
- The message id is derived from the run id and the step reference (`<runId>/do/0/implement`), so a repeated call is recognisable and agents can answer it with the existing task. The run id and step reference also travel in `SendMessageRequest.metadata` (`dev.tendworks/runId`, `dev.tendworks/stepReference`).
- Only `COMPLETED` completes the step. Any other state the call ends in (failed, rejected, canceled, input required, auth required) fails the step with a DSL runtime error; a call that cannot be delivered fails with a communication error.
- The interpreter core is deterministic and free of Node APIs; schema validation (Ajv) runs before a run starts, outside the durable execution engine. The initial `$context` is `{}`.
