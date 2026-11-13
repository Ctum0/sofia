#!/bin/bash
# =============================================================================
# hermes-profile-backup.sh — archive the Hermes *brain* (memories, skills,
# sessions, per-profile state, cron) which vps-backup.sh misses.
#
# Why this exists: /opt/data inside the hermes container is a bind mount of
# /home/ctum/.hermes, and that host directory is 0700 root:root — so a host-side
# `tar` as ctum gets "Permission denied". The only readable view is inside the
# container, where docker exec runs as root. Hence: tar *inside*, write *outside*.
#
# Usage:
#   hermes-profile-backup.sh                 # -> /tmp/vps-backup/hermes-profile/
#   hermes-profile-backup.sh <target-dir>    # -> <target-dir>/hermes-profile.tar.gz
#   FULL=1 hermes-profile-backup.sh          # also include the 385 MB default
#                                            # profile state.db (~160 MB gzipped)
#
# Exit: 0 = archive written and verified, non-zero = nothing usable produced.
# =============================================================================
set -uo pipefail

CONTAINER="${CONTAINER:-hermes}"
OUTDIR="${1:-/tmp/vps-backup/hermes-profile}"
LOG="/home/ctum/logs/hermes-profile-backup.log"
OUT="${OUTDIR}/hermes-profile.tar.gz"
TMP="${OUT}.partial"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

mkdir -p "$OUTDIR" "$(dirname "$LOG")"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
    log "ERROR: container '$CONTAINER' not found. Aborting."
    exit 1
fi

# What makes a restore possible, in order of what hurts most to lose:
#   memories/            MEMORY.md + USER.md (the two files that ARE the persona)
#   profiles/<p>/…       SOUL.md, config.yaml, memories, cron, per-profile state.db
#   skills/              1008 curated skill files (20 categories)
#   sessions/            27 MB of transcripts (session_search)
#   scripts/, cron/, .env, config.yaml, SOUL.md
# Excluded on purpose: cache (5 G), images, audio_cache, node_modules, logs,
# and the live state.db-wal (the DB is copied mid-write, so the -wal is noise).
EXCLUDES=(
    --exclude='*/cache'          --exclude='*/images'
    --exclude='*/image_cache'    --exclude='*/audio_cache'
    --exclude='*/node_modules'   --exclude='*/logs'
    --exclude='*/state.db-wal'   --exclude='*.lock'
)
PATHS=(memories skills sessions profiles cron scripts config.yaml .env SOUL.md)
[ "${FULL:-0}" = "1" ] && PATHS+=(state.db kanban.db plans)

log "=== Hermes profile archive -> $OUT (FULL=${FULL:-0}) ==="

# --warning=no-file-changed: SQLite and log files are written while we read them.
# tar exits 1 for that benign case, so treat 1 as success only when gzip -t passes.
docker exec "$CONTAINER" tar czf - --warning=no-file-changed \
    -C /opt/data "${EXCLUDES[@]}" "${PATHS[@]}" > "$TMP" 2>/tmp/hermes-profile-backup.err
rc=$?

if [ ! -s "$TMP" ]; then
    log "ERROR: archive empty (tar exit $rc). $(head -3 /tmp/hermes-profile-backup.err)"
    rm -f "$TMP"; exit 1
fi
if ! gzip -t "$TMP" 2>/dev/null; then
    log "ERROR: gzip integrity failed (tar exit $rc) — not keeping a broken archive."
    rm -f "$TMP"; exit 1
fi

mv -f "$TMP" "$OUT"
chmod 600 "$OUT"

# NB: read the listing ONCE. `tar tzf | grep -qx` under `set -o pipefail` reports a
# false MISSING — grep -q exits at the first match, tar takes SIGPIPE (141), and
# pipefail hands that up as the pipeline's status. Cost one debugging cycle.
LISTING=$(tar tzf "$OUT" 2>/dev/null)
ENTRIES=$(printf '%s\n' "$LISTING" | wc -l)
SIZE=$(du -h "$OUT" | cut -f1)
# A restore needs all three; prove them present instead of trusting the exit code.
MISSING=""
for need in memories/MEMORY.md profiles/sofia/SOUL.md profiles/sofia/config.yaml; do
    grep -qx -- "$need" <<< "$LISTING" || MISSING="$MISSING $need"
done
if [ -n "$MISSING" ]; then
    log "ERROR: archive written ($SIZE) but missing:$MISSING"
    exit 1
fi

log "OK: $OUT ($SIZE, $ENTRIES entries, tar exit $rc treated as changed-while-reading)"
exit 0
