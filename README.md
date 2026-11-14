# GVPT — G's Video Projection Tool

Vibecoded Video Projection Tool by [Guilherme Martins](http://guilhermemartins.net)

**English** · [Português](#português)

This Video Projection Tool was made for the **Raspberry Pi 5** (there is also a branch adapted to the RPi 4), but this main repo should also work. 

This app also runs on **macOS, Windows and Linux computers**.

<img src="docs/rpivpt2.jpeg" width="600">

Plays several videos, each one with an optional **PNG mask** or a **drawn mask**, with position, scale, rotation and
**corner pin** controls. Everything is controlled live from a web panel on your phone or computer.

---

# English

## How it works

- **Player**: a web page in Chromium (kiosk mode, fullscreen) that draws the layers with plain DOM/CSS.
- **Panel**: a web app served by the computer. Changes reach the player instantly over WebSocket.
- **Server**: Node.js (Express + ws). Converts uploads with ffmpeg and stores the setup in one JSON file.

The mask defines the layer: its size sets the layer box and the video fills it (*cover*), so swapping the video
never changes the mask. Details in [`docs/MODELO.md`](docs/MODELO.md) (Portuguese).

## Install

Requirements on every system: **Node.js 18+**, **ffmpeg** (with `ffprobe`) and a Chromium-based browser (Chrome, Chromium, Edge, Brave).
The install scripts below set everything up and can be run more than once.

### Raspberry Pi 5 (Raspberry Pi OS Bookworm 64-bit, desktop)

```bash
sudo apt update && sudo apt install -y nodejs npm ffmpeg chromium curl avahi-daemon
cd GVPT/server && npm install --omit=dev
cd .. && deploy/install-service.sh      # starts the server now and on every boot
./kiosk on                              # optional: open the player fullscreen at boot
```

### Linux desktop (Debian/Ubuntu, Fedora, Arch)

```bash
bash deploy/linux/install.sh            # installs Node.js, ffmpeg, Chromium and the dependencies
deploy/linux/start.sh                   # starts the server and opens the player fullscreen
```

### macOS

```bash
bash deploy/mac/install.command         # installs Homebrew, Node.js, ffmpeg, Chrome and the dependencies
deploy/mac/start.command                # or double-click it in Finder
deploy/mac/autostart.command on         # optional: start when you log in (off / status)
```

### Windows 10/11

1. Double-click `deploy\win\install.bat` (installs Node.js, ffmpeg and Chrome with winget, and asks about auto-start).
2. Double-click `deploy\win\start.bat` to start. Use `deploy\win\stop.bat` to stop and `deploy\win\autostart.bat on|off|status` for auto-start.
3. If the firewall asks about `node`, allow it on **private networks** so other devices can open the panel.

All launchers accept `PORT=8080` (port) and `NO_PLAYER=1` (server only, no browser). On Windows use `set NO_PLAYER=1` first.
The player is at `http://localhost:8080/player/`. Set `VIDEO_PLATFORM=pi|generic|off` to force how system stats (CPU, GPU, temperature, RAM) are read; the default picks automatically (Linux → `pi`, macOS/Windows → `generic`).

Open the panel from any device on the same network: `http://<computer-ip>:8080` (or `http://<hostname>.local:8080`, not on Windows).
The addresses (`localhost:8080` and the network one) and a QR code also show on the output screen for the first 10 seconds after the player starts.

## Use

- **RUN / EDIT** (top bar): **RUN** only watches the output (layers and properties are hidden, nothing can be dragged by accident). **EDIT**
  unlocks everything. EDIT turns itself off after 5 minutes without activity, or when the last panel disconnects. It always starts in RUN.
- **Layers**: add, duplicate, delete, reorder, show/hide and **lock** (a locked layer cannot be picked or moved in the preview).
- **Layer Transform**: X, Y, Scale and **Rotate**. The title shows the layer's current size on screen.
- **Preview**: drag a layer to move it, drag its 4 handles for the corner pin.
- **Media** (library, upload and conversion):
  - Upload by file picker or drag and drop. Videos are converted automatically (H.264, constant fps, no audio, HDR to SDR). PNGs become masks.
  - **Maximum size per upload**: choose landscape or portrait presets, or a custom size (64 to 4096). The video is scaled down to fit, never enlarged;
    a portrait video in a landscape box (or the reverse) turns the box automatically.
  - **Library**: tick several files, **Select all**, **Delete selected**. Each file shows where it is **in use**, and PNG masks show their resolution.
  - **Re-convert** (resize) a video that is already in the library: creates a **new** copy named `name_resized_WIDTHxHEIGHT` (the original is untouched), re-encoded at
    near-lossless quality, never enlarged. Works on one file or on the selection (**Re-convert selected**).
    **Fit to usage** suggests the smallest size the layers really need. Optionally the layers switch to the new copy and keep the same size on screen.
    The player's videos pause while it works and resume afterwards.
- **Turn off player / F9**: stops all videos (the last frame stays on screen, the computer decodes nothing). Click again, or press F9, to resume.
  F9 on the Pi: see *F9 shortcut* below.
- **Settings**: output resolution, QR start screen on/off, optional PIN.
- **Mask drawing**: polygon, freehand, ellipse; add/subtract, invert, feather, directly on the preview, with live outlines on the output.
- **Debug**: live FPS, dropped frames, CPU, GPU, temperature and **RAM** (used / free).

There is **no PIN by default**: anyone on your network can control the screen. Set one in Settings.

### F9 shortcut (Raspberry Pi, labwc)

Add inside `<keyboard>` in `~/.config/labwc/rc.xml`, then run `kill -HUP $(pidof labwc)`:

```xml
<keybind key="F9"><action name="Execute"><command>/home/pi/GVPT/deploy/toggle-player.sh</command></action></keybind>
```

## Commands (Raspberry Pi service)

```bash
sudo systemctl status|restart|stop|start video-server   # the server
journalctl -u video-server -f                           # logs
./kiosk on | off | status                               # open the player at boot (off = normal desktop)
```

## Your data and backup

Everything of yours lives in `data/` (not in git): `config.json` (layers and settings), `media/` (videos and masks).

```bash
tar czf ~/gvpi-backup-$(date +%F).tar.gz data/config.json data/media
```

To restore: stop the server, put the files back, start it again. The config file is written atomically and the previous version is kept as `config.json.bak`.
Configurations from older versions are upgraded automatically (new fields get defaults).

## Troubleshooting

- **`ffmpeg not found` in the log**: install ffmpeg (see Install) and restart the server.
- **Panel won't open on a Mac (ping works)**: allow your browser in *System Settings → Privacy & Security → Local Network*. Use `http://`, not `https://`.
- **Panel won't open from another device on Windows**: allow `node` in the firewall on private networks.
- **HDMI shows the desktop, not the player (Pi)**: kiosk is off. Run `./kiosk on` and reboot, or `deploy/kiosk-session.sh &`.
- **Forgot the PIN**: stop the server, set `"pinHash": ""` in `data/config.json`, start it again.
- **Mask looks inverted or the video disappears**: switch the mask mode between *Alpha* and *Luminance*.
- **Stuttering**: turn on **Debug** and check CPU, temperature and RAM; use fewer layers, or **Re-convert** the videos to a smaller size.
- **RAM shows `-`**: restart the server after updating, so it starts sending RAM.
- **Errors in the browser**: JavaScript errors from the panel and the player are printed in the server terminal (`[browser …]`).

## Development

```bash
cd server && npm install && npm test    # 38 tests
```

Layout: `server/` (Node server, `lib/platform/` for Pi/generic), `public/player/`, `public/panel/`, `public/shared/` (geometry used by both),
`deploy/` (Pi service and kiosk, plus `win/`, `mac/`, `linux/`), `docs/`, `phase0/` (DOM vs WebGL benchmarks).

On the Pi 5 at 1920×1080 with 640×480@30 videos, 8 masked layers use about 26% CPU and 33% GPU with the DOM
approach (WebGL was heavier), with no throttling.

---

# Português

## Como funciona

- **Player**: uma página web no Chromium (modo kiosk, ecrã inteiro) que desenha as layers com DOM/CSS simples.
- **Painel**: uma aplicação web servida pelo computador. As alterações chegam ao player na hora, por WebSocket.
- **Servidor**: Node.js (Express + ws). Converte os envios com ffmpeg e guarda a configuração num só ficheiro JSON.

A máscara define a layer: o tamanho dela dá a caixa da layer e o vídeo enche-a (*cover*), por isso trocar o vídeo
nunca muda a máscara. Pormenores em [`docs/MODELO.md`](docs/MODELO.md) e guia completo em [`docs/README.pt.md`](docs/README.pt.md).

## Instalação

Em qualquer sistema precisas de **Node.js 18+**, **ffmpeg** (com `ffprobe`) e um browser baseado em Chromium (Chrome, Chromium, Edge, Brave).
Os scripts de instalação tratam de tudo e podem ser corridos mais do que uma vez.

### Raspberry Pi 5 (Raspberry Pi OS Bookworm 64 bits, desktop)

```bash
sudo apt update && sudo apt install -y nodejs npm ffmpeg chromium curl avahi-daemon
cd GVPT/server && npm install --omit=dev
cd .. && deploy/install-service.sh      # arranca o servidor já e a cada arranque do Pi
./kiosk on                              # opcional: abre o player em ecrã inteiro ao arrancar
```

### Linux (desktop: Debian/Ubuntu, Fedora, Arch)

```bash
bash deploy/linux/install.sh            # instala Node.js, ffmpeg, Chromium e as dependências
deploy/linux/start.sh                   # arranca o servidor e abre o player em ecrã inteiro
```

### macOS

```bash
bash deploy/mac/install.command         # instala Homebrew, Node.js, ffmpeg, Chrome e as dependências
deploy/mac/start.command                # ou duplo clique no Finder
deploy/mac/autostart.command on         # opcional: arrancar ao iniciar sessão (off / status)
```

### Windows 10/11

1. Duplo clique em `deploy\win\install.bat` (instala Node.js, ffmpeg e Chrome com o winget, e pergunta pelo arranque automático).
2. Duplo clique em `deploy\win\start.bat` para arrancar. `deploy\win\stop.bat` pára tudo e `deploy\win\autostart.bat on|off|status` trata do arranque automático.
3. Se a firewall perguntar pelo `node`, escolhe **Permitir em redes privadas**, para o painel abrir noutros dispositivos.

Todos os scripts aceitam `PORT=8080` (porta) e `NO_PLAYER=1` (só o servidor, sem abrir o browser). No Windows usa `set NO_PLAYER=1` antes.
O player está em `http://localhost:8080/player/`. Com `VIDEO_PLATFORM=pi|generic|off` forças a forma de ler as estatísticas do sistema (CPU, GPU, temperatura, RAM); por omissão escolhe sozinho (Linux → `pi`, macOS/Windows → `generic`).

Abre o painel de qualquer dispositivo na mesma rede: `http://<ip-do-computador>:8080` (ou `http://<nome>.local:8080`, não no Windows).
Os endereços (`localhost:8080` e o da rede) e um QR code aparecem também no ecrã de saída nos primeiros 10 segundos depois de o player arrancar.

## Utilização

- **RUN / EDIT** (barra de cima): **RUN** só observa o output (layers e propriedades escondidas, nada se arrasta por engano). **EDIT** liberta tudo.
  O EDIT desliga sozinho após 5 minutos sem atividade, ou quando o último painel se desliga. Arranca sempre em RUN.
- **Layers**: adicionar, duplicar, apagar, reordenar, mostrar/esconder e **bloquear** (uma layer bloqueada não se escolhe nem se move na pré-visualização).
- **Layer Transform**: X, Y, Scale e **Rotate**. O título mostra o tamanho atual da layer no ecrã.
- **Pré-visualização**: arrasta uma layer para a mover e as 4 pegas para o corner pin.
- **Media** (biblioteca, envio e conversão):
  - Envio pelo seletor de ficheiros ou arrastando. Os vídeos são convertidos sozinhos (H.264, fps constante, sem áudio, HDR para SDR). Os PNGs passam a máscaras.
  - **Tamanho máximo por envio**: tamanhos em paisagem ou retrato, ou um tamanho à escolha (64 a 4096). O vídeo encolhe para caber, nunca é ampliado;
    um vídeo vertical numa caixa horizontal (ou ao contrário) vira a caixa sozinho.
  - **Biblioteca**: marca vários ficheiros, **Select all**, **Delete selected**. Cada ficheiro mostra onde está **em uso**, e as máscaras PNG mostram a resolução.
  - **Re-convert** (re-conversão) de um vídeo que já está na biblioteca: cria uma cópia **nova** com o nome `nome_resized_LARGURAxALTURA` (o original não é tocado),
    re-codificada com qualidade quase sem perdas e sem ampliar. Serve para um ficheiro ou para a seleção (**Re-convert selected**).
    **Fit to usage** sugere o menor tamanho de que as layers realmente precisam. Podes mandar as layers passar para a cópia, mantendo o mesmo tamanho no ecrã.
    Os vídeos do player param enquanto trabalha e retomam no fim.
- **Turn off player / F9**: pára todos os vídeos (fica o último frame no ecrã e o computador deixa de descodificar). Carrega outra vez, ou F9, para retomar.
  F9 no Pi: ver *Atalho F9* abaixo.
- **Settings**: resolução de saída, ecrã do QR ligado/desligado, PIN opcional.
- **Desenhar máscaras**: polígono, mão livre, elipse; somar/subtrair, inverter, desfocar, diretamente na pré-visualização, com os contornos ao vivo no output.
- **Debug**: FPS, frames perdidos, CPU, GPU, temperatura e **RAM** (ocupada / livre).

**Por omissão não há PIN**: qualquer pessoa na rede pode controlar o ecrã. Define um em Settings.

### Atalho F9 (Raspberry Pi, labwc)

Acrescenta dentro de `<keyboard>` em `~/.config/labwc/rc.xml` e corre `kill -HUP $(pidof labwc)`:

```xml
<keybind key="F9"><action name="Execute"><command>/home/pi/GVPT/deploy/toggle-player.sh</command></action></keybind>
```

## Comandos (serviço no Raspberry Pi)

```bash
sudo systemctl status|restart|stop|start video-server   # o servidor
journalctl -u video-server -f                           # registos
./kiosk on | off | status                               # abrir o player ao arrancar (off = desktop normal)
```

## Os teus dados e a cópia de segurança

Tudo o que é teu está em `data/` (fora do git): `config.json` (layers e definições) e `media/` (vídeos e máscaras).

```bash
tar czf ~/gvpi-backup-$(date +%F).tar.gz data/config.json data/media
```

Para restaurar: pára o servidor, repõe os ficheiros e arranca-o outra vez. O `config.json` escreve-se de forma atómica e a versão anterior fica em `config.json.bak`.
As configurações de versões antigas são atualizadas sozinhas (os campos novos recebem valores por omissão).

## Problemas comuns

- **`ffmpeg não encontrado` no registo**: instala o ffmpeg (ver Instalação) e reinicia o servidor.
- **O painel não abre num Mac (o ping responde)**: autoriza o browser em *Definições do Sistema → Privacidade e Segurança → Rede local*. Usa `http://`, não `https://`.
- **O painel não abre noutro dispositivo (Windows)**: permite o `node` na firewall, em redes privadas.
- **O HDMI mostra o desktop e não o player (Pi)**: o kiosk está desligado. Corre `./kiosk on` e reinicia, ou `deploy/kiosk-session.sh &`.
- **Esqueci-me do PIN**: pára o servidor, põe `"pinHash": ""` em `data/config.json` e arranca-o.
- **A máscara parece invertida ou o vídeo desaparece**: troca o modo da máscara entre *Alpha* e *Luminance*.
- **Engasgos**: liga o **Debug** e vê CPU, temperatura e RAM; usa menos layers, ou faz **Re-convert** dos vídeos para um tamanho menor.
- **A RAM mostra `-`**: reinicia o servidor depois de atualizar, para ele passar a enviar a RAM.
- **Erros no browser**: os erros de JavaScript do painel e do player aparecem no terminal do servidor (`[browser …]`).

## Desenvolvimento

```bash
cd server && npm install && npm test    # 38 testes
```

Estrutura: `server/` (servidor Node, `lib/platform/` para Pi/genérico), `public/player/`, `public/panel/`, `public/shared/` (geometria usada pelos dois),
`deploy/` (serviço do Pi e kiosk, mais `win/`, `mac/`, `linux/`), `docs/`, `phase0/` (testes DOM vs WebGL).
