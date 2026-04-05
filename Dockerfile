# ────────────────────────────────────────────────────────────────────────────
# Multi-stage Dockerfile for Hubot + Discord adapter
#
# Stage 1 (deps)  – install production npm dependencies
# Stage 2 (final) – copy only the artefacts needed at runtime
# ────────────────────────────────────────────────────────────────────────────

# ── Stage 1: dependency installation ────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

# Copy manifests first to maximise layer caching.
COPY package.json package-lock.json ./

# Install production-only dependencies.
RUN npm ci --omit=dev

# ── Stage 2: final runtime image ─────────────────────────────────────────────
FROM node:22-alpine AS final

# OCI image labels (values are injected by the GitHub Actions workflow).
ARG CREATED
ARG REVISION
ARG VERSION
LABEL org.opencontainers.image.title="hubot-discord" \
      org.opencontainers.image.description="Hubot chatbot connected to Discord" \
      org.opencontainers.image.source="https://github.com/flmesh/hubot" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.version="${VERSION}"

WORKDIR /app

# Copy installed modules from the deps stage.
COPY --from=deps /app/node_modules ./node_modules

# Copy application source.
COPY package.json ./
COPY external-scripts.json ./
COPY scripts/ ./scripts/
COPY docker-entrypoint.sh ./

# Hubot checks these paths during bootstrap; keep them present even when empty.
RUN mkdir -p /app/configuration /app/src/scripts

# Create a non-root user/group, fix ownership, and make the entrypoint
# executable in a single layer.
RUN addgroup -S hubot && adduser -S hubot -G hubot \
    && chown -R hubot:hubot /app \
    && chmod +x /app/docker-entrypoint.sh

USER hubot

# Hubot does not listen on any inbound port when using the Discord adapter.
# EXPOSE is omitted intentionally.

# Validate required env vars and start the bot.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
