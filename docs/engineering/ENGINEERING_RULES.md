# Sofia — Engineering Rules (this fork)

Derived from the 2026-11-08/09 session. Each rule exists because a specific
incident happened; the incident id is in `INCIDENT_REGISTER.md`. A rule without
an id is a guess and does not belong here.

## R1 — A claim ships with output from the current run
Never write "done", "verified", "fixed", "deployed" without the command output
that proves it in the same run. If it was not measured now, label it
`UNVERIFIED`. (I1, I3, I8, I9, I14)

## R2 — Production is GitHub `HEAD`, and a container is not a deployment
Before claiming a deploy contains a fix: `git rev-parse HEAD` must equal
`origin/main`, and the deployment row must read `finished` with the same commit.
A new container name is not proof; Coolify swaps containers before it finishes
the job. (I8, I9, I20)

## R3 — Read the shipped artifact before patching the source
When behaviour contradicts the source you are reading, read the artifact that
actually runs: the built bundle, the container's `/app`, the compiled
`dist/`. Three caller patches were wasted on a default that lived in the bundle
(`normalizeOptions`). (I10)

## R4 — Test the way the user uses it, not the way that passes
A harness that needs a special flag is a broken harness. The voice gate passed
for hours because it launched Chromium with
`--autoplay-policy=no-user-gesture-required` and a fake audio file while the
real browser was silent. No gate may enable a flag the product does not
control; the failure it hides is the failure that matters. (I11)

## R5 — Two failures of one approach means change the layer, not the arguments
Second failure ⇒ stop, state what the evidence now proves, and act on a
different layer. Patch-a-caller three times was the violation; the fix was in
the transport. (I10, I14)

## R6 — Instrument before guessing at data shape
If a condition "should" be true and is not, print what is actually there.
The empty state failed three times because `${message.content}` on structured
content is truthy; one `page.evaluate` would have said so immediately. (I14)

## R7 — Edits must land where the file is owned
Most files in this checkout are owned by `root` because builds run as root in
the `sofia-build` container. A `ctum`-level edit fails with `PermissionError`.
Edit through `docker exec -i sofia-build python3 - /app`, then prove the change
landed with a grep. (I15)

## R8 — Platform behaviour is configuration, not intuition
Verified the hard way: Coolify replaces the image `HEALTHCHECK` with its own
probe (port 3000 by default), builds only from GitHub, and stores env values
through an `encrypted` Eloquent cast — a query-builder write bypasses it and
poisons every later deploy with `DecryptException`. (I6, I9)

## R9 — Never kill by pattern
`pkill -f <script>` matched the invoking SSH command line and ended the session.
Kill by listening port: `ss -ltnp | grep :PORT`, then `kill <pid>`. (I16)

## R10 — Capacity is a build dependency
A 90%-full disk with 130 GB of build cache fails deploys in seconds with no
useful log. Check `df` and `docker system df` before believing a build failure
is about code. (I17)

## R11 — The queue must say what is true, even when it is inconvenient
Retired cards were marked `done` with a summary that says "retired, not
implemented by this card". Never let a board imply work that did not happen.
(I18)

## R12 — Gates must be idempotent or serialised
Two voice-gate runs inside a minute fail (Live session slot contention) while
one passes. Run once, wait ~60 s, or the gate lies in the other direction.
(I12, I13)

## R13 — No secrets in argv, logs, or chat
Tokens go through a `0600` file or a pipe, never a command line; never print a
key or password, not even to prove it changed. (standing rule)

## R14 — Do not expand scope while reporting
Finishing an audit is not permission to redesign. Name the next item and stop.
(standing rule; violated once on 2026-11-09 by touching a machine that was not
in scope)

## R15 — A build's exit code is the gate, its output is not
`cmd | grep "✓ built"` matches whatever you tell it to match. Twice now a grep
match has been read as a passing build while `vite build` had exited 1. Run the
build into a log, check `$?`, and only then commit. (I21)
