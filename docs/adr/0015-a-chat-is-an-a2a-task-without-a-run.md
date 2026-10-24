# A chat is an A2A task without a run

A chat is an agent session a human starts and leads directly: the control plane hands a message to the agent runtime, which creates an ordinary A2A task for it, without a run, workflow or trigger. After every turn the task goes to `input-required`; every further human message is a `SendMessage` to the same task, and the task ends only when the human ends the chat. One chat is one task, one agent session and one harness session. The control plane exposes chats as the public resource `chats` (start, list, get, send a message, cancel the current turn, end); it reaches the agent runtime through an agent runtime API served by the worker (`contracts/openapi/agent-runtime.yaml`), as it reaches orchestration through the orchestration API.

All chat state lives on the platform (the durable task, ADR 0004; the transcript, ADR 0007; workspace and harness configuration on the session's volumes, ADR 0009), so clients hold none: any client can attach to a chat, leave and come back, several at once. Messages are serialized: a message sent while a turn is still running is refused (409); the client can cancel the turn instead.

A chat's sandbox does not outlive its idle time: when the human has not answered for the profile's `spec.chat.idleMinutes`, the runtime destroys the sandbox and keeps the volumes; the next message resumes the session in a new sandbox, the same path as after a platform restart. Ending a chat deletes its volumes and keeps its transcript.

Only agent profiles with `spec.chat` can be chatted with. What a chat can do follows from its profile alone (credentials, MCP servers, workspace); a profile without repository credentials can work in its workspace but cannot push.

## Considered Options

- **A run of a built-in chat workflow** with a `listen` loop: chats would appear among runs and orchestration would sit between human and agent for no gain; every message would become a workflow event.
- **A run without a workflow**: a second kind of run for one use case.
- **A task per turn in the same A2A context**: every turn would be a new agent session, losing the harness's own conversation state.
- **A chat with any profile**: anyone with API access could steer an agent holding push rights directly and bypass its workflow.

## Consequences

- The same mechanism (`input-required`, `SendMessage` to a running task) later carries a human's intervention in a run's agent step.
- "Task" is no longer only what orchestration hands to an agent (see `GLOSSARY.md`).
- Resuming a session is the normal case of every idle chat, not only a recovery path, so it is exercised constantly.
- Background processes do not survive a chat's idle time; the transcript shows the resume.
