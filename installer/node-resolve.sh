#!/bin/bash
# Shared Node resolver, sourced by figd-run.sh and fig-host.sh.
#
# Both wrappers run from launchd or from Chrome's native-messaging exec, and
# neither inherits the user's shell PATH. A user whose Node came from fnm,
# volta, asdf, mise, n, or a keg-only Homebrew formula has no binary at any of
# the three classic paths, so the old three-path check reported "not found" on
# a machine with a perfectly good Node. Sets FIG_NODE, or returns 1.
#
# Order: explicit override, classic paths, version managers, keg-only Homebrew,
# inherited PATH, then a login shell -- the catch-all, since it sources the
# profile that defines the user's shim, whatever manager put it there.

fig_node_ok() {
  # Usable means executable AND Node 18+. A 0.10 binary left over on the box
  # would otherwise satisfy a bare -x check and then fail at require().
  [ -n "$1" ] && [ -x "$1" ] || return 1
  local major
  major="$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || return 1
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  [ "$major" -ge 18 ]
}

# Version-manager install trees, newest version first, so a stale old install
# never wins over a current one.
fig_manager_candidates() {
  local d
  for d in "$HOME"/.nvm/versions/node/*/bin/node \
           "$HOME"/.fnm/node-versions/*/installation/bin/node \
           "$HOME"/Library/Application\ Support/fnm/node-versions/*/installation/bin/node \
           "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
           "$HOME"/.asdf/installs/nodejs/*/bin/node \
           "$HOME"/.local/share/mise/installs/node/*/bin/node \
           "$HOME"/.local/share/mise/installs/nodejs/*/bin/node \
           "$HOME"/n/versions/node/*/bin/node \
           "$HOME"/.n/versions/node/*/bin/node; do
    [ -e "$d" ] && printf '%s\n' "$d"
  done | sort -Vr
}

fig_resolve_node() {
  local c

  # 1. Explicit override. Anyone diagnosing a failure can record a path here
  #    and be done, without waiting on a new build.
  if [ -f "$HOME/.fig/node-path" ]; then
    c="$(tr -d '[:space:]' < "$HOME/.fig/node-path" 2>/dev/null)"
    if fig_node_ok "$c"; then FIG_NODE="$c"; return 0; fi
  fi

  # 2. Classic absolute paths, including MacPorts.
  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node /opt/local/bin/node; do
    if fig_node_ok "$c"; then FIG_NODE="$c"; return 0; fi
  done

  # 3. Version-manager install trees.
  while IFS= read -r c; do
    if fig_node_ok "$c"; then FIG_NODE="$c"; return 0; fi
  done <<< "$(fig_manager_candidates)"

  # Volta and the asdf/mise shims resolve through their own launcher.
  for c in "$HOME/.volta/bin/node" "$HOME/.asdf/shims/node" "$HOME/.local/share/mise/shims/node"; do
    if fig_node_ok "$c"; then FIG_NODE="$c"; return 0; fi
  done

  # 4. Keg-only Homebrew formulae (node@20, node@22, ...) are never linked into bin.
  for c in /opt/homebrew/opt/node@*/bin/node /usr/local/opt/node@*/bin/node; do
    if fig_node_ok "$c"; then FIG_NODE="$c"; return 0; fi
  done

  # 5. Whatever is already on PATH.
  c="$(command -v node 2>/dev/null)"
  if fig_node_ok "$c"; then FIG_NODE="$c"; return 0; fi

  # 6. Login shell. The catch-all: it sources the profile where the user's
  #    manager installs its shim, so it finds setups this file has never heard
  #    of. Timed out because a slow profile must not hang Chrome's native
  #    messaging handshake.
  local sh="${SHELL:-/bin/zsh}"
  if [ -x "$sh" ]; then
    c="$("$sh" -lc 'command -v node' 2>/dev/null &
         pid=$!
         ( sleep 8; kill -9 "$pid" 2>/dev/null ) >/dev/null 2>&1 &
         watchdog=$!
         wait "$pid" 2>/dev/null
         kill "$watchdog" 2>/dev/null)"
    c="$(printf '%s\n' "$c" | tail -1 | tr -d '[:space:]')"
    if fig_node_ok "$c"; then FIG_NODE="$c"; return 0; fi
  fi

  return 1
}

fig_node_report() {
  # Printed on failure so the log says something actionable instead of nothing.
  cat <<REPORT
Fig could not find a usable Node.js (18 or newer) on this Mac.

Looked in: /opt/homebrew/bin, /usr/local/bin, /usr/bin, /opt/local/bin,
nvm, fnm, asdf, mise, n, volta, keg-only Homebrew node@*, the PATH this
process inherited, and a login shell (${SHELL:-/bin/zsh}).

Two ways to fix it:
  1. Install Claude Code (it brings its own Node), or install Node 18+
     from nodejs.org. Then open Fig Companion again.
  2. If Node IS installed somewhere unusual, record its path and reopen
     Fig Companion:
        mkdir -p ~/.fig && command -v node > ~/.fig/node-path
REPORT
}
