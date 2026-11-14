#!/bin/bash
# macOS: instala tudo o que o projecto precisa (Homebrew, Node, ffmpeg, Chrome) e prepara a pasta.
# Pode ser corrido várias vezes: só instala o que falta.
#   AUTOSTART=yes|no   responde de antemão à pergunta "arrancar ao ligar o Mac?" (por defeito pergunta)
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[31mErro: %s\033[0m\n' "$1" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || die "Este script é só para macOS."

# 1. Homebrew
say "1/5 Homebrew"
if ! command -v brew >/dev/null; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)" && break; done
fi
if command -v brew >/dev/null; then
  echo "já instalado."
else
  echo "A instalar o Homebrew. Vai pedir a palavra-passe do Mac (não aparece nada enquanto escreves)."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || die "falhou a instalação do Homebrew."
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)" && break; done
  command -v brew >/dev/null || die "o Homebrew instalou mas o comando 'brew' não foi encontrado."
fi
# Deixa o 'brew' disponível nos próximos terminais (uma só vez).
BREW_LINE="eval \"\$($(command -v brew) shellenv)\""
grep -qsF "$BREW_LINE" "$HOME/.zprofile" || echo "$BREW_LINE" >> "$HOME/.zprofile"

# 2. Node e ffmpeg
say "2/5 Node e ffmpeg"
for pkg in node ffmpeg; do
  if command -v "$pkg" >/dev/null; then echo "$pkg: já instalado."; else brew install "$pkg" || die "falhou 'brew install $pkg'."; fi
done

# 3. Browser para o player (Chrome, Chromium, Edge ou Brave)
say "3/5 Browser"
FOUND=""
for a in "Google Chrome" "Chromium" "Microsoft Edge" "Brave Browser"; do [ -d "/Applications/$a.app" ] && { FOUND="$a"; break; }; done
if [ -n "$FOUND" ]; then echo "$FOUND: já instalado."; else brew install --cask google-chrome || die "falhou a instalação do Chrome."; fi

# 4. Preparar a pasta do projecto
say "4/5 A preparar o projecto"
xattr -dr com.apple.quarantine "$ROOT" 2>/dev/null
chmod +x "$ROOT"/deploy/mac/*.command
(cd "$ROOT/server" && npm install --omit=dev) || die "falhou 'npm install'."

# 5. Arranque automático (opcional)
say "5/5 Arranque automático"
ANS="$AUTOSTART"
if [ -z "$ANS" ]; then read -r -p "Arrancar sozinho quando entrares no Mac? [s/N] " ANS; fi
case "$ANS" in
  [sSyY]*) "$ROOT/deploy/mac/autostart.command" on ;;
  *) echo "Não ligado. Para ligar mais tarde: deploy/mac/autostart.command on" ;;
esac

say "Tudo pronto"
echo "Para arrancar:  $ROOT/deploy/mac/start.command"
echo "(ou duplo clique em deploy/mac/start.command)"
