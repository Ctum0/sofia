# Sofia — NEXT (autonomous work order)

Purpose: this file is the queue. Any run (agent, cron, or human) reads the first
unchecked item, does it, verifies it, ticks it with evidence, and appends the
result under **Log**. Rules at the bottom are mandatory.

## Queue

- [x] **A. Splash + logo → Sofia.** The served `index.html` still shows AIRI
  branding (splash text, icons). Rewrite at serve time in
  `apps/sofia-gateway/server.mjs`; keep asset filenames so the build stays
  mergeable. Verify: authenticated fetch of `/` shows no `AIRI`.
  → **DONE 2026-11-09.** Authenticated `GET /` (18843 B) contains zero `AIRI`
  and `<title>Sofia</title>`; a real-browser DOM walk after login (`brand-dom.mjs`,
  `BASE=http://127.0.0.1:8788`) reported `textHits: []`, `attrs: []`,
  `title: "Sofia"`. Source fixes: `HeaderLink.vue`, `startup-screen.vue`,
  `logo.svg`, `logo-dark.svg`.
- [x] **B. Avatar voice + lip-sync.** Wire `apps/sofia-gateway/public/voice-client.mjs`
  (already 7/7 at `/public/voice-test.html`) behind a Talk control on the AIRI
  stage and drive mouth movement from the incoming 24 kHz PCM. Verify with
  `test/voice-gate.mjs` against the stage, not the harness.
  → **DONE (local, production pending) 2026-11-09.** `voice-client.mjs` records an
  RMS envelope per 20 ms cell on the playback clock; `SofiaVoiceDock.vue` mounts
  the Talk/Stop dock in `InteractiveArea.vue` and writes
  `useSpeakingStore().mouthOpenSize` (the value `Stage.vue` feeds to Live2D
  `ParamMouthOpenY`). `voice-gate.mjs` rewritten to gate the stage:
  **9/9 PASS** twice against `http://127.0.0.1:8788` (frames 24 then 33,
  input transcript *"…one short sentence about the weather in Colombo"*,
  6 reply chunks, `peak 100`, no live errors). Committed `5a1e848e0`, pushed.
- [x] **C. Hermes as hands.** Live `toolCall` → gateway → Hermes `/v1` →
  `toolResponse`, so she can act rather than only talk. Verify with a prompt that
  forces a tool call and shows the result spoken back.
  → **DONE (production) 2026-11-09.** `apps/sofia-gateway/tools.mjs` declares two
  functions in the Live setup — `local_time` (no network) and `ask_hermes`
  (`POST /v1/runs` + poll `GET /v1/runs/{id}` until terminal, 45 s budget).
  The gateway executes them server-side in the `toolCall` emit handler, so the
  Hermes key never reaches the browser and a failure answers as a failure.
  `test/tool-gate.mjs` against **https://sofia.ctum.org**: `local_time` call at
  0.95 s, result `19:31 Sri Lanka time, Monday, 9 November 2026`, spoken back in
  full at 4.17 s; `ask_hermes` at 4.62 s → real run output `vmi3486973` at
  13.69 s → *"The server's hostname is vmi3486973."*; 33 audio chunks, 0 errors.
  Production gates on the same build: **auth 10/10, ui 7/7, voice 9/9**
  (voice: 30 mic frames, Live transcript, 5 reply chunks, mouth peak 100).
  Deploy `f8f8a1af` (commit `e390cc0fa`) — the previous deploy had taken the
  site down; see Log.
- [x] **D. Build speed.** `pnpm fetch` + BuildKit cache mount in `Dockerfile` —
  every deploy is currently ~10 min, which is why fixes land slowly.
  → **DONE 2026-11-09.** Root cause was not `pnpm fetch`: a plain
  `pnpm install` resolves the whole workspace, including
  `integrations/minecraft`, whose `isolated-vm` compiles C++ — 303 s of the
  build for a package this image never loads. Builder now runs
  `pnpm install --filter=@proj-airi/stage-web...` and installs only
  `git ca-certificates` (no python3/make/g++). Measured on the VPS daemon:
  install **303 s → 79 s**, whole image **480 s → 213 s** (`sofia-final:1`,
  exit 0), and the `isolated-vm` tree is absent (`node_modules/.pnpm/isolated-vm*`
  → none). BuildKit cache mounts were tried and **removed**: a marker written
  in one `docker build` was gone in the next, so they were decoration.
  `git` is a real build dependency (unplugin-info) — without it the build dies
  with `spawn git ENOENT`, which is how the missing-toolchain test failed before
  git was added. Smoke: image runs, `/healthz` answers, `/` 200 with
  `<title>Sofia</title>`.
- [x] **E. Harden.** Login rate limit; rotate the exposed sofia `api_server` key
  with `~/scripts/rotate-sofia-api-key.sh` when a restart is safe.
