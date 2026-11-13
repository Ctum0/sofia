#!/bin/sh
# Coolify builds a fresh image per deployment and never prunes: on 2026-11-10 the
# VPS hit 100% disk with 155 GB of build cache and 82 images. This keeps the last
# 48 hours (one rollback window) and drops everything older.
set -eu
echo "[$(date -Iseconds)] prune start: $(df -h / | tail -1)"
docker builder prune -af --filter "until=48h" >/dev/null 2>&1 || true
# buildx path — belt and braces. On 2026-11-12 `builder prune` reported "Total: 0B"
# against 65 GB of cache while `buildx prune` cleared it. Run both so a blind spot
# in either command cannot silently let cache accumulate.
docker buildx prune -af --filter "until=48h" >/dev/null 2>&1 || true
docker image prune -af --filter "until=72h" >/dev/null 2>&1 || true
# Only Coolify-managed containers: plain `container prune` matches on CREATED time,
# so it will delete long-lived stopped stacks (MISP, Velociraptor) regardless of
# how recently they were stopped. Restrict to containers Coolify rebuilds anyway.
docker container prune -f --filter "until=24h" \
    --filter "label=coolify.managed=true" >/dev/null 2>&1 || true
cache=$(docker buildx du 2>/dev/null | awk "/^Reclaimable:/{print \$2}" || true)
echo "[$(date -Iseconds)] prune done:  $(df -h / | tail -1) build-cache-reclaimable=${cache:-unknown}"
