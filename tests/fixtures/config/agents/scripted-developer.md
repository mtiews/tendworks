---
apiVersion: tendworks.dev/v1
kind: AgentProfile
metadata:
  name: scripted-developer
spec:
  harness: claude-code
  sandbox: scripted-acp
---
Runs the Claude Code harness against a scripted ACP agent instead of Claude Code: the
real sandbox, volumes, ACP connection and `session/resume`, without a model. Used by the
end-to-end restart test. The harness still insists on a credential
(`TEND_CLAUDE_CODE_CREDENTIAL`); any value does, the scripted agent ignores it.
