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
    HOME=/app/data/home \
    MATRIX_DATABASE_PATH=/app/data/matrix-bot.sqlite \
    CORE_DATABASE_URL=file:/app/data/codex-core.sqlite \
    FILE_ROOT=/app/data/files \
    BASH_ROOT=/app/data/files/bash \
    MATRIX_SESSION_PATH=/app/data/matrix/session.json \
    MATRIX_STORAGE_PATH=/app/data/matrix/sync \
    MATRIX_CRYPTO_PATH=/app/data/matrix/crypto \
    CODEX_HOME=/app/data/codex \
    CODEX_PATH=/usr/local/bin/codex

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node system_prompt.md ./system_prompt.md

RUN mkdir -p /app/data/home /app/data/files/bash /app/data/matrix /app/data/codex \
    && chown -R node:node /app

USER node

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD npm run health --silent || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "start"]
