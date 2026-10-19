# The agent runtime records transcripts and cost from the ACP stream

The transcript of an agent session is what the agent runtime sees on the ACP connection, not the harness's own session files: every `session/update` notification, the harness's stderr, the task message and the result go as JSON Lines into a `TranscriptStore` (port; a file store on the worker volume `transcripts`, an in-memory fake). The task reports where it is (`Task.metadata["dev.tendworks/transcript"]`, a `file://` URL) and what the session cost (`Task.metadata["dev.tendworks/cost"]`, the last `usage_update` cost of the session); orchestration copies both onto the step, so `tend run get` shows them. The harness credential is chosen by `TEND_CLAUDE_CODE_CREDENTIAL` (`oauth-token` or `api-key`), and only that one variable is passed into the sandbox. While a session runs, the client sends an unknown ACP extension request (`_tendworks/keepalive`) every minute; the adapter answers "method not found", so the attached stream through the socket proxy never sits idle for its 10-minute cut.

## Considered Options

- **Copy the harness's own transcript** (`$CLAUDE_CONFIG_DIR/projects/…/<session>.jsonl`) out of the sandbox before destroying it: richer, but harness-specific, lost when the sandbox dies unexpectedly, and its path layout is undocumented.
- **Record the ACP stream in the runtime** (chosen): harness-neutral, written while the session runs, so it survives a crashed sandbox.
- **Patch the socket proxy's HAProxy config with `timeout tunnel`**: fixes the idle cut for every stream, but changes a pinned third-party image's config; the keep-alive needs no proxy change and is tested in-process.

## Consequences

- The transcript contains what ACP exposes (messages, tool calls, plans, usage), not the model's raw API traffic.
- Cost with a subscription OAuth token is the harness's estimate, not a bill.
- The ACP session id is recorded in the transcript (`acp-session` entry); keeping it next to the task for `session/resume` is #11 (ADR 0004).
- Transcripts are files on one worker volume; several workers or a web UI that shows transcripts need the store behind an API or object storage.
