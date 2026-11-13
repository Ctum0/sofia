# VPS operations scripts

These scripts lived only on the Sofia VPS, in `/home/ctum/scripts/`, and were not
in git. They are copied here so that a lost or rebuilt host does not take the
deploy path, the prune cron and the key-rotation runbook with it.

Copied 2026-11-13 from `ctum@myvps:/home/ctum/scripts/`. They are a record, not a
package: nothing here is wired into CI, and none of them is a library the app
imports.

| Script | What it does | When it runs |
|---|---|---|
| `coolify-deploy.sh` | Queues a Coolify deployment of the app, refusing if HEAD is not `origin/main`. Prints `deployment=… status=… commit=…`. | By hand, every release |
| `coolify-restart.sh` | Same, with `force_rebuild: false`, so a restart does not rebuild. | By hand |
| `docker-prune.sh` | Reclaims images and BuildKit cache older than 48 h, plus Coolify-managed stopped containers. Exists because the VPS hit 100% disk on 2026-11-10 with 155 GB of cache. | `crontab` at 04:30 daily |
| `run-gate.sh` | Runs one browser gate inside the `sofia-qa` container. | By hand |
| `sofia-stage.sh` | Moves, resizes or closes a stage window over the gateway API. | By hand |
| `rotate-sofia-api-key.sh` | Rotation runbook for the gateway's Hermes key. | By hand |
| `hermes-profile-backup.sh` | Archives the Hermes `sofia` profile. | By hand |
| `restore-drill.sh` | Rehearsal of a restore. | By hand |

`crontab.txt` is the host's crontab as of the same date, for reference. Check it
for secrets before sharing it anywhere; it currently references secret FILES by
path rather than containing values.

## Two things to know before redeploying

- `coolify-deploy.sh` hardcodes `REPO=/home/ctum/projects/sofia`. If that clone is
  removed, the script must be pointed at wherever the checkout lives.
- Every script that needs a credential reads it from `/home/ctum/secrets/`
  (`sofia-password`, `hermes-sofia.key`, `gemini.key`, `honcho-token`). Those files
  are **not** in this repository and must be restored separately; a deploy without
  `sofia-password` leaves `healthz` green and every login failing.
