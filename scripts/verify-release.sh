#!/usr/bin/env bash
# verify-release.sh — the only thing allowed to call a change "live".
#
# It answers five questions, in order, and refuses to continue when one fails:
#   1. is the working tree clean, and is HEAD the same commit GitHub has?
#   2. did the latest Coolify deployment finish, for that same commit?
#   3. is the container healthy and does /healthz agree with itself?
#   4. does the browser actually work (voice gate, single run)?
#   5. is the rendered DOM free of the upstream brand?
#
# Usage:  bash scripts/verify-release.sh            # full check
#         bash scripts/verify-release.sh --git-only # no docker, no browser
# Exit:   0 pass, 1 environment problem, 2 HEAD not pushed, 3 deployment not finished,
#         4 health mismatch, 5 gate failed, 6 brand leak
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# Runs on the VPS host; falls back to SSH when invoked from the Hermes container.
onhost() {
  if docker info >/dev/null 2>&1; then bash -lc "$1"; else
    ssh -i /opt/data/ssh/id_ed25519 -o BatchMode=yes ctum@127.0.0.1 "$1" </dev/null
  fi
}

GIT_ONLY=0
[ "${1:-}" = "--git-only" ] && GIT_ONLY=1
fail() { echo "FAIL [$1] $2"; exit "$1"; }
note() { echo "  $*"; }

echo "== 1. repository =="
dirty=$(git status --porcelain | wc -l | tr -d ' ')
[ "$dirty" = "0" ] || fail 1 "working tree has $dirty uncommitted path(s); commit or stash first"
head_sha=$(git rev-parse HEAD)
git fetch -q origin main 2>/dev/null || true
remote_sha=$(git rev-parse origin/main 2>/dev/null || echo none)
note "HEAD        ${head_sha:0:9}"
note "origin/main ${remote_sha:0:9}"
[ "$head_sha" = "$remote_sha" ] || fail 2 "HEAD is not what Coolify builds — push first (rule R2)"
[ "$GIT_ONLY" = "1" ] && { echo "PASS git-only"; exit 0; }

echo "== 2. deployment =="
row=$(onhost "docker exec coolify php artisan tinker --execute='\$d=App\\\\Models\\\\ApplicationDeploymentQueue::orderByDesc(\"id\")->first(); echo \$d->status.\" \".(string)\$d->commit;' 2>/dev/null")
status=${row%% *}; commit=$(echo "$row" | awk '{print $2}')
note "status ${status:-unknown} · commit ${commit:0:9}"
[ "$status" = "finished" ] || fail 3 "latest deployment is '${status:-unknown}', not finished (rule R2)"
case "$head_sha" in "$commit"*) : ;; *) fail 3 "deployment built ${commit:0:9}, HEAD is ${head_sha:0:9}" ;; esac

echo "== 3. container and health =="
onhost "docker ps --format '{{.Names}} {{.Status}}' | grep zp31 | head -1" | grep -q "(healthy)" \
  || fail 4 "no healthy sofia container"
hz=$(curl -fsS -m 10 https://sofia.ctum.org/healthz) || fail 4 "/healthz unreachable"
echo "$hz" | grep -q '"ok":true' || fail 4 "/healthz does not report ok"
for field in hermes reasoning; do
  echo "$hz" | grep -q "\"$field\":\"\(reachable\|stripped\)\"" || fail 4 "healthz.$field is not healthy"
done
note "$(echo "$hz" | cut -c1-160)"

echo "== 4. gates =="
PW=mcr.microsoft.com/playwright:v1.64.1-jammy
run_gate() {
  docker run --rm --network host -v /home/ctum/qa:/qa -v /home/ctum/secrets:/home/ctum/secrets:ro \
    -w /qa -e BASE=https://sofia.ctum.org "$PW" node "$1" 2>&1
}
voice=$(run_gate voice-gate.mjs)
echo "$voice" | grep -qE "12/12|ALL .*PASS|checks passed" || { echo "$voice" | tail -15; fail 5 "voice gate failed"; }
note "$(echo "$voice" | grep -oE '[0-9]+/12|[0-9]+ checks passed' | tail -1)"

echo "== 5. brand =="
brand=$(run_gate dark-check.mjs)
echo "$brand" | grep -q '"strayAIRI": false' || { echo "$brand" | tail -10; fail 6 "upstream brand visible in the DOM"; }
note "strayAIRI false · $(echo "$brand" | grep -oE '"anyWhiteSurfaces": [0-9]+')"

echo "PASS ${head_sha:0:9} — tree clean, deployed, healthy, gated, on-brand"
