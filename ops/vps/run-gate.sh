#!/bin/bash
set -e
exec docker exec -e BASE=https://sofia.ctum.org -e SOFIA_PASSWORD="$(cat /home/ctum/secrets/sofia-password)" sofia-qa sh -c "cd /qa && node ${1:-brand-assets-gate.mjs}"
