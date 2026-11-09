# Development Workflow — gates and checkpoints

Proportional: a copy change does not need LEVEL 4 ritual; auth, deploy plumbing,
and data integrity do.

## 0. Classify the risk before starting
- LEVEL 1 cosmetic/copy → conventions + a build.
- LEVEL 2 component/feature → official docs + one real-world implementation.
- LEVEL 3 architecture/auth/deploy/infra → comparative research, experiment, rollback.
- LEVEL 4 destructive/production/secret → evidence, risk note, explicit approval.

## 1. Pre-implementation gate
Read the requirement verbatim; read the current `NEXT.md`; read the code and its
callers; check `DECISIONS.md` for a rejected approach; name the unknowns; state
acceptance criteria and how each will be measured.

## 2. During
Re-read the requirement every ~30 minutes of work. If the implementation drifts
from it, say so out loud rather than silently widening scope. When new evidence
contradicts the plan: stop, write the contradiction down, choose again.

## 3. Post-implementation gate
`bash scripts/verify-release.sh` — it is the only thing allowed to say the word
"live". It checks: clean tree, `HEAD == origin/main`, latest deployment
`finished` with the same commit, `/healthz` ok, voice gate, DOM brand check.

State the level reached explicitly: IMPLEMENTED / TESTED / VERIFIED /
PARTIALLY VERIFIED / NOT VERIFIED. They are not synonyms.

## 4. Checkpoints
- after a feature: what shipped, what assumption was wrong, what debt was added.
- after debugging: how many attempts, which were the same approach again, what
  would have detected it earlier.
- after an architecture call: alternatives, evidence, what would invalidate it.
- end of session: write the `AGENT_LEARNING_LOG.md` entry before stopping.

## 5. Escalate on these triggers
- same approach failed twice → change layer (R5)
- evidence contradicts a decision → reconcile in `DECISIONS.md`
- about to claim completion without output → run `verify-release.sh`
- uncertain and the consequence is large → ask, do not guess
