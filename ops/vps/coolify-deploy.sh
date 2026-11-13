#!/usr/bin/env bash
# Trigger a Coolify deployment of the Sofia app and print the queue UUID.
#
# Why this exists: Coolify's deploy API needs a Sanctum token, and minting one
# by hand fails (createToken leaves team_id null; explicit inserts lose the
# fillable fields). Calling Coolify's own helper inside its container is both
# simpler and exactly what the UI does.
#
# Two rules learned the hard way (docs/engineering/ENGINEERING_RULES.md R2):
#   - a deployment must record the commit it built, so `verify-release.sh` can
#     compare it with HEAD; passing commit:null makes Coolify store "HEAD",
#     which is unverifiable;
#   - refuse to queue when HEAD is not what GitHub has, because Coolify builds
#     GitHub, not this working tree.
set -uo pipefail

APP_UUID="${APP_UUID:-zp31tstwfvpppxp5woswltmv}"
REPO="${REPO:-/home/ctum/projects/sofia}"
PHP=/tmp/coolify-deploy-queue.php

cd "$REPO" || { echo "FAIL [1] no repo at $REPO"; exit 1; }
dirty=$(git status --porcelain | wc -l | tr -d ' ')
[ "$dirty" = "0" ] || { echo "FAIL [1] working tree has $dirty uncommitted path(s)"; exit 1; }
git fetch -q origin main || true
SHA=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main 2>/dev/null || echo none)
[ "$SHA" = "$REMOTE" ] || { echo "FAIL [2] HEAD ${SHA:0:9} is not origin/main ${REMOTE:0:9} — push first"; exit 2; }

cat > "$PHP" <<'PHPEOF'
<?php
use App\Models\Application;
use App\Models\ApplicationDeploymentQueue;
use Illuminate\Support\Str;

$app = Application::where('uuid', getenv('COOLIFY_APP_UUID'))->firstOrFail();
$deploymentUuid = (string) Str::uuid();

queue_application_deployment(
    application: $app,
    deployment_uuid: $deploymentUuid,
    pull_request_id: 0,
    commit: getenv('COOLIFY_COMMIT') ?: null,
    force_rebuild: true,
    is_webhook: false,
    is_api: false,
);

$row = ApplicationDeploymentQueue::where('deployment_uuid', $deploymentUuid)->first();
echo "deployment={$deploymentUuid} status=" . ($row->status ?? 'unknown')
   . " commit=" . substr((string) $row->commit, 0, 9) . "\n";
PHPEOF

docker cp "$PHP" coolify:/tmp/coolify-deploy-queue.php >/dev/null
docker exec -e COOLIFY_APP_UUID="$APP_UUID" -e COOLIFY_COMMIT="$SHA" \
  coolify php artisan tinker --execute='require "/tmp/coolify-deploy-queue.php";' 2>&1 | tail -3
docker exec -u root coolify rm -f /tmp/coolify-deploy-queue.php
rm -f "$PHP"