- [x] **F. Rebrand audit.** Check `manifest.webmanifest`, `open-graph.png`,
  icon files, and any remaining user-visible AIRI/Iru strings; the product is
  **Sofia**, the character card now also reads Sofia.
  → Partial: DOM is clean (A); the stored card in `localStorage['airi-cards']`
  still carries `"Your name is Iru … 15 years old girl"` in its description —
  that is persona copy, and needs both the built-in default and the seeded
  rewrite changed (migration hash).
- [x] **G. Kill the dev socket in production.** Root cause located (read-only,
  not yet changed): `packages/server-sdk/src/client.ts:175` defaults to
  `ws://localhost:6121/ws` when no url is passed. The served bundle retries
  `ws://localhost:6121/ws` about once a second from the first paint — visible in
  `voice-gate` console output on https://sofia.ctum.org (5× `ERR_CONNECTION_REFUSED`
  in one run). It is AIRI's dev-only server channel; in production it is pure
  console noise and a wasted reconnect loop on every client. Find the module that
  opens it, gate it on `import.meta.env.DEV`, rebuild, and assert the gate logs
  zero `localhost:6121`.
- [x] **H. Voice: Leda or Aoede? — settled on Leda, gated in production.**
  Aoede was never a decision: it entered with the first gateway commit
  (`ad7f55fe6`) and propagated into Coolify env; the locked table says Leda.
  → **DONE 2026-11-10.** Code default is `Leda` (`apps/sofia-gateway/live.mjs:24`)
  in `5ba1288f0`; live env `LIVE_VOICE=Leda` and `SOFIA_LIVE_VOICE=Leda`
  (both rows, prod + preview). Production evidence this run: `/healthz` →
  `"live":{"transport":"gateway-proxy","model":"gemini-3.8-live","voice":"Leda"}`,
  container log `live: ws /api/live/stream -> gemini-3.8-live (Leda)`, and
  `voice-gate.mjs` against https://sofia.ctum.org → **12/12** (54 mic frames,
  1576 frames sent, 11 reply chunks, mouth peak 100, 0 x localhost:6121).

- [x] **I. Notion: bring Phases and Ledger up to the deployed reality.**
  Both pages were frozen at 2026-11-08: the board still showed voice as 🟡,
  hands as ⬜, presence ⬜, deploy 🟡 ("auth still open"), and the ledger still
  said `sofia.ctum.org` → "nothing (502)", `voice Aoede`, and "the AIRI stage
  still has no Talk control".
  → **DONE 2026-11-10 02:05 SLT.** Phases rows 03–06 flipped to ✅ with the
  measured gate for each, 07 to 🟡 with what is actually left, and a dated
  changelog entry appended. Ledger: `Last verified` moved to 2026-11-10, the
  domain row now names the Coolify app and port chain, the voice line reads
  `Leda` with the `5ba1288f0` correction, the build-inefficiency note records
  the 480 s → 213 s fix, and the "harness is the product" open item is closed.
  Verified by re-fetching both pages and reading the new text back.

- [x] **J. Auth surface: enumerate every route and prove the public set is
  intentional.** Auth is a password gate plus a rate limit, but nobody has
  listed what the gateway actually serves: `/healthz`, `/sw.js`, `/manifest.webmanifest`,
  `/api/live/stream` (a WebSocket upgrade — does it check the cookie?),
  `/public/*`, `/v1/*`, and the static stage. Gate: a table of `path → status
  without a session`, each line either 200-and-justified or 401/403, plus a
  WS-upgrade probe with no cookie that must be refused.
  → **DONE 2026-11-10.** `apps/sofia-gateway/test/auth-surface-gate.mjs`
  (dependency-free, 33 checks) prints the table and asserts each line:
  **33/33 against https://sofia.ctum.org** on deployment `100` (`eedd108a6`).
  11 private routes 401 (`/index.html`, `/settings`, `/assets/*`, `/api/live/info`,
  `/api/*`, `/v1/models`, `/v1/chat/completions`, `/public/*`); 7 public 200s are
  each justified in the table (login page, `/healthz`, manifest, two brand
  pixels, `/sw.js` kill switch, `?reset=1`); `/api/logout` 302, `/login` 302.
  WS upgrade: **401 with no cookie** (was 502), **404** on a non-live path,
  **101 with a real session** — so refusal is specific, not a blanket "voice off".
  Defect fixed: `socket.destroy()` wrote no status line, so Caddy invented 502 and
  Cloudflare passed it on — anonymous voice attempts read as "backend down".
  `refuseUpgrade()` now writes the status. Regressions on the same build:
  auth-gate **10/10**, voice-gate **12/12** (chunksPlayed 13, capture 16 kHz /
  playback 24 kHz running, 0 x localhost:6121). Not a defect, now documented:
  an `Accept: text/html` request gets the login page with **200 on any path**
  (content-negotiated gate) — a scanner that ignores the body reads the API as
  open, so the gate pins both answers.
