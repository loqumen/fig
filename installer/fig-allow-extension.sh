#!/bin/bash
# Allow another extension id to reach the Fig companion.
#
# The Web Store assigns its own permanent id, which cannot be known before an
# item exists, so the id list is data rather than something baked into the
# signed binary. This records an id and rewrites every browser's native
# messaging host manifest in place -- no reinstall, no new notarized build.
#
# Usage: fig-allow-extension <extension-id> [more ids...]
#        fig-allow-extension --list

set -euo pipefail

SUPPORT="$HOME/Library/Application Support/Fig"
STORE="$HOME/.fig/extension-ids.txt"
HOST_NAME="com.loqumen.fig"
BUILTIN="lifccpiojocfhbmomkbdobgknhjimhbm"

BROWSER_DIRS=(
  "Google/Chrome" "Google/Chrome Beta" "Google/Chrome Canary"
  "BraveSoftware/Brave-Browser" "BraveSoftware/Brave-Browser-Beta"
  "Microsoft Edge" "Chromium" "Vivaldi" "Arc"
)

valid_id() { [[ "$1" =~ ^[a-p]{32}$ ]]; }

collect_ids() {
  # Builtin first, then the bundled list, then the user's, deduped in order.
  { echo "$BUILTIN"
    sed 's/#.*//' "$SUPPORT/extension-ids.txt" 2>/dev/null || true
    sed 's/#.*//' "$STORE" 2>/dev/null || true
  } | tr '[:upper:]' '[:lower:]' | tr -d '[:blank:]' | grep -E '^[a-p]{32}$' | awk '!seen[$0]++'
}

write_manifests() {
  local ids origins target dir count=0
  ids="$(collect_ids)"
  # Comma after every line but the last. `paste -sd',\n'` CYCLES its delimiters,
  # so with three or more ids it emits a newline where a comma belongs and the
  # manifest stops being JSON.
  origins="$(printf '%s\n' "$ids" | awk '{lines[NR]="    \"chrome-extension://" $0 "/\""}
                                          END {for (i=1; i<=NR; i++) printf "%s%s\n", lines[i], (i<NR ? "," : "")}')"
  for b in "${BROWSER_DIRS[@]}"; do
    dir="$HOME/Library/Application Support/$b"
    [ -d "$dir" ] || continue                    # browser not installed
    mkdir -p "$dir/NativeMessagingHosts"
    target="$dir/NativeMessagingHosts/$HOST_NAME.json"
    cat > "$target" <<JSON
{
  "name": "$HOST_NAME",
  "description": "Fig companion bridge",
  "path": "$SUPPORT/fig-host",
  "type": "stdio",
  "allowed_origins": [
$origins
  ]
}
JSON
    count=$((count + 1))
    echo "  updated ${b##*/}"
  done
  [ "$count" -gt 0 ] || echo "  no Chromium browser found"
}

if [ "${1:-}" = "--list" ]; then
  echo "Extension ids allowed to reach the companion:"
  collect_ids | sed 's/^/  /'
  exit 0
fi

[ $# -gt 0 ] || { echo "usage: $(basename "$0") <extension-id> [more ids...]"; exit 2; }

[ -x "$SUPPORT/fig-host" ] || {
  echo "Fig Companion is not installed ($SUPPORT/fig-host is missing)."
  echo "Install it from loqumen.com/products first."
  exit 1
}

mkdir -p "$(dirname "$STORE")"
touch "$STORE"
for raw in "$@"; do
  id="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr -d '[:blank:]')"
  # Accept a pasted dashboard or store URL as well as a bare id.
  if ! valid_id "$id"; then
    extracted="$(printf '%s' "$id" | grep -oE '[a-p]{32}' | head -1 || true)"
    [ -n "$extracted" ] && id="$extracted"
  fi
  valid_id "$id" || { echo "Not an extension id: $raw"; exit 1; }
  if grep -qx "$id" "$STORE" 2>/dev/null; then
    echo "Already allowed: $id"
  else
    echo "$id" >> "$STORE"
    echo "Allowed: $id"
  fi
done

echo "Rewriting host manifests:"
write_manifests
echo
echo "Done. Reload the extension (or restart the browser) and press the Fig toolbar icon to confirm."
