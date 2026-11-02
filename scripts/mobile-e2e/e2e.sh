#!/bin/bash
# Done-means item 5: the full phone <-> isolated Peers Flow round trip on the E2E emulator.
# Prerequisites: build-desktop.sh, seed-store.js --reset, launch-isolated.js, avd.sh start,
# the real APK installed (adb install -r $APK). Stops at the first failing step and leaves
# everything running for inspection. Usage: e2e.sh [first-step-letter]   (e.g. `e2e.sh c`)
set -euo pipefail
source /Users/iij/Desktop/AgentsFlow/scripts/mobile-e2e/env.sh
UI="python3 $PF_E2E/ui.py"
TS="$PF_E2E/transcript.sh"
A=("$ADB" -s "$SERIAL")
STATE="$PF_TMP/e2e-state.sh"          # carries VOICE_ID / timings across partial reruns
mkdir -p "$EVIDENCE"
[[ -f "$STATE" ]] && source "$STATE"

now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
save() { echo "$1=\"$2\"" >> "$STATE"; eval "$1=\"$2\""; }
shot() { $UI screenshot "$EVIDENCE/$1" >/dev/null; echo "  shot $1"; }
die() { echo "  FAIL: $*" >&2; return 1; }
# poll <seconds> <command...>: retry every 2 s until the command succeeds.
poll() {
  local secs=$1; shift
  local deadline=$(( $(date +%s) + secs ))
  until "$@" >/dev/null 2>&1; do
    (( $(date +%s) >= deadline )) && return 1
    sleep 2
  done
}
store_q() { # node expression over `s` (the isolated store.json); prints the result
  node -e "const s=JSON.parse(require('fs').readFileSync('$PF_USERDATA/store.json','utf8'));const r=($1);if(r===undefined||r===null||r===false)process.exit(1);console.log(r)"
}
voice_conv() { store_q "(s.conversations||[]).filter(c=>c.chatKind==='voice'&&String(c.title||'').includes('Hello from the phone')).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))).map(c=>c.id).pop()"; }
voice_field() { store_q "((s.conversations||[]).find(c=>c.id==='$VOICE_ID')||{})['$1']"; }
voice_transcript() { echo "$TRANSCRIPTS/$(voice_field sessionId).jsonl"; }
chat_rows_ge2() { (( $($UI count chat_msg_) >= 2 )); }
voice_done() { [[ "$(voice_field state)" == "done" ]]; }
has_assistant() { [[ -f "$(voice_transcript)" ]] && $TS show "$(voice_transcript)" | grep -q '^assistant.text'; }
reply_keys() { node -e "try{const j=JSON.parse(require('fs').readFileSync('$PF_USERDATA/mobile-idempotency.json','utf8'));console.log(j.entries.filter(e=>e[0].startsWith('reply:')).length)}catch{console.log(0)}"; }
reply_keys_gt() { (( $(reply_keys) > $1 )); }
count_is() { [[ "$($TS count-user "$1")" == "$2" ]]; }
# Back until Home is showing (the first back usually only closes the soft keyboard).
go_home() {
  local i
  for i in 1 2 3 4; do
    $UI exists home_list >/dev/null 2>&1 && return 0
    # Left the app (launcher in front)? Bring it back instead of pressing back again.
    if ! "${A[@]}" shell dumpsys activity activities | grep -q "topResumedActivity.*$PKG"; then
      "${A[@]}" shell am start -n "$PKG/com.peersflow.mobile.MainActivity" >/dev/null; sleep 2; continue
    fi
    $UI back >/dev/null; sleep 1
  done
  $UI exists home_list >/dev/null 2>&1
}
open_chat() { $UI wait "conv_row_$VOICE_ID" 15 && $UI tap "conv_row_$VOICE_ID" && $UI wait chat_composer 10; }
strip_has() { $UI text status_strip | grep -qiE "$1"; }

