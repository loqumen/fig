#!/bin/bash
# LaunchAgent entry point: resolve node, then run the companion daemon.
# launchd sends stdout and stderr to /tmp/figd.log, so everything printed here
# is what a user (or their Claude) reads when the companion fails to come up.
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/node-resolve.sh"

echo "[figd-run] $(date '+%Y-%m-%d %H:%M:%S') starting"

if ! fig_resolve_node; then
  echo "[figd-run] FAILED: no usable Node.js found"
  fig_node_report
  # Exit 0 with a delay rather than 1: KeepAlive would respawn a hard failure
  # in a tight loop, launchd would throttle it, and the log would fill with
  # duplicates of this same report.
  sleep 30
  exit 0
fi

echo "[figd-run] node: $FIG_NODE ($("$FIG_NODE" -v 2>/dev/null))"
exec "$FIG_NODE" "$DIR/figd.js"
