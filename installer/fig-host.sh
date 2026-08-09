#!/bin/bash
# Native messaging host wrapper: resolve node, then exec the host.
# Chrome execs this path directly and speaks stdio to it, so stdout is the
# protocol channel and NOTHING may be written to it. Diagnostics go to
# /tmp/fig-host.log instead.
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG=/tmp/fig-host.log
. "$DIR/node-resolve.sh"

if ! fig_resolve_node; then
  {
    echo "[fig-host] $(date '+%Y-%m-%d %H:%M:%S') FAILED: no usable Node.js found"
    fig_node_report
  } >> "$LOG" 2>&1
  exit 1
fi

exec "$FIG_NODE" "$DIR/fig-host.js"
