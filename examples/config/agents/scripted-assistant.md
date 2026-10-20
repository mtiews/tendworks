---
apiVersion: tendworks.dev/v1
kind: AgentProfile
metadata:
  name: scripted-assistant
spec:
  harness: claude-code
  sandbox: scripted-acp
  # The shortest idle time, so the end-to-end tests see an idle sandbox go.
  chat:
    idleMinutes: 1
---
Runs chats on the Claude Code harness against a scripted ACP agent instead of Claude
Code: the real sandbox, volumes and ACP session across turns, without a model. Used by
the end-to-end chat tests. The harness still insists on a credential
(`TEND_CLAUDE_CODE_CREDENTIAL`); any value does, the scripted agent ignores it.
