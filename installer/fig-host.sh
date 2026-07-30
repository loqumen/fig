#!/bin/bash
# Native messaging host wrapper: resolve node, then exec the host.
# Chrome execs this path directly and speaks stdio to it.
DIR="$(cd "$(dirname "$0")" && pwd)"
for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  [ -x "$c" ] && exec "$c" "$DIR/fig-host.js"
done
if command -v node >/dev/null 2>&1; then exec "$(command -v node)" "$DIR/fig-host.js"; fi
for d in "$HOME"/.nvm/versions/node/*/bin/node; do
  [ -x "$d" ] && exec "$d" "$DIR/fig-host.js"
done
exit 1
