#!/usr/bin/env bash
# Selftest for mem-admission.sh (defer-then-deny) — no real memory
# pressure, no real Agent spawn, no writes to the real log, the real ~/.claude/locks or the real
# deferred-marker directory. Every case redirects MEM_ADMISSION_LOG / MEM_LOCK_DIR /
# MEM_ADMISSION_DEFER_DIR to a temp path and bounds the wait with MEM_ADMISSION_WAIT_S.
# Prints "all passing" and exits 0 on success, "N FAILING" and exits 1 otherwise.
#
# Usage: bash ~/.claude/hooks/peersflow/mem-admission.selftest.sh   (or <repo>/guards/mem-admission.selftest.sh)
#        MEM_ADMISSION_HOOK=/path/to/candidate.sh bash …selftest.sh     test another copy
set -uo pipefail

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADMISSION="${MEM_ADMISSION_HOOK:-$HOOK_DIR/mem-admission.sh}"

PASS=0
FAIL=0
FAILURES=()

ok()   { PASS=$((PASS+1)); }
bad()  { FAIL=$((FAIL+1)); FAILURES+=("$1"); }

check_eq() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then ok; else bad "$desc (got [$got] want [$want])"; fi
}

check_true() {
  local desc="$1" cond="$2"
  if [ "$cond" = "true" ]; then ok; else bad "$desc (got [$cond])"; fi
}

check_deny() { # check_deny <desc> <stdout>
  if printf '%s' "$2" | jq -e . >/dev/null 2>&1; then
    check_eq "$1 permissionDecision" "$(printf '%s' "$2" | jq -r '.hookSpecificOutput.permissionDecision')" "deny"
    check_eq "$1 hookEventName" "$(printf '%s' "$2" | jq -r '.hookSpecificOutput.hookEventName')" "PreToolUse"
  else
    bad "$1 stdout is not valid JSON: $2"
  fi
}

