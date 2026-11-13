# Sofia is paused — how to bring it back

Shut down 2026-11-13. Everything is in git (`Ctum0/sofia`, branch `main`,
`5510bd39d`); the VPS holds no running Sofia container and no Sofia image.

## What is still on the VPS

| Thing | Where | Why it was kept |
|---|---|---|
| Data volume | `zp31tstwfvpppxp5woswltmv-sofia-data` (Docker volume) | Her database, Honcho token, audio cache, proactive state. Removing it loses every conversation. |
| Profile bind | `/home/ctum/sofia-browser-profile` | Browser logins from the headless service. Empty of cookies today, cheap to keep. |
| Backups | `/home/ctum/backups/sofia/` | Dated snapshots, including `sofia-data-20261113-121057.tar.gz` (1.5 MB) taken immediately before shutdown, verified to contain `sofia.db`, its 3.9 MB WAL, the Honcho token and `proactive.json`. A second copy is on the **workstation** at `/home/ctum/sofia-backups/`, not on the Parrot. |
| Ops scripts | `/home/ctum/scripts/` and `ops/vps/` in this repo | `coolify-deploy.sh` is the deploy path. |
| Repo clone | `/home/ctum/projects/sofia` | `coolify-deploy.sh` hardcodes this path. Its `node_modules` (4.4 GB) could not be deleted: root-owned files from a container run, and no passwordless sudo. `rm -rf` as `ctum` fails with EPERM. |

## What was removed

- Containers: `zp31…-20261113T110349` and `sofia-browser`.
- Images: every `zp31tstwfvpppxp5woswltmv:*` tag, 787 MB each.
- Build cache: 15.66 GB.
- Dangling images: 3.2 GB.

Disk went from 130 G to 112 G used of 290 G.

## Bringing it back

```bash
ssh ctum@myvps
cd /home/ctum/projects/sofia && git fetch && git reset --hard origin/main
bash /home/ctum/scripts/coolify-deploy.sh
```

Then, if you want her to have a browser again, either:

- **the local agent** (the direction this was heading): `node apps/sofia-agent/sofia-agent.mjs --gateway wss://sofia.ctum.org/api/agent --token <SOFIA_AGENT_TOKEN> --executable /usr/bin/chromium` on the Parrot, or
- **the host service**: `bash scripts/host-services.sh --recreate`, which recreates `sofia-browser`.

Without either, `browse` falls through to `fetch($BROWSER_URL)` and fails as a
connection error, because the transport is only installed by a connected agent —
there is no friendly "no agent" message on that path.

## What is unfinished

The JARVIS dashboard was planned and not started: it is a large frontend build
and was deliberately left for its own session. `docs/JARVIS.md` records the design
direction and which panels would have real data versus a visible `MOCK` badge.

The stage is still the AIRI-derived Live2D interface, restyled burgundy. Replacing
it with the dashboard would remove the avatar-as-page model entirely — she would
live in a panel of the dashboard instead.

## What is verified, and what is not

Stated plainly, because the containers are stopped and a full release run is no
longer possible until they come back.

**Verified on the final tree (`5510bd39d`, deployed):**

- `guards.mjs` 17/17, including the new G17 that ties `DEFAULT_PERSONA` to
  `en/base.yaml` and G14 that keeps every shipped persona in the retired set.
- `windows-gate.mjs` 20/20 and `windows-responsive-gate.mjs` 25/25, run against
  the deployed build at 1440, 1280, 1024, 768 and 390. The narrow viewports still
  go low and wide, which is the case a naive 28% share broke.
- `apps/sofia-agent/test/guardrails.test.mjs` 17/17 and
  `apps/sofia-agent/test/browser.test.mjs` 8/8 against a real Chromium.
- `apps/sofia-gateway/test/agent-bridge.test.mjs` 5/5 and
  `agent-transport.test.mjs` 3/3.
- Hermes: the patched `VERIFY` block prints `VERIFY_OK` when run by hand.

**NOT verified — these never ran against the final commits:**

- `text-panel-gate`, `browser-gate`, `frame-gate`, `secrets-gate`, `tools-gate`,
  `hands-gate`, `voice-gate`. The last full `verify-release.sh` PASS is
  `e1a0c119e`, four commits back. The change in between that matters most is the
  lockfile and the Dockerfile's `--frozen-lockfile`: it is the change that broke
  the build once, and no full run has covered it.
- The **tile split** has no gate. `windows-gate` contains no `tile` reference, so
  the two-column arrangement is unasserted.
- The **transport path** is wired but its round trip is only partly covered: the
  tests prove pairing, installation and fallback, not `runBrowse` reaching a real
  page through the agent.
- The **frame path** is not wired for an agent-backed page at all: the agent
  returns `jpeg`, `/api/browse/frame` still proxies to the host service, so a
  window backed by the laptop would render empty. This is the next thing to build.

**Not done:** the JARVIS dashboard (never started), the laptop's `node_modules`
removal (root-owned, no sudo), and the GitHub repo's own description/homepage,
which live in repository settings rather than in any file.