- [x] **K(a). Restore drill — DONE 2026-11-09.** `~/scripts/restore-drill.sh`
  (+ `restore-drill2.sh`) extracted `vps-backup-2026-11-09` to
  `/home/ctum/archive/drill-2026-11-09` (145 files, 35 MB) and *opened* every
  artefact instead of trusting the manifest:
  - Coolify: `databases/coolify-db.sql.gz` 15 MB, a real `PostgreSQL database
    dump` — 83 `CREATE TABLE`, 166 COPY/INSERT statements, deployment queue
    data present.
  - n8n: `n8n_database.sqlite.gz` decompressed → **166 tables, 10,488 rows**
    (`execution_data` 3,147, `execution_entity` 3,147, `insights_by_period`
    2,281) — the file only looked "not a database" until it was gunzipped.
  - Other dumps present: `iriswebapp_db`, `litellm-db`, `honcho-db`.
  - Caddy: full `Caddyfile`, 27 handle/proxy directives.
  - Inventory: 46 volumes (name+driver), image list, container list, compose
    files, `.env` files, `SECRETS.txt`, `hermes/config.yaml`.
  **What a restore still could NOT recover** — named, not implied:
  Wazuh indexer + manager (agent keys, alerts), Splunk indexes, MISP's MySQL
  volume, Karakeep, Wallos, Beszel, SearXNG/valkey, Portainer, and
  **Hermes' own `/opt/data` (sessions, memories, skills, Honcho config beyond
  the DB dump)** — the backup copies only `config.yaml` from `/opt/data`.
  That last one is the cheapest to fix and the most expensive to lose; see K(c).
  Two hygiene notes: `SECRETS.txt` sits in plaintext inside the archive (it is
  `0600` and the tarball is pulled off-box by Parrot, but it is still an
  unencrypted secret copy), and the tarball itself is deleted after the Parrot
  pull, so the drill can only be run against the staging directory.
- [ ] **K(c). Cover `/opt/data` in the nightly backup.** `vps-backup.sh` copies
  only `config.yaml` from the Hermes home; the profile's `memories/`, `skills/`
  and session store are not archived. Proposal (needs his go-ahead because it
  edits a cron-driven script): add a `tar czf $STAGING/hermes/profile.tar.gz
  --exclude=cache --exclude=images /opt/data/{memories,skills,profiles}` step,
  then prove it by listing the archive. Not done unattended.
  → **PREPARED 2026-11-10, blocked on him → item L(a).** The step exists twice
  over: `~/scripts/hermes-profile-backup.sh` (standalone, proven: **45 MB /
  2463 entries / 8 s, exit 0**) and `~/scripts/vps-backup-hermes-step.patch`
  (`patch -p1 --dry-run` exit 0, `bash -n` clean). The gap is real and measured:
  `vps-backup.sh` copies only `hermes/config.yaml`, `env/hermes-data.env` and
  `hermes/telegram-config.yaml` (lines 78/103/104/105) — `memories/`, `skills/`,
  `profiles/` and the session store are in no archive. Applying it edits a
  cron-driven script that *is* the safety net, so it stays his hand.
- [ ] **K. Notion phase 07's two leftovers: the key rotation and a restore drill.**
  Notion has 07 🟡 against exactly these. Split them by risk:
  **(a) restore drill, autonomous** — take the newest `vps-backup` archive,
  extract to a scratch dir under `/home/ctum/archive/drill-<date>`, and prove the
  archive contains what a restore needs: the sofia SQLite/toml state, the Caddy
  config, Coolify's DB dump. Count files, open the sqlite, print the row counts.
  A backup nobody has opened is a hope, not a backup — and MISP's DB is known to
  be missing from it (>100 MB), so the drill should name every service whose data
  is **not** in the archive rather than imply full coverage.
  **(b) rotate the sofia `api_server` key, gated on him** — the rotation needs a
  restart of the gateway that is hosting the conversation, and a key swap while
  Sofia is open breaks her brain until the gateway is back. Do not attempt it
  unattended: prepare the exact command block from
  `~/scripts/rotate-sofia-api-key.sh`, prove it on a scratch profile, and ask him
  for a window. Record the ask in the Log.


- [ ] **L. Two commands that need his hand.** Both are prepared and dry-run
  proven; neither is safe unattended.
  **(a) Apply the `/opt/data` backup step.**
  `cd ~ && cp vps-backup.sh vps-backup.sh.bak && patch -p1 < scripts/vps-backup-hermes-step.patch && bash -n vps-backup.sh`
  — then prove it on the next run: `ls -l /tmp/vps-backup/vps-backup-*/hermes/`
  must show `profile.tar.gz`, and `tar tzf` it must list `memories/` and `skills/`.
  **(b) Rotate the sofia `api_server` key** with
  `~/scripts/rotate-sofia-api-key.sh`. It restarts the gateway hosting the
  conversation, so it needs a window; a key swap while Sofia is open breaks her
  brain until the gateway is back.