# ---- optional video (RECORD=1): emulator screenrecord around step groups A (a-b), B (c-d), C (e)
REC_PIDFILE="$PF_TMP/rec.pid"
rec_start() { # rec_start <name>
  [[ "${RECORD:-0}" == "1" ]] || return 0
  "${A[@]}" shell rm -f "/sdcard/rec-$1.mp4" >/dev/null 2>&1 || true
  ( "${A[@]}" shell screenrecord --size 720x1600 --bit-rate 6000000 --time-limit 170 "/sdcard/rec-$1.mp4" >/dev/null 2>&1 & echo $! > "$REC_PIDFILE" )
  sleep 3   # 2 s idle at the start (+1 s for the recorder to come up)
}
rec_stop() { # rec_stop <name> <evidence-file>
  [[ "${RECORD:-0}" == "1" ]] || return 0
  sleep 2   # 2 s idle at the end
  local p; p=$("${A[@]}" shell pidof screenrecord 2>/dev/null | tr -d '\r' || true)
  [[ -n "$p" ]] && "${A[@]}" shell kill -2 $p >/dev/null 2>&1 || true
  local i; for i in 1 2 3 4 5 6 7 8 9 10; do [[ -z "$("${A[@]}" shell pidof screenrecord 2>/dev/null | tr -d '\r')" ]] && break; sleep 1; done
  [[ -f "$REC_PIDFILE" ]] && { wait "$(cat "$REC_PIDFILE")" 2>/dev/null || true; }
  sleep 1
  "${A[@]}" pull "/sdcard/rec-$1.mp4" "$EVIDENCE/$2" >/dev/null && echo "  video $2 ($(stat -f %z "$EVIDENCE/$2") bytes)"
  "${A[@]}" shell rm -f "/sdcard/rec-$1.mp4" >/dev/null 2>&1 || true
  shrink_video "$EVIDENCE/$2"
}
shrink_video() { # keep each mp4 <= 6 MB
  local f=$1 tmp="$PF_TMP/shrink.mp4"
  [[ -f "$f" ]] || return 0
  (( $(stat -f %z "$f") <= 6000000 )) && return 0
  ffmpeg -y -loglevel error -i "$f" -c:v libx264 -crf 30 -preset slow -pix_fmt yuv420p -movflags +faststart -an "$tmp" && mv "$tmp" "$f"
  echo "  re-encoded $(basename "$f") to $(stat -f %z "$f") bytes"
}

prereqs() {
  [[ -f "$PF_PIDFILE" ]] && kill -0 "$(cat "$PF_PIDFILE")" || die "isolated instance not running (launch-isolated.js)"
  curl -sf "$PF_SIDE_BASE/info" >/dev/null || die "side channel down"
  "$PF_E2E/avd.sh" status >/dev/null || die "emulator $SERIAL not running (avd.sh start)"
  "${A[@]}" shell pm path "$PKG" >/dev/null || die "$PKG not installed (adb install -r \$APK)"
}

step_a_pair() {
  local t0
  # Fresh app state every run: an outbox left from an earlier run (against a store that
  # seed-store.js --reset has since wiped) would otherwise surface in later steps.
  "${A[@]}" shell pm clear "$PKG" >/dev/null
  t0=$(now_ms)
  PAIR_SHOT_BEFORE="$EVIDENCE/01-pairing.png" "$PF_E2E/pair.sh"
  save T_PAIR_TO_HOME $(( $(now_ms) - t0 ))
  shot 02-home.png
}

step_b_online() {
  poll 30 strip_has "online" || die "status_strip never said online: $($UI text status_strip 2>&1)"
  shot 03-home-online.png
}

step_c_spawn() {
  local t0
  "${A[@]}" shell am start -n "$PKG/com.peersflow.mobile.services.HiLisaActivity" \
    --es typed "\"Hello from the phone e2e\"" --es source e2e >/dev/null
  $UI wait hilisa_send 10
  shot 04-hilisa.png
  t0=$(now_ms)
  $UI tap hilisa_send
  poll 30 voice_conv || die "no voice conversation in the isolated store after 30 s"
  save VOICE_ID "$(voice_conv)"
  echo "  voice conversation $VOICE_ID"
  if ! $UI wait "conv_row_$VOICE_ID" 10 >/dev/null 2>&1; then
    "${A[@]}" shell am start -n "$PKG/com.peersflow.mobile.MainActivity" >/dev/null
  fi
  $UI wait "conv_row_$VOICE_ID" 30
  $UI tap "conv_row_$VOICE_ID"
  $UI wait chat_messages 10
  poll 120 has_assistant || die "no assistant.text in $(voice_transcript) after 120 s"
  save T_SPAWN_TO_ASSISTANT $(( $(now_ms) - t0 ))
  poll 60 chat_rows_ge2 || die "phone shows < 2 chat_msg_ rows"
  shot 05-chat-stream.png
  "$TS" show "$(voice_transcript)" > "$EVIDENCE/05-voice-transcript.txt" || true
  cp "$PF_USERDATA/store.json" "$EVIDENCE/store-after-spawn.json"   # before any restart can strip chatKind
  [[ "$(voice_field contract)" == "until-done" ]] || die "store row contract is '$(voice_field contract 2>/dev/null || echo none)', expected until-done"
  [[ "$(voice_field chatKind)" == "voice" ]] || die "store row chatKind is '$(voice_field chatKind 2>/dev/null || echo none)', expected voice"
  # The first user message must read as the slash command, never as raw <command-message> XML.
  if $UI has-text "command-message|command-name|command-args" >/dev/null 2>&1; then die "phone chat shows raw <command-message> markup (see 05-chat-stream.png)"; fi
  $UI has-text "/voice-task Hello from the phone" >/dev/null 2>&1 || die "phone chat has no '/voice-task Hello from the phone…' user message (see 05-chat-stream.png)"
}

