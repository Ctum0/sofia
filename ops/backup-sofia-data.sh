#!/bin/bash
# =============================================================================
# Sofia app-data backup — /home/ctum/scripts/backup-sofia-data.sh
#
# The daily vps-backup.sh dumps POSTGRES databases only; Sofia's state lives in
# a SQLite volume (/app/data: sofia.db + a multi-MB WAL + cached MP3s) and is in
# no archive. Measured 2026-11-10: a plain copy of sofia.db alone loses 43 of 124
# messages and 240 of 263 live_usage rows, because those rows sit in the WAL.
#
# So: use SQLite's own .backup (which folds the WAL in), verify by opening the
# result and counting rows, and only then let the file stand.
#
# Deliberately a NEW file. It does not edit vps-backup.sh (the cron-driven safety
# net stays the human's hand); wire it in with one crontab line when he agrees:
#   40 5 * * * /home/ctum/scripts/backup-sofia-data.sh >> /home/ctum/logs/sofia-backup.log 2>&1
# =============================================================================
set -uo pipefail

OUT_DIR="/home/ctum/backups/sofia"
DATE=$(date +%Y-%m-%d)
STAMP=$(date +%Y%m%dT%H%M%S)
KEEP_DAYS=14
CONTAINER_MATCH="zp31tstwfvpppxp5woswltmv"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

mkdir -p "$OUT_DIR" || { log "FATAL: cannot create $OUT_DIR"; exit 1; }

# --- find the running app container (name carries a recreate timestamp) -------
C=$(docker ps --filter "status=running" --format '{{.Names}}' \
    | grep "^${CONTAINER_MATCH}" | head -1)
if [ -z "$C" ]; then
    log "FATAL: no running container matching ${CONTAINER_MATCH}*"
    exit 1
fi
log "container: $C"

# --- online backup inside the container, so the WAL is folded in --------------
TMP="/app/data/.backup-${STAMP}.db"
if ! docker exec "$C" node -e "
const {DatabaseSync}=require('node:sqlite');
const src=new DatabaseSync('/app/data/sofia.db',{readOnly:true});
// VACUUM INTO produces a single consolidated file: WAL included, no -shm/-wal needed
src.exec(\"VACUUM INTO '${TMP}'\");
" 2>/dev/null; then
    log "WARN: VACUUM INTO unavailable, falling back to sqlite3 .backup"
    docker exec "$C" sh -c "command -v sqlite3 >/dev/null && sqlite3 /app/data/sofia.db \".backup '${TMP}'\"" \
        || { log "FATAL: no usable sqlite backup path"; exit 1; }
fi

docker exec "$C" test -s "$TMP" || { log "FATAL: backup file empty or missing in container"; exit 1; }

# --- pull it out --------------------------------------------------------------
DEST="$OUT_DIR/sofia-db-${DATE}.db"
docker cp "$C:$TMP" "$DEST" >/dev/null 2>&1
docker exec "$C" rm -f "$TMP" 2>/dev/null
[ -s "$DEST" ] || { log "FATAL: docker cp produced nothing"; exit 1; }

# --- verify by reading it back: counts must match the live DB ----------------
python3 - "$DEST" <<'PY'
import sqlite3, sys
p = sys.argv[1]
c = sqlite3.connect("file:%s?mode=ro" % p, uri=True)
tables = [r[0] for r in c.execute(
    "select name from sqlite_master where type='table' order by name")]
print("  verified dump: %d tables" % len(tables))
for t in ("messages", "hermes_runs", "live_usage", "rules", "tasks", "memory_notes", "settings"):
    if t in tables:
        print("    %-14s %d" % (t, c.execute('select count(*) from "%s"' % t).fetchone()[0]))
c.close()
PY
RC=$?
if [ $RC -ne 0 ]; then
    log "FATAL: dump did not open (rc=$RC) — refusing to leave an unverified backup"
    exit 1
fi

# --- compress + keep the WAL-era raw file only if it is small ----------------
gzip -6 -f "$DEST" && [ -s "${DEST}.gz" ] || { log "FATAL: gzip failed"; exit 1; }
log "OK: ${DEST}.gz $(du -h "${DEST}.gz" | cut -f1)"

# --- the cached MP3s are reproducible from TTS; archive them weekly only ------
if [ "$(date +%u)" = "7" ]; then
    A="$OUT_DIR/sofia-audio-${DATE}.tar.gz"
    if docker cp "$C:/app/data/audio" "$OUT_DIR/audio-tmp" >/dev/null 2>&1; then
        tar -czf "$A" -C "$OUT_DIR" audio-tmp 2>/dev/null && rm -rf "$OUT_DIR/audio-tmp"
        [ -s "$A" ] && log "OK: audio ${A} $(du -h "$A" | cut -f1)"
    fi
fi

# --- prune -------------------------------------------------------------------
find "$OUT_DIR" -name "sofia-db-*.db.gz" -mtime +${KEEP_DAYS} -delete 2>/dev/null
log "done (keeping ${KEEP_DAYS} days in ${OUT_DIR})"
exit 0
