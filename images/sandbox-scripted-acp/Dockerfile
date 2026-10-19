# Test image for the end-to-end restart test: a scripted ACP agent installed as
# `claude-agent-acp`, so the Claude Code harness runs it like the real adapter (ACP over
# stdio, session/resume on the session volume) without a model or credentials.
# Built by `pnpm e2e`; never used for real agents.
FROM node:24.21.0-trixie-slim

WORKDIR /opt/harness
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY agent.mjs ./
RUN chmod 0755 agent.mjs && ln -s /opt/harness/agent.mjs /usr/local/bin/claude-agent-acp

# The same fixed paths as images/sandbox-claude-code: both are volumes of the agent session.
RUN mkdir -p /workspace /session/home /session/claude && chown -R 1000:1000 /workspace /session

USER 1000:1000
WORKDIR /workspace
ENV HOME=/session/home
