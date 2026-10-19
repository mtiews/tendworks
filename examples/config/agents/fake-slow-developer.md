---
apiVersion: tendworks.dev/v1
kind: AgentProfile
metadata:
  name: fake-slow-developer
spec:
  harness: fake
  fake:
    outcome: completed
    message: Pretended to implement the issue, slowly.
    delaySeconds: 20
---
Like `fake-developer`, but works for 20 seconds, long enough to restart the platform
while it works. Used by the restart end-to-end test.
