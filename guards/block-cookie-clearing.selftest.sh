#!/usr/bin/env bash
# Self-test for block-cookie-clearing.sh. Every case feeds a PreToolUse payload (built with jq) and
# checks deny/allow. Hermetic: the hook only reads stdin, nothing on disk is touched.
# Usage: bash <dir>/block-cookie-clearing.selftest.sh   (any cwd)
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$DIR/block-cookie-clearing.sh"
pass=0; fail=0

verdict() { # $1 = deny|allow, $2 = label, stdin = payload
  local out got
  out=$(bash "$HOOK" 2>&1)
  if printf '%s' "$out" | grep -q '"permissionDecision": *"deny"'; then got=deny; else got=allow; fi
  if [ "$got" = "$1" ]; then pass=$((pass+1)); printf 'ok    %-5s %s\n' "$1" "$2"
  else fail=$((fail+1)); printf 'FAIL  want %-5s got %-5s %s\n' "$1" "$got" "$2"; [ -n "$out" ] && printf '      %s\n' "$out"; fi
}
check() { # Bash tool: $1 = deny|allow, $2 = command
  verdict "$1" "$2" < <(jq -cn --arg c "$2" '{tool_name:"Bash",tool_input:{command:$c}}')
}
check_js() { # claude-in-chrome javascript tool: $1 = deny|allow, $2 = code
  verdict "$1" "[js] $2" < <(jq -cn --arg c "$2" '{tool_name:"mcp__claude-in-chrome__javascript_tool",tool_input:{code:$c}}')
}

# --- clearing the shared cookie jar / site data
check    deny  'node -e "await cdp.send(\"Network.clearBrowserCookies\")"'
check_js deny  'await chrome.debugger.sendCommand({tabId}, "Network.clearBrowserCookies")'
check    deny  "osascript -e 'tell application \"Google Chrome\" to execute javascript \"localStorage.clear()\"'"
check_js deny  'localStorage.clear()'
check    deny  'rm -f ~/Library/Application\ Support/Google/Chrome/Default/Cookies'
check    deny  'await context.clearCookies()'
check    deny  'sqlite3 Cookies "DELETE FROM cookies"'

# --- legitimate commands stay allowed
check    allow 'echo hello'
check    allow 'grep -rn clearBrowserCookies src/ # ALLOW_COOKIE_PATTERN_SCAN'
check_js allow 'document.cookie.length'
check    allow 'ls ~/Library/Application\ Support/Google/Chrome/Default'

# --- the deny names the installed path
out=$(jq -cn '{tool_name:"Bash",tool_input:{command:"localStorage.clear()"}}' | bash "$HOOK")
if printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecisionReason | test("~/.claude/hooks/peersflow/block-cookie-clearing.sh")' >/dev/null 2>&1; then
  pass=$((pass+1)); echo "ok    reason names ~/.claude/hooks/peersflow/block-cookie-clearing.sh"
else fail=$((fail+1)); echo "FAIL  reason does not name the peersflow path: $out"; fi

echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
