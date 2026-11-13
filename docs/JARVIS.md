# Sofia → JARVIS: what is built, what is missing, and the order to build it

Written 2026-11-12, after the release that fixed the hands, the secrets, the
browser lifecycle and the personality split. This is the plan for the product
Sithum actually described, not a generic assistant roadmap.

The sentence that defines the target:

> "Sofia, what did I spend on servers last quarter — show me. Then open the
> invoice site, log me in, find the March one and read the total. And shrink
> yourself so I can see it."

Everything below is in service of that kind of turn.

---

## 1. The personality question, answered

There were **three** personas, and they disagreed.

| Lane | Where the persona came from | What it produced |
|---|---|---|
| Text | the character card: `systemPrompt + description + personality + scenario` (`airi-card.ts:resolveSystemPrompt`) | AIRI's default — "your name is Sofia, an experimental virtual AI VTuber, a 15 year old girl… talk like an English anime or Vtuber girl, add cute words" (`packages/i18n/src/locales/en/base.yaml`) |
| Voice | a hand-written two-sentence string in `server.mjs` | "warm, quick-witted personal assistant to Sithum, who is Sri Lankan and lives in Colombo" — no temperament, no humour, no card |
| Hermes (`sofia` profile) | `profiles/sofia/SOUL.md` | a genuinely good companion persona — warm, lightly witty, direct, no filler — that the Live call **never saw**, and the text lane only reached indirectly through `ask_hermes` |

So the observation was correct and the cause was simpler than it looked: the
voice lane had its own persona string, hard-coded, and the card never reached it.

**Fixed** (commit `3be6b9481`): the dock sends her card as the first message on
the voice socket, the gateway composes `card + VOICE_RULES`, and the old
hard-coded persona is deleted. `VOICE_RULES` keeps only what the card cannot
know — the tools, "say it, do not read it", and "a failed tool is said plainly".

**Resolved** (commit `4516de197`): it was both, and the order mattered.

1. `SOUL.md` is the source. Its persona sections — temperament, conversational
   behaviour, interaction principles, spoken delivery — were merged into the
   card's `prompt.prefix` in all ten locales, translated per locale and keeping
   each locale's streaming-token block verbatim. Its *Stage & Browser Workspace*
   and *VPS & Container Rules* sections were deliberately left out: the first
   named `mcp__sofia-browser__*` tools that this profile does not have, and the
   second is host-lifecycle policy that has no business shipping to a device.
2. `base.yaml` no longer holds AIRI's anime-VTuber default, in any locale.
3. Every persona this fork has shipped is remembered by SHA-256 in
   `retiredPersonaDescriptionHashes`, because changing the default makes a
   device's stored text stop matching any built-in and `splitCard` then treats it
   as a user edit — stranded forever, and uploaded as one. Coverage is verified
   across all history.

`profiles/sofia/SOUL.md` in this repository is a copy of the Hermes profile, so
the richest persona is not one VPS disk away from being lost. Hermes still reads
its own copy; the two are edited together.

---

## 2. What works today, verified

`bash scripts/verify-release.sh` → PASS, with these gates:

| Lane | Proven by |
|---|---|
| She hears and answers with audio | `voice-gate` 13/13 |
| Voice drives tools (avatar, page) | `voice-hands-gate` (hand-run, real Live session) |
| Typed turns drive the stage | `text-panel-gate` 17/17, including an untouched window alive after 200 s |
| Real browser, real clicks, visible redraw | `browser-gate` 10/10, `frame-gate` 6/6 |
| One contract for both lanes | `hands-gate` 26/26 in-container |
| Several windows, named targeting | `hands-gate` (two pages, different answers) |
| Charts | `hands-gate` (image from quickchart, refusals) |
| No credential in the image | `secrets-gate` 2/2 |
| Login survives a suspend | persistent profile + `idle-gate` 6/6 |
| CPU when unused | 563.5 % → 0.0 %, suspend/resume with same sid |

---

## 3. What JARVIS needs that is not there

Ranked by what the acceptance sentence needs, and by how much of it is missing.

### Tier 1 — without these, "JARVIS" is not true

**1. She cannot see the page.** Every `browse` verb returns text or a
coordinates-only screenshot. When a page changes in a way the DOM text does not
describe — a CAPTCHA, a chart, a modal that says "are you sure", a login that
failed with a red banner — she has no way to know. This is the single biggest
gap: it is why "she clicked the wrong thing" is invisible to her.
*Needs:* `browse(action: 'look')` → the frame as an image the model can receive,
and a Live session that accepts `realtimeInput` video frames (the socket already
carries `inlineData`, so the plumbing exists).

**2. Memory is per-browser, not per-person.** `memory` lives in IndexedDB in the
stage (`stores/memory.ts`), so it is one browser profile's memory: a new device,
a cleared cache or a different browser has none of it. Voice never reads it at
all — `ask_hermes` is her only door to anything remembered, and that is a
separate store (`profiles/sofia/`, Honcho).
*Needs:* one memory that both lanes read, server-side, keyed by person. Honcho is
already running on the box.

**3. Forms beyond text boxes.** `fill` + `press` handles inputs. There is no
`<select>`, no checkbox, no radio, no date picker, no iframe, no shadow DOM. Any
"book me a ticket" stops here.
*Needs:* `select`, `check`, `choose` (radio), `date`, and iframe/frame
traversal in the service, with one gate per control on a real site.

**4. She does not know what is on her own stage.** `[stage: …]` lists open pages
now, but not which one is focused, what the user is looking at, or what she said
last turn. A JARVIS knows the room.
*Needs:* the stage reports focus and the last interaction, and the gateway folds
it into `[stage: …]`.

