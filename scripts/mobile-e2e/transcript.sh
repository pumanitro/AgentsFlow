#!/bin/bash
# Reads the scratch peer's Claude Code transcripts (JSONL) under $TRANSCRIPTS.
#   transcript.sh latest               path of the newest transcript (subagents/ ignored)
#   transcript.sh count-user <text>    number of non-meta `user` entries (all transcripts) whose text contains <text>
#   transcript.sh show [file]          kind / uuid / first 80 chars per message entry (default: latest)
set -euo pipefail
source /Users/iij/Desktop/AgentsFlow/scripts/mobile-e2e/env.sh

latest() {
  ls -t "$TRANSCRIPTS"/*.jsonl 2>/dev/null | head -n 1
}

cmd=${1:-}
case "$cmd" in
  latest)
    f=$(latest); [[ -n "$f" ]] || { echo "no transcripts in $TRANSCRIPTS" >&2; exit 1; }
    echo "$f" ;;
  count-user)
    needle=${2:?usage: transcript.sh count-user <text>}
    shopt -s nullglob
    files=("$TRANSCRIPTS"/*.jsonl)
    if (( ${#files[@]} == 0 )); then echo 0; exit 0; fi
    python3 - "$needle" "${files[@]}" <<'PY'
import json, sys
needle, files = sys.argv[1], sys.argv[2:]
n = 0
for f in files:
    with open(f, encoding='utf-8', errors='replace') as fh:
        for line in fh:
            try: e = json.loads(line)
            except Exception: continue
            if e.get('type') != 'user' or e.get('isMeta'): continue
            c = (e.get('message') or {}).get('content')
            texts = [c] if isinstance(c, str) else [p.get('text', '') for p in (c or []) if isinstance(p, dict) and p.get('type') == 'text']
            if any(needle in t for t in texts): n += 1
print(n)
PY
    ;;
  show)
    f=${2:-$(latest)}; [[ -n "$f" && -f "$f" ]] || { echo "no transcript" >&2; exit 1; }
    python3 - "$f" <<'PY'
import json, sys
for line in open(sys.argv[1], encoding='utf-8', errors='replace'):
    try: e = json.loads(line)
    except Exception: continue
    t = e.get('type')
    if t not in ('user', 'assistant'): continue
    c = (e.get('message') or {}).get('content')
    parts = [('text', c)] if isinstance(c, str) else [(p.get('type'), p) for p in (c or []) if isinstance(p, dict)]
    for kind, p in parts:
        if kind == 'text': text = p if isinstance(p, str) else p.get('text', '')
        elif kind == 'tool_use': text = p.get('name', '')
        elif kind == 'tool_result': text = str(p.get('content', ''))
        elif kind == 'thinking': text = '(thinking)'
        else: text = ''
        meta = ' meta' if e.get('isMeta') else ''
        print(f"{t}.{kind}{meta}\t{e.get('uuid','')}\t{' '.join(str(text).split())[:80]}")
PY
    ;;
  *) echo "usage: transcript.sh latest|count-user <text>|show [file]" >&2; exit 2 ;;
esac
