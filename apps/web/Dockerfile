# ─── Base ────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH"
RUN corepack enable

# ─── Dependencies ────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /workspace
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile

# ─── Build ───────────────────────────────────────────────────────────────────
FROM deps AS builder
WORKDIR /workspace
COPY packages/shared/ packages/shared/
COPY apps/web/ apps/web/
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @agentops/shared build && \
    pnpm --filter @agentops/web build

# ─── Production runner ───────────────────────────────────────────────────────
# Next.js standalone output bundles everything needed into .next/standalone
FROM node:20-alpine AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001 -G nodejs

WORKDIR /app

# Static assets
COPY --from=builder /workspace/apps/web/public ./public

# Standalone server (self-contained node_modules)
COPY --from=builder --chown=nextjs:nodejs /workspace/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /workspace/apps/web/.next/static ./.next/static

USER nextjs

EXPOSE 3000
ENV PORT=3000 \
    HOSTNAME="0.0.0.0"

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:3000/ || exit 1

CMD ["node", "server.js"]
