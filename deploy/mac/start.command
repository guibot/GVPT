#!/bin/bash
# macOS: arranca o servidor e abre o player em ecrã inteiro (duplo clique, ou ./deploy/mac/start.command).
# Ctrl+C ou fechar esta janela pára o servidor.
#   NO_PLAYER=1      só o servidor (sem abrir o browser)
#   PORT=8080        porta do servidor
#   BROWSER_APP="Google Chrome"   escolhe o browser (por defeito: Chrome, Chromium, Edge, Brave)
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PORT:-8080}"
URL="${PLAYER_URL:-http://localhost:$PORT/player/}"
PROFILE="${PLAYER_PROFILE:-$HOME/Library/Application Support/video-player-browser}"   # perfil próprio

for cmd in node ffmpeg ffprobe; do
  command -v "$cmd" >/dev/null || { echo "Falta '$cmd'. Corre primeiro: bash deploy/mac/install.command" >&2; exit 1; }
done

cd "$ROOT/server" || exit 1
[ -d node_modules ] || npm install --omit=dev || exit 1
PORT="$PORT" node index.js &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT INT TERM

if [ "$NO_PLAYER" != "1" ]; then
  for _ in $(seq 1 60); do curl -fs -o /dev/null "http://localhost:$PORT/api/info" && break; sleep 1; done
  APP="$BROWSER_APP"
  if [ -z "$APP" ]; then
    for a in "Google Chrome" "Chromium" "Microsoft Edge" "Brave Browser"; do
      [ -d "/Applications/$a.app" ] && { APP="$a"; break; }
    done
  fi
  if [ -z "$APP" ]; then echo "Sem Chrome/Chromium/Edge/Brave em /Applications. Abre $URL num browser." >&2
  else
    open -na "$APP" --args --user-data-dir="$PROFILE" --kiosk --noerrdialogs --disable-infobars \
      --disable-session-crashed-bubble --disable-features=Translate,TranslateUI --no-first-run \
      --no-default-browser-check --autoplay-policy=no-user-gesture-required \
      --overscroll-history-navigation=0 --disable-pinch "$URL"
  fi
fi
wait $SERVER
