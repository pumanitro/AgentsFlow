#!/usr/bin/env python3
"""The one decision core for Peers Flow's mass-kill protection.

Used by BOTH
  * the PreToolUse hook  ~/.claude/hooks/peersflow/block-mass-kill.py   (check_command on the Bash string)
  * the PATH shims       ~/.claude/hooks/peersflow/bin/{pkill,kill}       (check_argv on the real argv)
so a rule fixed here is fixed for both. Edit it in the repo (guards/lib/killcheck.py) — Peers Flow
overwrites the installed copy on every start.

WHY THIS EXISTS
  2026-10-27 07:37:01 an agent cleaned up its dev servers with
      pkill -f "dashboard/api/server.mjs" -U $(id -u) -n
  macOS pkill (BSD getopt) stops reading options at the first pattern, so `-U`, `501` and `-n`
  became three MORE patterns, OR-ed together. "-n" matches every Chromium/Electron helper
  (--num-raster-threads, --no-sandbox, ...), so ~130 processes got SIGTERM at once. The machine
  had to be rebooted. The intended command (options first) matches 0 processes.

WHAT IS REFUSED
  * pkill with an option after its first pattern   (`pkill foo -9`, `pkill -f x -U 501 -n`)
  * pgrep with an option after its first pattern, when its output is piped into kill (shell strings only)
  * kill with -1 as a target                        (`kill -9 -1`, `kill -- -1`) = every process you own
  * pkill whose pattern matches more than MAX_MATCHES live processes right now
WHAT IS NOT
  * correctly ordered pkill/pgrep, kill <pid>, kill -- -<pgid>, text that merely mentions these

CLI
  python3 killcheck.py --shim <pkill|kill> -- ARG...  -> 0 allow (silent) | 2 refuse (one line on stderr) | 3 internal error
  python3 killcheck.py --command "<shell string>"     -> 0 allow (silent) | 2 refuse (reason on stdout)

Runs on /usr/bin/python3 3.9: no `match`, no `X | None` at runtime.
"""
from __future__ import annotations

import os
import re
import shlex
import subprocess
import sys
from typing import List, Optional, Tuple

MAX_MATCHES = 15
ESCAPE_TOKEN = "BH_ALLOW_MASS_KILL=1"   # literal in a command string (hook) / env var =1 (shims)
PGREP = "/usr/bin/pgrep"

SEPARATORS = {";", "&", "&&", "|", "||", "(", ")", "\n"}
PREFIXES = {"sudo", "command", "exec", "nohup", "time", "env", "builtin"}
# BSD pkill/pgrep options that take a value
PKILL_ARG_OPTS = set("FGgPstUuJcj")
SHELLS = {"bash", "sh", "zsh", "dash", "ksh", "fish"}
# wrapper -> its options that take a value; the wrapped command follows
WRAPPERS = {"xargs": set("IJLnPRSEs"), "timeout": set("sk"), "gtimeout": set("sk"), "nice": set("n"),
            "caffeinate": set("tw"), "stdbuf": set("ioe")}

# pids never counted as live matches: this process, plus (shim mode) the shim's own bash, whose
# command line carries the pattern but is about to be replaced by the real pkill via exec.
_EXCLUDE_PIDS = {os.getpid()}


def segments(cmd):
    """Split into simple commands; yields (argv, piped_into_next)."""
    lex = shlex.shlex(cmd.replace("\n", " ; "), posix=True, punctuation_chars=";&|()")
    lex.whitespace_split = True
    lex.commenters = ""
    toks = list(lex)
    cur = []
    for t in toks:
        if t in SEPARATORS or set(t) <= set(";&|()"):
            yield cur, t == "|"
            cur = []
        else:
            cur.append(t)
    yield cur, False


def strip_prefix(argv):
    i = 0
    while i < len(argv):
        a = argv[i]
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", a) or a in PREFIXES:
            i += 1
            continue
        w = os.path.basename(a)
        if w in WRAPPERS:
            i += 1
            while i < len(argv) and argv[i].startswith("-"):
                takes = len(argv[i]) == 2 and argv[i][1] in WRAPPERS[w]
                i += 2 if takes else 1
            if w in ("timeout", "gtimeout") and i < len(argv):
                i += 1  # the duration
            continue
        break
    return argv[i:]


def inner_scripts(prog, args):
    """Command strings nested inside `bash -c '…'` / `eval …`."""
    if prog == "eval":
        return [" ".join(args)]
    if prog in SHELLS:
        for j, a in enumerate(args):
            if a.startswith("-") and "c" in a[1:] and not a.startswith("--") and j + 1 < len(args):
                return [args[j + 1]]
    return []


def split_pkill(args: list) -> Tuple[List[str], List[str], List[str]]:
    """Return (options, operands, misplaced) following BSD getopt."""
    opts, operands, misplaced = [], [], []
    i, end_opts = 0, False
    while i < len(args):
        a = args[i]
        if operands or end_opts:
            if a == "--" and not end_opts and not operands:
                end_opts = True
            elif a.startswith("-") and len(a) > 1 and not end_opts:
                misplaced.append(a)
            operands.append(a)
        elif a == "--":
            end_opts = True
        elif a.startswith("-") and len(a) > 1:
            opts.append(a)
            if a[-1] in PKILL_ARG_OPTS and len(a) == 2 and i + 1 < len(args):
                i += 1
                opts.append(args[i])
        else:
            operands.append(a)
        i += 1
    return opts, operands, misplaced