step_d_reply() {
  local t0 k0
  k0=$(reply_keys)
  $UI type chat_composer "$REPLY_TEXT"
  t0=$(now_ms)
  $UI tap chat_send
  poll 90 count_is "$REPLY_TEXT" 1 || die "reply not in transcript exactly once (count $($TS count-user "$REPLY_TEXT"))"
  save T_REPLY_TO_TRANSCRIPT $(( $(now_ms) - t0 ))
  # The HTTP call must finish (idempotency entry written) before anything else happens, and
  # the phone must not resend it: a phone-side timeout shorter than the gateway's send+verify
  # puts an already-delivered reply into the outbox, and its retry is delivered a second time.
  poll 60 reply_keys_gt "$k0" || die "the gateway never completed the reply request (no reply: idempotency entry)"
  save T_REPLY_HTTP_DONE $(( $(now_ms) - t0 ))
  sleep 20
  count_is "$REPLY_TEXT" 1 || die "reply delivered $($TS count-user "$REPLY_TEXT") times (expected 1)"
  go_home || die "could not get back to Home"
  if $UI exists outbox_card >/dev/null 2>&1; then $UI screenshot "$EVIDENCE/06b-reply-stuck-in-outbox.png" >/dev/null; "${A[@]}" shell am start -n "$PKG/com.peersflow.mobile.MainActivity" >/dev/null; die "reply sits in the outbox although it was delivered"; fi
  open_chat || die "could not reopen the chat"
  shot 06-reply.png
}

step_e_outbox() {
  local t0
  "$PF_E2E/stop-isolated.sh" >/dev/null
  # Home has status_strip; the chat screen shows an untagged "Mac off — messages will be queued" banner.
  poll 150 $UI has-text "mac off|not running|\\boff\\b" || die "the phone never showed the Mac as off"
  $UI type chat_composer "$QUEUED_TEXT"
  $UI tap chat_send
  sleep 1
  go_home || die "could not get back to Home"
  $UI wait outbox_card 10
  shot 07-outbox.png
  t0=$(now_ms)
  node "$PF_E2E/launch-isolated.js" >/dev/null
  # The phone backs off up to 120 s while the Mac is off; bringing the app to front kicks it.
  "${A[@]}" shell am start -n "$PKG/com.peersflow.mobile.MainActivity" >/dev/null
  poll 240 count_is "$QUEUED_TEXT" 1 || die "queued message not delivered once (count $($TS count-user "$QUEUED_TEXT"))"
  save T_OUTBOX_RELAUNCH_TO_DELIVERY $(( $(now_ms) - t0 ))
  sleep 20
  count_is "$QUEUED_TEXT" 1 || die "queued message delivered more than once ($($TS count-user "$QUEUED_TEXT"))"
  if $UI exists outbox_card >/dev/null 2>&1; then die "outbox_card still visible after delivery"; fi
  shot 08-outbox-flushed.png
}

