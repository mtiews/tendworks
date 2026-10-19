---
apiVersion: tendworks.dev/v1
kind: AgentProfile
metadata:
  name: fake-developer
spec:
  harness: fake
  fake:
    outcome: completed
    message: Pretended to implement the issue.
    delaySeconds: 1
---
Stands in for the developer agent: answers every task after a second with an artifact
that echoes the task, without a sandbox or a model. Used by the end-to-end tests and to
try the platform without credentials.
