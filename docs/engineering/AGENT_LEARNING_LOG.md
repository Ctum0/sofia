# Agent learning log

One entry per session in which something was learned. Newest first. Each entry
names the failure, the cause, the change made to the process, and how the change
was verified — if the last one is missing, the entry is not finished.

## 2026-11-08 → 09 — the session that produced the rules

**What was built.** A live, password-gated assistant at sofia.ctum.org: a fork of
the upstream stage with a same-origin gateway, server-side Gemini Live audio,
Hermes as the tool-calling brain, a dark burgundy palette, and 602 localised
strings. 56 commits, 91 deployments.

**What went wrong, in one sentence each.**
1. Reported "verified" from a clean browser while the owner's PWA still showed the
   onboarding wizard — the harness was cleaner than reality.
2. Reported the rebrand done while the UI still said the old name, because the
   strings ship compiled from `dist`, not `src`.
3. Spent four deployments verifying fixes that had never been pushed.
4. Spent three deployments on an empty state that could never render, because the
   content field is structured and my emptiness test was a template literal.
5. Passed a voice gate for hours that used a flag disabling the very policy that
   was breaking the product.
6. Killed my own SSH session with `pkill -f`.
7. Wrote plaintext into an encrypted config column and broke three deployments
   in 13 seconds.

**Why.** Not one of these was a hard problem. All seven were the same habit:
acting on the model's picture of the system instead of on the system. Six of them
were reported to the owner as success before being measured.

**What changed.**
- `scripts/verify-release.sh` — one command that must print `PASS <sha>`; exit
  codes 2/3/4/5/6 name the rule breached. Claiming "live" without it is now a
  process violation, not an oversight.
- `docs/engineering/ENGINEERING_RULES.md` — 14 rules, each mapped to an incident.
- `AGENTS.md` points at the whole directory before any deploy, rebrand or voice
  change, and the Hermes skill `sofia-engineering-governance` carries the
  platform facts into every session.
- The pre-implementation gate now requires restating the requirement and naming
  how it will be measured, before the first edit.

**How it was verified.** The verifier was tested against a clone carrying one
unpushed commit: `FAIL [2] HEAD is not what Coolify builds`, exit 2. It was then
run against production and passed on the commit that was actually deployed.

**Still open.** Real-device voice cannot be verified from here; the amber glyph is
baked into an asset; the cron lane can commit while a human lane works and pausing
it is manual.
