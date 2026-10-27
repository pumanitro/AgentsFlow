#!/usr/bin/env bash
# PreToolUse guard: refuse any command that would start a SECOND instance of the user's
# Google Chrome (/Applications/Google Chrome.app) — headless or not.
#
# WHY THIS EXISTS
#   Every copy of that bundle registers with macOS LaunchServices as com.google.Chrome, the
#   default browser, and LaunchServices hands EVERY link the user clicks in another app
#   (Teams, Slack, Peers Flow, `open …`) to the OLDEST running instance. A throwaway that
#   outlives a Chrome restart therefore hijacks the user's link clicks — invisibly when
#   headless. 2026-09-09→10: an orphaned `--headless=new` experiment swallowed a full day of
#   Trello / lab-page clicks into tabs nobody could see.
#
#   Prose rules in CLAUDE.md are advisory. This is the part that actually says no.
#   Use `bh-throwaway-chrome` instead (Google Chrome for Testing, bundle id
#   com.google.chrome.for.testing — LaunchServices never routes a URL to it).
#
# WHAT IS BLOCKED (Bash tool_input.command)
#   * the real binary  …/Google Chrome.app/Contents/MacOS/Google Chrome  invoked with a
#     launch flag (--user-data-dir / --headless / --remote-debugging-port|pipe / --app / --profile-directory)
#   * open -n / -na / --new  with "Google Chrome" or com.google.Chrome
#   * Playwright/Puppeteer  channel: "chrome"  or  executablePath pointing into Google Chrome.app
# WHAT IS NOT
#   * the user's own instance (…/Google/ChromeAuto profile) — restarting it is legitimate
#   * ps/pgrep/lsof/kill/grep lines that merely mention the binary (no launch flag)
#   * bh-throwaway-chrome, Chrome for Testing, Chromium
#
# CONTRACT
#   stdin  : PreToolUse hook JSON     stdout : nothing (allow) | permissionDecision:"deny" JSON
#   exit   : always 0 — a crashing hook must not wedge the session
#
# ESCAPE HATCH
#   Include the literal token BH_ALLOW_SECOND_CHROME=1 in the command. Only with the user's
#   explicit OK — the reaper will still kill the instance the moment it is older than the
#   user's own Chrome.
set -uo pipefail

payload=$(cat)
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "${cmd:-}" ] && exit 0

case "$cmd" in *BH_ALLOW_SECOND_CHROME=1*) exit 0 ;; esac

hit=""
# 1. direct exec of the real binary with a launch flag (any quoting/escaping of the space)
if printf '%s' "$cmd" | grep -qE 'Google[ \\]*Chrome\.app/Contents/MacOS/Google[ \\]*Chrome'; then
  if printf '%s' "$cmd" | grep -qE -- '--(user-data-dir|headless|remote-debugging-(port|pipe)|app=|profile-directory)'; then
    case "$cmd" in *Google/ChromeAuto*) ;; *) hit="direct launch of Google Chrome.app binary" ;; esac
  fi
fi
# 2. LaunchServices new-instance launch
if [ -z "$hit" ] && printf '%s' "$cmd" | grep -qE 'open +(-[a-zA-Z]*n[a-zA-Z]* +|--new +).*("Google Chrome"|Google\\ Chrome|com\.google\.Chrome)'; then
  hit="open -n … Google Chrome (new LaunchServices instance)"
fi
# 3. Playwright / Puppeteer pointed at the real Chrome
if [ -z "$hit" ] && printf '%s' "$cmd" | grep -qE "channel *[:=] *['\"]chrome['\"]"; then
  hit="Playwright/Puppeteer channel:'chrome'"
fi
if [ -z "$hit" ] && printf '%s' "$cmd" | grep -qE 'executablePath.{0,120}Google[ \\]*Chrome\.app'; then
  hit="executablePath into Google Chrome.app"
fi

[ -z "$hit" ] && exit 0

reason="BLOCKED by ~/.claude/hooks/peersflow/block-second-chrome.sh — starting a second instance of /Applications/Google Chrome.app is forbidden (matched: ${hit}). Every instance registers with macOS LaunchServices as com.google.Chrome, and LaunchServices hands the user's link clicks (Teams, Peers Flow, \`open\`) to the OLDEST running instance — a headless orphan swallowed a day of the user's links on 2026-09-09→10. Use \`bh-throwaway-chrome [--headed]\` instead: it starts Google Chrome for Testing (bundle id com.google.chrome.for.testing, never a LaunchServices target) and prints BU_CDP_URL=…; \`bh-throwaway-chrome stop <port>\` when done. See the 'NEVER start a second copy of Google Chrome.app' section in ~/.claude/CLAUDE.md."

jq -cn --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}'
exit 0
