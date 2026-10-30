#!/usr/bin/env python3
"""PreToolUse guard: refuse Bash commands that would signal far more processes than intended.

WHY THIS EXISTS
  2026-10-27 07:37:01 an agent cleaned up its dev servers with
      pkill -f "dashboard/api/server.mjs" -U $(id -u) -n
  macOS pkill (BSD getopt) stops reading options at the first pattern, so `-U`, `501` and `-n`
  became three MORE patterns, OR-ed together. "-n" matches every Chromium/Electron helper
  (--num-raster-threads, --no-sandbox, ...), so ~130 processes got SIGTERM at once: every
  Chrome tab ("Error code: 15"), Peers Flow's renderer + network service, Slack, Teams,
  Discord, Wispr, VS Code helpers, system UI agents. The machine had to be rebooted.
  The intended command (options first) matches 0 processes.

WHAT IS BLOCKED (Bash tool_input.command)
  * pkill with an option after its first pattern   (`pkill foo -9`, `pkill -f x -U 501 -n`)
  * pgrep with an option after its first pattern, when its output is piped into kill
  * kill with -1 as a target                        (`kill -9 -1`, `kill -- -1`) = every process you own
  * pkill whose pattern matches more than MAX_MATCHES live processes right now
  * pkill whose pattern matches a process running in another project's folder (2026-10-30: an
    ai-factory agent's `pkill -f "next dev"` took down the Peers Flow dev stack)
WHAT IS NOT
  * correctly ordered pkill/pgrep, kill <pid>, kill -- -<pgid>, text that merely mentions these

The decision itself lives in lib/killcheck.py (shared with the bin/pkill and bin/kill PATH shims).
Installed by Peers Flow into ~/.claude/hooks/peersflow/ — edit the repo copy (guards/), not this one.

CONTRACT
  stdin : PreToolUse hook JSON     stdout : nothing (allow) | permissionDecision:"deny" JSON
  exit  : always 0 — a crashing hook must not wedge the session

ESCAPE HATCH
  Include the literal token BH_ALLOW_MASS_KILL=1 in the command. Only with the user's explicit OK.
"""
import json
import os
import sys

sys.dont_write_bytecode = True


def _load_core():
    here = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, here)
    try:
        from lib.killcheck import check_command, ESCAPE_TOKEN
        return check_command, ESCAPE_TOKEN
    except ImportError:
        # a regular package named `lib` elsewhere on sys.path shadows our namespace dir — load by path
        import importlib.util
        spec = importlib.util.spec_from_file_location("pf_killcheck", os.path.join(here, "lib", "killcheck.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.check_command, mod.ESCAPE_TOKEN


def main():
    try:
        check_command, escape = _load_core()
        payload = json.load(sys.stdin)
        cmd = (payload.get("tool_input") or {}).get("command") or ""
        if not cmd or escape in cmd:
            return
        why = check_command(cmd, payload.get("cwd") or os.getcwd())
    except Exception:
        return
    if why:
        reason = ("BLOCKED by Peers Flow guard block-mass-kill (~/.claude/hooks/peersflow/block-mass-kill.py) — " + why +
                  " (On 2026-10-27 a misordered pkill SIGTERMed ~130 of the user's processes and forced a reboot.)")
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                                 "permissionDecision": "deny",
                                                 "permissionDecisionReason": reason}}))


if __name__ == "__main__":
    main()
