#!/bin/bash
# Build, sign, notarize and package Fig Companion + the DMG users download.
#
# This exists as a committed script because the recipe used to live in /tmp.
# When /tmp was cleared the recipe was rebuilt from memory and the 0.3.6 DMG
# shipped with the app alone -- no extension/, no INSTALL.html -- so every
# person who downloaded it followed an install step three that pointed at a
# folder that was not there. The verify phase at the bottom is the guard: the
# script refuses to publish a DMG that is missing any piece of the install.
#
# Usage: installer/ship.sh <version>          e.g. installer/ship.sh 0.4.1
#        installer/ship.sh <version> --no-notarize   (local test build)

set -euo pipefail

VERSION="${1:-}"
[ -n "$VERSION" ] || { echo "usage: $0 <version> [--no-notarize]"; exit 2; }
NOTARIZE=1
[ "${2:-}" = "--no-notarize" ] && NOTARIZE=0

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$REPO/build"
STAGE="$BUILD/dmg-root"
APP="$BUILD/Fig Companion.app"
DMG="$REPO/dist/Fig_${VERSION}_universal.dmg"

IDENTITY="Developer ID Application: Braden Tinnin (FKSX2YR7TC)"
ASC_KEY="$HOME/Desktop/Claude Codebases/hq/signing/AuthKey_S77VZ4JV2H.p8"
ASC_KEY_ID="S77VZ4JV2H"
ASC_ISSUER="e6386155-3acd-4305-8702-2ca3a9e19fd8"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# ---- 1. compile universal ---------------------------------------------------
say "Compiling FigCompanion $VERSION (arm64 + x86_64)"
rm -rf "$BUILD"
mkdir -p "$BUILD/obj" "$APP/Contents/MacOS" "$APP/Contents/Resources"
for arch in arm64 x86_64; do
  swiftc -O -target "${arch}-apple-macos13.0" \
    -o "$BUILD/obj/FigCompanion-$arch" "$REPO/installer/main.swift"
done
lipo -create -output "$APP/Contents/MacOS/FigCompanion" \
  "$BUILD/obj/FigCompanion-arm64" "$BUILD/obj/FigCompanion-x86_64"
chmod 755 "$APP/Contents/MacOS/FigCompanion"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key><string>Fig Companion</string>
  <key>CFBundleExecutable</key><string>FigCompanion</string>
  <key>CFBundleIconFile</key><string>FigCompanion</string>
  <key>CFBundleIdentifier</key><string>com.loqumen.figcompanion</string>
  <key>CFBundleName</key><string>Fig Companion</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

cp "$REPO/installer/FigCompanion.icns" "$APP/Contents/Resources/FigCompanion.icns"