step_f_voice() {
  local log="$EVIDENCE/09-voice-smoke.log" rc
  set +e
  (cd "$PF_REPO/android" && ./gw :voice:testDebugUnitTest --tests '*RealOpenAi*' --rerun -i) > "$log" 2>&1
  rc=$?
  set -e
  grep -iE "transcript|bytes" "$log" | tail -n 10 || true
  (( rc == 0 )) || die "voice smoke test exit $rc (see $log)"
  if grep -q 'sk-' "$log"; then die "an API key fragment (sk-) leaked into $log"; fi
  local v
  v=$(grep -oE 'transcript\[live[^]]*\].*finalAfterCommitMs=[0-9]+' "$log" | grep -oE 'finalAfterCommitMs=[0-9]+' | head -1 | cut -d= -f2 || true); [[ -n "$v" ]] && save T_VOICE_LIVE_FINAL "$v"
  v=$(grep -oE 'transcript\[live[^]]*\].*totalMs=[0-9]+' "$log" | grep -oE 'totalMs=[0-9]+' | head -1 | cut -d= -f2 || true); [[ -n "$v" ]] && save T_VOICE_LIVE_TOTAL "$v"
  v=$(grep -oE 'transcript\[file sample-en[^]]*\].*roundTripMs=[0-9]+' "$log" | grep -oE 'roundTripMs=[0-9]+' | head -1 | cut -d= -f2 || true); [[ -n "$v" ]] && save T_VOICE_FILE_RT_EN "$v"
  v=$(grep -oE 'transcript\[file sample-pl[^]]*\].*roundTripMs=[0-9]+' "$log" | grep -oE 'roundTripMs=[0-9]+' | head -1 | cut -d= -f2 || true); [[ -n "$v" ]] && save T_VOICE_FILE_RT_PL "$v"
  v=$(grep -oE 'bytes\[tts\].*firstByteMs=[0-9]+' "$log" | grep -oE 'firstByteMs=[0-9]+' | head -1 | cut -d= -f2 || true); [[ -n "$v" ]] && save T_TTS_FIRST_BYTE "$v"
  v=$(grep -oE 'bytes\[tts\]: [0-9]+' "$log" | grep -oE '[0-9]+$' | head -1 || true); [[ -n "$v" ]] && save TTS_BYTES "$v"
  return 0
}

step_g_outcomes() {
  poll 180 voice_done || die "voice chat not done after 180 s (state $(voice_field state 2>/dev/null))"
  "${A[@]}" shell cmd statusbar collapse >/dev/null 2>&1 || true   # a heads-up notification swallows top-bar taps
  go_home || true
  sleep 3; "${A[@]}" shell cmd statusbar collapse >/dev/null 2>&1 || true
  if ! { $UI tap home_outcomes >/dev/null 2>&1 && $UI wait outcomes_list 10 >/dev/null 2>&1; }; then
    echo "  home_outcomes tap did not open Outcomes; using the route intent"
    "${A[@]}" shell am start -n "$PKG/com.peersflow.mobile.MainActivity" --es route outcomes >/dev/null
  fi
  $UI wait outcomes_list 15
  shot 10-outcomes.png
  local n; n=$("${A[@]}" shell dumpsys notification --noredact | grep -c "$PKG" || true)
  (( n >= 1 )) || die "no notification from $PKG"
}

step_h_desktop() {
  curl -sf -X POST --data "localStorage.setItem('agentsflow:mobile:open','1'); location.reload(); 'ok'" "$PF_SIDE_BASE/js" >/dev/null || true
  sleep 4
  local fd="$PF_TMP/desktop-frames" bp i
  rm -rf /Users/iij/.claude/jobs/106e55f3/tmp/desktop-frames && mkdir -p "$fd"
  curl -sf -X POST --data "document.querySelector('[data-testid=mobile-pair]')?.scrollIntoView({block:'center'}); 'ok'" "$PF_SIDE_BASE/js" >/dev/null || true
  ( i=0; while [[ ! -f "$fd/stop" ]]; do curl -sf "$PF_SIDE_BASE/shot" -o "$fd/f$(printf %04d $i).png" && i=$((i+1)); sleep 0.25; done ) & bp=$!
  sleep 2.5
  curl -sf -X POST --data "document.querySelector('[data-testid=mobile-pair]')?.click(); 'ok'" "$PF_SIDE_BASE/js" >/dev/null
  sleep 2
  curl -sf -X POST --data "document.querySelector('[data-testid=mobile-pairing]')?.scrollIntoView({block:'center', behavior:'smooth'}); 'ok'" "$PF_SIDE_BASE/js" >/dev/null || true
  sleep 4
  touch "$fd/stop"; wait $bp 2>/dev/null || true
  local nf; nf=$(ls "$fd"/f*.png 2>/dev/null | wc -l | tr -d ' ')
  echo "  desktop frames: $nf"
  ffmpeg -y -loglevel error -framerate 3 -i "$fd/f%04d.png" -vf "scale=1600:-2,format=yuv420p" -movflags +faststart "$EVIDENCE/video-D-desktop-pair.mp4" \
    && echo "  video video-D-desktop-pair.mp4 ($(stat -f %z "$EVIDENCE/video-D-desktop-pair.mp4") bytes, $nf frames)"
  shrink_video "$EVIDENCE/video-D-desktop-pair.mp4"
  # The pairing card (QR) replaces the button below the fold of the Mobile panel: scroll to it.
  curl -sf -X POST --data "(() => { const el = document.querySelector('[data-testid=mobile-pairing]'); if (!el) return 'missing'; el.scrollIntoView({ block: 'center' }); return el.querySelector('img[alt=\"Pairing QR code\"]') ? 'qr' : 'no-qr'; })()" "$PF_SIDE_BASE/js" | grep -q '"qr"' || die "no pairing QR in the desktop Mobile panel"
  sleep 1
  curl -sf "$PF_SIDE_BASE/shot" -o "$EVIDENCE/11-desktop-mobile-panel.png"
  (( $(stat -f %z "$EVIDENCE/11-desktop-mobile-panel.png") > 50000 )) || die "desktop shot too small"
  echo "  shot 11-desktop-mobile-panel.png"
}


