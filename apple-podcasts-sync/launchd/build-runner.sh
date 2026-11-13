#!/bin/bash
# Builds ~/.claude/ApplePodcastsSync.app (#322), the ad-hoc-signed wrapper
# launchd runs (same shape as ~/.claude/AwcAgent.app). Grant it Full Disk
# Access once. Rebuilding changes the ad-hoc identity, so macOS may drop the
# grant — re-add the app in System Settings → Privacy & Security after a rebuild.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${APPLE_PODCASTS_SYNC_APP:-$HOME/.claude/ApplePodcastsSync.app}"

mkdir -p "$APP/Contents/MacOS"
swiftc -O "$HERE/ApplePodcastsSyncRunner.swift" -o "$APP/Contents/MacOS/ApplePodcastsSyncRunner"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>ApplePodcastsSyncRunner</string>
  <key>CFBundleIdentifier</key><string>com.claude.apple-podcasts-sync</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP"
echo "built $APP"
