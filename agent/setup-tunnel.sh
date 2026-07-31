#!/bin/zsh
# One-shot setup for the promenade-agent Cloudflare tunnel (run ON the Mac mini).
# Creates the tunnel, routes promenade-agent.georgeolaru.com to it, writes the
# config + LaunchAgent, starts it, and health-checks the public URL.
set -euo pipefail
CF=/Users/macbook/.local/bin/cloudflared
HOST=promenade-agent.georgeolaru.com
DIR=/Users/macbook/services/promenade-finder

$CF tunnel create promenade-agent
UUID=$($CF tunnel list | awk '/promenade-agent/ {print $1}')
echo "tunnel UUID: $UUID"
$CF tunnel route dns promenade-agent $HOST

cat > $DIR/agent/cloudflared.yml <<CONF
tunnel: $UUID
credentials-file: /Users/macbook/.cloudflared/$UUID.json

ingress:
  - hostname: $HOST
    service: http://127.0.0.1:3041
  - service: http_status:404
CONF

cat > /Users/macbook/Library/LaunchAgents/com.georgeolaru.promenade-agent-tunnel.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.georgeolaru.promenade-agent-tunnel</string>
    <key>ProgramArguments</key>
    <array>
      <string>$CF</string>
      <string>tunnel</string>
      <string>--config</string>
      <string>$DIR/agent/cloudflared.yml</string>
      <string>run</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$DIR/logs/tunnel.stdout.log</string>
    <key>StandardErrorPath</key><string>$DIR/logs/tunnel.stderr.log</string>
  </dict>
</plist>
PLIST

launchctl unload /Users/macbook/Library/LaunchAgents/com.georgeolaru.promenade-agent-tunnel.plist 2>/dev/null || true
launchctl load /Users/macbook/Library/LaunchAgents/com.georgeolaru.promenade-agent-tunnel.plist
sleep 6
curl -s https://$HOST/health && echo " ← tunnel LIVE"
