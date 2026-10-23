---
apiVersion: tendworks.dev/v1
kind: AgentProfile
metadata:
  name: scripted-mcp-assistant
spec:
  harness: claude-code
  sandbox: scripted-acp
  mcp: [tendworks]
  chat: {}
---
Runs chats with the platform MCP server against a scripted ACP agent instead of Claude
Code: a prompt `mcp:<tool>` calls that tool of the platform MCP server through the MCP-only
gateway, without a model. Used by the end-to-end chat and sandbox access tests.
