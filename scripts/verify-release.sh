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
    ssh -i /opt/data/ssh/id_ed25519 -o BatchMode=yes ctum@127.0.0.1 "$1"
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
php_from_stdin() {
  printf '%s\n' "\$x=App\\Models\\ApplicationDeploymentQueue::orderByDesc('id')->first(); echo \$x->status.' '.\$x->commit.PHP_EOL;" | onhost "docker exec -i coolify php artisan tinker"
}
# A deployment may still be running (or queued behind another). Wait for the
# queue to settle instead of judging a row that has not finished yet.
deadline=$(( $(date +%s) + 900 ))
while :; do
  row=$(php_from_stdin 2>/dev/null | tr -d '\r' | grep -Eo '(finished|failed|queued|in_progress|cancelled)[[:space:]]+[0-9A-Za-z._-]{7,40}' | head -1)
  status=$(echo "$row" | awk '{print $1}')
  commit=$(echo "$row" | awk '{print $2}')
  case "$status" in
    finished|failed|cancelled) break ;;
    "") fail 3 "could not read the deployment queue" ;;
    *) [ "$(date +%s)" -lt "$deadline" ] || fail 3 "deployment still '$status' after 15 min"
       note "deployment ${status}, waiting…"; sleep 30 ;;
  esac
done
note "status ${status} · commit ${commit:0:9}"
# Docs, evidence and gate scripts do not change the container. What must be
# deployed is the newest commit that touched runtime code (rule R2, finessed:
# a docs-only commit must not demand a five-minute rebuild).
# Gate files are not runtime: a change under `apps/sofia-gateway/test/` must not
# demand a five-minute rebuild. Everything else under those paths must.
deploy_target=$(git log -1 --format=%H -- apps packages server services plugins Dockerfile pnpm-lock.yaml ':(exclude)apps/sofia-gateway/test')
note "runtime HEAD ${deploy_target:0:9}"
[ "$status" = "finished" ] || fail 3 "latest deployment is '${status}', not finished (rule R2)"
case "$commit" in
  HEAD|""|None) fail 3 "the deployment did not record a commit (it built \"${commit:-nothing}\"); queue it with scripts/coolify-deploy.sh so the build is identifiable (rule R2)" ;;
esac
# The deployed commit must contain the newest runtime change — it may be newer
# (docs commits ride along), it may not be older.
if ! git merge-base --is-ancestor "$deploy_target" "$commit" 2>/dev/null; then
  fail 3 "deployment built ${commit:0:9}, which does not contain the newest runtime commit ${deploy_target:0:9}"
fi

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
    -w /qa -e BASE=https://sofia.ctum.org \
    -e SOFIA_PASSWORD="$(cat /home/ctum/secrets/sofia-password 2>/dev/null)" \
    -e PASSWORD="$(cat /home/ctum/secrets/sofia-password 2>/dev/null)" \
    "$PW" node "$1" 2>&1
}
voice=$(run_gate voice-gate.mjs)
# Assert the property, never the count: a gate that grows a check must not read
# as a failure, and a gate whose total is hardcoded once let "11/12" through
# (that regex matched "12"). Pass = every check passed, zero FAIL lines, and a
# total large enough that the file is the real gate.
voice_ratio=$(echo "$voice" | grep -oE '[0-9]+/[0-9]+ checks passed' | tail -1 | awk '{print $1}')
voice_num=${voice_ratio%%/*}
voice_den=${voice_ratio##*/}
voice_fail=$(echo "$voice" | grep -cE '^FAIL' || true)
if [ -z "$voice_ratio" ] || [ "$voice_num" != "$voice_den" ] || [ "${voice_den:-0}" -lt 12 ] || [ "$voice_fail" != "0" ]; then
  echo "$voice" | grep -E '^FAIL|checks passed' | head -6
  fail 5 "voice gate ${voice_ratio:-unknown} (${voice_fail} FAIL lines)"
fi
note "$voice_ratio"

echo "== 5. brand =="
brand=$(run_gate dark-check.mjs)
echo "$brand" | grep -q '"strayAIRI": false' || { echo "$brand" | tail -10; fail 6 "upstream brand visible in the DOM"; }
note "strayAIRI false · $(echo "$brand" | grep -oE '"anyWhiteSurfaces": [0-9]+')"

brand_px=$(run_gate brand-assets-gate.mjs)
echo "$brand_px" | grep -qE '^1[0-9]/1[0-9]|^13/13' || { echo "$brand_px" | tail -14; fail 6 "brand assets are not Sofia's"; }
note "$(echo "$brand_px" | grep -oE '[0-9]+/13' | tail -1) brand assets"

echo "PASS ${head_sha:0:9} — tree clean, deployed, healthy, gated, on-brand"
