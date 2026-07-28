# Copyright (C) 2017-2026 Smart code 203358507

# Build stage: compiles TypeScript to dist/.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Dependency stage: production node_modules only, kept separate so the compiler
# and its transitive dependencies never reach the runtime image.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The service holds only ephemeral in-memory state, so it needs no write access
# to the filesystem at all. Combine with `read_only: true` in compose.
USER node

EXPOSE 8787
EXPOSE 9091

# Uses the public health endpoint rather than the metrics listener, which is
# bound to localhost by default.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.WATCH_PARTY_PORT||8787)+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
