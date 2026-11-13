#!/usr/bin/env bash
# Rotate the Sofia profile's api_server key.
#
# WHY THIS IS A SCRIPT AND NOT SOMETHING I JUST RAN:
# the Hermes gateway that holds this key is the same process that hosts the
# conversation, so changing the key only takes effect on a gateway restart —
# and that restart ends the session. Run this when a restart is acceptable.
#
# 2026-11-10 fix (measured on a scratch copy of the live config):
#   * step 3 now calls `sed` directly with the key expanded host-side instead of
#     wrapping it in `sh -c` with three levels of quoting;
#   * step 4 now *asserts* the rotation (new key present twice, old key absent,
#     only the two key lines changed) instead of printing a count and hoping;
#   * step 5c's copy-paste command was broken — it read
#     `Bearer *** /home/ctum/secrets/hermes-sofia.key)`, a mangled `$(cat …)`,
#     so the verification curl always returned 401 and looked like a failed
#     rotation. Fixed and re-probed against the live gateway.
set -uo pipefail

CFG="${CFG:-/opt/data/profiles/sofia/config.yaml}"   # override-able so the flow can be rehearsed on a copy
STAMP=$(date +%Y%m%dT%H%M%S)
NEW=$(openssl rand -hex 32)

echo "== 1. backup"
docker exec hermes cp "$CFG" "${CFG}.bak-${STAMP}" \
  && echo "   backup: config.yaml.bak-$STAMP" || { echo "   FAILED backup"; exit 2; }

echo "== 2. current key occurrences (count only, never the value)"
COUNT=$(docker exec hermes grep -cE '^[[:space:]]*key:[[:space:]]*[0-9a-f]{64}' "$CFG" 2>/dev/null || true)
echo "   $COUNT line(s) matching a 64-hex key under key:"
if [ "$COUNT" -lt 1 ] || [ "$COUNT" -gt 2 ]; then
    echo "   UNEXPECTED SHAPE — expected 1 or 2. Nothing changed. Inspect $CFG by hand."
    exit 3
fi

echo "== 3. rewrite (direct sed, key expanded host-side)"
docker exec hermes sed -i -E "s/^([[:space:]]*key:[[:space:]]*)[0-9a-f]{64}\$/\1${NEW}/" "$CFG" \
  || { echo "   FAILED rewrite"; exit 4; }

echo "== 4. verify — the rotation must be provable, not assumed"
NEWHITS=$(docker exec hermes grep -cF "$NEW" "$CFG" 2>/dev/null || true)
echo "   new key present on $NEWHITS line(s) (expected $COUNT)"
if [ "$NEWHITS" != "$COUNT" ]; then
    echo "   MISMATCH — restore with: docker exec hermes cp ${CFG}.bak-${STAMP} $CFG"
    exit 5
fi
CHANGED=$(docker exec hermes diff "${CFG}.bak-${STAMP}" "$CFG" 2>/dev/null | grep -c '^>' || true)
echo "   changed lines: $CHANGED (expected $COUNT; anything else means the file moved)"
[ "$CHANGED" = "$COUNT" ] || echo "   WARNING: changed line count != key count — read the diff before restarting."

echo
echo "== NEW KEY (shown once — copy it now):"
echo "   $NEW"
echo
echo "== 5. do this next, in the right order:"
echo "   a) put the key in the gateway secret file:"
echo "        printf '%s' '$NEW' > /home/ctum/secrets/hermes-sofia.key && chmod 600 /home/ctum/secrets/hermes-sofia.key"
echo "   b) restart the gateway (this ends any live Hermes session):"
echo "        docker restart hermes"
echo "   c) prove it:"
echo '        curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8643/p/sofia/v1/models -H "Authorization: Bearer $(cat /home/ctum/secrets/hermes-sofia.key)"'
echo "      expect 200. A 401/403 means the running process still holds the old key."
echo "   d) the same key on the WRONG path must still be refused:"
echo '        curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8643/v1/models -H "Authorization: Bearer $(cat /home/ctum/secrets/hermes-sofia.key)"'
echo "      expect 401 — that is the profile-isolation proof, not an error."
