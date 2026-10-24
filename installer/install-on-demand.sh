#!/bin/bash
# Set up the Fig companion from this repo, started only when Fig needs it.
#
# - Registers the native messaging host (com.loqumen.fig) for every Chromium browser.
# - Installs a LaunchAgent (com.loqumen.figd.ondemand) that never starts at login
#   and never restarts itself. The native host asks launchd to start it when the
#   extension sends a job, lists figs, or publishes; it exits after 30 idle minutes.
# - Points at this checkout: pulling the repo updates the companion.
#
# Usage: installer/install-on-demand.sh            install or update
#        installer/install-on-demand.sh --remove   undo everything this installs
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SUPPORT="$HOME/Library/Application Support/Fig"
LABEL="com.loqumen.figd.ondemand"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
EXT_ID="lifccpiojocfhbmomkbdobgknhjimhbm"   # the unpacked extension's id (fixed by its manifest key)
IDLE_MIN="${FIG_IDLE_EXIT_MIN:-30}"
UID_NUM="$(id -u)"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  for f in fig-host figd-run node-resolve.sh fig-host.js figd.js; do rm -f "$SUPPORT/$f"; done
  find "$HOME/Library/Application Support" -path "*/NativeMessagingHosts/com.loqumen.fig.json" -delete 2>/dev/null || true
  echo "Removed the on-demand companion."
  exit 0
fi

if [ -f "$HOME/Library/LaunchAgents/com.loqumen.figd.plist" ]; then
  echo "The Fig Companion app's always-on agent is installed (com.loqumen.figd)."
  echo "Remove it first, or keep using it: the two would compete for port 41414."
  exit 1
fi

mkdir -p "$SUPPORT" "$HOME/.fig" "$HOME/Library/LaunchAgents"
cp "$REPO/installer/fig-host.sh" "$SUPPORT/fig-host"
cp "$REPO/installer/figd-run.sh" "$SUPPORT/figd-run"
cp "$REPO/installer/node-resolve.sh" "$SUPPORT/node-resolve.sh"
chmod +x "$SUPPORT/fig-host" "$SUPPORT/figd-run"
# Node runs the real files, so __dirname (and the scaffold beside it) is the repo.
ln -sf "$REPO/companion/fig-host.js" "$SUPPORT/fig-host.js"
ln -sf "$REPO/companion/figd.js" "$SUPPORT/figd.js"

echo "Registering the browser connection:"
"$REPO/installer/fig-allow-extension.sh" "$EXT_ID"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$SUPPORT/figd-run</string></array>
  <key>EnvironmentVariables</key><dict><key>FIG_IDLE_EXIT_MIN</key><string>$IDLE_MIN</string></dict>
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>$HOME/.fig/figd.log</string>
  <key>StandardErrorPath</key><string>$HOME/.fig/figd.log</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
echo "Installed. The companion starts when Fig needs it and stops after $IDLE_MIN idle minutes."