### Tier 2 — the behaviours that make it feel like JARVIS

**5. She cannot act while she talks.** Every tool call is awaited inside the
turn, so a 20 s page load is 20 s of silence. JARVIS narrates while working
("pulling that up…") and the answer arrives when it is ready.
*Needs:* a progress channel — the tool emits "started/done" and she speaks
between them; `live.mjs` already emits `tool` events, they are just not spoken.

**6. No plan, no retry.** She has `read` and `links` but no notion of a
multi-step task: if the third result is not the right one she has no way to go
back and try the fourth.
*Needs:* a bounded plan loop in the gateway — act, look, verify, retry once —
with the screenshot from (1) as the verification.

**7. Waking her.** Still the backlog's Tier 1: the detector ships in the fork
(`@sherpaw/kws`, `wake-word-detection.ts`), only the join to
`SofiaVoiceDock.start()` is missing. The Live socket stays closed until "Hey
Sofia". This is what makes her *present* rather than a thing you open.

**8. She does not move herself around the work.** `control_avatar` sets a scale
and an offset; it does not know where the windows are. JARVIS steps out of the
way of what he is showing you.
*Needs:* the window layer tells the avatar where it is, and she picks a side.

### Tier 3 — the polish that reads as competence

**9. Proactive awareness.** The clock fires three slots (`proactive.mjs`) and she
speaks first — but only about the time of day. Real JARVIS mentions that the
disk is filling or that a deploy failed.
*Needs:* a small watcher feeding `proactive` with facts worth interrupting for.

**10. Documents and uploads.** She can show a picture; she cannot accept a file
from you and act on it.
*Needs:* drag-and-drop onto the stage window, into the Hermes task.

**11. Real-device voice.** Every measurement uses a fake microphone. Latency,
barge-in and lip-sync on a real phone are Sithum's ear.

---

## 4. The order, with a gate per step

Each line is one commit: one feature, one gate, `verify-release.sh` green, then
push and deploy (Coolify does not auto-deploy).

| # | Commit | The gate that must exist |
|---|---|---|
| **A** | `feat(memory): one memory both lanes read` — server-side, keyed by person, Honcho or the existing store behind an API | a fact told by voice is recalled by a typed turn, and after a reload |
| **B** | `feat(browse): she can see the page` — `look` returns the frame, Live accepts it | a page whose only signal is visual (a modal) is described correctly |
| **C** | `feat(forms): select, checkbox, radio, date, iframe` | one gate per control on github.com/login and a real booking flow |
| **D** | `feat(voice): she narrates while she works` — progress channel | a slow tool produces speech before its result |
| **E** | `feat(agent): act, look, verify, retry once` | "open the third result and read the price" on a real search page |
| **F** | `feat(wake): "Hey Sofia" opens the socket` — the existing detector, joined | closed on background speech, open within 1 s of the word |
| **G** | `feat(stage): she steps aside of the window` | the avatar and a window never overlap at 390/768/1024/1440 |
| **H** | `fix(persona): one text defines her` — `SOUL.md` becomes the card, `base.yaml` becomes Sofia's | text and voice answer "who are you" in the same register |

A and B are first because every later feature is blind without them: forms
without sight is typing into the dark, and a plan without sight cannot verify
its own steps.

---

## 5. Edge cases the current design will hit

These are not hypothetical; each is a way the product will fail in real use.

1. **A login the user performs by hand, mid-task.** He types the password; she
   must notice the page changed without stealing the keyboard. The persistent
   profile keeps the session, but nothing yet pauses her while he types.
2. **Two windows with the same title** ("Sign in" on two sites). Title
   fragments are ambiguous; the `[stage: …]` list needs the url too, which it has.
3. **A page that needs a real click on a canvas** (maps, image editors).
   Coordinate clicks exist (`action: 'click'` with x/y) but nothing tells her
   where to click.
4. **A consent banner** that covers what she was asked to read. There is no
   "dismiss the thing in the way" verb.
5. **A download** she triggers. It lands in the browser's profile directory and
   nothing reports it.
6. **A page that never settles.** `networkidle` is capped at 12 s; a page with a
   websocket looks exactly like a broken one.
7. **Her own voice coming back into the microphone.** Only the fake device is
   tested; a real phone with a speaker will feed her reply into her ear.
8. **The Live socket's 10-minute cap.** Handled by resumption, but the persona
   is only sent on the first message — a reconnection must not lose her card.
9. **The browser container is unmanaged.** A Coolify deploy deleted it once
   already; nothing recreates it. `scripts/host-services.sh` is still owed.
10. **Two gates at once.** The Live slot is one per key, and every voice gate
    contends for it. Any new voice gate must be `auto:false`.

---

## 6. Housekeeping owed

- `scripts/host-services.sh`: recreate `sofia-browser` (and `sofia-qa`,
  `sofia-build`) idempotently, called by `verify-release.sh` before step 3.
- Origin lockdown: `169.58.126.200:443` answers with the right `Host` and
  bypasses Cloudflare. The `ufw` route in `NEXT.md` §Q would take down the other
  14 vhosts on the same Caddy; the correct fix is a Caddy `remote_ip` allowlist
  on the `sofia.ctum.org` block with a `127.0.0.1` exception. Needs `sudo`.
- `GEMINI_API_KEY` is still the value that was baked into every image layer
  before the fix. It needs one new value from Sithum; everything else about the
  rotation is done and gated.