token() { cat "$PF_TMP/e2e-token"; }
# http_code <method> <path> [token] [body]
http_code() { curl -s -o /dev/null -w '%{http_code}' -X "$1" ${3:+-H "authorization: Bearer $3"} -H 'content-type: application/json' ${4:+-d "$4"} "$PF_BASE$2"; }

# (iii) replayed clientId: the first call gives up after 2 s, the retry must be answered as a duplicate.
step_i_replay() {
  local text="replay probe 5150 $RUN_TAG" body out t0
  body="{\"text\":\"$text\",\"source\":\"phone\",\"clientId\":\"replay-$RUN_TAG\"}"
  curl -s -m 2 -X POST -H "authorization: Bearer $(token)" -H 'content-type: application/json' -d "$body" "$PF_BASE/conversations/$VOICE_ID/reply" > /dev/null || true
  t0=$(now_ms)
  out=$(curl -s -m 60 -X POST -H "authorization: Bearer $(token)" -H 'content-type: application/json' -d "$body" "$PF_BASE/conversations/$VOICE_ID/reply")
  save T_REPLAY_SECOND_CALL $(( $(now_ms) - t0 ))
  echo "  second call: $out"
  printf 'first call: curl -m 2 (gave up)\nsecond call (%s ms): %s\n' "$T_REPLAY_SECOND_CALL" "$out" > "$EVIDENCE/13-replay.txt"
  printf '%s' "$out" | grep -q '"duplicate":true' || die "replayed clientId not answered as duplicate: $out"
  sleep 20
  local n; n=$("$TS" count-user "$text")
  echo "transcript count after 20 s: $n" >> "$EVIDENCE/13-replay.txt"
  "$TS" show "$(voice_transcript)" >> "$EVIDENCE/13-replay.txt" || true
  [[ "$n" == "1" ]] || die "replayed reply is in the transcript $n times (expected 1)"
}

# (iv) voice task on a peer WITHOUT the voice-task skill: the gateway must send an inline brief.
step_j_noskill() {
  local skill="$PF_SCRATCH_PEER/.claude/skills/voice-task" bak="$PF_TMP/voice-task-skill.bak" text="no skill probe $RUN_TAG" out id f t0 first rc=0
  rm -rf /Users/iij/.claude/jobs/106e55f3/tmp/voice-task-skill.bak
  cp -R "$skill" "$bak"
  rm -rf /Users/iij/.claude/jobs/106e55f3/tmp/pf-scratch-peer/.claude/skills/voice-task
  t0=$(now_ms)
  out=$(curl -s -m 60 -X POST -H "authorization: Bearer $(token)" -H 'content-type: application/json' \
    -d "{\"peerId\":\"peer-lisa-test\",\"prompt\":\"$text\",\"kind\":\"voice\",\"clientId\":\"noskill-$RUN_TAG\"}" "$PF_BASE/conversations") || true
  # Restore the stub right after the spawn: the check is about what the gateway sent.
  cp -R "$bak" "$skill"
  echo "  spawn: $out"
  id=$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).conversationId||"")}catch{}})')
  [[ -n "$id" ]] || die "voice spawn without skill failed: $out"
  save NOSKILL_ID "$id"
  local sid_q="((s.conversations||[]).find(c=>c.id==='$id')||{}).sessionId"
  poll 30 store_q "$sid_q" || die "no sessionId for $id"
  f="$TRANSCRIPTS/$(store_q "$sid_q").jsonl"
  poll 120 bash -c "[[ -f '$f' ]] && '$TS' show '$f' | grep -q '^assistant.text'" || die "no assistant reply in $f after 120 s"
  save T_NOSKILL_SPAWN_TO_ASSISTANT $(( $(now_ms) - t0 ))
  "$TS" show "$f" > "$EVIDENCE/14-noskill-transcript.txt"
  first=$(grep -m1 -E '^user\.text	' "$EVIDENCE/14-noskill-transcript.txt" | cut -f3)
  echo "  first user entry: ${first:0:80}"
  [[ "$first" != /voice-task* ]] || die "first user entry starts with /voice-task although the peer has no skill"
  [[ "$(store_q "((s.conversations||[]).find(c=>c.id==='$id')||{}).chatKind")" == "voice" ]] || die "no-skill chat is not chatKind voice"
}

