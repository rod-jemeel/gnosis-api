# Gnosis API — production image.
#
# Build:  docker build -t gnosis-api .
# Run:    docker compose --profile app up -d --build   (with Neon DATABASE_URL)
#
# The embedding model (bge-small ONNX) is downloaded at build time and
# baked into the image so cold starts never re-fetch it.

FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Warm the local embedding model into .models/ for the runtime layer.
# Config validation needs placeholder values; no database is contacted.
RUN DATABASE_URL=postgres://build REDIS_URL=redis://build \
    pnpm exec tsx --eval "import('./src/providers/embeddings.js').then((m) => m.warmEmbedder()).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })"

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/.models ./.models

EXPOSE 3000
CMD ["node", "dist/index.js"]
