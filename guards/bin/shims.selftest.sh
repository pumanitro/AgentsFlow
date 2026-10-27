#!/usr/bin/env bash
# Self-test for the PATH shims bin/pkill and bin/kill (and, through them, lib/killcheck.py).
# Hermetic: never runs a REAL misordered pkill or a real `kill -1` — every dangerous case must be
# refused by the shim before the real binary is reached (a refusal is exit 2; a pass-through of a
# pattern that matches nothing is the real pkill's exit 1). The "too many live matches" case spawns
# its own 16 sleepers under a unique name and kills exactly those pids afterwards.
# Usage: bash <dir>/bin/shims.selftest.sh   (any cwd)
set -u
BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORIG_PATH="$PATH"
export PATH="$BIN:$PATH"
unset BH_ALLOW_MASS_KILL
pass=0; fail=0
pids=()
cleanup() { [ ${#pids[@]} -gt 0 ] && builtin kill "${pids[@]}" 2>/dev/null; return 0; }
gone() { local n=0; while /usr/bin/pgrep -f "$tag" >/dev/null 2>&1 && [ $n -lt 40 ]; do sleep 0.1; n=$((n+1)); done; }
trap cleanup EXIT

# run <want rc> <stderr must contain, or ""> <argv…> — argv[0] is resolved through PATH (no builtin)
run() {
  local want="$1" needle="$2"; shift 2
  local err rc
  err=$( { env "$@" >/dev/null; } 2>&1 ); rc=$?
  if [ "$rc" = "$want" ] && { [ -z "$needle" ] || printf '%s' "$err" | grep -qF -- "$needle"; }; then
    pass=$((pass+1)); printf 'ok    rc=%-3s %s\n' "$rc" "$*"
  else
    fail=$((fail+1)); printf 'FAIL  want rc=%s%s got rc=%s  %s\n' "$want" "${needle:+ +\"$needle\"}" "$rc" "$*"
    [ -n "$err" ] && printf '      %s\n' "$err"
  fi
}
expect() { # expect <desc> <cond-result 0|1>
  if [ "$2" = 0 ]; then pass=$((pass+1)); printf 'ok    %s\n' "$1"; else fail=$((fail+1)); printf 'FAIL  %s\n' "$1"; fi
}

# --- the shims are what PATH resolves
[ "$(command -v pkill)" = "$BIN/pkill" ]; expect "command -v pkill -> $BIN/pkill" $?
[ "$(type -P kill)" = "$BIN/kill" ];      expect "PATH kill -> $BIN/kill" $?

# --- misordered pkill: refused with the corrected order
run 2 'BLOCKED by Peers Flow kill shim' pkill -f foo -n
run 2 'pkill -n -f foo'                 pkill -f foo -n
run 2 'BLOCKED by Peers Flow kill shim' pkill node -9
run 2 'BH_ALLOW_MASS_KILL=1'            pkill -f "dashboard/api/server.mjs" -U 501 -n

# --- kill -1 = every process you own: refused
run 2 'BLOCKED by Peers Flow kill shim' kill -9 -1
run 2 'BLOCKED by Peers Flow kill shim' kill -- -1
run 2 'BLOCKED by Peers Flow kill shim' kill -s TERM -1

# --- refusal is exactly one stderr line
lines=$( { env pkill node -9 >/dev/null; } 2>&1 | wc -l | tr -d ' ')
[ "$lines" = 1 ]; expect "refusal prints one stderr line (got $lines)" $?

# --- a pattern that matches far too much right now: 16 sleepers of our own, then none
tag="pfguard-selftest-$$-$RANDOM"
# spawned from a subshell so they are not our jobs (no "Terminated" notices); pids come back on stdout
pids=($(for i in $(seq 1 16); do bash -c "exec -a $tag sleep 30" >/dev/null 2>&1 & echo $!; done))
sleep 0.5
run 2 'would signal' pkill -f "$tag"
builtin kill "${pids[@]}" 2>/dev/null; pids=(); gone
run 1 '' pkill -f "$tag"

# --- legitimate calls pass through to the real binary with its own exit code
run 1 '' pkill -9 -f no-such-proc-zzz
run 0 '' kill -0 $$
out=$(env kill -l 2>/dev/null); rc=$?
[ "$rc" = 0 ] && printf '%s' "$out" | grep -q 'TERM'; expect "kill -l exits 0 and lists signal names" $?

# --- escape hatch: env var passes through untouched (pattern matches nothing → real exit 1)
run 1 '' BH_ALLOW_MASS_KILL=1 pkill -9 -f no-such-proc-zzz

# --- no python3 on PATH: fail open (pass-through)
PATH="/nonexistent:$BIN" "$BIN/pkill" -9 -f no-such-proc-zzz >/dev/null 2>&1; rc=$?
[ "$rc" = 1 ]; expect "no python3 on PATH -> pass-through (rc $rc, want 1)" $?

# --- the check breaking (rc 3) also fails open, with a note on stderr
FAKE=$(mktemp -d "${TMPDIR:-/tmp}/pf-shims-selftest.XXXXXX")
printf '#!/bin/bash\nexit 3\n' > "$FAKE/python3"; chmod +x "$FAKE/python3"
err=$(PATH="$FAKE:$BIN:$ORIG_PATH" "$BIN/pkill" -9 -f no-such-proc-zzz 2>&1 >/dev/null); rc=$?
[ "$rc" = 1 ] && printf '%s' "$err" | grep -q 'kill shim check failed (rc 3), passing through'; expect "check rc 3 -> warn + pass-through (rc $rc)" $?
rm -rf "$FAKE"

export PATH="$ORIG_PATH"
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
