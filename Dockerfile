# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ARG CODEX_RELEASE=0.144.0

LABEL org.opencontainers.image.source="https://github.com/karilaa-dev/ai-matrix-bot" \
      org.opencontainers.image.description="Private Matrix assistant powered by Codex"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@openai/codex@${CODEX_RELEASE}" \
    && npm cache clean --force

WORKDIR /app

ENV NODE_ENV=production \
    MATRIX_DATABASE_PATH=/app/data/matrix-bot.sqlite \
    CORE_DATABASE_URL=file:/app/data/codex-core.sqlite \
    FILE_ROOT=/app/data/files \
    BASH_ROOT=/app/data/bash \
    MATRIX_STORAGE_PATH=/app/state/matrix/sync \
    MATRIX_CRYPTO_PATH=/app/state/matrix/crypto \
    MATRIX_ACCESS_TOKEN_FILE=/run/secrets/matrix_access_token \
    MATRIX_RECOVERY_KEY_FILE=/run/secrets/matrix_recovery_key \
    CODEX_HOME=/home/node/.codex \
    CODEX_PATH=/usr/local/bin/codex \
    DOCLING_URL=http://docling:5001

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node system_prompt.md ./system_prompt.md

RUN mkdir -p /app/data/files /app/data/bash /app/state/matrix /home/node/.codex \
    && chown -R node:node /app /home/node/.codex

USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "start"]
