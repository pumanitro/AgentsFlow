#!/usr/bin/env bash
# Self-test for block-mass-kill.py (and, through it, lib/killcheck.py). Every case feeds a
# PreToolUse payload and checks deny/allow. Hermetic: the "too many live matches" case spawns its
# own 16 sleepers under a unique name instead of relying on what happens to run on this Mac.
# Case 1 is the exact command that SIGTERMed ~130 of the user's processes on 2026-10-27 07:37.
# Usage: bash <dir>/block-mass-kill.selftest.sh   (any cwd; PY=/usr/bin/python3 to pin the interpreter)
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$DIR/block-mass-kill.py"
PY="${PY:-python3}"
pass=0; fail=0
pids=()
cleanup() { [ ${#pids[@]} -gt 0 ] && kill "${pids[@]}" 2>/dev/null; return 0; }
gone() { local n=0; while /usr/bin/pgrep -f "$tag" >/dev/null 2>&1 && [ $n -lt 40 ]; do sleep 0.1; n=$((n+1)); done; }
trap cleanup EXIT

check() { # $1 = deny|allow, $2 = command
  local out got
  out=$(jq -cn --arg c "$2" '{tool_name:"Bash",tool_input:{command:$c}}' | "$PY" -B "$HOOK" 2>&1)
  if printf '%s' "$out" | grep -q '"permissionDecision": *"deny"'; then got=deny; else got=allow; fi
  if [ "$got" = "$1" ]; then pass=$((pass+1)); printf 'ok    %-5s %s\n' "$1" "$2"
  else fail=$((fail+1)); printf 'FAIL  want %-5s got %-5s %s\n' "$1" "$got" "$2"; [ -n "$out" ] && printf '      %s\n' "$out"; fi
}

# --- the incident and its variants: options after the pattern become extra patterns on macOS
check deny  'pkill -f "ATLAS_DASH_API_PORT=5953" ; pkill -f "vite.lane2.config.mjs"; pkill -f "dashboard/api/server.mjs" -U $(id -u) -n 2>/dev/null; lsof -ti tcp:5953 tcp:5952 | xargs kill 2>/dev/null; echo done'
check deny  'pkill -f "dashboard/api/server.mjs" -U 501 -n'
check deny  'pkill node -9'
check deny  'cd /tmp && pkill -f foo -n'
check deny  'pgrep -f "server.mjs" -n | xargs kill'
# --- kill everything the user owns
check deny  'kill -- -1'
check deny  'kill -9 -1'
check deny  'kill -TERM -- -1'
check deny  'kill -s TERM -1'
# --- a pattern that matches far too much right now: 16 sleepers of our own, then none
tag="pfguard-selftest-$$-$RANDOM"
# spawned from a subshell so they are not our jobs (no "Terminated" notices); pids come back on stdout
pids=($(for i in $(seq 1 16); do bash -c "exec -a $tag sleep 30" >/dev/null 2>&1 & echo $!; done))
sleep 0.5
check deny  "pkill -f $tag"
check deny  "pkill -9 -f -- $tag"
kill "${pids[@]}" 2>/dev/null; pids=(); gone
check allow "pkill -f $tag"
# --- a pattern that reaches into ANOTHER project's folder (2026-10-30: an ai-factory agent's
#     `pkill -f "next dev"` killed the Peers Flow dev renderer). Two scratch "projects"; a sleeper lives in A.
projA=$(mktemp -d /tmp/pfguard-projA.XXXXXX); projB=$(mktemp -d /tmp/pfguard-projB.XXXXXX)
tag2="pfguard-foreign-$$-$RANDOM"
pids=($(bash -c "cd '$projA' && exec -a $tag2 sleep 30" >/dev/null 2>&1 & echo $!))
sleep 0.3
check_in() { # $1 = deny|allow, $2 = caller cwd, $3 = command
  local out got
  out=$(jq -cn --arg c "$3" --arg d "$2" '{tool_name:"Bash",cwd:$d,tool_input:{command:$c}}' | "$PY" -B "$HOOK" 2>&1)
  if printf '%s' "$out" | grep -q '"permissionDecision": *"deny"'; then got=deny; else got=allow; fi
  if [ "$got" = "$1" ]; then pass=$((pass+1)); printf 'ok    %-5s (in %s) %s\n' "$1" "${2##*/}" "$3"
  else fail=$((fail+1)); printf 'FAIL  want %-5s got %-5s (in %s) %s\n' "$1" "$got" "${2##*/}" "$3"; fi
}
check_in deny  "$projB" "pkill -f $tag2"
check_in deny  "$projB" "bash -c 'pkill -f $tag2'"
check_in allow "$projA" "pkill -f $tag2"
kill "${pids[@]}" 2>/dev/null; pids=(); rm -rf "$projA" "$projB"

# --- the same mistakes wrapped in another command
check deny  "bash -c 'pkill node -9'"
check deny  'sh -c "pkill -f foo -n"'
check deny  "zsh -lc 'kill -9 -1'"
check deny  "eval 'pkill node -9'"
check deny  'echo x | xargs pkill -f foo -n'
check deny  'timeout 5 pkill node -9'
check deny  'sudo pkill node -9'
check deny  '/usr/bin/pkill node -9'

# --- legitimate commands stay allowed
check allow 'pkill -U 501 -n -f "pfguard-not-running-xyz/server.mjs"'
check allow 'pkill -f "vite.lane2.config.mjs"'
check allow 'pkill -9 -f "definitely-not-a-running-process-xyz"'
check allow 'pgrep -lf "dashboard/api/server.mjs"'
check allow 'kill 12345'
check allow 'kill -9 12345 23456'
check allow 'kill -- -12345'
check allow 'lsof -ti tcp:5953 | xargs kill'
check allow 'echo "pkill node -9 is a bad idea"'
check allow 'git commit -m "kill -1 bug"'
check allow 'BH_ALLOW_MASS_KILL=1 pkill node -9'
check allow "bash -c 'pkill -U 501 -f pfguard-not-running-xyz.mjs'"
check allow 'timeout 5 pkill -9 -f my-server.mjs'
check allow 'echo 123 | xargs -n 1 kill'

echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