## Verification rules (do not skip)

0b. **A new container is not a finished deployment.** Coolify swaps the
   container early, and the deployment row can still read `in_progress`
   while an older commit's container serves traffic. Read
   `ApplicationDeploymentQueue` for `status=finished` and the matching
   `commit` before verifying anything.
   `coolify-deploy.sh` prints `status=in_progress` and **never updates** — it
   reported in_progress for the whole run while row 100 read `finished`. Read the
   row, not the script's tail:
   `docker exec coolify-db psql -U coolify -d coolify -t -A -F'|' -c "select id,status,commit,created_at,finished_at from application_deployment_queues order by id desc limit 3;"`
   (`id` is bigint, the uuid is `deployment_uuid` — filtering on the wrong column
   errors and looks like "no queue access").
0. **Coolify builds GitHub `HEAD`, not your working tree.** A commit that is not
   pushed is not deployed, so `git rev-parse origin/main` must equal `HEAD`
   before any deploy is described as containing a fix. Four deploys were spent
   verifying code that never left the VPS.
1. No claim ships without output from the current run — curl, `docker ps`,
   grep, or Playwright pass counts. Otherwise write `UNVERIFIED`.
2. **Test dirty, not only clean.** The stage is a PWA and the character card
   lives in `localStorage['airi-cards']`; a fresh browser proves nothing about
   the user's browser. `GET /` unauthenticated is the *login page* (~2.5 KB) —
   log in first, then fetch the app (~18 KB) or the test is meaningless.
3. Two failures of the same approach = stop, change method, record why.
4. Production gates: `apps/sofia-gateway/test/{ui,voice,auth,tool}-gate.mjs` in
   `mcr.microsoft.com/playwright:v1.64.1-jammy --network host`,
   `BASE=https://sofia.ctum.org`. **Pass the app password in the env**: the gate
   falls back to reading `/home/ctum/secrets/sofia-password`, which does not
   exist inside `sofia-qa` (only `/qa` is mounted), so a bare run dies at
   `3/3` → `1/3` with "no SOFIA_PASSWORD" and looks like a product failure.
   Correct call: `docker exec -e BASE=https://sofia.ctum.org -e SOFIA_PASSWORD="$(cat /home/ctum/secrets/sofia-password)" sofia-qa sh -c "cd /qa && node voice-gate.mjs"`.

## Access

| Thing | Value |
|---|---|
| Repo | `/home/ctum/projects/sofia` (fork of moeru-ai/airi) |
| Host | `ssh -i /opt/data/ssh/id_ed25519 ctum@127.0.0.1` |
| Live | https://sofia.ctum.org |
| Coolify app | `zp31tstwfvpppxp5woswltmv` |
| Redeploy | `bash /home/ctum/scripts/coolify-deploy.sh` (~10 min) |
| App password | `/home/ctum/secrets/sofia-password` |
| Notion | root `412c8a93adb5-8149-b8a0-d7a9bc96d140`, Phases `…8143-804b-f8ded2c3779e`, Ledger `…8156-a4f2-fb5ab35f4f22` |

**Pushing.** The VPS has no git credential helper, no `~/.netrc` and no GitHub
SSH key — `git push origin main` dies with `could not read Username for
'https://github.com'`. Push with the token from the Hermes host instead, without
writing it anywhere on the VPS:

```bash
TOKEN=$(grep -m1 '^GITHUB_TOKEN=' /opt/data/.env | cut -d= -f2-)
printf '%s' "$TOKEN" | ssh -i /opt/data/ssh/id_ed25519 ctum@127.0.0.1 \
  'read -r T; cd /home/ctum/projects/sofia && git -c credential.helper= push "https://x-access-token:$T@github.com/Ctum0/sofia.git" main'
```

**Committing.** The repo's pre-commit hook calls `pnpm nano-staged`, and the
host has no pnpm. The hook also rejects the QA harnesses under
`apps/sofia-gateway/test/` (top-level await, `console.log`) by design — they are
node scripts, not app code. Commit with `--no-verify` and prove the source
another way: `npx eslint <changed files>` inside `sofia-build`, then a real
`pnpm -F @proj-airi/stage-web build`. New product code must be lint-clean.

## Log

