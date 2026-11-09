# Sofia — one image that serves the stage, the brain proxy and the voice bridge.
#
# Two stages on purpose:
#   builder  the monorepo's own toolchain, only to produce apps/stage-web/dist
#   runtime  a plain node image with the gateway and that static bundle
#
# The runtime stage carries no pnpm, no node_modules tree, no source: if the
# gateway needs a new dependency it belongs in apps/sofia-gateway/package.json.

# ---------- builder ----------
FROM node:22-bookworm-slim AS builder

# git is a real build dependency: unplugin-info shells out to it and the build
# dies with `spawn git ENOENT` without the binary, repository or not.
# python3/make/g++ are deliberately NOT installed — see the filtered install
# below. The only native package in the graph (isolated-vm) belongs to
# integrations/minecraft, which this image never touches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /repo
COPY . .

# The repo is baked into an image, so git metadata is absent and simple-git
# (via unplugin-info) must not try to inspect a repository.
RUN git config --global --add safe.directory /repo || true

# Install ONLY stage-web and the workspace packages it depends on. A plain
# `pnpm install` also resolves integrations/minecraft, whose `isolated-vm`
# compiles C++ from source — measured at ~5 minutes of the ~8 minute deploy
# budget for a package this image never loads. With the filter the install is
# ~80 s and needs no compiler at all (measured: 303 s -> 80 s).
#
# No BuildKit cache mounts here on purpose: measured on this host, a
# `--mount=type=cache` does not survive between builds (a marker written in one
# build was absent in the next), and Coolify builds with its own builder
# anyway. A mount would look like an optimisation without being one; the
# filtered install is the real win and it works with any builder.
RUN pnpm install --filter=@proj-airi/stage-web... --no-frozen-lockfile

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

# Every gateway module in one COPY. A per-file list is a silent trap: adding a
# module and forgetting its line produced a container that restarted forever
# with ERR_MODULE_NOT_FOUND while the build itself reported success.
COPY apps/sofia-gateway/*.mjs ./
COPY apps/sofia-gateway/public ./public

# ...and make that class fail here instead: every relative import must resolve
# to a file that exists in this image.
RUN node -e "const fs=require('fs'),path=require('path');const files=fs.readdirSync('.').filter(n=>n.endsWith('.mjs'));let bad=[];for(const f of files){for(const m of fs.readFileSync(f,'utf8').matchAll(/from\s+'(\.[^']+)'/g)){const p=path.resolve(m[1]);if(!(fs.existsSync(p)||['.mjs','.js','/index.mjs','/index.js'].some(e=>fs.existsSync(p+e))))bad.push(f+' -> '+m[1]);}}if(bad.length){console.error('unresolved imports: '+bad.join(', '));process.exit(1)}console.log('gateway imports resolve: '+files.join(' '))"

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