def corrected_order(opts: list, operands: list) -> str:
    """The same pkill call with every option (and the value it takes, e.g. `-U 501`) before the patterns."""
    moved, patterns = [], []
    i = 0
    while i < len(operands):
        a = operands[i]
        if a.startswith("-") and len(a) > 1 and patterns:
            moved.append(a)
            if len(a) == 2 and a[1] in PKILL_ARG_OPTS and i + 1 < len(operands):
                i += 1
                moved.append(operands[i])
        else:
            patterns.append(a)
        i += 1
    return " ".join(moved + list(opts) + patterns)


def live_matches(opts: list, operands: list) -> int:
    """How many processes would pkill hit right now (via pgrep, signal option dropped). 0 on any failure."""
    if not operands:
        return 0
    keep = [o for o in opts if not re.fullmatch(r"-([0-9]+|[A-Z][A-Z0-9]*)", o)]
    try:
        out = subprocess.run([PGREP, *keep, "--", *operands],
                             capture_output=True, text=True, timeout=3).stdout
    except Exception:
        return 0
    n = 0
    for line in out.splitlines():
        first = line.split(None, 1)[0] if line.strip() else ""
        if not first:
            continue
        if first.isdigit() and int(first) in _EXCLUDE_PIDS:
            continue
        n += 1
    return n


def kill_targets_all(args: list) -> bool:
    """True when -1 is a target of kill (after -SIG / -s SIG / --)."""
    i = 0
    if i < len(args) and args[i] == "-s" and i + 1 < len(args):
        i += 2
    elif i < len(args) and args[i].startswith("-") and args[i] != "--" and len(args) > 1:
        i += 1  # -SIG / -9
    if i < len(args) and args[i] == "--":
        i += 1
    return "-1" in args[i:]


def check_argv(prog: str, args: list, count_live: bool = True) -> Optional[str]:
    """Per-program decision. prog = basename; None = allow, str = human reason."""
    prog = os.path.basename(prog)
    if prog == "pkill":
        opts, operands, misplaced = split_pkill(args)
        if misplaced:
            return (f"`pkill` has option(s) {' '.join(misplaced)} AFTER the pattern. On macOS pkill stops "
                    f"reading options at the first pattern, so they become extra patterns OR-ed in — "
                    f"`-n` alone matches ~90 processes (every Chrome/Electron helper). "
                    f"Put every option before the pattern: `pkill {corrected_order(opts, operands)}`.")
        if count_live:
            hits = live_matches(opts, operands)
            if hits > MAX_MATCHES:
                return (f"`pkill {' '.join(args)}` would signal {hits} live processes right now "
                        f"(limit {MAX_MATCHES}). Run `pgrep -lf ...` with the same arguments, then narrow "
                        f"the pattern or kill the exact pids.")
        return None
    if prog == "kill":
        if kill_targets_all(args):
            return "`kill ... -1` signals EVERY process you own (all apps, all browsers). Kill exact pids instead."
        return None
    return None


def _check(cmd):
    segs = list(segments(cmd))
    for n, (argv, piped) in enumerate(segs):
        argv = strip_prefix(argv)
        if not argv:
            continue
        prog, args = os.path.basename(argv[0]), argv[1:]
        for inner in inner_scripts(prog, args):
            why = _check(inner)
            if why:
                return why
        if prog in ("pkill", "kill"):
            why = check_argv(prog, args, count_live=not any(c in cmd for c in "$`*?"))
            if why:
                return why
        elif prog == "pgrep" and piped and n + 1 < len(segs):
            nxt = strip_prefix(segs[n + 1][0])
            if nxt and "kill" in " ".join(nxt[:2]):
                _, _, misplaced = split_pkill(args)
                if misplaced:
                    return (f"`pgrep` piped into kill has option(s) {' '.join(misplaced)} AFTER the pattern; "
                            f"on macOS they become extra patterns and match far too much. Put options first.")
    return None


def check_command(cmd: str) -> Optional[str]:
    """Decision for a whole shell string (the Bash tool's command). None = allow. Fails open."""
    if not cmd or ESCAPE_TOKEN in cmd:
        return None
    if not re.search(r"\b(pkill|pgrep|kill)\b", cmd):
        return None
    try:
        return _check(cmd)
    except Exception:
        return None


def main(argv: list) -> int:
    try:
        if len(argv) >= 2 and argv[0] == "--command":
            why = check_command(argv[1])
            if why:
                print(why)
                return 2
            return 0
        if len(argv) >= 3 and argv[0] == "--shim" and argv[2] == "--":
            prog = argv[1]
            if prog not in ("pkill", "kill"):
                sys.stderr.write(f"killcheck: unknown shim program {prog!r}\n")
                return 3
            _EXCLUDE_PIDS.add(os.getppid())
            why = check_argv(prog, argv[3:], count_live=True)
            if why:
                sys.stderr.write(f"{prog}: BLOCKED by Peers Flow kill shim — {why} "
                                 f"Set {ESCAPE_TOKEN} only with the user's OK.\n")
                return 2
            return 0
        sys.stderr.write("usage: killcheck.py --shim <pkill|kill> -- ARG... | --command STRING\n")
        return 3
    except Exception as e:  # never let a bug here look like a refusal
        sys.stderr.write(f"killcheck: internal error: {e!r}\n")
        return 3


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
