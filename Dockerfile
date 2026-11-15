# AI-Receptionist — production image (Next.js standalone server + migrations)
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time only: allow the build without live DB/Redis (lazy clients).
RUN npm run build \
 && npm run build:runtime

# Production dependencies only: the runtime image must not carry the build
# toolchain (drizzle-kit, tsx, vitest, esbuild) — those ship their own binaries
# and are scanned as part of the image.
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev \
 && npm cache clean --force

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    RUN_MIGRATIONS=true

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs \
 && mkdir -p /app/storage /app/.next/cache \
 && chown -R nextjs:nodejs /app

COPY --chown=nextjs:nodejs --from=prod-deps /app/node_modules ./node_modules
COPY --chown=nextjs:nodejs --from=builder /app/package.json ./package.json
COPY --chown=nextjs:nodejs --from=builder /app/next.config.ts ./next.config.ts
COPY --chown=nextjs:nodejs --from=builder /app/tsconfig.json ./tsconfig.json
COPY --chown=nextjs:nodejs --from=builder /app/.next ./.next
COPY --chown=nextjs:nodejs --from=builder /app/public ./public
COPY --chown=nextjs:nodejs --from=builder /app/drizzle ./drizzle
COPY --chown=nextjs:nodejs --from=builder /app/src ./src
# Compiled runtime scripts (migrate/worker/media/admin): plain CommonJS, so the
# image needs no TypeScript runner.
COPY --chown=nextjs:nodejs --from=builder /app/runtime ./runtime
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh \
 # npm and corepack bundle their own dependency trees (brace-expansion, pacote,
 # sigstore, ip-address, picomatch …) that are useless at runtime and regularly
 # carry advisories. Everything here uses `node` directly.
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0"]
