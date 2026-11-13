#!/usr/bin/env bash
# Restore drill — prove the newest archive contains what a restore needs,
# and name every service whose data is NOT in it.
set -uo pipefail
SRC=/tmp/vps-backup/vps-backup-2026-11-09
DRILL=/home/ctum/archive/drill-2026-11-09

echo "== source =="
du -sh "$SRC"; find "$SRC" -type f | wc -l
ls "$SRC"

echo "== manifest =="
head -5 "$SRC/MANIFEST.txt" 2>/dev/null; grep -c . "$SRC/MANIFEST.txt" 2>/dev/null

echo "== required pieces =="
for p in $(find "$SRC" -name "*.db" -o -name "*.sqlite*" -o -name "*.toml" -o -name "Caddyfile" -o -name "coolify*.sql*" -o -name "*.dump" 2>/dev/null); do
  printf "%8s  %s\n" "$(du -h "$p" | cut -f1)" "${p#$SRC/}"
done

echo "== extract to $DRILL =="
rm -rf "$DRILL"; mkdir -p "$DRILL"
cp -a "$SRC"/. "$DRILL"/ 2>/dev/null
find "$DRILL" -type f | wc -l
du -sh "$DRILL"

echo "== open the databases =="
for db in $(find "$DRILL" -name "*.db" -o -name "*.sqlite*" 2>/dev/null | head -6); do
  echo "--- ${db#$DRILL/}"
  python3 - "$db" <<'PY'
import sqlite3, sys
try:
    c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
    t = [r[0] for r in c.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")]
    print(f"    tables={len(t)} rows=" + ", ".join(f"{n}:{c.execute(f'select count(*) from \"{n}\"').fetchone()[0]}" for n in t[:5]))
except Exception as e:
    print("    NOT a readable sqlite:", e)
PY
done

echo "== what a restore still needs that is NOT here =="
docker ps --format '{{.Names}}' | sort > /tmp/live-containers.txt
echo "live containers: $(wc -l < /tmp/live-containers.txt)"
for vol in $(docker volume ls -q | head -20); do
  sz=$(docker system df -v 2>/dev/null | awk -v v="$vol" '$1==v{print $3" "$4}')
  [ -n "$sz" ] && echo "  volume $vol  $sz"
done | head -12
