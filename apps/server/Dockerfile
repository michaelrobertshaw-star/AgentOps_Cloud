# ─── Base ────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH"
RUN corepack enable

# ─── Dependencies ────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /workspace
# Copy only manifests first (layer caching)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/db/package.json packages/db/tsconfig.json ./packages/db/
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
RUN pnpm install --frozen-lockfile

# ─── Build ───────────────────────────────────────────────────────────────────
FROM deps AS builder
WORKDIR /workspace
COPY packages/ packages/
COPY apps/server/ apps/server/
RUN pnpm --filter @agentops/shared build && \
    pnpm --filter @agentops/db build && \
    pnpm --filter @agentops/server build

# ─── Production runner ───────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
WORKDIR /workspace

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S agentops -u 1001 -G nodejs

# Copy workspace structure for pnpm resolution
COPY --from=builder /workspace/package.json .
COPY --from=builder /workspace/pnpm-workspace.yaml .
COPY --from=builder /workspace/pnpm-lock.yaml .
COPY --from=builder /workspace/tsconfig.base.json .

# Copy built workspace packages (dist + package.json only)
COPY --from=builder /workspace/packages/db/package.json     ./packages/db/
COPY --from=builder /workspace/packages/db/dist             ./packages/db/dist
COPY --from=builder /workspace/packages/shared/package.json ./packages/shared/
COPY --from=builder /workspace/packages/shared/dist         ./packages/shared/dist

# Copy built server
COPY --from=builder /workspace/apps/server/package.json ./apps/server/
COPY --from=builder /workspace/apps/server/dist         ./apps/server/dist

# Install production dependencies only (workspace packages resolved via symlinks)
RUN pnpm install --frozen-lockfile --prod && \
    chown -R agentops:nodejs /workspace

USER agentops
WORKDIR /workspace/apps/server

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:4000/api/health || exit 1

CMD ["node", "dist/index.js"]
