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
# The build container bind-mounts this tree and writes into it as root, and a
# tracked source file once came back as `SofiaWindow.vue -> /proc/self/fd/0`
# (a pipe: its content is whatever stdin happened to be). `git status` said only
# "typechange", and a commit would have shipped the pipe. Refuse while any
# tracked link points at a pipe or outside the tree. `.claude/skills` is a
# legitimate relative link and must stay allowed.
bad_links=$(git ls-files -s | awk '$1=="120000"{print $4}' | while read -r p; do
  t=$(readlink "$p" 2>/dev/null || true)
  case "$t" in /proc/*|/dev/*|/*) echo "$p -> $t" ;; esac
done)
[ -z "$bad_links" ] || fail 1 "tracked symlink(s) point outside the tree: $(echo "$bad_links" | tr '\n' ' ')"
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
# Coolify marks the deployment finished a beat before the new container reports
# healthy, so a check with no patience reads that gap as an outage.
healthy=0
for _ in $(seq 1 18); do
  if onhost "docker ps --format '{{.Names}} {{.Status}}' | grep zp31 | head -1" | grep -q "(healthy)"; then healthy=1; break; fi
  sleep 5
done
[ "$healthy" = "1" ] || fail 4 "no healthy sofia container after 90 s"
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
# One retry, said out loud. The Live slot is shared: when another gate or his
# own tab holds a session the first turn comes back with 0 audio chunks and
# the second is fine (13/13 at 888c5892a, 12/13 on the next run). A real
# regression fails both attempts, so this buys determinism without hiding it.
voice_try=$(echo "$voice" | grep -oE '[0-9]+/[0-9]+' | tail -1)
if [ -n "$voice_try" ] && [ "${voice_try%%/*}" != "${voice_try##*/}" ]; then
  echo "  note: first voice attempt ${voice_try}, retrying once in 8 s (shared Live slot)"
  sleep 8
  voice=$(run_gate voice-gate.mjs)
fi
# Parse the count, do not grep for a substring: "11/12" contains "12" and a
# loose pattern let a partially failing gate through once.
# Require every check to pass, not a hardcoded 12: the lanes add checks, and a
# magic number turns a green 13/13 into a false failure (it did, 2026-11-10).
voice_ok=$(echo "$voice" | grep -oE '[0-9]+/[0-9]+' | tail -1)
voice_pass=${voice_ok%%/*}; voice_all=${voice_ok##*/}
[ -n "$voice_ok" ] && [ "$voice_pass" = "$voice_all" ] || { echo "$voice" | grep -E '^FAIL' | head -5; fail 5 "voice gate ${voice_ok:-unknown}"; }
note "$voice_ok"

echo "== 5. brand =="
brand=$(run_gate dark-check.mjs)
echo "$brand" | grep -q '"strayAIRI": false' || { echo "$brand" | tail -10; fail 6 "upstream brand visible in the DOM"; }
note "strayAIRI false · $(echo "$brand" | grep -oE '"anyWhiteSurfaces": [0-9]+')"

brand_px=$(run_gate brand-assets-gate.mjs)
brand_ok=$(echo "$brand_px" | grep -oE '[0-9]+/[0-9]+' | tail -1)
brand_pass=${brand_ok%%/*}; brand_all=${brand_ok##*/}
[ -n "$brand_ok" ] && [ "$brand_pass" = "$brand_all" ] || { echo "$brand_px" | tail -14; fail 6 "brand assets are not Sofia's (${brand_ok:-no count})"; }
note "$brand_ok brand assets"

# The gates that catch the failures this project actually has: a window
# that cannot be clicked, a browser that stops answering, a typed turn that
# opens nothing, and — added 2026-11-10 — the same window on a phone, a tablet
# and a laptop, because that gate found a real 74 px overlap at 1024x768 while
# every other gate looked at 1440 only.
for g in windows-gate.mjs browser-gate.mjs text-panel-gate.mjs windows-responsive-gate.mjs; do
  out=$(run_gate "$g")
  # A browser that cannot reach the page is not a product failure. Seen on
  # 2026-11-10: "net::ERR_NETWORK_CHANGED" scored windows-gate 0/1 and read
  # like a regression. Retry once, and say that it was the network.
  if echo "$out" | grep -qE "net::|ERR_NETWORK|ECONNRESET|EAI_AGAIN"; then
    echo "  note: ${g} could not reach the site, retrying once in 5 s"
    sleep 5
    out=$(run_gate "$g")
  fi
  count=$(echo "$out" | grep -oE '[0-9]+/[0-9]+' | tail -1)
  got=${count%%/*}; want=${count##*/}
  if [ -z "$count" ] || [ "$got" != "$want" ]; then
    echo "$out" | grep -E '^FAIL' | head -6
    fail 7 "$g ${count:-did not report a count}"
  fi
  note "$g $count"
done

# The tool layer cannot be reached from the QA browser: it is server-side. This
# gate runs inside the gateway container against the very code that is serving,
# and it is the one that caught a context rebuilt per call — the reason she said
# she could not see a page she had opened herself.
app_container=$(docker ps --format "{{.Names}}" | grep zp31 | head -1)
if [ -n "$app_container" ] && [ -f apps/sofia-gateway/test/tools-gate.mjs ]; then
  docker cp apps/sofia-gateway/test/tools-gate.mjs "$app_container:/tmp/tools-gate.mjs" >/dev/null 2>&1
  tools_out=$(docker exec "$app_container" node /tmp/tools-gate.mjs 2>&1)
  tools_count=$(echo "$tools_out" | grep -oE '[0-9]+/[0-9]+' | tail -1)
  tools_got=${tools_count%%/*}; tools_want=${tools_count##*/}
  if [ -z "$tools_count" ] || [ "$tools_got" != "$tools_want" ]; then
    echo "$tools_out" | grep -E '^FAIL' | head -6
    fail 8 "tools-gate.mjs ${tools_count:-did not report a count}"
  fi
  note "tools-gate.mjs $tools_count"
else
  fail 8 "tools-gate.mjs did not run (no container)"
fi

echo "PASS ${head_sha:0:9} — tree clean, deployed, healthy, gated, on-brand"
