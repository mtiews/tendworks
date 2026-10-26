# Sandbox image for agent profiles with harness `claude-code`: Claude Code behind its
# ACP adapter (`claude-agent-acp`, versions pinned in package-lock.json), git and the
# GitHub CLI, run as non-root.
# The platform never pulls images; build it on the sandbox host:
#   docker compose -f deploy/compose.yaml --profile sandbox-images build sandbox-claude-code
FROM node:24.21.0-trixie-slim

ARG TARGETARCH
# GitHub CLI for pushing branches and opening pull requests; pinned, checksums from the
# release's gh_<version>_checksums.txt.
ARG GH_VERSION=2.102.0
ARG GH_SHA256_AMD64=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386
ARG GH_SHA256_ARM64=7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
 && case "$arch" in amd64) sum="$GH_SHA256_AMD64" ;; arm64) sum="$GH_SHA256_ARM64" ;; *) echo "unsupported architecture $arch" >&2; exit 1 ;; esac \
 && curl -fsSL -o /tmp/gh.tar.gz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz" \
 && echo "$sum  /tmp/gh.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/gh.tar.gz -C /tmp \
 && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh \
 && rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_${arch}" \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# git reaches any host with the workspace's own credential through a generic credential
# helper, which the agent runtime's checkout configures for the repository's host only
# (ADR 0022); the GitHub CLI is an agent tool and reads its token from the variable the
# workspace exposes (e.g. GH_TOKEN). Commits carry a fixed agent identity.
COPY --chmod=0755 git-credential-tendworks /usr/local/bin/git-credential-tendworks
RUN git config --system user.name "Tendworks agent" \
 && git config --system user.email "agent@tendworks.dev" \
 && git config --system init.defaultBranch main \
 && gh --version

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
