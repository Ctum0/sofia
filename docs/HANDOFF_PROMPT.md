# Sofia — handoff prompt (paste this into paseo)

You are taking over **Sofia**, an embodied voice assistant, at
`https://github.com/Ctum0/sofia`. Work directly on `main` in a clone of that repo.
This prompt is the whole brief; `docs/HANDOFF.md` in the repo is the same state in
file form. Read both, then start at §8.

## 1. What the product is

A JARVIS-shaped assistant, not a chat window. She has a body on screen (Live2D
avatar), she hears you (`gemini-3.8-live`, native audio, server-side bridge), and
she has hands: she opens real web pages in windows beside herself, clicks, types,
reads, and moves her own body and windows around. The brain behind her answers is
Hermes over `/v1`; the stage is a fork of `moeru-ai/airi`.

Acceptance sentence to keep in your head: *"Sofia, shrink a bit, open github, click
Sign in, read me the page."* — and every part of that must visibly happen.

## 2. Verified state at handoff (2026-11-11 23:40 SLT)

- HEAD `bea358a49` (docs only). Last code commit `a7077bd71`, which is what
  production runs. Tree clean, `origin/main` == local.
- Production: https://sofia.ctum.org behind a password gate. Coolify app
  `zp31tstwfvpppxp5woswltmv` builds **GitHub HEAD**, not a working tree.
- `bash scripts/verify-release.sh` → `PASS a7077bd71 — tree clean, deployed,
  healthy, gated, on-brand`: voice 13/13 · brand 13/13 · windows 19/19 ·
  browser 10/10 · text-panel 15/15 · frame 6/6 · responsive 25/25 · tools 8/8.
- That script is the **only** thing allowed to call anything "live". No claim ships
  without its output, otherwise label it `UNVERIFIED`.
- Fixed at handoff, all gated: (a) her clicks were invisible because the window kept
  the screenshot from when it opened — every browse action now broadcasts a `tick`
  and the window refetches, even when the action failed; (b) a failed `clickText`
  used to be narrated as success — it now returns the labels actually on the page;
  (c) windows could only open on the right half — `control_window move` takes
  `position: left | centre | right`, and typed "move the window to the left" routes
  to it.

## 3. Architecture, by file

- `apps/sofia-gateway/server.mjs` — async request handler: `/v1` proxy, `/api/events`
  SSE, `/api/browse/*` proxy, `/api/stage/control`, `stageIntent()` +
  `runStageIntent()` for typed turns, `AVATAR_RULES`, `stageLine()`, one `toolCtx`
  per Live connection.