# (ii) safety: unknown bearer 401; revoke all devices from the desktop; phone gets 401 + revoked strip; re-pair.
step_k_revoke() {
  local c t0
  c=$(http_code GET /me "unknown-token-$RUN_TAG"); echo "  unknown bearer /me: $c"
  printf 'unknown bearer GET /me: %s\n' "$c" > "$EVIDENCE/12-revoke.txt"
  [[ "$c" == "401" ]] || die "unknown bearer got $c, expected 401"
  c=$(http_code GET /me "$(token)"); echo "  e2e bearer before revoke: $c"
  [[ "$c" == "200" ]] || die "e2e token not valid before revoke ($c)"
  go_home || true
  t0=$(now_ms)
  curl -sf -X POST --data "window.agentsflow.mobile.revokeAll().then(() => 'revoked')" "$PF_SIDE_BASE/js" | tee -a "$EVIDENCE/12-revoke.txt"; echo
  c=$(http_code GET /me "$(token)"); echo "  e2e bearer after revoke: $c"
  printf 'e2e bearer GET /me after revokeAll: %s\n' "$c" >> "$EVIDENCE/12-revoke.txt"
  [[ "$c" == "401" ]] || die "revoked token got $c, expected 401"
  # The phone learns it on its next request; bringing the app to the front kicks the stream.
  "${A[@]}" shell am start -n "$PKG/com.peersflow.mobile.MainActivity" >/dev/null
  poll 90 strip_has "revoked" || { shot 12-revoked.png; die "status_strip never showed revoked within 90 s: $($UI text status_strip 2>&1)"; }
  save T_REVOKE_TO_PHONE $(( $(now_ms) - t0 ))
  echo "phone status_strip after $T_REVOKE_TO_PHONE ms: $($UI text status_strip)" >> "$EVIDENCE/12-revoke.txt"
  shot 12-revoked.png
  # Leave the app usable: pair the phone again (deep link) and the curl client too.
  "$PF_E2E/pair.sh" >/dev/null
  "$PF_E2E/pair.sh" --curl-only >/dev/null
  poll 30 strip_has "online" || die "phone not online after re-pairing"
  echo "re-paired: phone online, curl token valid ($(http_code GET /me "$(token)"))" >> "$EVIDENCE/12-revoke.txt"
}

# chatKind must survive the run: step e restarts the instance, and every later store write
# rewrites all rows. A voice chat must still be a voice chat in store.json and on the phone API.
step_l_kind_survives() {
  local out="$EVIDENCE/15-chatkind-after-restart.txt" id k g bad=0
  : > "$out"
  for id in ${VOICE_ID:-} ${NOSKILL_ID:-}; do
    k=$(store_q "((s.conversations||[]).find(c=>c.id==='$id')||{}).chatKind" 2>/dev/null || echo missing)
    g=$(curl -s -H "authorization: Bearer $(token)" "$PF_BASE/conversations" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=(JSON.parse(s).summaries||[]).find(c=>c.id==='$id');process.stdout.write(String(r&&r.chatKind))})")
    echo "$id store.chatKind=$k gateway.chatKind=$g" | tee -a "$out"
    [[ "$k" == "voice" && "$g" == "voice" ]] || bad=1
  done
  (( bad == 0 )) || die "a voice chat lost chatKind 'voice' after the restart (see 15-chatkind-after-restart.txt)"
}

