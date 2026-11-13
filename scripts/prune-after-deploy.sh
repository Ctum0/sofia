#!/usr/bin/env bash
# Reclaims what a deploy leaves behind, without touching anything that is running.
#
# Why: every deploy produces a new ~787 MB image and keeps the previous one. Five
# deploys in one day left 4 GB of dead images plus 10.3 GB of BuildKit cache on a
# VPS that also runs eleven other services. Nothing pruned it, because Coolify does
# not and `docker system prune` is too blunt to run unattended.
#
# Scope, stated precisely, because this runs on a shared host:
#   * images whose repository is this app's (`zp31…`, `sofia…`) AND which no
#     container references — the running app is excluded by construction;
#   * BuildKit cache older than 24 h — a rebuild within the day still hits cache,
#     which is the window that matters while iterating on a deploy;
#   * anonymous volumes only. `docker volume prune` without `-a` is defined to
#     remove anonymous volumes that no container references; named volumes (this
#     app's `/app/data`, the browser profile) are never candidates. `-a` is
#     deliberately absent.
#
# The BuildKit prune is global rather than per-app: Docker keys cache by layer, not
# by project, so a scoped version is not available. `until=24h` bounds it to cache
# that no build in the last day used.
set -uo pipefail

say() { echo "  $*"; }

before=$(docker system df --format '{{.Type}} {{.Size}}' 2>/dev/null | tr '\n' ' ')

removed=0
kept=0
# Process substitution, not a pipe: in `cmd | while read`, the loop body runs in a
# subshell and `removed` never leaves it. That bug made an earlier version report
# "removed 0" while the image it was pointed at was still there.
while read -r id repo; do
  [ -n "$id" ] || continue
  if docker ps --filter "ancestor=$id" -q | grep -q .; then
    kept=$((kept + 1))
    continue
  fi
  if docker rmi "$id" >/dev/null 2>&1; then
    removed=$((removed + 1))
  fi
done < <(docker images --format '{{.ID}} {{.Repository}}' | grep -E ' (zp31|sofia)' | sort -u)

say "images: removed $removed, kept $kept in use"

cache_before=$(docker buildx du 2>/dev/null | tail -1 | awk '{print $2}')
docker builder prune -f --filter "until=24h" >/dev/null 2>&1
cache_after=$(docker buildx du 2>/dev/null | tail -1 | awk '{print $2}')
say "build cache (>24h): ${cache_before:-?} -> ${cache_after:-?}"

vols=$(docker volume prune -f 2>/dev/null | grep -i reclaimed | head -1)
say "anonymous volumes: ${vols:-nothing reclaimed}"

after=$(docker system df --format '{{.Type}} {{.Size}}' 2>/dev/null | tr '\n' ' ')
say "before: $before"
say "after:  $after"
