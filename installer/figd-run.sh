#!/bin/bash
# LaunchAgent entry point: resolve node, then run the companion daemon.
DIR="$(cd "$(dirname "$0")" && pwd)"
for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  [ -x "$c" ] && exec "$c" "$DIR/figd.js"
done
if command -v node >/dev/null 2>&1; then exec "$(command -v node)" "$DIR/figd.js"; fi
for d in "$HOME"/.nvm/versions/node/*/bin/node; do
  [ -x "$d" ] && exec "$d" "$DIR/figd.js"
done
exit 1
