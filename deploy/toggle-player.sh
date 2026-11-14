#!/bin/bash
# Pára ou retoma os vídeos do player (o output fica visível, parado; o Pi descodifica menos). Atalho global F9 (ver ~/.config/labwc/rc.xml).
# É o mesmo que o botão "Turn off player" do painel: pede ao servidor que alterne o estado (POST /api/player {"toggle":true}).
# A tecla repetida dispara várias vezes seguidas: ignora chamadas com menos de 2 s de intervalo. Variável: PORT (por omissão 8080).
PORT="${PORT:-8080}"
LAST=/tmp/toggle-player-gvpt.last; NOW=$(date +%s)
[ -f "$LAST" ] && [ $((NOW - $(cat "$LAST" 2>/dev/null || echo 0))) -lt 2 ] && exit 0
echo "$NOW" > "$LAST"
R=$(curl -fsS -m 5 -X POST -H 'Content-Type: application/json' -d '{"toggle":true}' "http://localhost:$PORT/api/player" 2>&1)
case "$R" in
  *'"on":false'*) MSG="Vídeos parados" ;;
  *'"on":true'*)  MSG="Vídeos a correr" ;;
  *)              MSG="Não consegui falar com o servidor (porta $PORT)" ;;
esac
echo "$MSG"
command -v notify-send >/dev/null && notify-send "GVPT" "$MSG" 2>/dev/null
exit 0
