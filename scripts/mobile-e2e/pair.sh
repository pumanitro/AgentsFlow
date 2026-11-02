#!/bin/bash
# Pairs a client with the isolated gateway.
#   pair.sh --curl-only   pair over HTTP, save the token to $PF_TMP/e2e-token, check /peers and /me
#   pair.sh               pair the emulator through the peersflow://pair deep link
set -euo pipefail
source /Users/iij/Desktop/AgentsFlow/scripts/mobile-e2e/env.sh
UI="python3 $PF_E2E/ui.py"

offer=$(curl -sf -X POST "$PF_BASE/dev/pair-code")
CODE=$(printf '%s' "$offer" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).code))')
[[ -n "$CODE" ]] || { echo "no pairing code in: $offer" >&2; exit 1; }
echo "code: $CODE"

if [[ "${1:-}" == "--curl-only" ]]; then
  resp=$(curl -sf -X POST -H 'content-type: application/json' -d "{\"code\":\"$CODE\",\"deviceName\":\"e2e\"}" "$PF_BASE/pair")
  TOKEN=$(printf '%s' "$resp" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token||""))')
  [[ -n "$TOKEN" ]] || { echo "pair failed: $resp" >&2; exit 1; }
  # The pair response may carry the speech key: print the token only, never the whole body.
  echo "token: $TOKEN"
  umask 077; printf '%s' "$TOKEN" > "$PF_TMP/e2e-token"
  echo "peers: $(curl -sf -H "authorization: Bearer $TOKEN" "$PF_BASE/peers")"
  me=$(curl -sf -H "authorization: Bearer $TOKEN" "$PF_BASE/me")
  voice=$(printf '%s' "$me" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).voicePeerId)))')
  echo "me.voicePeerId: $voice"
  [[ "$voice" == "peer-lisa-test" ]] || { echo "expected voicePeerId peer-lisa-test" >&2; exit 1; }
  echo "PAIR OK (curl)"
  exit 0
fi

# Runtime permissions up front: a POST_NOTIFICATIONS dialog over Home hides every test tag.
for perm in POST_NOTIFICATIONS RECORD_AUDIO CAMERA; do
  "$ADB" -s "$SERIAL" shell pm grant "$PKG" "android.permission.$perm" 2>/dev/null || true
done
URL_ENC="http%3A%2F%2F10.0.2.2%3A$PF_PORT"
"$ADB" -s "$SERIAL" shell am start -W -a android.intent.action.VIEW \
  -d "\"peersflow://pair?url=$URL_ENC&code=$CODE&fp=\"" "$PKG"
$UI wait pair_submit 20
[[ -n "${PAIR_SHOT_BEFORE:-}" ]] && $UI screenshot "$PAIR_SHOT_BEFORE"
$UI tap pair_submit
$UI wait home_list 30
echo "PAIR OK (deep link)"