res() { local r="STEP_$1_RESULT" m="STEP_$1_MS"; echo "${!r:-not run} (${!m:-?} ms)"; }
write_outputs() {

  cat > "$EVIDENCE/timings.json" <<JSON
{
  "pairToHomeMs": ${T_PAIR_TO_HOME:-null},
  "spawnToFirstAssistantMs": ${T_SPAWN_TO_ASSISTANT:-null},
  "replyToTranscriptMs": ${T_REPLY_TO_TRANSCRIPT:-null},
  "replyHttpDoneMs": ${T_REPLY_HTTP_DONE:-null},
  "outboxRelaunchToDeliveryMs": ${T_OUTBOX_RELAUNCH_TO_DELIVERY:-null},
  "voiceLiveFinalAfterCommitMs": ${T_VOICE_LIVE_FINAL:-null},
  "voiceLiveTotalMs": ${T_VOICE_LIVE_TOTAL:-null},
  "voiceFileRoundTripEnMs": ${T_VOICE_FILE_RT_EN:-null},
  "voiceFileRoundTripPlMs": ${T_VOICE_FILE_RT_PL:-null},
  "ttsFirstByteMs": ${T_TTS_FIRST_BYTE:-null},
  "ttsBytes": ${TTS_BYTES:-null},
  "replaySecondCallMs": ${T_REPLAY_SECOND_CALL:-null},
  "noSkillSpawnToAssistantMs": ${T_NOSKILL_SPAWN_TO_ASSISTANT:-null},
  "revokeToPhoneRevokedMs": ${T_REVOKE_TO_PHONE:-null},
  "steps": { "a": "$(res a)", "b": "$(res b)", "c": "$(res c)", "d": "$(res d)", "e": "$(res e)", "f": "$(res f)", "g": "$(res g)", "h": "$(res h)", "i": "$(res i)", "j": "$(res j)", "k": "$(res k)", "l": "$(res l)" }
}
JSON
  [[ -f "$PF_USERDATA/store.json" ]] && cp "$PF_USERDATA/store.json" "$EVIDENCE/store-final.json"
  cat > "$EVIDENCE/INDEX.md" <<MD
# Mobile E2E evidence ($(date '+%Y-%m-%d %H:%M'), run tag ${RUN_TAG:-?})

A test copy of Peers Flow (its own data folder, gateway on 127.0.0.1:$PF_PORT in dev mode) talked to the
phone app on the Android emulator $SERIAL. The real Peers Flow app was not touched.
Phone-started voice chat: ${VOICE_ID:-?}. Voice chat on a peer without the skill: ${NOSKILL_ID:-?}.

## Steps

| Step | What it checks | Result |
|---|---|---|
| a pair | phone data wiped; pairing link opens the pairing screen filled in; submit lands on Home | $(res a) |
| b online | Home says the Mac is online | $(res b) |
| c spawn | Hi LISA from the phone starts a voice chat (store: chatKind voice, contract until-done); answers stream to the phone; first message shows as "/voice-task …", not raw markup | $(res c) |
| d reply | a reply typed on the phone lands in the chat history exactly once, also 20 s later; nothing stuck in the outbox | $(res d) |
| e outbox | Mac off: message waits on the phone; after restart it lands exactly once and the outbox empties | $(res e) |
| f voice | real OpenAI speech-to-text and text-to-speech, one run; no key in the log | $(res f) |
| g outcomes | voice chat finished; Outcomes lists it; the app posted a notification | $(res g) |
| h desktop | the desktop Mobile panel shows a pairing QR | $(res h) |
| i replay | the same reply sent twice (first one abandoned after 2 s): second answer says duplicate, history holds it once | $(res i) |
| j no-skill | voice task on a peer without the voice-task skill gets a plain-text brief and an answer | $(res j) |
| k revoke | unknown key refused (401); "revoke all" on the desktop locks the phone out (401) and the phone says so; phone paired again afterwards | $(res k) |
| l kind kept | both voice chats are still marked "voice" at the end of the run, after the restart in step e | $(res l) |

## Files

| File | What it shows | Step |
|---|---|---|
| 01-pairing.png | pairing screen opened by the link, address and code filled in | a |
| 02-home.png | Home right after pairing | a |
| 03-home-online.png | status line says the Mac is online, the test peer LISA listed | b |
| 04-hilisa.png | Hi LISA sheet with the typed task | c |
| 05-chat-stream.png | the phone-started voice chat with its answer; first message "/voice-task …" | c |
| 05-voice-transcript.txt | the voice chat's history on the Mac when the answer arrived | c |
| 06-reply.png | the reply typed on the phone, shown once | d |
| 07-outbox.png | message waiting in the outbox while the Mac was off | e |
| 08-outbox-flushed.png | outbox empty after restart | e |
| 09-voice-smoke.log | real speech test output (no key inside) | f |
| 10-outcomes.png | Outcomes screen with the finished voice chat | g |
| 11-desktop-mobile-panel.png | desktop Mobile panel with the pairing QR | h |
| 13-replay.txt | both replay answers and the history count | i |
| 14-noskill-transcript.txt | history of the voice chat on a peer without the skill | j |
| 12-revoke.txt | status codes before and after revoking, phone status text | k |
| 12-revoked.png | phone status line after the desktop revoked it | k |
| 15-chatkind-after-restart.txt | chat kind of both voice chats at the end, in the store and on the phone API | l |
| e2e-run.log | the console output of the run | all |
| video-A-pairing.mp4 | phone video: pairing link opens, Pair tapped, Home shows the Mac online | a, b |
| video-B-chat.mp4 | phone video: Hi LISA task sent, new voice chat opened, answer streams in, reply typed and shown | c, d |
| video-C-outbox.mp4 | phone video: Mac switched off, message waits in the outbox, Mac back, outbox empties | e |
| video-D-desktop-pair.mp4 | desktop video (3 frames a second): "Pair a phone" clicked, QR appears | h |
| store-after-spawn.json | the test copy's chat list right after the phone started the voice chat | c |
| store-final.json | the test copy's chat list at the end (test data only) | all |
| timings.json | all measured times | all |

## Timings

| Measure | ms |
|---|---|
| pair → home | ${T_PAIR_TO_HOME:-n/a} |
| spawn → first assistant message | ${T_SPAWN_TO_ASSISTANT:-n/a} |
| reply → transcript | ${T_REPLY_TO_TRANSCRIPT:-n/a} |
| reply → HTTP call finished | ${T_REPLY_HTTP_DONE:-n/a} |
| outbox: relaunch → delivery | ${T_OUTBOX_RELAUNCH_TO_DELIVERY:-n/a} |
| voice: live final (after commit) | ${T_VOICE_LIVE_FINAL:-n/a} |
| voice: live total | ${T_VOICE_LIVE_TOTAL:-n/a} |
| voice: file round trip EN / PL | ${T_VOICE_FILE_RT_EN:-n/a} / ${T_VOICE_FILE_RT_PL:-n/a} |
| TTS first byte | ${T_TTS_FIRST_BYTE:-n/a} |
| replay: second call answered | ${T_REPLAY_SECOND_CALL:-n/a} |
| no-skill voice: spawn → answer | ${T_NOSKILL_SPAWN_TO_ASSISTANT:-n/a} |
| revoke → phone shows revoked | ${T_REVOKE_TO_PHONE:-n/a} |
MD
  [[ -f "$PF_TMP/bugs.md" ]] && { echo; echo "## Bugs found"; echo; cat "$PF_TMP/bugs.md"; } >> "$EVIDENCE/INDEX.md"
  return 0
}