# ---- 2. stage the payload ---------------------------------------------------
say "Staging payload"
PAYLOAD="$APP/Contents/Resources/payload"
mkdir -p "$PAYLOAD"
# Every companion module ships. Listing them by hand is how figd.js came to
# require a sibling (inline-assets.js) that was not in the bundle.
for f in "$REPO"/companion/*.js; do cp "$f" "$PAYLOAD/"; done
cp "$REPO/companion/package.json" "$PAYLOAD/"
cp -R "$REPO/scaffold" "$PAYLOAD/scaffold"
cp "$REPO/installer/node-resolve.sh"        "$PAYLOAD/node-resolve.sh"
cp "$REPO/installer/extension-ids.txt"      "$PAYLOAD/extension-ids.txt"
cp "$REPO/installer/figd-run.sh"            "$PAYLOAD/figd-run"
cp "$REPO/installer/fig-host.sh"            "$PAYLOAD/fig-host"
cp "$REPO/installer/fig-allow-extension.sh" "$PAYLOAD/fig-allow-extension"
chmod 755 "$PAYLOAD/figd-run" "$PAYLOAD/fig-host" "$PAYLOAD/node-resolve.sh" \
          "$PAYLOAD/fig-allow-extension"
# Demo pages are development fixtures, not product.
rm -f "$PAYLOAD"/*-demo.html

say "Checking the payload is self-contained"
for js in "$PAYLOAD"/*.js; do node --check "$js"; done
bash -n "$PAYLOAD/figd-run" "$PAYLOAD/fig-host" "$PAYLOAD/node-resolve.sh" "$PAYLOAD/fig-allow-extension"
missing=0
for js in "$PAYLOAD"/*.js; do
  while IFS= read -r dep; do
    [ -f "$PAYLOAD/$dep" ] || { echo "MISSING: $(basename "$js") requires ./$dep"; missing=1; }
  done < <(grep -oE 'require\("\./[^"]+"\)' "$js" | sed -E 's|require\("\./([^"]+)"\)|\1|')
done
[ "$missing" -eq 0 ] || { echo "Payload is missing a required module."; exit 1; }

# ---- 3. sign ----------------------------------------------------------------
say "Signing"
codesign --force --options runtime --timestamp \
  --sign "$IDENTITY" "$APP/Contents/MacOS/FigCompanion"
codesign --force --options runtime --timestamp \
  --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

# ---- 4. notarize the app ----------------------------------------------------
if [ "$NOTARIZE" -eq 1 ]; then
  say "Notarizing the app"
  ditto -c -k --keepParent "$APP" "$BUILD/FigCompanion.zip"
  xcrun notarytool submit "$BUILD/FigCompanion.zip" \
    --key "$ASC_KEY" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER" --wait
  xcrun stapler staple "$APP"
fi

# ---- 5. assemble the DMG ----------------------------------------------------
# Everything the install needs travels together: the app, the extension the
# user loads unpacked, the instructions, the licence.
say "Assembling the DMG"
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/Fig Companion.app"
cp -R "$REPO/extension" "$STAGE/extension"
cp "$REPO/installer/INSTALL.html" "$STAGE/INSTALL.html"
cp "$REPO/LICENSE" "$STAGE/LICENSE"
ln -s /Applications "$STAGE/Applications"
find "$STAGE" -name '.DS_Store' -delete

mkdir -p "$REPO/dist"
rm -f "$DMG"
hdiutil create -volname "Fig" -srcfolder "$STAGE" -ov -format UDZO -quiet "$DMG"
codesign --force --timestamp --sign "$IDENTITY" "$DMG"

if [ "$NOTARIZE" -eq 1 ]; then
  say "Notarizing the DMG"
  xcrun notarytool submit "$DMG" \
    --key "$ASC_KEY" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER" --wait
  xcrun stapler staple "$DMG"
fi

# ---- 6. verify what actually shipped ----------------------------------------
# The whole point of this phase: prove the artifact a user downloads carries
# every piece of the documented install, by reading the DMG, not the staging
# folder it was built from.
say "Verifying the DMG"
MP="$(mktemp -d)"
hdiutil attach -nobrowse -quiet "$DMG" -mountpoint "$MP"
fail=0
for required in \
  "Fig Companion.app/Contents/MacOS/FigCompanion" \
  "Fig Companion.app/Contents/Resources/payload/figd.js" \
  "Fig Companion.app/Contents/Resources/payload/inline-assets.js" \
  "Fig Companion.app/Contents/Resources/payload/node-resolve.sh" \
  "Fig Companion.app/Contents/Resources/payload/figd-run" \
  "Fig Companion.app/Contents/Resources/payload/fig-host" \
  "Fig Companion.app/Contents/Resources/payload/fig-allow-extension" \
  "Fig Companion.app/Contents/Resources/payload/extension-ids.txt" \
  "extension/manifest.json" \
  "extension/background.js" \
  "extension/fig-overlay.js" \
  "INSTALL.html" \
  "LICENSE" \
  "Applications" ; do
  [ -e "$MP/$required" ] || { echo "  MISSING FROM DMG: $required"; fail=1; }
done
got="$(defaults read "$MP/Fig Companion.app/Contents/Info" CFBundleShortVersionString)"
[ "$got" = "$VERSION" ] || { echo "  VERSION MISMATCH: bundle says $got, building $VERSION"; fail=1; }
if [ "$NOTARIZE" -eq 1 ]; then
  spctl -a -vv "$MP/Fig Companion.app" 2>&1 | grep -q "accepted" || { echo "  GATEKEEPER REJECTED THE APP"; fail=1; }
fi
hdiutil detach "$MP" -quiet
rmdir "$MP" 2>/dev/null || true
[ "$fail" -eq 0 ] || { echo; echo "DMG verification FAILED -- not shippable."; rm -f "$DMG"; exit 1; }

say "Shipped: $DMG"
echo "Publish with: cp '$DMG' ~/CLAUDE/projects/loqumen/public/products/Fig_universal.dmg"
