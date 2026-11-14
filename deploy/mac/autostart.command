#!/bin/bash
# macOS: arrancar automaticamente ao iniciar sessão (LaunchAgent do utilizador; não toca em /Library nem em /etc).
#   ./deploy/mac/autostart.command on | off | status
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="$(basename "$(cd "$HERE/../.." && pwd)")"
LABEL="local.$NAME"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
case "$1" in
  on)
    mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$HERE/start.command</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict></plist>
EOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null; launchctl bootstrap "$DOMAIN" "$PLIST" \
      && echo "autostart LIGADO ($LABEL): arranca ao iniciar sessão." ;;
  off)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null; rm -f "$PLIST"; echo "autostart DESLIGADO." ;;
  status|"")
    [ -f "$PLIST" ] && echo "autostart: LIGADO ($PLIST)" || echo "autostart: desligado" ;;
  *) echo "uso: $0 on|off|status" >&2; exit 2 ;;
esac