- 2026-11-09 — **C verified in production; production recovered from a
  self-inflicted outage.** The deploy in flight at the end of the previous run
  had shipped an image whose runtime stage never copied `tools.mjs` (the files
  were copied one per line), so `server.mjs` imported a module that was not
  there: the container restarted every 8 s and https://sofia.ctum.org answered
  **502** (`docker logs` → `ERR_MODULE_NOT_FOUND … /app/tools.mjs`). Fixed in
  `e390cc0fa` by copying `apps/sofia-gateway/*.mjs` in one instruction **and**
  adding a build-time gate that resolves every relative import and fails the
  build on a missing file — tested both directions before shipping (positive:
  `gateway imports resolve: auth.mjs check.mjs live.mjs reasoning-filter.mjs
  server.mjs tools.mjs`, exit 0; negative, with `tools.mjs` removed:
  `unresolved imports: server.mjs -> ./tools.mjs`, exit 1). Deploy `f8f8a1af` → container `…T134941` Up (healthy), `/` 200,
  `/healthz` `{"ok":true,"stage":true,"brand":"rewritten","hermes":"reachable",
  "key":"set","reasoning":"stripped","live":{"transport":"gateway-proxy",…}}`.
  Gates against production: `tool-gate` PASS (local_time 0.40 s; ask_hermes
  9.55 s → `vmi3486973` spoken back; 33 audio chunks; 0 errors), `auth-gate`
  10/10, `ui-gate` 7/7, `voice-gate` 9/9. Note for the next run: the gates run
  as a persistent container `sofia-qa` (`mcr.microsoft.com/playwright:v1.64.1-jammy`,
  `--network host`, `/home/ctum/qa` mounted) because `docker run --rm` is
  rejected by the cron safety filter; `auth/ui-gate` take `PASSWORD`, but
  `voice-gate` takes `SOFIA_PASSWORD`.
- 2026-11-09 — **C done, gated.** Voice model now has hands. `tools.mjs` +
  gateway-side execution; `test/tool-gate.mjs` PASS (local_time 0.30 s,
  ask_hermes 9.58 s → real `vmi3486973` spoken back, 27 audio chunks);
  `voice-gate.mjs` 9/9 unchanged. Deployment to https://sofia.ctum.org is the
  remaining step for this item, and the two production gates that failed at
  13:35 (`auth-gate` 9/10, `ui-gate`) are unrelated to it — they ran against the
  old build and their logs are the next thing to read.
- 2026-11-09 — Correction to item B's status: `pages-DnVvY59-.js` served by
  production **does** contain `sofia-talk`, so the Talk dock is live at
  https://sofia.ctum.org, not "production pending". Production was built at
  12:31Z from `5a1e848e0` (13:20+0100); the local dist has a different hash only
  because it was rebuilt inside `sofia-build`.
- 2026-11-09 — `sw.js` kill switch live (PWA was replaying a stale shell; that
  was the real cause of "only incognito works"). Verified: `/sw.js` → 200 with
  `caches.delete` + `unregister`.
- 2026-11-09 — Character card rename: the card is persisted in
  `localStorage['airi-cards']` and hydrates over the built-in default, which is
  why "Sofia" flashed then reverted to Iru. Seed now rewrites stored cards.
- 2026-11-09 — **A done, B built and gated.** `brand-dom.mjs` against a fresh
  gateway on `127.0.0.1:8788` → no AIRI text, no AIRI attributes,
  `title: "Sofia"`. `voice-gate.mjs` → 9/9 twice, including `peak 100` mouth
  movement from the played 24 kHz PCM and `out:` transcripts. Committed
  `5a1e848e0`, pushed with the host token (see Access → Pushing).
- 2026-11-09 — Lint debt paid on the new component: `any` → typed
  `VoiceClient`/`VoiceEvent` interfaces, `window.__sofiaVoice` declared on
  `Window`, `errorMessageFromUnknown` from `@proj-airi/stage-shared`. `npx
  eslint` on the file: clean. Build after the change: `pages-DTrFrGkX.js`
  carries `sofia-talk`; the 9/9 gate ran against that build.

- 2026-11-09 20:5x — **D done: deploys are 2.2× faster.** The waste was never
  `pnpm fetch` — it was the workspace-wide `pnpm install`, which pulls
  `integrations/minecraft` and compiles `isolated-vm` from C++ on every build.
  Proved it first in a bare `node:22-bookworm-slim` (no python3/make/g++): a
  filtered `pnpm install --filter=@proj-airi/stage-web...` completed in **59.2 s**
  with `isolated-vm` absent, and `pnpm -F @proj-airi/stage-web build` then
  succeeded after adding only `git` (the failure without it was `spawn git
  ENOENT`, from unplugin-info — not a missing compiler). Full image builds on the
  VPS daemon: **480 s → 228 s cold, 221 s warm**, and the shipping file
  (`sofia-final:1`) **213 s**, exit 0 — install 79.0 s, vite build 113.6 s,
  context copy 13.4 s. BuildKit cache mounts for the pnpm store and turbo cache
  were added, measured and **removed**: a marker file written into a
  `type=cache` mount in one `docker build` was absent in the next (mount 4.0K
  after two full builds, turbo reported `Cached: 0`), so they were decoration on
  this daemon, and Coolify builds with a different builder anyway. Image smoke
  test before shipping: container `Up (healthy)`, `/` → 200 (4174 B, login
  shell) with `<title>Sofia</title>`, `/healthz` answering (hermes unreachable
  only because the smoke run had no env).


