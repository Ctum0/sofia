# Sofia — NEXT (autonomous work order)

Purpose: this file is the queue. Any run (agent, cron, or human) reads the first
unchecked item, does it, verifies it, ticks it with evidence, and appends the
result under **Log**. Rules at the bottom are mandatory.

## Queue

- [ ] **A. Splash + logo → Sofia.** The served `index.html` still shows AIRI
  branding (splash text, icons). Rewrite at serve time in
  `apps/sofia-gateway/server.mjs`; keep asset filenames so the build stays
  mergeable. Verify: authenticated fetch of `/` shows no `AIRI`.
- [ ] **B. Avatar voice + lip-sync.** Wire `apps/sofia-gateway/public/voice-client.mjs`
  (already 7/7 at `/public/voice-test.html`) behind a Talk control on the AIRI
  stage and drive mouth movement from the incoming 24 kHz PCM. Verify with
  `test/voice-gate.mjs` against the stage, not the harness.
- [ ] **C. Hermes as hands.** Live `toolCall` → gateway → Hermes `/v1` →
  `toolResponse`, so she can act rather than only talk. Verify with a prompt that
  forces a tool call and shows the result spoken back.
- [ ] **D. Build speed.** `pnpm fetch` + BuildKit cache mount in `Dockerfile` —
  every deploy is currently ~10 min, which is why fixes land slowly.
- [ ] **E. Harden.** Login rate limit; rotate the exposed sofia `api_server` key
  with `~/scripts/rotate-sofia-api-key.sh` when a restart is safe.
- [ ] **F. Rebrand audit.** Check `manifest.webmanifest`, `open-graph.png`,
  icon files, and any remaining user-visible AIRI/Iru strings; the product is
  **Sofia**, the character card now also reads Sofia.

## Verification rules (do not skip)

1. No claim ships without output from the current run — curl, `docker ps`,
   grep, or Playwright pass counts. Otherwise write `UNVERIFIED`.
2. **Test dirty, not only clean.** The stage is a PWA and the character card
   lives in `localStorage['airi-cards']`; a fresh browser proves nothing about
   the user's browser. `GET /` unauthenticated is the *login page* (~2.5 KB) —
   log in first, then fetch the app (~18 KB) or the test is meaningless.
3. Two failures of the same approach = stop, change method, record why.
4. Production gates: `apps/sofia-gateway/test/{ui,voice,auth}-gate.mjs` in
   `mcr.microsoft.com/playwright:v1.64.1-jammy --network host`,
   `BASE=https://sofia.ctum.org`.

## Access

| Thing | Value |
|---|---|
| Repo | `/home/ctum/projects/sofia` (fork of moeru-ai/airi) |
| Host | `ssh -i /opt/data/ssh/id_ed25519 ctum@127.0.0.1` |
| Live | https://sofia.ctum.org |
| Coolify app | `zp31tstwfvpppxp5woswltmv` |
| Redeploy | `bash /home/ctum/scripts/coolify-deploy.sh` (~10 min) |
| App password | `/home/ctum/secrets/sofia-password` |
| Notion | root `412c8a93adb5-8149-b8a0-d7a9bc96d140`, Phases `…8043-804b-f8ded2c3779e`, Ledger `…8156-a4f2-fb5ab35f4f22` |

## Log

- 2026-11-09 — `sw.js` kill switch live (PWA was replaying a stale shell; that
  was the real cause of "only incognito works"). Verified: `/sw.js` → 200 with
  `caches.delete` + `unregister`.
- 2026-11-09 — Character card rename: the card is persisted in
  `localStorage['airi-cards']` and hydrates over the built-in default, which is
  why "Sofia" flashed then reverted to Iru. Seed now rewrites stored cards.
