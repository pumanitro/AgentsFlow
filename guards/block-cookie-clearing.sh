#!/usr/bin/env bash
# PreToolUse guard: refuse any attempt to clear browser cookies / site data.
#
# WHY THIS EXISTS
#   ~/Library/Application Support/Google/Chrome is a symlink to .../Google/ChromeAuto,
#   and that profile runs with --remote-debugging-port=9222. The daily-driver browser
#   and the automation browser are the SAME cookie jar. A single clear-cookies call
#   therefore signs the user out of Google, banking and work SSO all at once — this has
#   already happened repeatedly (whole jar wiped, 137 cookies rebuilt from zero).
#
#   Prose rules in CLAUDE.md are advisory. This is the part that actually says no.
#
# CONTRACT
#   stdin  : PreToolUse hook JSON
#   stdout : nothing (allow), or a permissionDecision:"deny" object (block)
#   exit   : always 0 — a crashing hook must not wedge the session
#
# ESCAPE HATCH
#   Include the literal token ALLOW_COOKIE_PATTERN_SCAN in the command to audit these
#   patterns read-only (grep/rg over a codebase) without tripping the guard.
set -uo pipefail

payload=$(cat)

# Flatten every string in tool_input so the scan is agnostic to which tool fired and
# which field carries the payload (command, code, script, args, ...).
blob=$(printf '%s' "$payload" | jq -r '[.tool_input // {} | .. | strings] | join("\n")' 2>/dev/null)
[ -z "${blob:-}" ] && blob=$payload

case "$blob" in *ALLOW_COOKIE_PATTERN_SCAN*) exit 0 ;; esac

# CDP verbs, library wrappers, extension API, the settings page, and on-disk profile DBs.
pattern='clearBrowserCookies'
pattern="$pattern"'|clearBrowserCache'
pattern="$pattern"'|Network\.deleteCookies'
pattern="$pattern"'|Storage\.clearCookies'
pattern="$pattern"'|Storage\.clearDataForOrigin'
pattern="$pattern"'|Storage\.clearDataForStorageKey'
pattern="$pattern"'|clearCookies\('
pattern="$pattern"'|deleteCookie\('
pattern="$pattern"'|browsingData\.remove'
pattern="$pattern"'|chrome://settings/clearBrowserData'
pattern="$pattern"'|localStorage\.clear\('
pattern="$pattern"'|sessionStorage\.clear\('
pattern="$pattern"'|DELETE +FROM +cookies'
pattern="$pattern"'|(rm|shred|truncate|mv|:>|>) *[^|;&]*(Cookies|Local Storage)'

hit=$(printf '%s' "$blob" | grep -inE "$pattern" 2>/dev/null | head -3 | tr '\n' ' ' | cut -c1-300)

[ -z "${hit:-}" ] && exit 0

reason="BLOCKED by ~/.claude/hooks/peersflow/block-cookie-clearing.sh — clearing browser cookies or site data is forbidden. The user's daily-driver Chrome profile IS the automation profile (symlinked, CDP on :9222), so this wipes real Google/banking/work-SSO sessions. Matched: ${hit}. Instead: launch a throwaway Chrome with its own --user-data-dir under \$CLAUDE_JOB_DIR/tmp and clear whatever you want in there, or stop and ask the user naming exactly which cookies and why. See the 'NEVER clear cookies or site data' section in ~/.claude/CLAUDE.md."

jq -cn --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}'
exit 0
