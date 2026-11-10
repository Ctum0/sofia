#!/usr/bin/env python3
"""NEXT.md write-back for the 2026-11-10 14:15 SLT restore-drill run.
Every edit is anchored; if an anchor is missing the script aborts before writing."""
import re, sys, shutil, os

P = "/home/ctum/projects/sofia/NEXT.md"
s = open(P).read()
orig = s


def must(cond, msg):
    if not cond:
        print("ANCHOR FAILED:", msg)
        sys.exit(1)


# ---------------------------------------------------------------- 1. K -> K(a)/K(b)
start = s.index("- [ ] **K. Notion phase 07")
end = s.index("Record the ask in the Log.", start) + len("Record the ask in the Log.")
old_k = s[start:end]
must("restore drill, autonomous" in old_k, "K body present")

new_k = """- [x] **K(a). Restore drill — DONE 2026-11-10 14:15 SLT.** The archive was
  opened for the first time and every number below came from reading it, not
  from listing it. Round trip: `tar` **42 M** (matching the log's own `(42M)`),
  extract **165 files**, `sha256sum -c MANIFEST.txt` → **164/164 OK, 0 failures**.
  Dumps opened: `coolify-db` **90 tables / 38 non-empty** (`applications 1`,
  `application_deployment_queues 111`, `environment_variables 44`), `honcho-db`
  13/11, `litellm-db` 99/15, `iriswebapp_db` 79/39, `n8n` **167 tables /
  `execution_entity 3291` / 4 workflows / 5 credentials**, `Caddyfile` 1 745 B
  with `sofia.`/`hermes.`/`coolify.ctum.org` all present.
  **What is not in it, named:** Sofia's `/app/data` (`sofia.db` + 4 MB WAL + 41
  MP3 — **124 messages, 44 runs, 263 live_usage** live, none archived), Wazuh
  indexer + manager logs, Splunk, MISP (`>100MB (skipped)` by its own log line),
  karakeep, Portainer, Beszel, Grafana, Velociraptor, IRIS attachments, and
  **Hermes `memories/`+`skills/`+`profiles/`** (zero entries → the K(c)/L(a)
  patch). Two of my own claims died here and are retracted in the Log.
  Delivered instead of a report: `~/scripts/backup-sofia-data.sh` — runs, and
  its dump reads back **124/44/263, `integrity_check ok`**, versus a naive
  `sofia.db` copy which reads **81/39/23** because 35 % of the conversation sits
  in an un-checkpointed WAL.
  → **PREPARED 2026-11-10, blocked on him → item L(a).** The step exists twice
  over: `~/scripts/hermes-profile-backup.sh` (standalone, proven: **45 MB /
  2463 entries / 8 s, exit 0**) and `~/scripts/vps-backup-hermes-step.patch`
  (`patch -p1 --dry-run` exit 0, `bash -n` clean). The gap is real and measured:
  `vps-backup.sh` copies only `hermes/config.yaml`, `env/hermes-data.env` and
  `hermes/telegram-config.yaml` (lines 78/103/104/105) — `memories/`, `skills/`,
  `profiles/` and the session store are in no archive. Applying it edits a
  cron-driven script that *is* the safety net, so it stays his hand.
- [ ] **K(b). Rotate the sofia `api_server` key — gated on him.** Notion 07 is
  still 🟡 on this. The rotation needs a restart of the gateway that is hosting
  the conversation, and a key swap while Sofia is open breaks her brain until
  the gateway is back. Do not attempt it unattended: prepare the exact command
  block from `~/scripts/rotate-sofia-api-key.sh`, prove it on a scratch profile,
  and ask him for a window. Record the ask in the Log."""

s = s[:start] + new_k + s[end:]

