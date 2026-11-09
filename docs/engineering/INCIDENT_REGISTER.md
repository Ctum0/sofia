# Incident Register — Sofia session 2026-11-08 → 09

Evidence is command output from the session, quoted where short. Severity:
S1 = false claim to the user, S2 = wasted production cycle, S3 = local waste.

| ID | Failure | Root cause | Severity | Corrective action | Prevention | Verification |
| --- | --- | --- | --- | --- | --- | --- |
| I1 | Declared onboarding verified from a clean browser; user's PWA still showed it | Tested the happy harness, not the user's client | S1 | Added `?reset=1` + service-worker unregister | R1, R4 | `/sw.js` 200 with `caches.delete`; authenticated `/` 18,905 B |
| I2 | Rename flashed "Sofia" then reverted to the old name | `localStorage['airi-cards']` hydrates over the built-in default | S2 | Seed rewrites stored cards once | Knowledge captured in `NEXT.md` | card storage read back shows `"name":"Sofia"` |
| I3 | Rebrand reported done while the UI still said AIRI | Locales ship compiled from `packages/i18n/dist`, not `src` | S1 | Patched `src`, let `postinstall` rebuild | R1, R3 | card description on prod reads "Your name is Sofia." |
| I4 | Live 403 in onboarding | Gateway forwarded the browser `Origin`; Hermes rejects it | S2 | `delete headers.origin/referer` | recorded in gateway code comment | completion 200 |
| I5 | `hermes: "status 301"` in production | `node:http.request` ignores the URL scheme | S2 | `requestFor()` selects https/http | R8 | `/healthz` → `hermes:"reachable"` |
| I6 | Container "unhealthy" while healthy | Coolify's probe replaced the image healthcheck, port 3000 | S2 | Set `health_check_port=8787`, path `/healthz` | R8 | container `(healthy)` |
| I7 | Deploy failed on lockfile; native gyp failed 3× | Hand-installed dependency absent from lockfile; alpine image lacked python | S2 | `pnpm install --lockfile-only`; bookworm-slim base | R8 | build 130 s clean |
| I8 | Claimed fixes were live when they were not | Commits unpushed; Coolify builds GitHub `HEAD` | S1 | Push then redeploy | R2 + `scripts/verify-release.sh` | `git rev-parse HEAD == origin/main` |
| I9 | Three deploys failed in 13 s | Plaintext write into Coolify's `encrypted` env column → `DecryptException` | S2 | `Crypt::encrypt()` write | R8 | env reads back `Leda`; deploys 88-94 finished |
| I10 | Dev socket `ws://localhost:6121` retried 5×/s in production | Hunted callers; default lived in `normalizeOptions` | S2 | Transport refuses to dial without a url outside dev | R3, R5 | gate `0 x localhost:6121` |
| I11 | Voice "worked" in the gate, silent for the user | Gate launched with `--autoplay-policy=no-user-gesture-required` + fake mic | S1 | Strict policy; unlock inside the click; mic-constraint fallback | R4 | gate now asserts both contexts `running` |
| I12 | Gate passes then fails minutes later | Live session slot contention between runs | S3 | Documented; run once per minute | R12 | 12/12 on a single run |
| I13 | Gate read a field that does not exist | Assertion written against an imagined API | S3 | Read `window.__sofiaVoice.stats` | R1 | STATS line shows `chunksPlayed` |
| I14 | Empty state never rendered (3 deploys) | `${message.content}` on structured content is truthy; wrong component | S3 | Moved into `ChatHistory` keyed on `renderMessages.length` | R5, R6 | probe `hasEmptyText: true` |
| I15 | Patch reported applied but the file was unchanged | Root-owned file; `ctum` edit threw `PermissionError` | S3 | Edit through `sofia-build` container | R7 | grep count after edit |
| I16 | SSH session died mid-task | `pkill -f` matched its own command line | S3 | Kill by port | R9 | port free, session alive |
| I17 | Builds failing with an empty log | Disk 90%, 130.9 GB build cache | S2 | `docker builder prune -af` → 128 GB free | R10 | `df` 57% used |
| I18 | Kanban implied work that never ran | Workers crashed (gateway SIGKILL); cards retired | S3 | Marked done with "retired, not implemented" | R11 | board summaries say so |
| I19 | Cron creation rejected 5× by the tool | Tool-side validation bug (`calls[0] requires a 'name'`) | S3 | Used the CLI | R5 | `hermes cron list` shows the job |
| I20 | Verified against the wrong commit once | Container swaps before the deployment finishes | S3 | Check the queue row first | R2 | `finished <sha>` matched HEAD |
| I21 | Committed a build that had already failed | the gate was `pnpm build \| grep "error\|✓ built"`; the grep matched a stack-trace line, so the pipeline "passed" while vite had exited 1 | S2 | gate on the exit code, not on grep output | R1, R4 | `exit=0, ✓ built in 1m 24s` before the commit |
| I22 | A six-character CSS change failed the build twice | `bg-white/25` written as a bare attribute — this repo uses bare UnoCSS utilities, and a `/` modifier is a Vue parse error (`Illegal '/' in tags`) | S2 | moved it into `class="… bg-white/25"` | R3 (read how the file writes attributes) | build green; deployment `121689dc` finished, verifier PASS |

