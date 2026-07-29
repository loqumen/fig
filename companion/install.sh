#!/bin/bash
# Fig companion installer: keeps figd running at login via launchd.
# Run from the Fig folder: ./companion/install.sh
set -euo pipefail
cd "$(dirname "$0")"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Fig needs Node.js (https://nodejs.org or: brew install node)"; exit 1; }
DEST="$HOME/.fig/app"
mkdir -p "$DEST"
cp figd.js "$DEST/figd.js"
LABEL="com.loqumen.figd"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key><array><string>$NODE</string><string>$DEST/figd.js</string></array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>10</integer>
	<key>StandardOutPath</key><string>/tmp/figd.log</string>
	<key>StandardErrorPath</key><string>/tmp/figd.log</string>
</dict>
</plist>
PLIST_EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 1
echo "Fig companion is running (and will start at login)."
echo "Your extension token is in ~/.fig/settings.json — paste it into the Fig popup once."
