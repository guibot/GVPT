#!/bin/bash
# Linux (desktop genérico, não só o Pi): arranca o servidor e abre o player em ecrã inteiro.
# Ctrl+C ou fechar esta janela pára o servidor.
#   NO_PLAYER=1     só o servidor (sem abrir o browser)
#   PORT=8080       porta do servidor
#   BROWSER_BIN=... escolhe o browser (por defeito: chromium, chromium-browser, google-chrome, brave-browser, microsoft-edge)
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PORT:-8080}"
URL="${PLAYER_URL:-http://localhost:$PORT/player/}"
PROFILE="${PLAYER_PROFILE:-$HOME/.config/video-player-browser}"

for cmd in node ffmpeg ffprobe; do
  command -v "$cmd" >/dev/null || { echo "Falta '$cmd'. Corre primeiro: bash deploy/linux/install.sh" >&2; exit 1; }
done

cd "$ROOT/server" || exit 1
[ -d node_modules ] || npm install --omit=dev || exit 1
PORT="$PORT" node index.js &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT INT TERM

if [ "$NO_PLAYER" != "1" ]; then
  for _ in $(seq 1 60); do curl -fs -o /dev/null "http://localhost:$PORT/api/info" && break; sleep 1; done
  BIN="$BROWSER_BIN"
  if [ -z "$BIN" ]; then for b in chromium chromium-browser google-chrome brave-browser microsoft-edge; do command -v "$b" >/dev/null && { BIN="$b"; break; }; done; fi
  if [ -z "$BIN" ]; then echo "Sem Chromium/Chrome/Brave/Edge. Abre $URL num browser." >&2
  else
    "$BIN" --user-data-dir="$PROFILE" --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
      --disable-features=Translate,TranslateUI --no-first-run --no-default-browser-check --password-store=basic \
      --autoplay-policy=no-user-gesture-required --overscroll-history-navigation=0 --disable-pinch "$URL" &
  fi
fi
wait $SERVER
