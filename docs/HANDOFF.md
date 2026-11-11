# Sofia — handoff state

Last verified: **2026-11-11 23:40 SLT**, commit **`a7077bd71`**.
`PASS a7077bd71 — tree clean, deployed, healthy, gated, on-brand`
voice 13/13 · brand 13/13 · windows 19/19 · browser 10/10 · text-panel 15/15 ·
frame 6/6 · responsive 25/25 · tools 8/8

This file is the handoff: what exists, what is proven, what is not, and what to
build next. It is a queue, not a history — history lives in git and `NEXT.md`.

---

## 1. What is running

| piece | where | notes |
|---|---|---|
| Stage (fork of `moeru-ai/airi`) | `apps/stage-web` | Vue 3 + Live2D avatar, burgundy #0b0708 |
| Gateway (brain + hands) | `apps/sofia-gateway/server.mjs` | Node, async handler, no framework |
| Live voice bridge | `apps/sofia-gateway/live.mjs` | `gemini-3.8-live`, voice `Leda`, server-side proxy |
| Browser service | `apps/sofia-gateway/browse-service/server.mjs` | Playwright Chromium, container `sofia-browser`, port 8790 unpublished |
| Brain | Hermes `/v1` | tools round-trip through `tools.mjs` |
| Deploy | Coolify app `zp31tstwfvpppxp5woswltmv` | builds GitHub `HEAD`, not the working tree |
| Live URL | https://sofia.ctum.org | password gate + rate limit |

Host service containers: `sofia-browser`, `sofia-qa` (Playwright + `/qa`, where
gates run), `sofia-build` (node:22, root, bind-mounts the repo at `/app` — it
stops after host events, `docker start sofia-build`).

## 2. What is proven, and how

Run `bash scripts/verify-release.sh` — it is the **only** thing allowed to call a
build "live". It checks repo ↔ deployment ↔ runtime ↔ health ↔ gates ↔ brand and
exits non-zero with a rule name when it fails.

- `voice-gate` 13 — a real Live socket answers with audio chunks.
- `windows-gate` 19 — open / raise / drag / resize / close / close-all.
- `browser-gate` 10 — a real Chromium page, real screenshots, private IPs refused.
- `text-panel-gate` 15 — typed turns drive the stage; it survives a refresh.
- `frame-gate` 6 — **her click changes the pixels in the window** (SHA-256 of the
  frame before/after), and a window can sit on either half of the screen.
- `windows-responsive-gate` 25 — 390 / 768 / 1024 / 1440 / 1920.
- `tools-gate` 8 — runs *inside* the gateway container; one tool context per Live
  session, so `lastPage` survives from one tool call to the next.

Hand-run only (`auto:false`): `voice-hands-gate` (real Live session, 4/4),
`panel-live-gate`, `proactive-gate`.

## 3. The three defects fixed at handoff

1. **Her clicks were invisible.** Every action did reach the page, but the window
   kept the screenshot from when it opened. Browse actions now broadcast a `tick`
   and the window refetches the frame — including when the action *failed*, so a
   stale picture can never masquerade as a live page.
2. **She claimed clicks that never landed.** `clickText` matched by strict wording;
   example.com now says "Learn more", not "More information". A miss now returns
   the labels that *are* on the page, so a retry is possible and lying is not.
3. **Windows could only open on the right half.** `control_window move` takes
   `position: left | centre | right`; typed "move the window to the left" routes
   to it (measured x=24 of 1440, and back to 736).

## 4. What is NOT done — ranked

**Tier 1 — the vision is not complete without these**

1. **Wake word ("Hey Sofia").** Nothing exists. Needs an always-on local VAD +
   keyword spotter (openWakeWord or Picovoice Porcupine) in the stage; the Live
   socket must not open until the word fires. Cost: ~1 day, no new server.
2. **3D avatar.** Engine already supports VRM (`stage-ui-three`,
   `stage-model-renderer: 'vrm'`); we ship Live2D `hiyori_free_zh`. A VRM model
   plus camera work is what makes her look embodied rather than a sticker.
   Do not touch the Live2D art until this decision is made.