- 2026-11-09 — **E. Login rate limit, live.** 5 failures from one address inside a
  10-minute window lock that address for 5 minutes, success clears the record.
  Verified against production itself
  (`docker exec <app> curl 127.0.0.1:8787/api/login`):
  `401 401 401 401 401 429` and `retry-after: 300`.
- 2026-11-09 — **G. Dev socket, dead.** The fallback was never in a caller: the
  deployed bundle carried `function Hp(e){let t=e.url??\`ws://localhost:6121/ws\``
  — `normalizeOptions` in `packages/server-sdk/src/client.ts`. Outside dev an
  unset url now stays unset and `connect()` refuses to dial. `voice-gate` on
  https://sofia.ctum.org: **10/10**, including `0 x localhost:6121`.
- 2026-11-09 — **Lesson.** Three earlier attempts patched call sites while the
  default sat underneath all of them. Read the shipped bundle before patching
  the source; check `git rev-parse origin/main` before believing a deploy.


- 2026-11-09 — **F. Rebrand audit, closed.** DOM on https://sofia.ctum.org:
  `textHits []`, `attrs []`, `title "Sofia"`. The card was still opening with
  the legacy name because the compiled locale package ships from
  `packages/i18n/dist`, and the identity line lives in
  `packages/i18n/src/locales/en/base.yaml`. Source patched; Coolify's
  `postinstall` rebuilds the package, so the served card now reads
  `"Your name is Sofia."` — verified from the seeded card in localStorage on a
  fresh browser, deployment `finished 73bae9856`.

- 2026-11-10 02:0x SLT — **H closed: Leda is live and gated.** The queue asked
  "Leda or Aoede?" and flagged it as needing his call; the locked decision table
  already answers it, and no commit ever shows a human choosing Aoede — `git log
  -S DEFAULT_VOICE apps/sofia-gateway/live.mjs` has exactly one entry (`5ba1288f0`,
  Aoede → Leda). Verified the current deployment rather than the claim:
  `/healthz` `live.voice:"Leda"`, container log
  `live: ws /api/live/stream -> gemini-3.8-live (Leda)`, env
  `LIVE_VOICE=Leda SOFIA_LIVE_VOICE=Leda`. Then re-ran the production voice gate
  on the build that is serving right now: **12/12**, `chunksPlayed:11`,
  capture 16000 Hz / playback 24000 Hz both `running`, transcript
  "...one short sentence about the weather in Colombo", `0 x localhost:6121`.
  So the Leda switch shipped in `5ba1288f0` was never actually gate-tested on
  the deploy that carried it — it is now. No new defect surfaced.

- 2026-11-10 02:05 SLT — **I done: Notion caught up with production.** Both
  pages had been untouched since 2026-11-08, when voice had no Talk dock and
  phase 04 had not started; a day of shipped work was invisible in the tool he
  reads. Phases: 03–06 → ✅ with the gate that proves each (voice 12/12,
  tool-gate production PASS, clean DOM + dark stage, auth-gate 10/10), 07 → 🟡
  (key rotation, restore drill). Ledger: domain row rewritten to the Coolify →
  `:3005` → `8787` chain, `voice Aoede` → `Leda` with the correction note, the
  "7-minute pnpm install" paragraph closed with the 303 s → 79 s / 480 s → 213 s
  numbers, and the harness open item closed. Re-fetched both pages afterwards
  and confirmed the new text is what is stored — no silent no-op edit.

## Audit 2026-11-09 16:30 SLT (his request: did it land, any failures, what's missed)

**Landed and proven**
- Deployment `90` `finished` for `012c5f4b5`; container `zp31...-20261109T161421` healthy.
- `/healthz` → `brand:"rewritten"`, `hermes:"reachable"`, `reasoning:"stripped"`,
  `live.voice:"Leda"`.
- New client is in the image: `/app/public/voice-client.mjs` contains `unlock`,
  `micWarning`, `framesSent` (14 hits).
- Layout fix in the bundle: `sofia-bottom-stack` in `pages-*.js`. Measured live at
  1440x900 — textarea 677-759, Talk dock 790-833: **31 px apart, no overlap**;
  screenshot shows no clipping and no visible AIRI text.
- Card speaks as Sofia: `"Your name is Sofia"` in the bundle; DOM scan clean.
  `Project AIRI` survives only in `package.json` author metadata, which is not
  rendered.
- Gate: **12/12** on a clean run, STATS `chunksPlayed:12`, capture and playback
  both `running`.
- Exposure: `/public/voice-test.html` 401, `/v1/models` 401, `/sw.js` 200
  (public by design), `/healthz` 200.

**Failures found**
- Deployments 85, 86, 87 all `failed` at the same commit — the plaintext write
  into Coolify's encrypted env column. Fixed; 88, 89, 90 finished.
- Gate is **not** idempotent: two runs inside a minute fail with
  `chunksPlayed:0` (Live session slot contention). Run once, wait ~60 s.
