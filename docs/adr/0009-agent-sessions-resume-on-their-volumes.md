# Agent sessions resume on their volumes with the kept ACP session

A platform restart ends the worker's attached ACP connection, so the adapter in the sandbox exits; the sandbox container stays, but nothing can reattach to it. To resume instead of starting over (ADR 0004), an agent session keeps two things beyond its sandbox:

- **Volumes per agent session.** The sandbox API gets named volumes (`CreateSandboxRequest.volumes`, `DELETE /volumes/{volumeName}`): created on first mount, they take over the ownership of the image directory they are mounted on and outlive the sandbox. The Claude Code harness mounts `<taskId>-workspace` on `/workspace` and `<taskId>-session` on `/session` (`HOME=/session/home`, `CLAUDE_CONFIG_DIR=/session/claude`), fixed paths in the sandbox image.
- **The harness session with the task.** The harness port gets `HarnessTask.session` and `HarnessObserver.saveSession()`; the agent runtime stores the opaque record in `agent_runtime.tasks.session` (jsonb) without looking inside. Claude Code keeps `{ sandboxId, sessionId }`: the sandbox right after it is created, the ACP session id before the first prompt is sent.

On resume the harness destroys the abandoned sandbox, creates a new one on the same volumes, sends `session/resume` with the kept session id and the same `cwd`, and prompts the agent to check the workspace and continue; the interrupted turn itself is not replayed. If the agent cannot resume (no `sessionCapabilities.resume`, or it no longer knows the session), the harness starts a new session with the original task message on the kept workspace and records `acp-resume-failed` in the transcript. When a session ends in any terminal state, the harness destroys the sandbox and deletes both volumes.

## Considered Options

- **Reattach to the still-running sandbox**: no volumes needed, but fails after a host reboot or when the sandbox died with the worker, and needs a way to find the adapter process again; volumes cover both.
- **`session/load`**: replays the whole history as updates, which the runtime does not need and would duplicate in the transcript; `session/resume` restores the context silently.
- **Named volumes in the sandbox API, kept session in the task store** (chosen): backend-neutral (OpenSandbox and Kubernetes have volumes too), and the session record sits where ADR 0004 put it.

## Consequences

- The socket proxy opens `VOLUMES` (with `POST`, writes too), so the worker can delete session volumes. This adds no new class of risk: whoever reaches the proxy can already create privileged containers (ADR 0001).
- The fake agent still resumes by its elapsed time; the end-to-end restart test uses it. Resuming Claude Code is covered by the scripted ACP agent in the unit suites and by a manual smoke test with the real harness (docs/platform-implementation.md).
- Volumes of a session interrupted for good (e.g. its run is never resumed) are not cleaned up yet; a sweeper over volumes without an unfinished task follows with operations work.
- Two workers resuming the same task at once would mount the same volumes; the lease from ADR 0004 is still needed before scaling workers out.
