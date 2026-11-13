# Sofia is paused — how to bring it back

Shut down 2026-11-13. Everything is in git (`Ctum0/sofia`, branch `main`,
`5510bd39d`); the VPS holds no running Sofia container and no Sofia image.

## What is still on the VPS

| Thing | Where | Why it was kept |
|---|---|---|
| Data volume | `zp31tstwfvpppxp5woswltmv-sofia-data` (Docker volume) | Her database, Honcho token, audio cache, proactive state. Removing it loses every conversation. |
| Profile bind | `/home/ctum/sofia-browser-profile` | Browser logins from the headless service. Empty of cookies today, cheap to keep. |
| Backups | `/home/ctum/backups/sofia/` | Dated snapshots, including `sofia-data-20261113-121057.tar.gz` (1.5 MB) taken immediately before shutdown. A second copy is on the laptop at `~/sofia-backups/`. |
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

Without either, `browse` fails with "no browser agent is connected" — which is an honest error, not a hang.

## What is unfinished

The JARVIS dashboard was planned and not started: it is a large frontend build
and was deliberately left for its own session. `docs/JARVIS.md` records the design
direction and which panels would have real data versus a visible `MOCK` badge.

The stage is still the AIRI-derived Live2D interface, restyled burgundy. Replacing
it with the dashboard would remove the avatar-as-page model entirely — she would
live in a panel of the dashboard instead.
