# Test image for the end-to-end restart test: a scripted ACP agent installed as
# `claude-agent-acp`, so the Claude Code harness runs it like the real adapter (ACP over
# stdio, session/resume on the session volume) without a model or credentials.
# Built by `pnpm e2e`; never used for real agents.
FROM node:24.21.0-trixie-slim

# git for the workspace checkout, and a local bare repository the end-to-end tests use as
# a git workspace (file:///srv/git/playground.git): one commit on main with a README.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system user.name "Tendworks agent" \
 && git config --system user.email "agent@tendworks.dev" \
 && git config --system init.defaultBranch main \
 && git init --quiet /tmp/seed \
 && printf 'scripted playground\n' > /tmp/seed/README.md \
 && git -C /tmp/seed add README.md \
 && git -C /tmp/seed commit --quiet -m initial \
 && git clone --quiet --bare /tmp/seed /srv/git/playground.git \
 && rm -rf /tmp/seed \
 && chown -R 1000:1000 /srv/git

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