STEPS="a:step_a_pair b:step_b_online c:step_c_spawn d:step_d_reply e:step_e_outbox f:step_f_voice g:step_g_outcomes h:step_h_desktop i:step_i_replay j:step_j_noskill k:step_k_revoke l:step_l_kind_survives"
FAILED=""
FROM=${1:-a}
if [[ "$FROM" == "a" ]]; then
  : > "$STATE"
  # count-user scans every transcript of the scratch peer, including earlier runs: make the
  # phrases unique per run (digits only, so speech/keyboard paths stay trivial).
  save RUN_TAG "$(date +%H%M%S)"
fi
[[ -n "${RUN_TAG:-}" ]] || { echo "no RUN_TAG in $STATE: start from step a" >&2; exit 1; }
REPLY_TEXT="reply from phone 4242 $RUN_TAG"
QUEUED_TEXT="queued while off 7777 $RUN_TAG"
set +e; ( set -e; prereqs ); rc=$?; set -e
(( rc == 0 )) || { echo "prerequisites missing" >&2; exit 1; }
started=0
for s in $STEPS; do
  letter=${s%%:*}; fn=${s#*:}
  [[ "$letter" == "$FROM" ]] && started=1
  (( started )) || continue
  echo "STEP $letter $fn"
  case "$letter" in a) rec_start A ;; c) rec_start B ;; e) rec_start C ;; esac
  t0=$(now_ms)
  # Subshell outside any conditional so `set -e` really aborts the step on the first error.
  set +e
  ( set -e; "$fn" )
  rc=$?
  set -e
  [[ -f "$STATE" ]] && source "$STATE"
  case "$letter" in b) rec_stop A video-A-pairing.mp4 ;; d) rec_stop B video-B-chat.mp4 ;; e) rec_stop C video-C-outbox.mp4 ;; esac
  if (( rc == 0 )); then r=PASS; else r=FAIL; FAILED="$FAILED $letter"; fi
  save "STEP_${letter}_RESULT" "$r"; save "STEP_${letter}_MS" "$(( $(now_ms) - t0 ))"
  echo "STEP $letter $r $(( $(now_ms) - t0 ))"
  # Keep going after a failure (later steps are still informative); the exit code reports it.
done
write_outputs
if [[ -n "$FAILED" ]]; then echo "E2E FAIL — steps:$FAILED; evidence in $EVIDENCE"; exit 1; fi
echo "E2E PASS — evidence in $EVIDENCE"