# ---------------------------------------------------------------- 2. queue item X
anchor_q = '- [x] **R. Session longevity'
must(anchor_q in s, "R item present")
item_x = """- [ ] **X. Probe ordering: the drill measured two data gaps, and both are one
  crontab line away.** Autonomous half is done — `~/scripts/backup-sofia-data.sh`
  exists, runs clean, and verifies its own output (23 tables, counts read back
  out of the finished dump, `integrity_check ok`); `~/scripts/hermes-profile-backup.sh`
  already works too. What is missing is only the schedule, which is his hand
  because it edits crontab:
  `40 5 * * * /home/ctum/scripts/backup-sofia-data.sh >> /home/ctum/logs/sofia-backup.log 2>&1`
  plus item L(a)'s patch for Hermes profile state. Prove on the next day:
  `ls -l ~/backups/sofia/` shows a fresh `sofia-db-*.db.gz`, and `tar tzf` of the
  vps-backup tarball lists `hermes/profile.tar.gz`.
  *Also worth one line in `vps-backup.sh`:* its `find /home/ctum /opt/data
  -maxdepth 5 -name config.yaml` returns **5** matches, three of them junk (two
  `.gemini/config.yaml`, two archived copies under `~/archive/`). Harmless today
  because Tier 2's `docker cp` runs after and overwrites — but the winner depends
  on find order, so exclude `archive/` when he next touches the script.

"""
s = s.replace(anchor_q, item_x + anchor_q, 1)

# ---------------------------------------------------------------- 3. END STATE row
old_row = "| Backups | daily archive now carries `/opt/data` profile state (39 MB, 2,197 entries, extrated and read) |"
must(old_row in s, "END STATE backups row present")
new_row = ("| Backups | daily archive **opened** 2026-11-10: 42 M, 165 files, 164/164 checksums, "
           "5 DB dumps read (coolify 90 tables, n8n 3 291 executions). **Not** in it: Sofia's "
           "`/app/data`, Hermes `memories/`+`skills/`, Wazuh indexer, Splunk, MISP (>100 MB), "
           "karakeep. Sofia half fixed by `~/scripts/backup-sofia-data.sh` (verified dump); "
           "needs a crontab line (item X) |")
s = s.replace(old_row, new_row, 1)

