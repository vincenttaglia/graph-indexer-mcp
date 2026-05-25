# syntax=docker/dockerfile:1.7
# =============================================================================
# graph-indexer-mcp — multi-stage container image
#
# Stage 1 (builder):  install all deps, compile TypeScript, prune devDeps.
# Stage 2 (kubectl):  pull pinned kubectl binary from the official upstream
#                     image (no curl/network call from our build).
# Stage 3 (runtime):  minimal node:22-alpine, non-root, with kubectl baked in
#                     for the graphman CLI fallback (kubectl exec into
#                     graph-node pods).
#
# `pg` (the postgres client) is pure JS — no native bindings — so alpine is
# safe. If a future dep adds native build steps, switch the runtime base to
# node:22-bookworm-slim and re-run a build.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: builder
# -----------------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /build

# Install deps first (better layer caching). `npm ci` requires the lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=optional

# Compile TypeScript -> dist/.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies (typescript, @types/*) from node_modules so we ship
# the runtime tree only.
RUN npm prune --omit=dev


# -----------------------------------------------------------------------------
# Stage 2: kubectl (pinned)
# -----------------------------------------------------------------------------
# Bitnami publishes a minimal, signed image with the kubectl binary at a known
# path. Pinning to a specific minor version keeps the image reproducible.
FROM bitnami/kubectl:1.31.0 AS kubectl


# -----------------------------------------------------------------------------
# Stage 3: runtime
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# OCI metadata.
LABEL org.opencontainers.image.title="graph-indexer-mcp"
LABEL org.opencontainers.image.description="MCP server for managing Graph Protocol indexer operations"
LABEL org.opencontainers.image.source="https://github.com/graphprotocol/graph-indexer-mcp"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# Tini gives us a real PID 1 (proper signal handling + zombie reaping). The
# MCP stdio loop is long-lived; a stuck child without reaping causes leaks.
RUN apk add --no-cache tini ca-certificates

# kubectl from the pinned bitnami stage.
COPY --from=kubectl /opt/bitnami/kubectl/bin/kubectl /usr/local/bin/kubectl
RUN chmod 0755 /usr/local/bin/kubectl \
 && /usr/local/bin/kubectl version --client=true >/dev/null 2>&1 \
    || (echo "WARNING: kubectl client smoke-check failed; binary may not be runnable on alpine (musl)." >&2 && exit 1)

# Non-root user. UID 10001 sidesteps collisions with common host UIDs.
RUN addgroup -g 10001 -S mcp \
 && adduser -u 10001 -G mcp -S -h /home/mcp -s /sbin/nologin mcp

WORKDIR /app

# Copy the compiled app + pruned node_modules from builder.
COPY --from=builder --chown=mcp:mcp /build/dist ./dist
COPY --from=builder --chown=mcp:mcp /build/node_modules ./node_modules
COPY --from=builder --chown=mcp:mcp /build/package.json ./package.json

# Entrypoint script (validates required env vars before exec).
COPY --chown=root:root scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

USER mcp:mcp

ENV NODE_ENV=production
ENV NODE_OPTIONS="--enable-source-maps"

# MCP speaks stdio, so there is no HTTP endpoint to probe. Health = the node
# process is still alive. `pgrep` is busybox-provided on alpine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD pgrep -f "node dist/index.js" >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/index.js"]