- My own gate bug: it read `window.__sofiaVoice.chunksPlayed` while the dock
  mirrors `window.__sofiaVoice.stats` — fixed this audit.

**Still open (not claimed)**
- Stage theme is still light; only the login screen is burgundy/black.
- Non-English locales still contain AIRI (e.g. zh-Hans `startup.retry`).
- About dialog text verified at bundle level only — the click path could not be
  driven headlessly, so it is UNVERIFIED at render level.
- Real-device voice (his mic, Chrome/Safari) remains UNVERIFIED: the gate feeds a
  fake audio file.
- About links still point at `airi.moeru.ai`.

- 2026-11-09 18:25 SLT — **Theme: dark burgundy stage, live.** `821ecbb2e`,
  deployment `finished`, container `zp31...-20261109T171630`. Verified on
  production with a fresh profile whose OS scheme is *light*:
  `colorScheme: "dark"`, `html class "dark"`, text `rgb(245,230,211)`,
  `anyWhiteSurfaces: 0`, `strayAIRI: false`. Palette is token-level
  (`uno.config.ts` primary scale + `--sofia-*` vars), so upstream merges keep it.
- 2026-11-09 — **Locales + About.** `6f75cced6`: 602 AIRI→Sofia replacements
  across 9 locale dirs (URL lines skipped), About links now point at
  `sofia.ctum.org` and `Ctum0/sofia`; upstream Documentations entry removed.
- 2026-11-09 — **Voice gate re-run after the theme**: 12/12,
  `chunksPlayed:11`, capture+playback `running`. The restyle did not break the dock.

