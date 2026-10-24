---
apiVersion: tendworks.dev/v1
kind: AgentProfile
metadata:
  name: scripted-secret-assistant
spec:
  harness: claude-code
  sandbox: scripted-acp
  # An agent secret no compose file names: the end-to-end test adds it to deploy/.env.
  env:
    SCRIPTED_SECRET:
      secretRef:
        name: TENDWORKS_AGENT_E2E_SECRET
  chat:
    idleMinutes: 1
---
Like scripted-assistant, with one agent secret passed in as SCRIPTED_SECRET. A prompt
"secret:" answers with the SHA-256 digest of what arrived, never the value. Used by the
end-to-end test of agent secrets added to deploy/.env.
