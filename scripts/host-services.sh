#!/usr/bin/env bash
# host-services.sh — the containers Coolify does not manage, recreated on demand.
#
# Why this exists: a Coolify deployment deleted `sofia-browser` once, and the
# release then failed with "fetch failed" — a product-looking error with an
# infrastructure cause. The browser is not part of the Coolify app: it is a
# Playwright container the gateway talks to over the docker network. Nothing in
# the repo described how to bring it back, so it was recreated by hand and the
# knowledge lived in one shell history.
#
# Idempotent: a healthy container is left alone, so calling this before every
# release costs nothing.
#
# Usage:
#   bash scripts/host-services.sh            # ensure everything is up
#   bash scripts/host-services.sh --status   # describe, change nothing
#   bash scripts/host-services.sh --recreate # force a fresh browser container
#
# Runs on the VPS host (needs docker). Called by scripts/verify-release.sh.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

MODE="${1:-ensure}"
BROWSER_IMAGE="mcr.microsoft.com/playwright:v1.64.1-jammy"
# The profile lives on the host, not in the container: it is the whole reason a
# login survives a deploy, and an unmounted path would be an anonymous layer that
# vanished with the container.
PROFILE_DIR_HOST="${PROFILE_DIR_HOST:-/home/ctum/sofia-browser-profile}"
REPO="$(pwd)"
QA_DIR="${QA_DIR:-/home/ctum/qa}"

say() { echo "  $*"; }
fail() { echo "FAIL [$1] $2"; exit "$1"; }

docker info >/dev/null 2>&1 || fail 1 "no docker on this host"

browser_state() {
  docker inspect sofia-browser --format '{{.State.Status}}' 2>/dev/null || echo missing
}

browser_healthy() {
  local app
  app=$(docker ps --format '{{.Names}}' | grep zp31 | head -1)
  [ -n "$app" ] || return 1
  docker exec "$app" node -e '
    fetch("http://sofia-browser:8790/healthz")
      .then(r => r.ok ? process.exit(0) : process.exit(1))
      .catch(() => process.exit(1))
  ' >/dev/null 2>&1
}

describe() {
  say "sofia-browser: $(browser_state)"
  if [ "$(browser_state)" = "running" ]; then
    local app
    app=$(docker ps --format '{{.Names}}' | grep zp31 | head -1)
    say "  reachable from the app: $(browser_healthy && echo yes || echo no)"
    say "  mounts: $(docker inspect sofia-browser --format '{{range .Mounts}}{{.Destination}} {{end}}')"
    say "  profile on host: ${PROFILE_DIR_HOST}$( [ -d "$PROFILE_DIR_HOST" ] && echo ' (present)' || echo ' (MISSING)')"
  fi
}

if [ "$MODE" = "--status" ]; then
  describe
  exit 0
fi

# --- the browser -------------------------------------------------------------
# `sofia-browser` is the gateway's eyes and hands. It must be on the same docker
# network as the app, must see the browse-service source, must have the profile
# volume, and must be able to resolve `playwright` (the image ships browsers but
# the module is resolved from the QA directory, which is mounted).
if [ "$MODE" = "--recreate" ] || [ "$(browser_state)" != "running" ]; then
  [ -d "$PROFILE_DIR_HOST" ] || { mkdir -p "$PROFILE_DIR_HOST" && chmod 700 "$PROFILE_DIR_HOST"; }
  say "starting sofia-browser"
  docker rm -f sofia-browser >/dev/null 2>&1
  docker run -d --name sofia-browser --restart unless-stopped \
    --network coolify \
    -v "$REPO/apps/sofia-gateway/browse-service:/app" \
    -v "$QA_DIR:/qa" \
    -v "$PROFILE_DIR_HOST:/app/data/profile" \
    -w /app \
    -e PLAYWRIGHT_MODULE=/qa/node_modules/playwright/index.mjs \
    -e PROFILE_DIR=/app/data/profile \
    --entrypoint node \
    "$BROWSER_IMAGE" server.mjs >/dev/null || fail 2 "could not start sofia-browser"
else
  say "sofia-browser: already running"
fi

# --- and prove it ------------------------------------------------------------
# A container that is "Up" but cannot resolve playwright, or cannot answer
# /healthz, is exactly the state that made a release fail with "fetch failed".
for _ in $(seq 1 20); do
  browser_healthy && break
  sleep 1
done
browser_healthy || {
  echo "  --- last lines from sofia-browser ---"
  docker logs --tail 12 sofia-browser 2>&1 | tail -12
  fail 3 "sofia-browser is running but the app cannot reach it"
}
say "sofia-browser answers from the app container"

describe
exit 0