- `apps/sofia-gateway/tools.mjs` — the tools the model may call: `ask_hermes`,
  `local_time`, `show_panel` (kind decided by URL, never by the model's label),
  `control_window`, `control_avatar`, `browse` (goto / clickText / clickSelector /
  fill / press / read / links / scroll / back / reload / close). Every tool reply
  ends with `[stage: …]` so she always knows what is on screen.
- `apps/sofia-gateway/live.mjs` — Live socket, VAD (`silenceDurationMs: 500`), tool
  dispatch.
- `apps/sofia-gateway/browse-service/server.mjs` — Playwright Chromium service
  (`/open`, `/act`, `/frame`, `/close`, `/healthz`), role-first `clickText`,
  `settleAfterNavigation`. Real browser, never an iframe: sites send
  `X-Frame-Options` and a blank frame looks like a bug.
- `apps/stage-web/src/pages/index.vue` — the window layer, chat toggle, avatar
  transform (`translate3d(x,y,0) scale(s)`), `STAGE_KEY` persistence, `sid`-first
  window lookup.
- `packages/stage-layouts/src/components/Widgets/Sofia{Window,Windows,VoiceDock}.vue`.
- `scripts/verify-release.sh`, `scripts/ci/guards.mjs` (G1–G11),
  `apps/sofia-gateway/test/*.mjs` + `gates.json`.

## 4. Rules that exist because they were broken — do not relitigate

1. A build's **exit code** is the gate, never a grep of its output.
2. `verify-release.sh` is the only authority on "live". Never report an intention as
   an outcome.
3. Coolify builds GitHub `HEAD`. A queued deployment is not a finished one — wait
   for `status=finished` and a matching commit.
4. Prove staleness before debugging: `docker inspect <app> --format '{{.Created}}'`
   against `git log -1`.
5. `tools-gate.mjs` must run **inside the gateway container** (`docker cp` +
   `docker exec`); the build container is on a different Docker network.
6. A `/opacity` modifier belongs in `class=""`, never as a bare attribute (Vue
   parse error, and the build still exits 0).
7. Gate text is **discovered, never hardcoded** — a gate naming a link whose wording
   later changes fails for a reason unrelated to the product.
8. Keep the fork mergeable: never rename `@proj-airi/*` packages; rebrand only
   user-visible strings. **Never touch the Live2D character artwork** — theme
   through tokens.
9. One writer. If two agents commit to `main`, whichever lands second silently
   reverts the first.
10. All UI text in English. Secrets never in the repo, never in a commit, never in
    a message.

## 5. Verify loop you must use for every item

```
bash scripts/verify-release.sh          # must print PASS <sha>, exit 0
```

For a change that needs a real Live session (voice, tools, avatar by voice), also
run the hand-run gates — they are `auto:false` because each key has one concurrent
Live slot:

```
node apps/sofia-gateway/test/voice-hands-gate.mjs     # 4/4
node apps/sofia-gateway/test/panel-live-gate.mjs
```

Exit codes from `verify-release.sh` name the breached rule. A red gate is a product
fact; a flaky harness is not — prove which one you are looking at before "fixing"
the product.

## 6. What is NOT built (ranked; this is the backlog)

**Tier 1 — the vision is incomplete without these**

1. **Wake word ("Hey Sofia").** Nothing exists. OpenWakeWord or Picovoice Porcupine
   running in the stage; the Live socket must stay closed until the word fires.
   Acceptance: a gate that proves no socket opens on background speech, and one that
   proves it opens within ~1 s of the word.
2. **3D / VRM avatar.** The engine already supports it (`stage-ui-three`,
   `stage-model-renderer: 'vrm'`); we ship Live2D `hiyori_free_zh`. Decide, then one
   VRM model driven by the existing mouth parameter. Do not touch the Live2D art
   before that decision.
3. **Real-device voice.** Every measurement uses
   `--use-fake-device-for-media-stream`. Latency, lip-sync and barge-in on a real
   phone are measured by Sithum's ear only. Ask him to test after any voice change.

**Tier 2 — the browser lane lies about capability**

4. **Form filling on real sites.** No `<select>`, checkbox, date picker, iframe or
   shadow-DOM handling. "Book me a ticket" is a lie until this exists.
5. **Multi-step page plans.** She has `read` and `links` but no retry-with-screenshot
   loop, so "search, open the third result, read the price" only works by luck.
6. **Concurrent pages.** One Live session keeps one `lastPage`; with two windows open,
   "click the link" is ambiguous. Needs per-window targeting (`sid`/title) in both
   `browse` and `control_window`.

**Tier 3 — hygiene**

7. Two writers on `main` (identities `ctum` and `Sofia <sofia@ctum.org>`) — pick one.
8. `169.58.126.200:443` still answers directly, bypassing Cloudflare (`NEXT.md` §Q
   has the ufw commands).
9. Live API key rotation, deferred; needs a restart window.
10. `text-panel`'s resize assertion is order-fragile under a contended Live slot.
    Capability is proven separately; not fixed.

## 7. Things that are true about how this project fails

- Passing gates are not proof of quality; they are proof the specific past mistakes
  stay dead. Add a gate with every fix, named after the mistake.
- The expensive bugs have been *invisible state*: a window showing yesterday's
  pixels, a variable written and never read, a tool context recreated per call.
  When something "doesn't work", check what the user can actually see first.
- A gate that hardcodes real-world text (a link label, a page title) will fail for
  reasons that are not the product's fault.
- Anything you cannot measure, say `UNVERIFIED` and hand to Sithum to test. He will
  re-issue the same instruction until it visibly works — that repetition is the test,
  not nagging.

## 8. Your first five commits, in order

1. Clone, `pnpm install`, build `@proj-airi/stage-web`, run
   `bash scripts/verify-release.sh` **before changing anything**, and report the
   exact output. That is the baseline.
2. Wake-word spike behind a feature flag, with the two gates described in §6.1.
3. Per-window targeting: `browse` takes an optional `sid`/`target`; `control_window`
   can focus by title. Gate: two windows, click in the second one.
4. Form lane: `<select>`, checkbox, date input, iframe fill — one gate per control,
   on github.com/login as the honest target.
5. VRM decision + one VRM model rendering with the existing mouth parameter.

Each item: one commit, one gate, `verify-release.sh` green, then push. Do not batch
three features into one commit; do not push a red tree.