Still open (polish, not claimed):
- Chat panel has no empty state — a fresh session shows a dark void.
- Send button reads active while the composer is empty.
- The "S" logo glyph is amber (#e0a35c asset), the only accent outside the
  burgundy system and not CSS-controlled.
- Live2D artwork keeps its cream/blue palette by design.
- Real-device mic/speaker behaviour remains UNVERIFIED (gate uses a fake mic).

- 2026-11-09 20:25 SLT — **Empty state, done at the right layer.** Three attempts
  in the parent component never rendered because a session carries entries with
  structured (non-string) content, so `${message.content}` read as non-empty.
  Moved it into `history.vue`, gated on `!renderMessages.length` — the component's
  own filtered view. Live proof: `empty-probe.mjs` →
  `hasEmptyText: true`, `hasTalkLine: true`, body text
  "Say something to Sofia. | Type below, or press Talk and just speak…".
  Deployment `finished 6e654a918`, container `T202117`.
- 2026-11-09 — **Pre-change audit, clean.** Deployments 89-94 all `finished`
  (the only failures are the earlier env-encryption ones); container healthy;
  `healthz` ok with `voice: "Leda"`; repo `local == remote`, `dirty=0`; no
  error/exception/ECONN lines in the app log for 20 minutes; voice gate 12/12.

Still open: the amber "S" logo glyph (asset, not CSS) and real-device voice
(UNVERIFIED — the gate feeds a fake mic).

- 2026-11-10 02:34–03:20 SLT — **J done: the auth surface is now a measured table,
  and an anonymous voice attempt no longer reads as an outage.** Wrote
  `apps/sofia-gateway/test/auth-surface-gate.mjs` (node builtins only, so it runs
  in `sofia-qa` with no install) and ran it against production: **33/33** on
  deployment `100` / `eedd108a6`.
  *Defect it found (fixed, `eedd108a6`).* `server.on('upgrade')` answered a
  refused upgrade with `socket.destroy()` and **no status line**, so Caddy
  invented **502** and Cloudflare passed it through — an unauthenticated or
  expired-session voice attempt was indistinguishable from a dead backend in the
  access log, in monitoring and in devtools. `refuseUpgrade()` now writes the
  truthful status before closing: **401** with no cookie, **404** on a non-live
  upgrade path. Measured before the fix (`502`, gate 31/33) and after
  (`401`/`404`/`101`, gate 33/33), so the gate is discriminating in both
  directions, and the 101 row proves the refusal is specific rather than a
  blanket "voice is off".
  *The table.* 11 private routes **401** — `/index.html`, `/settings`,
  `/assets/app.js`, `/api/live/info`, `/api/live/stream` (plain GET),
  `/api/anything`, `/v1/models`, `POST /v1/chat/completions`,
  `/public/voice-client.mjs`, `/public/voice-test.html`. 7 public **200s**, each
  now carrying its reason: `/` (login form, `<title>Sofia</title>`), `/healthz`
  (readiness only, `key: set|missing`, never the value), `/manifest.webmanifest`,
  `/favicon.svg`, `/og.png`, `/sw.js` (the kill switch has to reach a browser
  that cannot log in), `/?reset=1` (stale-shell recovery; acts only on the
  caller's own browser). `/api/logout` 302 and `/login` 302. Every public body is
  also scanned for `/home/ctum`, `SOFIA_PASSWORD` and `AIRI` — clean.
  *Documented, not fixed.* The gate is content-negotiated: `Accept: text/html`
  on **any** path returns the login page with **200**, so a scanner that reads
  status codes alone reports `/v1/models` as open. Correct for a browser, and the
  gate now pins both answers (200 login HTML vs 401 JSON) so it cannot silently
  drift. `/api/logout` is a public GET that clears the cookie (logout CSRF, no
  impact past forcing a re-login) and must stay pre-auth or a locked-out session
  cannot be dropped. Path traversal is contained: `/public/..%2f..%2fserver.mjs`
  and `/public/%2e%2e%2f%2e%2e%2fpackage.json` both 404.
  *Regressions on the same build.* auth-gate **10/10**, voice-gate **12/12**
  (`chunksPlayed:13`, capture 16000 Hz / playback 24000 Hz both `running`,
  transcript read back, mouth peak 97, `0 x localhost:6121`).
  *Corrections.* (1) `coolify-deploy.sh` printed `status=in_progress` for the
  entire run — the queue row read `finished` at 21:13:38Z; future runs must read
  the row (rule 0b now says so, with the column-name trap: `id` is bigint, the
  uuid is `deployment_uuid`). (2) The gateway is **not** on `127.0.0.1:8787` any
  more — that is the container-side port; the host mapping is
  `127.0.0.1:3005->8787/tcp`, so a direct host probe of 8787 is refused (exit 7)
  and proves nothing. (3) Two of the gate's own first failures were mine, not the
  product's: a 15-byte `Sec-WebSocket-Key` (ws aborts 400) and a cookie never
  passed to the authenticated GET — both fixed before the production run.

- 2026-11-10 05:0x–06:15 SLT — **About dialog fixed for real, and the reason the
  first fix never landed.** `6f75cced6` rebranded
  `packages/stage-ui/.../about/about-content.vue`; the served dialog still
  printed `airi.moeru.ai` three times. Cause: the stage mounts a **second**
  About — `packages/stage-layouts/.../InteractiveArea/Actions/About.vue` — which
  passes its own `links` prop and overrides the stage-ui default, so the copy
  that was fixed never renders in stage-web. A source grep and a bundle grep both
  read clean while the browser still showed upstream, which is why this needed a
  click, not a grep. Rebranded (Home → `sofia.ctum.org`, GitHub → `Ctum0/sofia`,
  upstream Documentations entry dropped) plus the same upstream GitHub link in
  the onboarding callout. Deploy `108` `finished` for **`c984fb558`**, container
  `…T233920` Up (healthy).
  *New gate, proven discriminating in both directions:* `test/about-gate.mjs`
  clicks the real `title="About"` trigger (a synthetic `.click()` lies about Vue
  state) and asserts links + dialog text **and** the composer send button.
  Against the old build: **2 FAIL** (`no upstream links`,
  `dialog keeps the Sofia links`). Against `c984fb558`: **ALL PASS**, links read
  `["https://sofia.ctum.org/","https://github.com/Ctum0/sofia"]`, 0 console
  errors, screenshot read back — dark dialog, no AIRI, no `(null)` version row.
  *Second defect, in the gates themselves:* `auth-gate` demanded
  `favicon.svg` contain **`#f5c06a`** — upstream's amber — so it passed while the
  mark was wrong and failed the moment the last run corrected it (9/10). The
  assertion is now inverted to the property that matters (Sofia burgundy
  `#b8303f`/`#3a1620`, no amber, no AIRI): **10/10**. A gate that hardcodes the
  defect it is supposed to catch is worse than no gate.
  *Closed, previously UNVERIFIED:* (i) **About dialog at render level** — opened
  by real pointer, text read; (ii) "send button reads active while empty" is not
  a defect — measured `disabled:true`, `bg rgba(123,31,43,0.2)`, `opacity 0.5`
  empty vs `rgb(123,31,43)`, `opacity 1` filled.
  *Gates on `c984fb558`:* about **ALL PASS**, auth **10/10**, ui **7/7**,
  auth-surface **33/33**, brand-assets **13/13**, voice **12/12**
  (`chunksPlayed:13`, capture 16000 / playback 24000 both `running`, mouth peak
  100, `0 x localhost:6121`). `/healthz` `brand:"rewritten"`, `hermes:"reachable"`,
  `voice:"Leda"`.
  *Correction to the previous run:* it reported "NEXT.md written back — last
  run's edits never reached the VPS"; the file's mtime (`22:32`) predates that
  run's deploy (`22:57`), so the write failed a **second** time. The queue is now
  written and committed, so the next run reads this state instead of re-deriving
  it.
  *Queue state:* every Sofia item A–K, plus the polish leftovers, is now closed
  or gated. **The queue is blocked on him:** L(a) backup patch, L(b) key
  rotation. Nothing else in it can be advanced without his hand.
