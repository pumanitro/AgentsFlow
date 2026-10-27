#!/usr/bin/env bash
# PreToolUse guard: defer-then-deny admission for a new Agent/Task while this Mac has no memory
# room for one, in every project, on every session.
#
# WHY THIS EXISTS
#   On 2026-09-22 thirteen parallel bulk-delivery lanes plus five browser agents were spawned
#   with no admission control and this 128 GB Mac ran out of application memory and hard-
#   rebooted. Nothing on the machine had a memory term before an Agent() call. This hook is
#   that term: it asks `mem-budget` (the one place on this machine that knows how to read
#   memory) before letting another agent start.
#   Retired 2026-09-26 as a plain "deny"; revived 2026-10-11 as DEFER-THEN-DENY: a denied step
#   used to be stranded (the agent gave up or looped). Now the hook first WAITS a bounded time
#   for room, and when it still has to deny it leaves a marker file that Peers Flow's Keeper
#   picks up, so the chat is told when memory is free again.
#
# FLOW (PreToolUse on Agent|Task)
#   1. any other tool                → exit 0, silent, no log line
#   2. an escape hatch (below)       → OFF, allow
#   3. read `mem-budget --json`      → any failure: ERR, allow (this hook fails OPEN)
#   4. room = (state ok) or (state warn and fit.agents >= 1), AND admission is not closed
#      (closed = $MEM_ADMISSION_CLOSED_FILE exists with now − mtime < 120 s; Peers Flow's memory
#      guard keeps it fresh while its own level is closed/critical)             → ALLOW
#   5. no room → wait up to $MEM_ADMISSION_WAIT_S with
#      `mem-budget wait --need <thresholds.MEM_PER_AGENT_GB> --timeout <left> --strict`
#      (exit 75 = still no room), re-read, re-check the closed file; when only the closed file or
#      a lane lease is in the way the same budget is spent re-checking every 2 s
#                                                                    → ALLOW-AFTER-WAIT
#   6. still no room → deny, and write a DeferredMarker             → DENY+DEFER
#
# CONTRACT
#   stdin  : PreToolUse hook JSON ({session_id, transcript_path, cwd, hook_event_name,
#            tool_name, tool_input:{prompt, description, subagent_type?, model?, isolation?, name?}})
#   stdout : DENY  -> {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
#            ALLOW -> nothing
#   exit   : ALWAYS 0 — a crashing hook must not wedge the session
#   marker : $MEM_ADMISSION_DEFER_DIR/<session_id first 8>-<epoch ms>.json (tmp + mv), the
#            DeferredMarker of Peers Flow shared/types.ts:
#            {schema:1, at, sessionId, cwd, transcriptPath, toolName, what, subagentType?, model?,
#             reason, availGB (number|null), state}
#            A marker that cannot be written is logged (ERR … state=marker-write-failed); the
#            deny still stands.
#   log    : one line per decision to $MEM_ADMISSION_LOG, rotated at 1 MB -> tail 500:
#            <ts> <ALLOW|ALLOW-AFTER-WAIT|DENY+DEFER|OFF|ERR> avail= state= waited=<s> [marker=]
#            model= type= iso= session= cwd=
#
# ENV (default)
#   MEM_ADMISSION_WAIT_S=40       bounded wait before a deny (0 = deny at once)
#   MEM_ADMISSION_DEFER_DIR       $MEM_LOCK_DIR/mem-deferred
#   MEM_ADMISSION_CLOSED_FILE     $MEM_LOCK_DIR/mem-admission-closed
#   MEM_ADMISSION_LOG             ~/Library/Logs/mem-admission.log
#   MEM_LOCK_DIR                  ~/.claude/locks
#   MEM_NODE                      node binary (else PATH, newest ~/.nvm, Homebrew)
#   every MEM_* of mem.mjs passes through (thresholds, MEM_FAKE_* readings)
#
# ESCAPE HATCHES (any one skips the memory check entirely, still logged as OFF)
#   1. MEM_ADMISSION_OFF=1 in this hook's environment
#   2. a file $MEM_LOCK_DIR/mem-admission-off (default ~/.claude/locks/mem-admission-off)
#      younger than 2 hours — `touch` it to open the escape hatch, let it age out
#   3. the literal token MEM_ADMISSION_OVERRIDE=1 anywhere in tool_input.prompt
set -uo pipefail

payload=$(cat)
[ -z "${payload:-}" ] && exit 0

tool_name=$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null)
case "$tool_name" in
  Agent|Task) ;;
  *) exit 0 ;;
esac

prompt=$(printf '%s' "$payload" | jq -r '.tool_input.prompt // empty' 2>/dev/null)
model=$(printf '%s' "$payload" | jq -r '.tool_input.model // empty' 2>/dev/null)
subagent_type=$(printf '%s' "$payload" | jq -r '.tool_input.subagent_type // empty' 2>/dev/null)
isolation=$(printf '%s' "$payload" | jq -r '.tool_input.isolation // empty' 2>/dev/null)
session_id=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)
cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null)
session_short=${session_id:0:8}

