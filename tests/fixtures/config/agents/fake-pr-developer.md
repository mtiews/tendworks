---
apiVersion: tendworks.dev/v1
kind: AgentProfile
metadata:
  name: fake-pr-developer
spec:
  harness: fake
  fake:
    outcome: completed
    message: Pretended to implement the issue and open a pull request.
    delaySeconds: 1
    artifacts:
      - name: pull-request
        url: https://git.example/example/playground/pull/1
        description: The pull request the fake agent pretends to have opened.
---
Like `fake-developer`, but reports a pull request, as the developer agent does after it
opened one. The pull request lives on the reserved `git.example` host. Used by the
end-to-end tests of the automated chain (`fake-develop-issue`).