3. **Real-device voice.** Every measurement uses
   `--use-fake-device-for-media-stream`. Sithum's ear is still the only test of
   latency, lip-sync and barge-in on a real phone.

**Tier 2 — capability gaps inside the browser lane**

4. **Form filling that survives real sites.** `fill` writes to one selector; no
   handling of date pickers, `<select>` menus, iframes, or shadow DOM. Needed
   before "book me a ticket" class requests are honest.
5. **Reading before acting.** She has `read` and `links` but no notion of a page
   *plan*; multi-step flows ("search, open the third result, read the price") only
   work by luck. A small action-retry loop with a screenshot check after each step
   would fix most of it.
6. **Concurrent pages.** One Live session, one `lastPage`. Two windows open ⇒
   "click the link" is ambiguous. Needs per-window targeting.

**Tier 3 — hygiene**

7. **Second writer risk.** Commits from identity `Sofia <sofia@ctum.org>` and
   `ctum` both land on `main`. From now on the laptop owns the tree; nothing else
   should push.
8. **Origin exposure.** `169.58.126.200:443` still answers directly, bypassing
   Cloudflare (`NEXT.md` §Q has the ufw commands).
9. **Key rotation** for the Live API key — deferred, needs a restart window.
10. **`text-panel` resize assertion is order-fragile** under a contended Live
    slot; it re-runs green, the capability is proven separately. Not fixed.

## 5. Rules that exist because they were broken

- A build's **exit code** is the gate, never a grep of its output.
- `verify-release.sh` is the only authority on "live". Never report an intention
  as an outcome.
- Coolify builds **GitHub HEAD**. A queued deployment is not a finished one; wait
  for `status=finished` and a matching commit.
- Prove staleness before debugging: compare `docker inspect <app> --format
  '{{.Created}}'` with `git log -1`.
- `tools-gate` cannot run in `sofia-build` (different Docker network) — it runs
  in the gateway container via `docker cp` + `docker exec`.
- A `/opacity` modifier goes in `class=""`, never as a bare attribute.
- Gate text is discovered, never hardcoded: a gate that names a link which later
  changes wording fails for a reason that has nothing to do with the product.

## 6. First five commits on the laptop

1. `docker start sofia-build` (or equivalent local dev container) and run
   `bash scripts/verify-release.sh` **before** touching anything — establish that
   the baseline is green on your machine too.
2. Wake-word spike: openWakeWord in the stage, gated behind a feature flag, with a
   gate that asserts the Live socket stays closed until the word fires.
3. Per-window targeting: `browse` takes an optional `sid`/`target`, and
   `control_window` can focus by title. Gate: two windows, click in the second.
4. Form lane: `<select>`, checkbox, date input, iframe fill; one gate per control
   on a real site (github.com/login is the honest target).
5. VRM decision + one VRM model rendering with the existing mouth parameter.

## 7. Where the parts live

- `apps/sofia-gateway/server.mjs` — `/v1` proxy, `/api/events` SSE, `/api/browse/*`,
  `/api/stage/control`, `stageIntent()` + `runStageIntent()` (typed lane),
  `AVATAR_RULES`, `stageLine()`.
- `apps/sofia-gateway/tools.mjs` — `ask_hermes`, `local_time`, `show_panel`,
  `control_window`, `control_avatar`, `browse`; one `ctx` per Live connection.
- `apps/sofia-gateway/browse-service/server.mjs` — `/open`, `/act`, `/frame`,
  `/close`, `/healthz`; role-first `clickText`; `settleAfterNavigation`.
- `apps/stage-web/src/pages/index.vue` — windows, chat toggle, avatar transform,
  `STAGE_KEY` persistence, `sid`-first window lookup.
- `packages/stage-layouts/src/components/Widgets/Sofia{Window,Windows,VoiceDock}.vue`.
- `scripts/verify-release.sh`, `scripts/ci/guards.mjs` (G1–G11),
  `apps/sofia-gateway/test/*.mjs` + `gates.json`.