LOG="${MEM_ADMISSION_LOG:-$HOME/Library/Logs/mem-admission.log}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null
if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  tail -n 500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi

ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }

T0=$(date +%s)
waited() { echo $(( $(date +%s) - T0 )); }

log_line() { # log_line <decision> <avail> <state> [marker]
  local decision="$1" avail="$2" state="$3" marker="${4:-}"
  printf '%s %s avail=%s state=%s waited=%s%s model=%s type=%s iso=%s session=%s cwd=%s\n' \
    "$(ts)" "$decision" "$avail" "$state" "$(waited)" "${marker:+ marker=$marker}" \
    "${model:-}" "${subagent_type:-}" "${isolation:-}" "${session_short:-}" "${cwd:-}" >> "$LOG" 2>/dev/null
}

allow_off() {
  log_line "OFF" "n/a" "n/a"
  exit 0
}

# --- escape hatch 1: env flag -------------------------------------------------------------
if [ "${MEM_ADMISSION_OFF:-}" = "1" ]; then
  allow_off
fi

# --- escape hatch 2: recent off-lock file ------------------------------------------------
LOCK_DIR="${MEM_LOCK_DIR:-$HOME/.claude/locks}"
OFF_FILE="$LOCK_DIR/mem-admission-off"
if [ -f "$OFF_FILE" ]; then
  mtime=$(stat -f %m "$OFF_FILE" 2>/dev/null || echo 0)
  now_epoch=$(date +%s)
  age=$(( now_epoch - mtime ))
  if [ "$age" -lt 7200 ]; then
    allow_off
  fi
fi

# --- escape hatch 3: literal override token in the prompt --------------------------------
case "$prompt" in
  *MEM_ADMISSION_OVERRIDE=1*) allow_off ;;
esac

# --- resolve node --------------------------------------------------------------------------
if [ -n "${MEM_NODE:-}" ]; then
  NODE="$MEM_NODE"
else
  NODE=$(command -v node 2>/dev/null || true)
  if [ -z "$NODE" ]; then
    NODE=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)
  fi
  if [ -z "$NODE" ]; then
    NODE=/opt/homebrew/bin/node
  fi
fi

MEM_BUDGET="$HOME/.claude/tools/cpu-gate/mem-budget.mjs"
CLOSED_FILE="${MEM_ADMISSION_CLOSED_FILE:-$LOCK_DIR/mem-admission-closed}"
DEFER_DIR="${MEM_ADMISSION_DEFER_DIR:-$LOCK_DIR/mem-deferred}"
CLOSED_FRESH_S=120
WAIT_S="${MEM_ADMISSION_WAIT_S:-40}"
case "$WAIT_S" in ''|*[!0-9]*) WAIT_S=40 ;; *) WAIT_S=$((10#$WAIT_S)) ;; esac

if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  log_line "ERR" "n/a" "unknown"
  exit 0
fi

with_timeout() { # with_timeout <seconds> cmd args… — perl's alarm, since macOS has no timeout(1)
  local s=$1; shift
  if [ -x /usr/bin/perl ]; then
    /usr/bin/perl -e '$t = shift; alarm $t; exec { $ARGV[0] } @ARGV or exit 127' "$s" "$@"
  else
    "$@"
  fi
}

read_budget() { # → state avail reasons per_agent agents_fit; 1 when mem-budget fails or prints no JSON
  local json rc
  json=$(with_timeout 20 "$NODE" "$MEM_BUDGET" --json </dev/null 2>/dev/null)
  rc=$?
  if [ $rc -ne 0 ] || [ -z "$json" ] || ! printf '%s' "$json" | jq -e . >/dev/null 2>&1; then
    return 1
  fi
  state=$(printf '%s' "$json" | jq -r '.reading.state // "unknown"' 2>/dev/null)
  avail=$(printf '%s' "$json" | jq -r '.reading.availGB // "n/a"' 2>/dev/null)
  reasons=$(printf '%s' "$json" | jq -r '(.reading.reasons // []) | join(", ")' 2>/dev/null)
  per_agent=$(printf '%s' "$json" | jq -r '.thresholds.MEM_PER_AGENT_GB // 1.5' 2>/dev/null)
  agents_fit=$(printf '%s' "$json" | jq -r '.fit.agents // 0' 2>/dev/null)
  case "$state" in ok|warn|critical) return 0 ;; *) return 1 ;; esac
}

closed_fresh() { # 0 while the closed file exists and is younger than CLOSED_FRESH_S
  local m now
  [ -f "$CLOSED_FILE" ] || return 1
  m=$(stat -f %m "$CLOSED_FILE" 2>/dev/null) || return 1
  now=$(date +%s)
  [ $(( now - m )) -lt "$CLOSED_FRESH_S" ]
}

