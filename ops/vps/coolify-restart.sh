#!/usr/bin/env bash
# Restart the Sofia app so it picks up changed env vars, without rebuilding the image.
set -uo pipefail

APP_UUID="${APP_UUID:-zp31tstwfvpppxp5woswltmv}"
PHP=/tmp/coolify-restart-queue.php

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
    commit: $app->git_commit_sha,
    force_rebuild: false,
    is_webhook: false,
    is_api: false,
    restart_only: true,
);

$row = ApplicationDeploymentQueue::where('deployment_uuid', $deploymentUuid)->first();
echo "restart={$deploymentUuid} status=" . ($row->status ?? 'unknown') . "\n";
PHPEOF

docker cp "$PHP" coolify:/tmp/coolify-restart-queue.php >/dev/null
docker exec -e COOLIFY_APP_UUID="$APP_UUID" coolify php artisan tinker --execute='require "/tmp/coolify-restart-queue.php";' 2>&1 | tail -3
docker exec -u root coolify rm -f /tmp/coolify-restart-queue.php
rm -f "$PHP"
