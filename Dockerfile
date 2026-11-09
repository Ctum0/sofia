# Sofia — one image that serves the stage, the brain proxy and the voice bridge.
#
# Two stages on purpose:
#   builder  the monorepo's own toolchain, only to produce apps/stage-web/dist
#   runtime  a plain node image with the gateway and that static bundle
#
# The runtime stage carries no pnpm, no node_modules tree, no source: if the
# gateway needs a new dependency it belongs in apps/sofia-gateway/package.json.
#
# The whole repo is copied before install rather than manifests-first: pnpm
# --frozen-lockfile validates the whole workspace graph, so a partial tree only
# buys a confusing lockfile error.

# ---------- builder ----------
FROM node:22-bookworm-slim AS builder

# isolated-vm (pulled by the workspace) compiles against Python and a C++ toolchain.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /repo
COPY . .

# The repo is baked into an image, so git metadata is absent and simple-git
# (via unplugin-info) must not try to inspect a repository.
RUN git config --global --add safe.directory /repo || true

RUN pnpm install --frozen-lockfile --prefer-offline

ENV NODE_OPTIONS=--max-old-space-size=3072
RUN pnpm -F @proj-airi/stage-web build

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime

# Coolify overrides an image's HEALTHCHECK with its own probe, which shells out to
# curl or wget. Without either, a perfectly healthy container reports unhealthy.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the gateway's own manifest: no workspace, so plain npm is fine here.
COPY apps/sofia-gateway/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

COPY apps/sofia-gateway/server.mjs ./server.mjs
COPY apps/sofia-gateway/auth.mjs ./auth.mjs
COPY apps/sofia-gateway/live.mjs ./live.mjs
COPY apps/sofia-gateway/reasoning-filter.mjs ./reasoning-filter.mjs
COPY apps/sofia-gateway/public ./public

COPY --from=builder /repo/apps/stage-web/dist ./dist

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DIST_DIR=/app/dist \
    PUBLIC_DIR=/app/public

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
