#!/bin/bash
# Headless UI test for the fig overlay (comment/reply/highlight/persistence).
# Deterministic: dumps the DOM after a virtual-time budget, greps #results.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
BRAVE="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
[ -x "$BRAVE" ] || BRAVE="$(command -v chromium || command -v google-chrome || true)"
if [ -z "$BRAVE" ]; then echo "no chromium-family browser found"; exit 2; fi

OUT="$("$BRAVE" --headless --disable-gpu --allow-file-access-from-files \
  --dump-dom --virtual-time-budget=8000 \
  "file://$DIR/overlay-ui.html" 2>/dev/null)"

RESULTS="$(printf '%s' "$OUT" | sed -n 's/.*<pre id="results">//p' | sed 's/<\/pre>.*//')"
# sed one-liner fails on multi-line pre; extract with python instead.
RESULTS="$(printf '%s' "$OUT" | python3 -c '
import re, sys
m = re.search(r"<pre id=\"results\">(.*?)</pre>", sys.stdin.read(), re.S)
print(m.group(1) if m else "NO RESULTS BLOCK")
')"
echo "$RESULTS"
FAILS=$(printf '%s' "$RESULTS" | grep -c "FAIL" || true)
PASSES=$(printf '%s' "$RESULTS" | grep -c "PASS" || true)
echo "----"
echo "passes: $PASSES  fails: $FAILS"
[ "$FAILS" -eq 0 ] && [ "$PASSES" -gt 0 ]
