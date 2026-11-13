#!/bin/bash
# Builds ~/.claude/AwcAgent.app (#317), the ad-hoc-signed wrapper launchd
# runs. Rebuilding changes the
# ad-hoc identity, so macOS may re-prompt for Automation (System Events).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${AWC_AGENT_APP:-$HOME/.claude/AwcAgent.app}"

mkdir -p "$APP/Contents/MacOS"
swiftc -O "$HERE/AwcAgentRunner.swift" -o "$APP/Contents/MacOS/AwcAgentRunner"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>AwcAgentRunner</string>
  <key>CFBundleIdentifier</key><string>com.claude.awc-agent</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP"
echo "built $APP"