# ---------------------------------------------------------------- 4. Log entry
anchor_log = "## END STATE — 2026-11-10"
must(anchor_log in s, "END STATE header present")
entry = """### 2026-11-10 14:15 SLT — K(a) restore drill: the archive opened for the first time

**Where the archive actually is.** `vps-backup.sh` writes
`/tmp/vps-backup/vps-backup-<date>.tar.gz` and its own header says *"Parrot
deletes this after verified download"* — so today the staging tree is there and
**the tarball is not**. The durable copy is on the laptop, and the VPS has no
key to it: `ssh -o BatchMode=yes ctum@100.116.206.17` → `Permission denied
(publickey,password)` while port 22 is open. Parrot authenticates *to* the VPS
(pull), never the reverse. The drill therefore rebuilt the archive from today's
staging — byte-for-byte the tree `tar` consumed — and verified it round-trips.

**Round trip:** `tar -czf` → **42 M**, matching the log's own
`Backup complete: /tmp/vps-backup/vps-backup-2026-11-10.tar.gz (42M)`; extract →
**165 files**; `sha256sum -c MANIFEST.txt` → **164/164 OK, 0 failures**
(165 = the 164 manifested files + MANIFEST itself). `/tmp` is the root ext4, not
tmpfs, so staging survives a reboot — systemd-tmpfiles still ages it out.

**Dumps opened, not merely listed** (`~/scripts/restore-drill.py`, parser over
the `COPY` blocks):
- `coolify-db` 19 M — **90 tables, 38 non-empty**; `applications 1`,
  `application_deployment_queues 111`, `environment_variables 44`, `users 1` ✓
- `honcho-db` 9.3 M — 13 tables, 11 non-empty
- `litellm-db` 132 K — 99 tables, 15 non-empty
- `iriswebapp_db` 56 K — 79 tables, 39 non-empty
- `n8n_database` 14 M → 122.9 M raw — **167 tables**; `workflow_entity 4`,
  `execution_entity 3291`, `credentials_entity 5`, `user 1`
- `caddy/Caddyfile` 1 745 B — `sofia.ctum.org`, `hermes.ctum.org`,
  `coolify.ctum.org`, `n8n`, `wazuh` all present; 21 env files, 32 compose dirs,
  per-container JSONs, `crontab.txt`, `ssh-authorized_keys`, Wazuh configs.
All five `.gz` dumps pass `gzip -t`. No file in the tree is empty (the script's
own integrity line agrees).

**What a restore would NOT get — data, named service by service.**
- **Sofia.** Live container mounts `zp31…-sofia-data → /app/data`: `sofia.db`
  344 064 B, **`sofia.db-wal` 4 128 272 B** (last write 2026-11-08 15:51), and
  `audio/` with 41 MP3s. The archive holds **none of it**, only the mount
  metadata in `containers/zp31….json`. Live counts, read read-only:
  **messages 124, hermes_runs 44, live_usage 263, rules 21, tasks 4,
  memory_notes 3, settings 1**.
  *The WAL is the trap:* copying `sofia.db` alone to a scratch dir and opening it
  gives **messages 81 / hermes_runs 39 / live_usage 23** — **43 messages (35 %)
  and 240 usage rows (91 %) exist only in the WAL.** Any file-copy backup of her
  state is silently lossy; it needs SQLite's own `.backup`/`VACUUM INTO`.
- **Wazuh** — indexer data volume and manager `logs`/`queue`: configs and certs
  only, so every alert ever raised.
- **Splunk** `etc`+`var`, **MISP** `misp_mysql_data` (its own log line:
  `misp-db-1: dump larger than 100MB (skipped)`), **karakeep** `karakeep-data` +
  Meilisearch, **Portainer**, **Beszel**, **Grafana**, **Velociraptor**, and
  **IRIS** attachments (`server_data`, `downloads`, `user_templates`).
- **Hermes profile state** — `memories/`, `skills/`, `profiles/`: **zero**
  entries (`find … -name "*memor*" -o -name "*skill*"` → empty). That is the
  unapplied K(c)/L(a) patch, now confirmed from the archive side. A hand-run
  `~/scripts/hermes-profile-backup.sh` result does exist and is correct —
  **47 MB, 2 463 entries, 919 skill files, memories for both profiles** at
  `/tmp/vps-backup/hermes-profile/hermes-profile.tar.gz` (23:48 last night) —
  but it sits in `/tmp`, inside no archive, and Parrot only pulls
  `vps-backup-<date>.tar.gz`, so **nothing has ever carried it off the box.**

**Fixed while drilling.** `~/scripts/backup-sofia-data.sh` (new file, does not
touch the safety net): `VACUUM INTO` inside the live container so the WAL is
folded in, then pull, then **read the result back before trusting it**. Measured:
`verified dump: 23 tables / messages 124 / hermes_runs 44 / live_usage 263` →
`sofia-db-2026-11-10.db.gz` **52 K**; decompressed and re-opened:
**124/44/263, `pragma integrity_check` → ok**, 409 600 B. So the fix is proven
end-to-end, not just written; only the crontab line is his (item X).

**Two of my own claims from earlier in this run died under evidence — retracted.**
1. *"Today's backup carries a stale 17 431 B config instead of the live 122 405 B
   one."* Wrong. `hermes/config.yaml` in the archive is `_config_version: 52`;
   the live container's is `53`. The backup ran at 05:00, the bump happened at
   07:47 — so v52 was correct at capture time, stale by one version now, by
   nothing at all then. The 122 KB file I compared against,
   `/home/ctum/.hermes-host/config.yaml`, is v46 and is **not** the live config.
2. *"The Tier-1 glob lets `~/archive/**` overwrite the live config."* It does
   match archived copies, but Tier 2's `docker cp hermes:/opt/data/config.yaml`
   runs afterwards and wins — proven by the file being v52 rather than v46.
   The glob is still untidy (5 matches, 3 junk, winner by find order) and is
   noted in item X as a one-line exclusion when he next edits the script.
   Also checked and dismissed: `hermes/telegram-config.yaml` being absent is
   **correct** — `/opt/data/profiles/telegram/config.yaml` no longer exists after
   multiplexing; and `env/hermes-data.env` (Sep 25 09:28 UTC) *is* the live
   `/opt/data/.env` (Sep 25 11:28 local). No defect in either.

"""
s = s.replace(anchor_log, entry + anchor_log, 1)

assert s != orig
shutil.copy2(P, P + ".bak-1415")
open(P, "w").write(s)
print("WROTE ok  delta=%+d bytes" % (len(s) - len(orig)))
print("  K(a) ticked:", "- [x] **K(a). Restore drill" in s)
print("  K(b) added :", "- [ ] **K(b). Rotate" in s)
print("  item X     :", "- [ ] **X. Probe ordering" in s)
print("  END STATE  :", "opened** 2026-11-10: 42 M" in s)
print("  Log entry  :", "the archive opened for the first time" in s)
