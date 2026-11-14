#!/bin/bash
# Arranca o servidor deste projeto (se ainda não estiver a correr) e abre o Chromium em ecrã inteiro no player.
# Alternativa ao serviço systemd: arranca à mão, a partir do desktop do Pi.
#   PORT=8080 ./deploy/start-all.sh      (a porta por omissão é a 8080)
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
export PORT="${PORT:-8080}"
LOG="${XDG_CACHE_HOME:-$HOME/.cache}/gvpt.log"
mkdir -p "$(dirname "$LOG")"

notify-send -t 6000 "GVPT" "A arrancar o servidor e o player (demora uns 30 s)…" 2>/dev/null

up() { curl -fs -o /dev/null "http://localhost:$PORT/api/info"; }

if ! up; then
  # Se a porta estiver ocupada por outra coisa que não responde como nós, não vale a pena continuar.
  cd "$ROOT/server" && setsid nohup node index.js >>"$LOG" 2>&1 </dev/null &
  for _ in $(seq 1 30); do up && break; sleep 1; done
  up || { notify-send "GVPT" "O servidor não arrancou (porta $PORT). Ver $LOG" 2>/dev/null; echo "servidor não arrancou; ver $LOG" >&2; exit 1; }
fi

# Abre o player (se ainda não estiver aberto).
exec "$HERE/start-player.sh"
