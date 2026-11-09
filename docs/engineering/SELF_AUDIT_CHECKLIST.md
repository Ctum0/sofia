# Self-audit checklist

## Before saying anything is done
- [ ] `bash scripts/verify-release.sh` exits 0 in this run
- [ ] the deployment row says `finished <sha>` and `<sha>` == `git rev-parse HEAD`
- [ ] `git rev-parse HEAD` == `git rev-parse origin/main`
- [ ] the evidence line is quoted, not paraphrased
- [ ] the level is stated: IMPLEMENTED / TESTED / VERIFIED / PARTIALLY / NOT

## After any failure
- [ ] how many attempts, and were two of them the same approach? (R5)
- [ ] what did the evidence prove that the previous theory did not?
- [ ] is the fix at the layer where the cause lives? (R3)
- [ ] does a gate now fail if this regresses?

## Before touching a shared resource
- [ ] is it root-owned? edit via `sofia-build` (R7)
- [ ] is a cron/agent lane writing to the same tree? pause it
- [ ] is disk healthy? (`df -h /`, `docker system df`) (R10)
- [ ] secrets go through a file or pipe, never argv (R13)

## Communication
- [ ] did I repeat the user's requirement back in one line before starting?
- [ ] did I name what I am NOT doing?
- [ ] did I avoid expanding scope to look productive? (R14)
