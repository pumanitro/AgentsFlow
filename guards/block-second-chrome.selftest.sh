#!/usr/bin/env bash
# Self-test for block-second-chrome.sh. Every case feeds a PreToolUse payload (built with jq) and
# checks deny/allow. Hermetic: the hook only reads stdin, no browser is started.
# Usage: bash <dir>/block-second-chrome.selftest.sh   (any cwd)
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$DIR/block-second-chrome.sh"
pass=0; fail=0

check() { # $1 = deny|allow, $2 = command
  local out got
  out=$(jq -cn --arg c "$2" '{tool_name:"Bash",tool_input:{command:$c}}' | bash "$HOOK" 2>&1)
  if printf '%s' "$out" | grep -q '"permissionDecision": *"deny"'; then got=deny; else got=allow; fi
  if [ "$got" = "$1" ]; then pass=$((pass+1)); printf 'ok    %-5s %s\n' "$1" "$2"
  else fail=$((fail+1)); printf 'FAIL  want %-5s got %-5s %s\n' "$1" "$got" "$2"; [ -n "$out" ] && printf '      %s\n' "$out"; fi
}

# --- a second instance of the real Google Chrome.app
check deny  '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --user-data-dir=/tmp/x'
check deny  '/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9333 --user-data-dir=/tmp/y'
check deny  'open -na "Google Chrome" --args --remote-debugging-port=9333'
check deny  'open -n -b com.google.Chrome --args --headless'
check deny  "const b = await chromium.launch({ channel: 'chrome' })"
check deny  'puppeteer.launch({executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"})'

# --- legitimate commands stay allowed
check allow 'pgrep -fl "Google Chrome"'
check allow '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir=$HOME/Library/Application\ Support/Google/ChromeAuto --remote-debugging-port=9222'
check allow 'bh-throwaway-chrome --headed'
check allow 'BH_ALLOW_SECOND_CHROME=1 open -na "Google Chrome"'
check allow 'open -a "Google Chrome" https://example.com'
check allow "const b = await chromium.launch({ headless: true })"

# --- the deny names the installed path
out=$(jq -cn '{tool_name:"Bash",tool_input:{command:"open -na \"Google Chrome\""}}' | bash "$HOOK")
if printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecisionReason | test("~/.claude/hooks/peersflow/block-second-chrome.sh")' >/dev/null 2>&1; then
  pass=$((pass+1)); echo "ok    reason names ~/.claude/hooks/peersflow/block-second-chrome.sh"
else fail=$((fail+1)); echo "FAIL  reason does not name the peersflow path: $out"; fi

echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
