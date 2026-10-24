# Builds the server and worker bundles from the monorepo. Build context: repository root.
FROM node:24.21.0-trixie-slim AS build
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 && pnpm install --frozen-lockfile --prod --offline

FROM node:24.21.0-trixie-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /repo /app
# Mount points of the transcript and agent secrets volumes; a new volume takes over this ownership.
RUN mkdir -p /var/lib/tendworks/transcripts /var/lib/tendworks/agent-secrets  && chown node:node /var/lib/tendworks/transcripts  && chown node:node /var/lib/tendworks/agent-secrets && chmod 700 /var/lib/tendworks/agent-secrets
USER node

FROM runtime AS server
EXPOSE 8080
CMD ["node", "apps/server/dist/main.js"]

FROM runtime AS worker
CMD ["node", "apps/worker/dist/main.js"]
