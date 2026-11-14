#!/bin/bash
# Linux (Debian/Ubuntu, Fedora, Arch): instala Node.js, ffmpeg e um browser Chromium, e prepara a pasta.
# Pode ser corrido várias vezes: só instala o que falta. Pede sudo para instalar pacotes.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[31mErro: %s\033[0m\n' "$1" >&2; exit 1; }
[ "$(uname)" = "Linux" ] || die "Este script é só para Linux."

if command -v apt-get >/dev/null; then PM="apt"; elif command -v dnf >/dev/null; then PM="dnf"; elif command -v pacman >/dev/null; then PM="pacman"
else die "Gestor de pacotes não reconhecido. Instala à mão: Node.js 18+, ffmpeg e Chromium."; fi
pkg() { case "$PM" in
  apt) sudo apt-get install -y "$@" ;;
  dnf) sudo dnf install -y "$@" ;;
  pacman) sudo pacman -S --needed --noconfirm "$@" ;; esac; }

say "1/3 Node.js e ffmpeg"
command -v node >/dev/null || { case "$PM" in apt) pkg nodejs npm ;; dnf) pkg nodejs npm ;; pacman) pkg nodejs npm ;; esac; } || die "falhou a instalação do Node.js."
command -v ffmpeg >/dev/null || pkg ffmpeg || die "falhou a instalação do ffmpeg."
node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' || die "O Node.js é demasiado antigo (precisa de 18 ou mais). Instala uma versão recente (https://nodejs.org)."

say "2/3 Browser"
FOUND=""; for b in chromium chromium-browser google-chrome brave-browser microsoft-edge; do command -v "$b" >/dev/null && { FOUND="$b"; break; }; done
if [ -n "$FOUND" ]; then echo "$FOUND: já instalado."; else case "$PM" in apt) pkg chromium || pkg chromium-browser ;; dnf) pkg chromium ;; pacman) pkg chromium ;; esac || die "falhou a instalação do Chromium."; fi

say "3/3 A preparar o projecto"
chmod +x "$ROOT"/deploy/*.sh "$ROOT"/deploy/linux/*.sh
(cd "$ROOT/server" && npm install --omit=dev) || die "falhou 'npm install'."

say "Tudo pronto"
echo "Para arrancar:  $ROOT/deploy/linux/start.sh"
