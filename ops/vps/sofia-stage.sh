#!/usr/bin/env bash
# sofia-stage.sh — move, resize or close a window on the stage from a shell.
#
# Why it exists: the stage only learned to arrange itself from words — a typed
# turn is matched by stageIntent, a spoken one by the live tool loop. An agent
# working on this build has neither, so it could describe a move and not make
# one. This posts to POST /api/stage/control, the same control event both lanes
# broadcast, with the same session cookie as everything else.
#
# Usage: sofia-stage.sh '{"action":"move","position":"left"}'
#        sofia-stage.sh '{"action":"resize","width":640,"height":520,"target":"last"}'
set -uo pipefail
BASE=${BASE:-https://sofia.ctum.org}
PASS_FILE=${PASS_FILE:-/home/ctum/secrets/sofia-password}
body=${1:-}
[ -n "$body" ] || { echo "usage: $0 '{\"action\":\"move\",\"position\":\"left\"}'" >&2; exit 2; }
jar=$(mktemp)
trap 'rm -f "$jar"' EXIT
code=$(curl -s -c "$jar" -o /dev/null -w "%{http_code}" -X POST --data-urlencode "password=$(cat "$PASS_FILE")" "$BASE/api/login")
[ "$code" = "302" ] || { echo "FAIL login ($code)" >&2; exit 1; }
curl -s -b "$jar" -X POST -H "content-type: application/json" -d "$body" "$BASE/api/stage/control"
echo
