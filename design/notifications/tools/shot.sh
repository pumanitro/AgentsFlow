#!/usr/bin/env bash
# tools/shot.sh — screenshot one gallery page and check it renders cleanly.
#
# usage:
#   tools/shot.sh <abs-html-path> <abs-out-png> [width=1440] [height=900] [theme=dark|light] [hash]
#
# success prints exactly one line:   shot: <png> · errors=[] · scroll=ok
# exit 1 (with the reason on stderr) when the page has JS errors (window.__pfErrors non-empty),
# scrolls sideways (documentElement.scrollWidth > innerWidth), or no PNG was written.
#
# How: starts a private, headless, muted Chrome for Testing via `bh-throwaway-chrome`
# (never the user's Chrome on :9222, never /Applications/Google Chrome.app), drives it with
# browser-harness under a unique BU_NAME="shot-<port>", and always stops it on exit.
# Safe to run several in parallel.
# Optional: SHOT_FULL=1 captures the whole scrolling page instead of just the viewport
# (same checks, same one-line output).
# Fallback (only if browser-harness cannot attach): a one-shot `--screenshot` run of the same
# Chrome for Testing binary; prints `errors=unchecked · scroll=unchecked` (checks skipped).
set -euo pipefail

die() { echo "shot.sh: $*" >&2; exit 1; }

[ $# -ge 2 ] || die "usage: shot.sh <abs-html-path> <abs-out-png> [width] [height] [dark|light] [hash]"
HTML=$1; OUT=$2; W=${3:-1440}; H=${4:-900}; THEME=${5:-dark}; HASH=${6:-}
case "$HTML" in /*) ;; *) die "html path must be absolute: $HTML" ;; esac
case "$OUT" in /*) ;; *) die "out path must be absolute: $OUT" ;; esac
QS=""; case "$HTML" in *\?*) QS="?${HTML#*\?}"; HTML="${HTML%%\?*}";; esac
[ -f "$HTML" ] || die "no such file: $HTML"
case "$THEME" in dark|light) ;; *) die "theme must be dark or light, got: $THEME" ;; esac
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"

URL="file://$HTML$QS"
[ -n "$HASH" ] && URL="$URL#$HASH"

TMPBASE="${CLAUDE_JOB_DIR:-${TMPDIR:-/tmp}}"; TMPBASE="${TMPBASE%/}"
[ -n "${CLAUDE_JOB_DIR:-}" ] && TMPBASE="$TMPBASE/tmp"
mkdir -p "$TMPBASE"

PORT=""; PROFILE=""
cleanup() {
  [ -n "$PORT" ] && bh-throwaway-chrome stop "$PORT" >/dev/null 2>&1 || true
  case "$PROFILE" in */chrome-shot-*) rm -rf "$PROFILE" "$PROFILE.log" 2>/dev/null || true ;; esac
  PROFILE=""
}
trap cleanup EXIT

START_OUT=$(bh-throwaway-chrome --name "shot-$$-$RANDOM" 2>&1) || die "could not start Chrome for Testing: $START_OUT"
CDP=$(printf '%s\n' "$START_OUT" | sed -n 's/^BU_CDP_URL=//p' | head -1)
[ -n "$CDP" ] || die "no BU_CDP_URL in bh-throwaway-chrome output: $START_OUT"
PORT=${CDP##*:}
PROFILE=$(printf '%s\n' "$START_OUT" | sed -n 's/^PROFILE=//p' | head -1)
[ "$PORT" != "9222" ] || die "refusing to drive port 9222 (the user's Chrome)"

export BU_CDP_URL="$CDP" BU_NAME="shot-$PORT" BH_LEGACY_TABS=1
export SHOT_URL="$URL" SHOT_OUT="$OUT" SHOT_W="$W" SHOT_H="$H" SHOT_THEME="$THEME"

RES_FILE="$TMPBASE/shot-result-$PORT.txt"
set +e
browser-harness >"$RES_FILE" 2>&1 <<'PY'
import os, time, json
W = int(os.environ["SHOT_W"]); H = int(os.environ["SHOT_H"])
new_tab("about:blank")
cdp("Emulation.setDeviceMetricsOverride", width=W, height=H, deviceScaleFactor=1, mobile=(W < 600))
cdp("Emulation.setEmulatedMedia", features=[{"name": "prefers-color-scheme", "value": os.environ["SHOT_THEME"]}])
goto_url(os.environ["SHOT_URL"])
wait_for_load()
time.sleep(1.0)
if os.environ.get("SHOT_FULL") == "1":
    import base64
    ph = int(js("Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)"))
    r = cdp("Page.captureScreenshot", format="png", captureBeyondViewport=True, clip={"x": 0, "y": 0, "width": W, "height": min(ph, 16000), "scale": 1})
    open(os.environ["SHOT_OUT"], "wb").write(base64.b64decode(r["data"]))
else:
    capture_screenshot(os.environ["SHOT_OUT"])
print("PFERR=" + js("JSON.stringify(window.__pfErrors||[])"))
print("PFOVER=" + json.dumps(js("document.documentElement.scrollWidth>window.innerWidth")))
print("PFSW=" + json.dumps(js("[document.documentElement.scrollWidth, window.innerWidth]")))
PY
BH_RC=$?
set -e
RES=$(cat "$RES_FILE"); rm -f "$RES_FILE"
# stop the harness daemon for this BU_NAME (best effort)
browser-harness --reload >/dev/null 2>&1 </dev/null || true

ERRS=$(printf '%s\n' "$RES" | sed -n 's/^PFERR=//p' | tail -1)
OVER=$(printf '%s\n' "$RES" | sed -n 's/^PFOVER=//p' | tail -1)
SW=$(printf '%s\n' "$RES" | sed -n 's/^PFSW=//p' | tail -1)

if [ "$BH_RC" -ne 0 ] || [ -z "$ERRS" ]; then
  # FALLBACK: browser-harness could not attach — one-shot headless screenshot, checks skipped.
  echo "shot.sh: browser-harness failed (rc=$BH_RC), using fallback: $(printf '%s' "$RES" | tail -3)" >&2
  cleanup; PORT=""
  BIN=$(for app in "$HOME"/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/"Google Chrome for Testing.app" "$HOME"/.cache/puppeteer/chrome/*/chrome-mac-arm64/"Google Chrome for Testing.app"; do [ -d "$app" ] && echo "$app/Contents/MacOS/Google Chrome for Testing"; done | tail -1)
  [ -n "$BIN" ] || die "fallback: no Google Chrome for Testing binary found"
  "$BIN" --headless=new --mute-audio --no-first-run --disable-gpu --hide-scrollbars \
    --window-size="$W,$H" --user-data-dir="$TMPBASE/shot-profile-$$" \
    --virtual-time-budget=4000 --screenshot="$OUT" "$URL" >/dev/null 2>&1 || true
  [ -s "$OUT" ] || die "fallback: no PNG written to $OUT"
  echo "shot: $OUT · errors=unchecked · scroll=unchecked"
  exit 0
fi

[ -s "$OUT" ] || die "no PNG written to $OUT"
FAIL=""
[ "$ERRS" = "[]" ] || FAIL="JS errors: $ERRS"
[ "$OVER" = "false" ] || FAIL="${FAIL:+$FAIL; }horizontal overflow: scrollWidth/innerWidth=$SW"
if [ -n "$FAIL" ]; then
  echo "shot: $OUT · errors=$ERRS · scroll=$([ "$OVER" = "false" ] && echo ok || echo OVERFLOW)"
  echo "shot.sh: $FAIL" >&2
  exit 1
fi
echo "shot: $OUT · errors=[] · scroll=ok"