# 2026-09-26: "warn" alone does not deny. Swap is a LAGGING signal on macOS — pages swapped
# out during a night of bulk runs stay in swap until touched, so `swap 9 GB > 8` read "warn"
# for a whole day while 50+ GB was free. A warn state has room when mem-budget's own fit
# (avail − 16 GB reserve − live lane leases, ÷ 1.5 GB per agent) says one more agent fits.
has_room() { # → 0 with ROOM_STATE set (for the log); 1 with WHY set (short, for the marker)
  if closed_fresh; then WHY="admission closed by the Peers Flow memory guard (state ${state})"; return 1; fi
  case "$state" in
    ok) ROOM_STATE=ok; return 0 ;;
    warn)
      if [ "${agents_fit:-0}" -ge 1 ] 2>/dev/null; then ROOM_STATE="warn-with-room(${agents_fit})"; return 0; fi
      WHY="warn with no room for one agent (${reasons})"; return 1 ;;
    *) WHY="${state} (${reasons})"; return 1 ;;
  esac
}

epoch_ms() {
  local ms=""
  [ -x /usr/bin/perl ] && ms=$(/usr/bin/perl -MTime::HiRes=time -e 'printf "%d", time * 1000' 2>/dev/null)
  case "$ms" in ''|*[!0-9]*) ms="$(date +%s)000" ;; esac
  echo "$ms"
}

write_marker() { # → 0 with MARKER (basename) set; 1 when the marker could not be written
  local short name tmp marker
  short=$(printf '%s' "$session_short" | tr -cd 'A-Za-z0-9_-')
  name="${short:-nosess}-$(epoch_ms).json"
  marker=$(printf '%s' "$payload" | jq -c \
    --arg at "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" --arg reason "$WHY" --arg avail "$avail" --arg state "$state" '
    def s: if type == "string" then . else "" end;
    (.tool_input // {}) as $ti
    | { schema: 1, at: $at,
        sessionId: (.session_id | s), cwd: (.cwd | s), transcriptPath: (.transcript_path | s),
        toolName: (.tool_name | s),
        what: (($ti.description | s) as $d | if $d != "" then $d
               else (($ti.prompt | s)[0:120] as $p | if $p != "" then $p else "sub-agent" end) end) }
      + (($ti.subagent_type | s) as $v | if $v != "" then { subagentType: $v } else {} end)
      + (($ti.model | s) as $v | if $v != "" then { model: $v } else {} end)
      + { reason: $reason, availGB: ($avail | tonumber? // null), state: $state }' 2>/dev/null) || return 1
  [ -n "$marker" ] || return 1
  mkdir -p "$DEFER_DIR" 2>/dev/null || return 1
  tmp="$DEFER_DIR/.$name.tmp.$$"          # dot-file, not *.json: never read half-written
  { printf '%s\n' "$marker" > "$tmp"; } 2>/dev/null || return 1
  mv -f "$tmp" "$DEFER_DIR/$name" 2>/dev/null || return 1
  MARKER=$name
}

state=unknown; avail="n/a"; reasons=""; per_agent=1.5; agents_fit=0; WHY=""; ROOM_STATE=""; MARKER=""

if ! read_budget; then
  log_line "ERR" "$avail" "$state"
  exit 0
fi

if has_room; then
  log_line "ALLOW" "$avail" "$ROOM_STATE"
  exit 0
fi

# --- no room: wait a bounded time for it ---------------------------------------------------
while :; do
  left=$(( WAIT_S - $(waited) ))
  [ "$left" -le 0 ] && break
  with_timeout $(( left + 15 )) "$NODE" "$MEM_BUDGET" wait --need "$per_agent" --timeout "$left" --strict </dev/null >/dev/null 2>&1
  wrc=$?
  if ! read_budget; then
    log_line "ERR" "$avail" "$state"
    exit 0
  fi
  if has_room; then
    log_line "ALLOW-AFTER-WAIT" "$avail" "$ROOM_STATE"
    exit 0
  fi
  [ "$wrc" -ne 0 ] && break       # 75 = the whole budget went by without room (anything else: wait itself broke)
  # mem-budget sees room but the closed file / a lane lease does not: re-check until the budget is spent
  left=$(( WAIT_S - $(waited) ))
  [ "$left" -le 0 ] && break
  if [ "$left" -lt 2 ]; then sleep "$left"; else sleep 2; fi
done

# --- still no room: deny, and leave a marker for the Keeper -------------------------------
if ! write_marker; then
  log_line "ERR" "$avail" "marker-write-failed"
  MARKER=FAILED
fi

reason="[mem-admission] avail ${avail} GB, state ${state} (${reasons:-no reasons}); ${WHY}; waited $(waited) s for room. Not spawning another agent now: on 2026-09-22 thirteen parallel lanes put this Mac out of application memory and it hard-rebooted. Do NOT retry in a loop. If this chat runs in Peers Flow, its Keeper will tell you when memory is free — carry on with other work. Otherwise wait with \`mem-budget wait --need ${per_agent}\` and retry ONCE. Override only with the user's OK: MEM_ADMISSION_OVERRIDE=1 in the prompt, or \`touch ~/.claude/locks/mem-admission-off\` (2 h)."
jq -cn --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}'
log_line "DENY+DEFER" "$avail" "$state" "$MARKER"
exit 0
