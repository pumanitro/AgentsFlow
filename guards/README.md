# Peers Flow guards

Safety checks that stop a Claude Code chat from doing a few things that have already hurt this
machine: wiping the browser's logins, starting a second Chrome that swallows link clicks, killing
far more programs than intended, and spawning sub-agents while the Mac is out of memory.

**Installed by Peers Flow on start into `~/.claude/hooks/peersflow/` — change these files in the
repo (`guards/`), the app overwrites the installed copies every time it starts.** On start the app
copies every file, runs each guard's selftest, and registers only the guards that pass as
`PreToolUse` hooks in `~/.claude/settings.json` (new entries reach NEW chat sessions only). The
kill shims go on every chat's `PATH` once their selftest passes.

## Layout

```
guards/                              installed as ~/.claude/hooks/peersflow/
  README.md                          this file
  block-cookie-clearing.sh           hook: no clearing of cookies / site data
  block-cookie-clearing.selftest.sh
  block-second-chrome.sh             hook: no second copy of Google Chrome.app
  block-second-chrome.selftest.sh
  block-mass-kill.py                 hook: no misordered pkill / kill -1 / huge pkill (calls lib/killcheck.py)
  block-mass-kill.selftest.sh
  mem-admission.sh                   hook: no new sub-agent while memory is short
  mem-admission.selftest.sh
  lib/killcheck.py                   the ONE kill decision core, shared by the hook and the shims (Python >= 3.9)
  bin/pkill                          PATH shim -> lib/killcheck.py -> /usr/bin/pkill
  bin/kill                           PATH shim -> lib/killcheck.py -> /bin/kill
  bin/shims.selftest.sh
```

Every selftest runs from any directory (`bash guards/<name>.selftest.sh`), exits 0 on success and
prints a `passed=N failed=M` (mem-admission: `passed: N  failed: M`) line. None of them touches real
files under `~/.claude` or `~/Library`, and none runs a real dangerous `pkill`/`kill`: the
"too many matches" cases start 16 throwaway `sleep` processes under a unique name and kill exactly
those.

Every hook reads the Claude Code `PreToolUse` JSON on stdin, prints nothing to allow or a
`permissionDecision: "deny"` object to refuse, and always exits 0 — a broken hook must never wedge
a chat.

## The guards

### Cookie guard — `block-cookie-clearing.sh` (Bash and claude-in-chrome tools)
- **Blocks:** CDP cookie/cache clearing (`Network.clearBrowserCookies`, `Storage.clearDataForOrigin`, …),
  Playwright/Puppeteer `clearCookies(` / `deleteCookie(`, `chrome.browsingData.remove*`,
  `chrome://settings/clearBrowserData`, `localStorage.clear()` / `sessionStorage.clear()`,
  `DELETE FROM cookies`, and `rm`/`mv`/`truncate` of a profile's `Cookies` or `Local Storage`.
  Why: the automation browser IS the daily-driver browser, so one call signs the user out of everything.
- **Does not block:** reading cookies (`document.cookie.length`), listing the profile folder, anything
  in a throwaway browser that does not use those verbs.
- **Escape token:** `ALLOW_COOKIE_PATTERN_SCAN` in the command — for read-only searches of code that
  mentions these patterns.

### Second-Chrome guard — `block-second-chrome.sh` (Bash)
- **Blocks:** launching `/Applications/Google Chrome.app`'s binary with a launch flag
  (`--user-data-dir`, `--headless`, `--remote-debugging-port|pipe`, `--app=`, `--profile-directory`),
  `open -n … "Google Chrome"` / `com.google.Chrome`, Playwright `channel: 'chrome'`, and
  `executablePath` into Google Chrome.app. Why: macOS sends every clicked link to the OLDEST running
  Chrome, so a hidden second copy eats the user's links.
- **Does not block:** restarting the user's own instance (the `Google/ChromeAuto` profile), `pgrep`/`ps`
  lines that only mention Chrome, `open -a "Google Chrome" <url>`, `bh-throwaway-chrome`
  (Chrome for Testing), Chromium.
- **Escape token:** `BH_ALLOW_SECOND_CHROME=1` in the command, only with the user's explicit OK.

### Mass-kill guard — `block-mass-kill.py` + `lib/killcheck.py` (Bash)
- **Blocks:** `pkill` with an option after its first pattern (`pkill foo -9`, `pkill -f x -U 501 -n`
  — macOS turns those options into extra patterns), `pgrep` with the same mistake piped into `kill`,
  `kill` with `-1` as a target (every process you own), and a `pkill` whose pattern matches more than
  15 running processes right now. Also inside `bash -c '…'`, `eval`, `sudo`, `xargs`, `timeout`,
  `nice`, `env` and friends. Why: on 2026-10-27 `pkill -f "…" -U 501 -n` stopped ~130 programs and
  the Mac had to be rebooted.
- **Does not block:** correctly ordered `pkill`/`pgrep`, `kill <pid>`, `kill -- -<pgid>`, text that
  merely mentions these commands (`echo`, commit messages). The live-match count is skipped when the
  command contains `$`, `` ` ``, `*` or `?` (the pattern is not known before the shell expands it).
- **Escape token:** `BH_ALLOW_MASS_KILL=1` in the command, only with the user's explicit OK.

### Memory admission — `mem-admission.sh` (Agent and Task tools)
- **Blocks:** starting a new sub-agent while this Mac has no memory room for one (asks
  `~/.claude/tools/cpu-gate/mem-budget.mjs`), after waiting up to 40 s for room. A refusal leaves a
  marker in `~/.claude/locks/mem-deferred/` so the Peers Flow Keeper resumes the chat once memory is
  free. Why: on 2026-09-22 a burst of parallel agents ran the Mac out of memory and it hard-rebooted.
- **Does not block:** any other tool; it lets the agent through ("fails open") whenever memory cannot
  be read (no `node`, no `mem-budget.mjs`).
- **Escape hatches:** `MEM_ADMISSION_OVERRIDE=1` in the agent prompt, `MEM_ADMISSION_OFF=1` in the
  hook's environment, or `touch ~/.claude/locks/mem-admission-off` (valid for 2 hours).

### Kill shims — `bin/pkill`, `bin/kill` (every chat's PATH)
- **Blocks:** the same `pkill` / `kill` mistakes as the mass-kill guard, decided by the same
  `lib/killcheck.py`, but at the moment the program actually runs — so they also catch scripts,
  Makefiles, npm scripts and `xargs kill`, which the hook never sees. A refusal exits 2 with one line
  on stderr that shows the corrected command.
- **Does not block:** anything else — the call is handed to `/usr/bin/pkill` or `/bin/kill` with the
  identical arguments and their own exit code. If `python3` is missing or the check itself breaks,
  the shim passes the call through ("fails open") rather than stopping legitimate work.
- **Escape token:** `BH_ALLOW_MASS_KILL=1` in the environment, only with the user's explicit OK.

## Known gap: the `kill` shell builtin

`kill` is built into every shell, and a shell runs its builtin without looking at `PATH`, so a bare
`kill -9 -1` typed into a shell never reaches `bin/kill`. In a chat's Bash tool that command is still
caught by the mass-kill hook (which reads the command text); what slips through is a `kill` inside a
script or a non-Bash tool that runs its own shell. Only `env kill`, `xargs kill`, scripts that call
the external `kill`, and non-shell callers hit the shim. Injecting a shell function through
`ZDOTDIR`/`BASH_ENV` would close the gap but rewrite every chat's shell startup, so it is not done.
`pkill` has no builtin and is always covered.
