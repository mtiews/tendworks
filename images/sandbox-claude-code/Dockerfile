# Sandbox image for agent profiles with harness `claude-code`: Claude Code behind its
# ACP adapter (`claude-agent-acp`, versions pinned in package-lock.json), run as non-root.
# The platform never pulls images; build it on the sandbox host:
#   docker compose -f deploy/compose.yaml --profile sandbox-images build sandbox-claude-code
FROM node:24.21.0-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/harness
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
ENV PATH=/opt/harness/node_modules/.bin:$PATH

# Fixed paths the agent runtime relies on: the workspace, and /session for the harness's
# home and config directory (HOME and CLAUDE_CONFIG_DIR are set per session). Both are
# mounted as volumes of the agent session; an empty volume takes over the content and
# ownership of these directories, so they must stay owned by the sandbox user.
RUN mkdir -p /workspace /session/home /session/claude && chown -R 1000:1000 /workspace /session

USER 1000:1000
WORKDIR /workspace
ENV HOME=/session/home
