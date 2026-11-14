#!/bin/bash
# Abre o Chromium em ecrã inteiro no ecrã (o ciclo deploy/kiosk-session.sh). Não mexe no servidor.
# Usado pelo atalho do desktop (start-all.sh). Variáveis: PORT, VS_DIR, PLAYER_PROFILE.
HERE="${VS_DIR:-$(cd "$(dirname "$0")" && pwd)}"
PORT="${PORT:-8080}"
# Já está ligado: não abre outro.
pgrep -u "$(id -u)" -f "^/bin/bash $HERE/kiosk-session.sh" >/dev/null && exit 0
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}" XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export PLAYER_URL="http://localhost:$PORT/player/"
export PLAYER_PROFILE="${PLAYER_PROFILE:-$HOME/.config/video-player-chromium}"
# Em segundo plano e desligado deste processo, para o script devolver já o controlo (o toggle F9 e o servidor não ficam à espera).
setsid "$HERE/kiosk-session.sh" >/dev/null 2>&1 </dev/null &
disown
exit 0
