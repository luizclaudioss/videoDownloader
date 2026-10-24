#!/bin/bash
# Instala o Video Radar Helper para iniciar automaticamente no login (macOS).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
PY="$(command -v python3)"
PLIST="$HOME/Library/LaunchAgents/com.videoradar.helper.plist"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.videoradar.helper</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$DIR/videoradar_helper.py</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
sleep 1
curl -s http://127.0.0.1:47654/ping && echo && echo "✅ Video Radar Helper instalado e rodando."