nmarkers() { ls "$1" 2>/dev/null | grep -c '\.json$'; }      # marker files in a defer dir (0 when it does not exist)
nstray()   { ls -A "$1" 2>/dev/null | grep -vc '\.json$'; }  # anything else left behind (tmp files)
marker_of() { ls "$1"/*.json 2>/dev/null | head -1; }

ROOT=$(mktemp -d "${TMPDIR:-/tmp}/mem-admission-selftest.XXXXXX")
N=0
newcase() { # fresh LOGF / LOCKS / DEFER for one case
  N=$((N+1))
  LOGF="$ROOT/$N.log"; LOCKS="$ROOT/$N.locks"; DEFER="$ROOT/$N.deferred"
  mkdir -p "$LOCKS"
}

# Fake readings must not be distorted by whatever lane leases are live on this Mac right now
# (a 6-lane ramp reserves 24 GB and turned case 3's "room" into none on 2026-09-26), and no
# case may wait the production 40 s.
export MEM_LOCK_DIR="$ROOT/default.locks"; mkdir -p "$MEM_LOCK_DIR"
export MEM_ADMISSION_WAIT_S=1
REAL_DEFER="$HOME/.claude/locks/mem-deferred"
real_sig() { { ls -lT "$REAL_DEFER" 2>/dev/null; stat -f '%z %m' "$HOME/Library/Logs/mem-admission.log" 2>/dev/null; } | shasum | cut -c1-12; }
REAL_BEFORE=$(real_sig)

AGENT_PAYLOAD='{"session_id":"abc12345-0000-4000-8000-000000000000","transcript_path":"/tmp/t.jsonl","cwd":"/tmp","hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"prompt":"hi","description":"probe the thing","model":"haiku","subagent_type":"general-purpose"}}'

run() { # run <payload> VAR=value… → stdout of the hook; sets RC
  local p="$1"; shift
  OUT=$(printf '%s' "$p" | env MEM_ADMISSION_LOG="$LOGF" MEM_LOCK_DIR="$LOCKS" MEM_ADMISSION_DEFER_DIR="$DEFER" "$@" bash "$ADMISSION")
  RC=$?
}

[ -f "$ADMISSION" ] || { echo "no hook at $ADMISSION"; exit 1; }
bash -n "$ADMISSION" && ok || bad "bash -n $ADMISSION"

# ---------------------------------------------------------------------------------- case 1
# critical memory (5 GB avail) -> deny after the bounded 1 s wait, marker file, exit 0
newcase
run "$AGENT_PAYLOAD" MEM_FAKE_AVAIL_GB=5
check_eq "case1 exit code" "$RC" "0"
check_deny "case1" "$OUT"
case "$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.permissionDecisionReason' 2>/dev/null)" in
  *"avail 5 GB, state critical (avail 5.0 < 10)"*"Not spawning another agent now"*"Do NOT retry in a loop"*"Keeper will tell you when memory is free"*'`mem-budget wait --need 1.5` and retry ONCE'*) ok ;;
  *) bad "case1 deny reason lacks the contract sentences: $OUT" ;;
esac
check_eq "case1 reason is one paragraph" "$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.permissionDecisionReason' | wc -l | tr -d ' ')" "1"
grep -Eq " DENY\+DEFER avail=5 state=critical waited=[1-3] marker=abc12345-[0-9]{13}\.json model=haiku type=general-purpose iso= session=abc12345 cwd=/tmp$" "$LOGF" && ok || bad "case1 log line missing DENY+DEFER … waited= marker=: $(cat "$LOGF")"
check_eq "case1 exactly one marker" "$(nmarkers "$DEFER")" "1"
check_eq "case1 no tmp file left in the defer dir" "$(nstray "$DEFER")" "0"
M=$(marker_of "$DEFER")
basename "$M" | grep -Eq '^abc12345-[0-9]{13}\.json$' && ok || bad "case1 marker name is not <session first 8>-<epoch ms>.json: $M"
jq -e '.schema==1 and .sessionId and .cwd and .toolName and .what and .state' "$M" >/dev/null 2>&1 && ok || bad "case1 marker fails the acceptance jq: $(cat "$M" 2>/dev/null)"
jq -e '.schema == 1 and .sessionId == "abc12345-0000-4000-8000-000000000000" and .cwd == "/tmp" and .transcriptPath == "/tmp/t.jsonl"
       and .toolName == "Agent" and .what == "probe the thing" and .subagentType == "general-purpose" and .model == "haiku"
       and (.reason | type == "string" and test("critical")) and .availGB == 5 and .state == "critical"
       and (.at | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))' "$M" >/dev/null 2>&1 && ok || bad "case1 marker fields wrong: $(cat "$M" 2>/dev/null)"
check_eq "case1 marker has exactly the DeferredMarker keys" "$(jq -r 'keys | join(",")' "$M" 2>/dev/null)" "at,availGB,cwd,model,reason,schema,sessionId,state,subagentType,toolName,transcriptPath,what"
check_eq "case1 marker is one line of JSON" "$(wc -l < "$M" | tr -d ' ')" "1"

# ---------------------------------------------------------------------------------- case 2
# ok memory (60 GB avail) -> allow, empty stdout, no marker, exit 0
newcase
run "$AGENT_PAYLOAD" MEM_FAKE_AVAIL_GB=60
check_eq "case2 exit code" "$RC" "0"
check_eq "case2 stdout empty" "$OUT" ""
grep -Eq " ALLOW avail=60 state=ok waited=[01] " "$LOGF" && ok || bad "case2 log line missing ALLOW: $(cat "$LOGF")"
check_eq "case2 no marker" "$(nmarkers "$DEFER")" "0"

# ---------------------------------------------------------------------------------- case 3
# warn via compressed memory but WITH room (25 GB avail, 40 GB compressed): since 2026-09-26 a
# warn state admits when mem-budget's fit says another agent fits (25 − 16 reserve = 9 GB → 6).
newcase
run "$AGENT_PAYLOAD" MEM_FAKE_AVAIL_GB=25 MEM_FAKE_COMPRESSED_GB=40
check_eq "case3 exit code" "$RC" "0"
check_eq "case3 stdout empty (warn with room admits)" "$OUT" ""
grep -q " ALLOW .*warn-with-room" "$LOGF" && ok || bad "case3 log line missing ALLOW warn-with-room"
check_eq "case3 no marker" "$(nmarkers "$DEFER")" "0"

# ---------------------------------------------------------------------------------- case 3b
# warn via swap with NO room (17 GB avail, 12 GB swap): 17 − 16 reserve = 1 GB < 1.5 → deny + marker
newcase
run "$AGENT_PAYLOAD" MEM_FAKE_AVAIL_GB=17 MEM_FAKE_SWAP_GB=12
check_eq "case3b exit code" "$RC" "0"
check_deny "case3b (warn, no room)" "$OUT"
grep -q " DENY+DEFER .*state=warn " "$LOGF" && ok || bad "case3b log line missing DENY+DEFER"
check_eq "case3b one marker" "$(nmarkers "$DEFER")" "1"
jq -e '.schema==1 and .state == "warn" and .availGB == 17 and (.reason | test("no room"))' "$(marker_of "$DEFER")" >/dev/null 2>&1 && ok || bad "case3b marker wrong: $(cat "$(marker_of "$DEFER")" 2>/dev/null)"

# ---------------------------------------------------------------------------------- closed file
# c1: a FRESH closed file denies even at ok memory, with a marker
newcase
touch "$LOCKS/mem-admission-closed"
run "$AGENT_PAYLOAD" MEM_FAKE_AVAIL_GB=60
check_eq "closed-fresh exit code" "$RC" "0"
check_deny "closed-fresh at ok" "$OUT"
grep -q " DENY+DEFER avail=60 state=ok " "$LOGF" && ok || bad "closed-fresh log line missing DENY+DEFER state=ok: $(cat "$LOGF")"
check_eq "closed-fresh one marker" "$(nmarkers "$DEFER")" "1"
jq -e '.schema==1 and .state == "ok" and .availGB == 60 and (.reason | test("closed"))' "$(marker_of "$DEFER")" >/dev/null 2>&1 && ok || bad "closed-fresh marker wrong: $(cat "$(marker_of "$DEFER")" 2>/dev/null)"

# c2: a closed file older than 120 s (mtime forced back 3 minutes) is ignored -> allow
newcase
touch "$LOCKS/mem-admission-closed"
touch -t "$(date -v-3M '+%Y%m%d%H%M.%S')" "$LOCKS/mem-admission-closed"
run "$AGENT_PAYLOAD" MEM_FAKE_AVAIL_GB=60
check_eq "closed-stale stdout empty (allow)" "$OUT" ""
grep -Eq " ALLOW avail=60 state=ok waited=[01] " "$LOGF" && ok || bad "closed-stale log line missing ALLOW"
check_eq "closed-stale no marker" "$(nmarkers "$DEFER")" "0"

# c3: MEM_ADMISSION_CLOSED_FILE overrides the path
newcase
touch "$ROOT/elsewhere-closed"
run "$AGENT_PAYLOAD" MEM_FAKE_AVAIL_GB=60 MEM_ADMISSION_CLOSED_FILE="$ROOT/elsewhere-closed"
check_deny "closed file via MEM_ADMISSION_CLOSED_FILE" "$OUT"

# ---------------------------------------------------------------------------------- the wait
# w1: room appears DURING the wait. MEM_NODE is a wrapper that answers the first mem-budget call
# with 5 GB (critical) and every later one (the wait, the re-read) with 60 GB.
newcase
REAL_NODE=$(command -v node 2>/dev/null || ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)
WRAP="$ROOT/node-flip.sh"
cat > "$WRAP" <<EOF
#!/bin/bash
n=\$(cat "$ROOT/flip.count" 2>/dev/null || echo 0); n=\$((n + 1)); echo "\$n" > "$ROOT/flip.count"
if [ "\$n" -ge 2 ]; then export MEM_FAKE_AVAIL_GB=60; else export MEM_FAKE_AVAIL_GB=5; fi
exec "$REAL_NODE" "\$@"
EOF
chmod +x "$WRAP"
run "$AGENT_PAYLOAD" MEM_NODE="$WRAP" MEM_ADMISSION_WAIT_S=20
check_eq "wait-room exit code" "$RC" "0"
check_eq "wait-room stdout empty (allowed after the wait)" "$OUT" ""
grep -Eq " ALLOW-AFTER-WAIT avail=60 state=ok waited=[0-9]+ " "$LOGF" && ok || bad "wait-room log line missing ALLOW-AFTER-WAIT: $(cat "$LOGF")"
check_eq "wait-room no marker" "$(nmarkers "$DEFER")" "0"
check_eq "wait-room: mem-budget ran 3 times (read, wait, re-read)" "$(cat "$ROOT/flip.count" 2>/dev/null)" "3"

# w2: the closed file goes stale during the wait (mtime 117 s ago, 8 s budget) -> ALLOW-AFTER-WAIT
newcase
touch "$LOCKS/mem-admission-closed"
touch -t "$(date -v-117S '+%Y%m%d%H%M.%S')" "$LOCKS/mem-admission-closed"
run "$AGENT_PAYLOAD" MEM_FAKE_AVAIL_GB=60 MEM_ADMISSION_WAIT_S=8
check_eq "closed-ages-out stdout empty" "$OUT" ""
grep -Eq " ALLOW-AFTER-WAIT avail=60 state=ok waited=[2-8] " "$LOGF" && ok || bad "closed-ages-out log line missing ALLOW-AFTER-WAIT: $(cat "$LOGF")"
check_eq "closed-ages-out no marker" "$(nmarkers "$DEFER")" "0"

# w3: MEM_ADMISSION_WAIT_S=0 denies at once
newcase
run "$AGENT_PAYLOAD" MEM_FAKE_AVAIL_GB=5 MEM_ADMISSION_WAIT_S=0
check_deny "wait 0" "$OUT"
grep -Eq " DENY\+DEFER .* waited=[01] " "$LOGF" && ok || bad "wait 0: expected waited=0: $(cat "$LOGF")"

# ---------------------------------------------------------------------------------- marker edge cases
# u1: an unwritable defer dir -> the deny still stands, exit 0, the failure is logged
newcase
run "$AGENT_PAYLOAD" MEM_FAKE_AVAIL_GB=5 MEM_ADMISSION_DEFER_DIR=/dev/null/nope
check_eq "unwritable defer dir exit code" "$RC" "0"
check_deny "unwritable defer dir" "$OUT"
grep -q " ERR .*state=marker-write-failed " "$LOGF" && ok || bad "unwritable defer dir: no ERR marker-write-failed line"
grep -q " DENY+DEFER .* marker=FAILED " "$LOGF" && ok || bad "unwritable defer dir: DENY+DEFER line lacks marker=FAILED"

# m1: no description -> `what` is the first 120 chars of the prompt; absent subagent_type/model are omitted
newcase
LONG=$(printf 'x%.0s' $(seq 1 200))
P_NODESC=$(jq -cn --arg p "$LONG" '{session_id:"feedfacecafe",transcript_path:"/tmp/t2.jsonl",cwd:"/tmp/with space",hook_event_name:"PreToolUse",tool_name:"Task",tool_input:{prompt:$p}}')
run "$P_NODESC" MEM_FAKE_AVAIL_GB=5
check_deny "Task tool is guarded too" "$OUT"
M=$(marker_of "$DEFER")
basename "$M" | grep -Eq '^feedface-[0-9]{13}\.json$' && ok || bad "m1 marker name: $M"
jq -e '(.what | length) == 120 and .toolName == "Task" and .cwd == "/tmp/with space" and (has("subagentType") | not) and (has("model") | not)' "$M" >/dev/null 2>&1 && ok || bad "m1 marker wrong: $(cat "$M" 2>/dev/null)"

# m2: two denies of one session leave two markers (epoch-ms names do not collide)
run "$P_NODESC" MEM_FAKE_AVAIL_GB=5
check_eq "m2 second deny adds a second marker" "$(nmarkers "$DEFER")" "2"

# ---------------------------------------------------------------------------------- case 4
# override 1: MEM_ADMISSION_OFF=1 skips the check even at critical memory
newcase
run "$AGENT_PAYLOAD" MEM_FAKE_AVAIL_GB=5 MEM_ADMISSION_OFF=1
check_eq "case4 exit code" "$RC" "0"
check_eq "case4 stdout empty (OFF via env)" "$OUT" ""
grep -q " OFF " "$LOGF" && ok || bad "case4 log line missing OFF"
check_eq "case4 no marker" "$(nmarkers "$DEFER")" "0"

# ---------------------------------------------------------------------------------- case 5
# override 2: a fresh lock file in MEM_LOCK_DIR skips the check
newcase
touch "$LOCKS/mem-admission-off"
run "$AGENT_PAYLOAD" MEM_FAKE_AVAIL_GB=5
check_eq "case5 exit code" "$RC" "0"
check_eq "case5 stdout empty (OFF via lock file)" "$OUT" ""
grep -q " OFF " "$LOGF" && ok || bad "case5 log line missing OFF"

# case 5b: a STALE lock file (mtime forced back 3 hours) does NOT skip the check
newcase
touch "$LOCKS/mem-admission-off"
touch -t "$(date -v-3H '+%Y%m%d%H%M.%S')" "$LOCKS/mem-admission-off"
run "$AGENT_PAYLOAD" MEM_FAKE_AVAIL_GB=5
check_deny "case5b stale lock file does not skip" "$OUT"

# ---------------------------------------------------------------------------------- case 6
# override 3: literal MEM_ADMISSION_OVERRIDE=1 token in the prompt
newcase
PAYLOAD_OVERRIDE='{"session_id":"abc12345","transcript_path":"/tmp/t.jsonl","cwd":"/tmp","hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"prompt":"please MEM_ADMISSION_OVERRIDE=1 go ahead","model":"haiku"}}'
run "$PAYLOAD_OVERRIDE" MEM_FAKE_AVAIL_GB=5
check_eq "case6 exit code" "$RC" "0"
check_eq "case6 stdout empty (OFF via prompt token)" "$OUT" ""
grep -q " OFF " "$LOGF" && ok || bad "case6 log line missing OFF"

# ---------------------------------------------------------------------------------- case 7
# ERR path: node cannot be resolved -> allow (fail open), logged ERR, no marker
newcase
run "$AGENT_PAYLOAD" MEM_NODE=/nonexistent
check_eq "case7 exit code" "$RC" "0"
check_eq "case7 stdout empty (ERR fails open)" "$OUT" ""
grep -q " ERR " "$LOGF" && ok || bad "case7 log line missing ERR"
check_eq "case7 no marker" "$(nmarkers "$DEFER")" "0"

# case 7b: mem-budget itself fails (node = /usr/bin/false) -> ERR, allow
newcase
run "$AGENT_PAYLOAD" MEM_NODE=/usr/bin/false
check_eq "case7b stdout empty (mem-budget failure fails open)" "$OUT" ""
grep -q " ERR " "$LOGF" && ok || bad "case7b log line missing ERR"

# case 7c: memory unreadable (MEM_DISABLE=1 → null reading) -> ERR, allow
newcase
run "$AGENT_PAYLOAD" MEM_DISABLE=1
check_eq "case7c stdout empty (null reading fails open)" "$OUT" ""
grep -q " ERR " "$LOGF" && ok || bad "case7c log line missing ERR"

# ---------------------------------------------------------------------------------- case 8
# non-Agent/Task tool_name -> silent no-op, no log line written, no marker
newcase
PAYLOAD_OTHER='{"session_id":"abc12345","transcript_path":"/tmp/t.jsonl","cwd":"/tmp","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}'
run "$PAYLOAD_OTHER" MEM_FAKE_AVAIL_GB=5
check_eq "case8 exit code" "$RC" "0"
check_eq "case8 stdout empty (not Agent/Task)" "$OUT" ""
if [ -s "$LOGF" ]; then bad "case8 expected no log line for a non-Agent/Task tool"; else ok; fi
check_eq "case8 no marker" "$(nmarkers "$DEFER")" "0"

# ---------------------------------------------------------------------------------- case 9
# log rotation: a >1MB log gets rotated to <=500 lines
newcase
yes "old line, padded to make each line reasonably long for a size test" | head -n 20000 > "$LOGF"
sz_before=$(stat -f%z "$LOGF")
[ "$sz_before" -gt 1048576 ] || bad "case9 setup: fixture log not >1MB ($sz_before bytes)"
run "$AGENT_PAYLOAD" MEM_FAKE_AVAIL_GB=60
lines_after=$(wc -l < "$LOGF" | tr -d ' ')
if [ "$lines_after" -le 501 ]; then ok; else bad "case9 log not rotated (lines=$lines_after)"; fi

# ---------------------------------------------------------------------------------- nothing real touched
check_eq "real ~/.claude/locks/mem-deferred and ~/Library/Logs/mem-admission.log untouched" "$(real_sig)" "$REAL_BEFORE"

# ---------------------------------------------------------------------------------- report
echo "----"
echo "passed: $PASS  failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  for f in "${FAILURES[@]}"; do echo "  FAIL: $f"; done
  echo "$FAIL FAILING (temp files kept in $ROOT)"
  exit 1
fi
rm -rf "$ROOT"
echo "all passing"
exit 0
