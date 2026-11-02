#!/bin/bash
# Builds what the isolated instance runs: dist/electron always, renderer/out only when stale.
# The renderer export runs with AGENTSFLOW_EXPORT=1 (renderer/next.config.js), which writes
# renderer/out and never touches the dev server's renderer/.next-dev.
set -euo pipefail
source /Users/iij/Desktop/AgentsFlow/scripts/mobile-e2e/env.sh
cd "$PF_REPO"

if pgrep -f "next build" >/dev/null 2>&1; then
  echo "another 'next build' is running (pid $(pgrep -f 'next build' | tr '\n' ' ')); refusing to build" >&2
  exit 1
fi

t0=$(date +%s)
npm run build:electron
echo "build:electron ok ($(( $(date +%s) - t0 )) s)"

out="$PF_REPO/renderer/out/index.html"
newest=$(find "$PF_REPO/renderer/components" "$PF_REPO/renderer/pages" "$PF_REPO/renderer/lib" "$PF_REPO/renderer/styles" "$PF_REPO/shared" -type f -newer "$out" -print -quit 2>/dev/null || true)
if [[ ! -f "$out" || -n "$newest" ]]; then
  echo "renderer export is stale (${newest:-missing index.html}); rebuilding"
  t1=$(date +%s)
  npm run build:renderer
  echo "build:renderer ok ($(( $(date +%s) - t1 )) s)"
else
  echo "renderer export is up to date; skipped"
fi
