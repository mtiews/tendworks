---
apiVersion: tendworks.dev/v1
kind: AgentProfile
metadata:
  name: fake-assistant
spec:
  harness: fake
  fake:
    message: Pretended to answer.
    delaySeconds: 1
  chat: {}
---
Stands in for the assistant in chats: answers every message after a second, without a
sandbox or a model. Used by tests and to try chats without credentials.
