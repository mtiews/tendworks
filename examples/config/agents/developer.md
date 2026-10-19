---
apiVersion: tendworks.dev/v1
kind: AgentProfile
metadata:
  name: developer
spec:
  harness: claude-code
  sandbox: claude-code
---
The developer: Claude Code over ACP in a sandbox created from the `claude-code` sandbox
template. Needs the sandbox image and a harness credential (see deploy/.env.example);
without them its tasks fail with a message saying what is missing.
