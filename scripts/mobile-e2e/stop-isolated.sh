#!/bin/bash
# Stops ONLY the isolated instance recorded in $PF_PIDFILE, plus the processes it spawned
# (Electron helpers, PTY shells, its codex app-server). Claude --bg daemons are owned by the
# claude CLI daemon, not by this instance, and are left alone. Never kills by name.
set -euo pipefail
source /Users/iij/Desktop/AgentsFlow/scripts/mobile-e2e/env.sh

if [[ ! -f "$PF_PIDFILE" ]]; then
  echo "no pid file ($PF_PIDFILE); nothing to stop"
  exit 0
fi
pid=$(tr -dc '0-9' < "$PF_PIDFILE")
if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
  echo "pid ${pid:-?} is not running; removing pid file"
  rm -f /Users/iij/.claude/jobs/106e55f3/tmp/pf-mobile.pid
  exit 0
fi
cmd=$(ps -o command= -p "$pid" || true)
if [[ "$cmd" != *"Electron"*"scripts/mobile-e2e/wrapper.js"* ]]; then
  echo "pid $pid is not the isolated instance ($cmd); refusing" >&2
  exit 1
fi

# Snapshot the descendants now: once the parent dies they are re-parented to launchd.
descendants() {
  local root=$1 kids k
  kids=$(pgrep -P "$root" || true)
  for k in $kids; do echo "$k"; descendants "$k"; done
}
victims=()
for d in $(descendants "$pid"); do
  c=$(ps -o command= -p "$d" 2>/dev/null || true)
  [[ -z "$c" ]] && continue
  # claude CLI / --bg daemons and their pty hosts belong to the claude daemon: leave them.
  if [[ "$c" == *"/.local/share/claude/"* || "$c" == *"/.local/bin/claude"* || "$c" == claude* ]]; then continue; fi
  victims+=("$d")
done
# Its own codex app-server (detached, keyed on this userData) if one was started.
for d in $(pgrep -f "$PF_USERDATA/codex/" || true); do victims+=("$d"); done

echo "SIGTERM $pid (+${#victims[@]} spawned processes)"
kill -TERM "$pid" 2>/dev/null || true
for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$pid" 2>/dev/null; then echo "still alive after 5 s: SIGKILL $pid"; kill -KILL "$pid" 2>/dev/null || true; fi
for v in "${victims[@]:-}"; do
  [[ -z "$v" ]] && continue
  if kill -0 "$v" 2>/dev/null; then kill -TERM "$v" 2>/dev/null || true; fi
done
sleep 1
for v in "${victims[@]:-}"; do
  [[ -z "$v" ]] && continue
  if kill -0 "$v" 2>/dev/null; then kill -KILL "$v" 2>/dev/null || true; fi
done
rm -f /Users/iij/.claude/jobs/106e55f3/tmp/pf-mobile.pid
echo "stopped"
echo "--- last [agentsflow][mobile] lines ---"
grep -a '\[agentsflow\]\[mobile\]' "$PF_LOG" | tail -n 5 || true
