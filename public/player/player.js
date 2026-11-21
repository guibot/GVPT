'use strict';
/*
 * Player: desenha as layers com DOM/CSS (<video> + mask-image + transform: matrix3d).
 *
 * Ordem de aplicação das transformações (por layer):
 *   1. O vídeo é posicionado dentro da caixa da layer (videoScale, videoOffsetX/Y).
 *      A caixa tem o tamanho nativo do vídeo e recorta (overflow: hidden).
 *   2. A máscara é aplicada no espaço da layer, centrada na caixa (maskScale).
 *   3. A layer é posicionada no ecrã: x,y = centro da caixa; scale = escala em torno do centro.
 *   4. Corner pin final: cada canto da caixa já posicionada é deslocado (pins[i], em píxeis de saída).
 * Os passos 3 e 4 resumem-se a uma única homografia (matrix3d) da caixa para o quadrilátero final.
 * Layers com mesh (mais de 1 x 1 células, ver shared/mesh.js) são desenhadas num <canvas> WebGL: o vídeo e a máscara são texturas.
 * Layers de cor sólida (source = 'color') têm um <div> com a cor em vez dos vídeos (que ficam sem ficheiro).
 * Layers com glitch (shared/glitch.js) desenham o vídeo num <canvas> com o mesmo tamanho e posição; os <video> só descodificam.
 */
(() => {
  const params = new URLSearchParams(location.search);
  const DEBUG = params.has('debug');
  const SPLASH_SECONDS = Number(params.get('splash')) || 10;

  const stage = document.getElementById('stage');
  const splash = document.getElementById('splash');
  const hud = document.getElementById('hud');

  let cfg = null;
  const layers = new Map();               // id -> estado da layer
  let splashUntil = performance.now() + SPLASH_SECONDS * 1000;
  let boot = null;                         // arranque do servidor; se mudar, recarrega a página (código novo)
  try { if (sessionStorage.getItem('autoReload')) { sessionStorage.removeItem('autoReload'); splashUntil = 0; } } catch {}

  // ---------- geometria (partilhada com o painel: /shared/geometry.js) ----------
  function applyGeometry(L) {
    const color = Geometry.isColor(L.cfg);                   // cor sólida: não há vídeo, a caixa por omissão tem tamanho fixo
    const vid = color ? Geometry.COLOR_SIZE : [L.vw, L.vh];
    if (!vid[0] || !vid[1]) return;                          // metadados do vídeo ainda não disponíveis
    let box = vid;                                           // sem máscara: a caixa é o vídeo
    if (L.cfg.vmask) box = [L.cfg.vmask.width, L.cfg.vmask.height];   // máscara desenhada: tamanho próprio
    else if (L.cfg.mask) {                                        // com máscara: é ela que define a caixa
      if (L.mw) box = [L.mw, L.mh];
      else if (!L.maskFailed) return;                        // ainda a carregar a máscara
    }
    const out = [cfg.output.width, cfg.output.height];
    const g = Geometry.apply(L.el, color ? [L.solid] : L.gc ? [...L.videos, L.gc] : L.videos, L.cfg, box, vid, out);
    if (g.meshed) {                                          // mesh: WebGL em vez de matrix3d + mask-image
      if (!L.mv) L.mv = Mesh.view(L.el);
      if (!L.mv) return applyGeometry(L);                    // sem WebGL: volta ao corner pin
      const c = L.cfg, vm = c.vmask ? VMask.toDataUrl(c.vmask) : null;
      L.mv.update({ c, g, out, media: color ? solidCanvas(L) : L.gc || L.video, maskKey: vm || c.mask || '', maskUrl: vm || (c.mask ? mediaUrl(c.mask) : null) });
    } else if (L.mv) { L.mv.destroy(); L.mv = null; }
  }

  // ---------- layers ----------
  const mediaUrl = name => '/media/' + encodeURIComponent(name);
  // Textura da cor sólida para layers com mesh (refeita só quando a cor muda).
  function solidCanvas(L) {
    if (!L.solidCv || L.solidCv.dataset.color !== L.cfg.color) { L.solidCv = Mesh.solid(L.cfg.color); L.solidCv.dataset.color = L.cfg.color; }
    return L.solidCv;
  }

  // Loop sem salto: cada layer tem dois <video> com o mesmo ficheiro. O ativo toca; pouco antes do fim,
  // o outro (já em 0 e com o 1.º frame descodificado) começa a tocar e, assim que apresenta um frame novo,
  // passa a ser o visível. O atributo `loop` simples deixa 1-3 frames parados em cada volta.
  // Interruptor "player desligado": pára todos os vídeos (o ecrã fica no último frame). Nada chama play() enquanto estiver parado.
  let halted = false;
  const LEAD = 0.12;   // segundos (reais) antes do fim em que o vídeo seguinte arranca
  const leadFor = L => Math.max(LEAD * (L.rate || 1), 0.08);   // em tempo do vídeo: a 4x arranca mais cedo, a 0.25x não espera pelo fim

  function makeVideo() {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.disablePictureInPicture = true;
    v.style.opacity = 0;
    return v;
  }

  // Velocidade de reprodução. O defaultPlaybackRate também conta: load() (ao trocar de ficheiro) repõe o playbackRate a partir dele.
  function setRate(L) {
    const r = L.rate || 1;
    for (const v of L.videos) { if (v.defaultPlaybackRate !== r) v.defaultPlaybackRate = r; if (v.playbackRate !== r) v.playbackRate = r; }
  }

  function createLayer(id) {
    const el = document.createElement('div');
    el.className = 'layer';
    const videos = [makeVideo(), makeVideo()];
    videos.forEach(v => el.appendChild(v));
    videos[0].style.opacity = 1;
    const solid = document.createElement('div');             // cor sólida (source = 'color')
    solid.className = 'solid'; solid.hidden = true;
    el.appendChild(solid);
    stage.appendChild(el);
    const L = { id, el, videos, solid, solidCv: null, gc: null, gl: null, cur: 0, mv: null, rate: 1, starting: false, cfg: null, vw: 0, vh: 0, srcName: null, maskKey: null,
                wraps: [], lastNow: 0, lastShown: 0, frames: 0, get video() { return this.videos[this.cur]; } };

    const standby = () => videos[L.cur ^ 1];
    const startStandby = () => {
      if (L.starting || halted) return;
      if (standby().readyState < 2) return;                 // reserva ainda não carregou: o 'ended' trata do loop
      L.starting = true;
      standby().play().catch(() => { L.starting = false; });
    };
    const swap = now => {
      const old = videos[L.cur], nxt = standby();
      nxt.style.opacity = 1; old.style.opacity = 0;
      L.wraps.push(+(now - L.lastShown).toFixed(1));    // intervalo entre o último frame e o 1.º do novo loop
      L.lastShown = now;
      old.pause(); try { old.currentTime = 0; } catch {}  // prepara-o como próximo
      L.cur ^= 1; L.starting = false;
      if (L.mv && !L.gc) L.mv.frame(nxt);
    };

    videos.forEach((v, i) => {
      v.addEventListener('loadedmetadata', () => { setRate(L); if (!L.vw) { L.vw = v.videoWidth; L.vh = v.videoHeight; } applyGeometry(L); });
      v.addEventListener('error', () => console.warn('[player] video error', L.srcName, v.error && v.error.message));
      v.addEventListener('ended', () => {                   // rede de segurança
        if (i !== L.cur || L.starting || halted) return;
        startStandby();
        if (!L.starting && L.cfg && L.cfg.visible && !halted) { v.currentTime = 0; v.play().catch(() => {}); }  // sem reserva: loop simples
      });
      const onFrame = (now, meta) => {
        if (i === L.cur) {
          L.frames++; L.lastNow = now;
          L.lastShown = now;
          if (L.gl && Glitch.on(L.cfg.glitch, 'stutter')) L.gl.capture(v);  // glitch: guarda o frame para o stutter
          if (L.mv && !L.gc) L.mv.frame(v);                  // layer com mesh: copia o frame novo para a textura (com glitch é o loop do glitch)
          if (v.duration && v.duration - meta.mediaTime <= leadFor(L)) startStandby();
        } else if (L.starting && meta.mediaTime > 0) {
          swap(now);
        }
        v.requestVideoFrameCallback(onFrame);
      };
      v.requestVideoFrameCallback(onFrame);
    });
    return L;
  }

  function updateLayer(L, c, index) {
    L.cfg = c;
    L.el.style.zIndex = index;                               // ordem do array = de baixo para cima
    L.rate = c.speed || 1; setRate(L);
    FX.apply(L.el, c);                                       // filtros, opacidade e modo de mistura
    setGlitch(L, Glitch.active(c));

    const color = Geometry.isColor(c);
    const vidName = color ? null : c.video;                  // cor sólida: os vídeos ficam sem ficheiro (não gastam CPU)
    L.solid.hidden = !color;
    if (color) L.solid.style.background = c.color;
    if (L.srcName !== vidName) {                             // só reinicia o vídeo se o ficheiro mudou
      L.srcName = vidName; L.vw = L.vh = 0; L.starting = false; L.cur = 0;
      const [main, spare] = L.videos;
      main.style.opacity = 1; spare.style.opacity = 0;
      spare.removeAttribute('src'); spare.load();
      if (vidName) main.src = mediaUrl(vidName); else main.removeAttribute('src');
      main.load();
      // A reserva carrega depois, escalonada por layer, para não sobrecarregar o arranque.
      const name = vidName;
      if (name) setTimeout(() => { if (L.srcName === name) { spare.src = mediaUrl(name); spare.load(); } }, 1200 + index * 400);
    }
    // A máscara desenhada (vmask) substitui o PNG. A chave muda quando qualquer uma delas muda.
    const vm = c.vmask ? VMask.cssUrl(c.vmask) : null;
    const maskKey = vm || c.mask || '';
    if (L.maskKey !== maskKey) {
      L.maskKey = maskKey;
      const val = vm || (c.mask ? `url("${mediaUrl(c.mask)}")` : 'none');
      L.el.style.webkitMaskImage = L.el.style.maskImage = val;
      L.mw = L.mh = 0; L.maskFailed = false;                 // dimensões da máscara (definem a caixa da layer)
      if (!vm && c.mask) {
        const img = new Image(), name = c.mask;
        img.onload = () => { if (L.maskKey === name) { L.mw = img.naturalWidth; L.mh = img.naturalHeight; applyGeometry(L); } };
        img.onerror = () => { if (L.maskKey === name) { L.maskFailed = true; applyGeometry(L); } };
        img.src = mediaUrl(name);
      }
    }

    applyGeometry(L);

    // Layer escondida: pausa para poupar CPU. Ao mostrar, retoma.
    L.el.style.visibility = c.visible ? 'visible' : 'hidden';
    if (c.visible && vidName) { if (L.video.paused && !L.starting && !halted) L.video.play().catch(() => {}); }
    else { L.videos.forEach(v => { if (!v.paused) v.pause(); }); L.starting = false; }
  }

  // ---------- glitch (shared/glitch.js) ----------
  // Um só loop a ~30 fps para todas as layers com glitch; só existe enquanto houver alguma.
  const glitched = new Set();
  let glRaf = 0, glLast = 0;
  function setGlitch(L, on) {
    if (on === !!L.gc) return;
    if (on) {
      L.gc = document.createElement('canvas'); L.gc.className = 'glitch';
      L.el.insertBefore(L.gc, L.solid);
      L.gl = Glitch.renderer(L.gc);
      glitched.add(L);
      if (!glRaf) glRaf = requestAnimationFrame(glTick);
    } else {
      L.gc.remove(); L.gc = L.gl = null;
      glitched.delete(L);
    }
    L.el.classList.toggle('glitched', on);
  }
  function glTick(ts) {
    if (!glitched.size) { glRaf = 0; return; }
    glRaf = requestAnimationFrame(glTick);
    if (ts - glLast < 33 || halted) return;                   // ~30 fps chega e poupa o Pi; com o player desligado fica no último desenho
    glLast = ts;
    const now = performance.now();
    for (const L of glitched) {
      if (!L.cfg.visible) continue;
      if (L.gl.draw(L.video, L.cfg.glitch, now) && L.mv) L.mv.frame(L.gc);
    }
  }

  // Pára/retoma todos os vídeos. Ao parar, a reserva do loop (se já tinha começado) volta ao início.
  function setHalted(on) {
    halted = !!on;
    for (const L of layers.values()) {
      if (halted) { L.starting = false; const sb = L.videos[L.cur ^ 1]; L.videos.forEach(v => v.pause()); try { sb.currentTime = 0; } catch {} }
      else if (L.cfg && L.cfg.visible && L.srcName && L.video.paused) L.video.play().catch(() => {});
    }
  }

  function applyConfig(next) {
    cfg = next;
    stage.style.width = cfg.output.width + 'px';
    stage.style.height = cfg.output.height + 'px';
    fitStage();

    const ids = new Set(cfg.layers.map(l => l.id));
    for (const [id, L] of layers) if (!ids.has(id)) {          // layers removidas
      L.videos.forEach(v => { v.pause(); v.removeAttribute('src'); v.load(); }); if (L.mv) L.mv.destroy(); setGlitch(L, false); L.el.remove(); layers.delete(id);
    }
    cfg.layers.forEach((c, i) => {
      let L = layers.get(c.id);
      if (!L) { L = createLayer(c.id); layers.set(c.id, L); }
      updateLayer(L, c, i);
    });
    updateSplash();
    drawEdit();
  }

  // ---------- contornos da máscara em edição (o painel está a desenhar) ----------
  // Só aparecem enquanto alguém edita no painel; servem para acertar os pontos na superfície real.
  const NS = 'http://www.w3.org/2000/svg';
  const editSvg = document.createElementNS(NS, 'svg');
  editSvg.id = 'edit-overlay';
  stage.appendChild(editSvg);
  let editing = { id: null, shape: -1 };
  // Mira: onde está o rato/dedo na pré-visualização do painel (só enquanto se edita uma máscara).
  const cursorEl = document.createElementNS(NS, 'g');
  cursorEl.innerHTML = '<circle r="14" fill="none" stroke="#000" stroke-width="5"/><circle r="14" fill="none" stroke="#fff" stroke-width="2.5"/>' +
    '<path d="M-24 0H-6M6 0H24M0 -24V-6M0 6V24" stroke="#000" stroke-width="5"/><path d="M-24 0H-6M6 0H24M0 -24V-6M0 6V24" stroke="#fff" stroke-width="2.5"/>' +
    '<circle r="3" fill="#ff3b6b"/>';
  let cursor = null;
  function placeCursor() {
    cursorEl.style.display = cursor ? '' : 'none';
    if (cursor) cursorEl.setAttribute('transform', `translate(${cursor.x},${cursor.y})`);
  }
  function drawEdit() {
    editSvg.textContent = '';
    const c = editing.id && cfg && cfg.layers.find(l => l.id === editing.id);
    editSvg.style.display = c && c.vmask ? '' : 'none';
    if (!c || !c.vmask) return;
    editSvg.appendChild(cursorEl); placeCursor();
    editSvg.setAttribute('width', cfg.output.width); editSvg.setAttribute('height', cfg.output.height);
    const L = layers.get(c.id);
    const g = Geometry.compute(c, [c.vmask.width, c.vmask.height], Geometry.isColor(c) ? Geometry.COLOR_SIZE : L && L.vw ? [L.vw, L.vh] : [c.vmask.width, c.vmask.height]);
    const add = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); editSvg.appendChild(e); };
    add('polygon', { points: g.pinned.map(p => p.join(',')).join(' '), fill: 'none', stroke: '#fff', 'stroke-opacity': .5, 'stroke-width': 2, 'stroke-dasharray': '10 8' });
    c.vmask.shapes.forEach((s, i) => {
      const pts = VMask.outline(s).map(p => Geometry.toScreen(g, c, p));
      const col = s.op === 'sub' ? '#ffb070' : '#7fd0ff', sel = i === editing.shape;
      add(pts.length >= 3 ? 'polygon' : 'polyline', { points: pts.map(p => p.join(',')).join(' '), fill: 'none', stroke: col, 'stroke-width': sel ? 4 : 2 });
      if (s.type === 'poly') for (const p of pts) add('circle', { cx: p[0], cy: p[1], r: sel ? 7 : 4, fill: sel ? '#fff' : col });
      else { const p = Geometry.toScreen(g, c, [s.cx, s.cy]); add('circle', { cx: p[0], cy: p[1], r: sel ? 7 : 4, fill: sel ? '#fff' : col }); }
    });
    editSvg.appendChild(cursorEl);                           // a mira fica por cima dos contornos
  }

  // Escala o palco lógico para a janela (1:1 quando a janela tem o tamanho da saída).
  function fitStage() {
    if (!cfg) return;
    const { width: w, height: h } = cfg.output;
    const s = Math.min(innerWidth / w, innerHeight / h);
    stage.style.transform = `translate(${(innerWidth - w * s) / 2}px, ${(innerHeight - h * s) / 2}px) scale(${s})`;
  }
  addEventListener('resize', fitStage);

  // ---------- ecrã de arranque (endereço do painel + QR) ----------
  async function loadInfo() {
    try {
      const info = await (await fetch('/api/info', { cache: 'no-store' })).json();
      document.getElementById('splash-local').textContent = `localhost:${info.port}`;
      document.getElementById('splash-url').textContent = (info.urls[0] || `http://<IP>:${info.port}`).replace('http://', '');
      document.getElementById('splash-mdns').textContent = info.mdns ? info.mdns.replace('http://', '') : '';
      document.getElementById('splash-qr').innerHTML = info.qr || '';
    } catch { setTimeout(loadInfo, 2000); }
  }
  function updateSplash() {
    // O ecrã do QR (Settings → Show the QR code start screen) aparece só nos primeiros segundos; depois mostra sempre o output.
    const on = !cfg || cfg.splash !== false;
    splash.hidden = !(on && performance.now() < splashUntil);
  }
  setInterval(updateSplash, 500);

  // ---------- WebSocket com reconexão ----------
  let retry = 500;
  let sock = null;
  function connect() {
    const ws = sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=player`);
    ws.onopen = () => { retry = 500; };
    ws.onmessage = ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'hello') {
        if (boot && msg.boot !== boot) { try { sessionStorage.setItem('autoReload', '1'); } catch {} location.reload(); return; }   // sem ecrã de arranque
        boot = msg.boot;
      }
      else if (msg.type === 'config') applyConfig(msg.config);
      else if (msg.type === 'maskEdit') { editing = { id: msg.id, shape: msg.shape }; if (!msg.id) cursor = null; drawEdit(); }
      else if (msg.type === 'maskCursor') { cursor = msg.x == null ? null : { x: msg.x, y: msg.y }; placeCursor(); }
      else if (msg.type === 'player') setHalted(!msg.on);
      else if (msg.type === 'debug') setReporting(!!msg.on);       // há um painel a ver o debug
    };
    ws.onclose = () => { setReporting(false); editing = { id: null, shape: -1 }; cursor = null; drawEdit(); setTimeout(connect, retry); retry = Math.min(retry * 2, 5000); };
    ws.onerror = () => ws.close();
  }

  // ---------- estatísticas para o painel (só medem enquanto um painel pedir) ----------
  // FPS = ritmo de composição do ecrã; perdidos = frames de vídeo descartados pelo browser.
  let repTimer = null, repRaf = 0, repFrames = 0, repT0 = 0, dropHist = [];
  function setReporting(on) {
    if (on === !!repTimer) return;
    if (!on) { clearInterval(repTimer); repTimer = null; cancelAnimationFrame(repRaf); return; }
    repFrames = 0; repT0 = performance.now(); dropHist = [];
    const raf = () => { repFrames++; repRaf = requestAnimationFrame(raf); };
    repRaf = requestAnimationFrame(raf);
    repTimer = setInterval(() => {
      const now = performance.now(), fps = repFrames / ((now - repT0) / 1000); repFrames = 0; repT0 = now;
      let dropped = 0, total = 0;
      for (const L of layers.values()) for (const v of L.videos) { const q = v.getVideoPlaybackQuality(); dropped += q.droppedVideoFrames; total += q.totalVideoFrames; }
      dropHist.push(dropped); if (dropHist.length > 11) dropHist.shift();
      const recent = dropped - dropHist[0];                          // perdidos nos últimos ~10 s
      if (sock && sock.readyState === 1) sock.send(JSON.stringify({ type: 'player-stats', fps: +fps.toFixed(1), dropped, recent, total, layers: layers.size }));
    }, 1000);
  }

  // ---------- depuração (?debug) ----------
  if (DEBUG) {
    hud.hidden = false;
    let frames = 0, t0 = performance.now();
    const raf = () => { frames++; requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
    setInterval(() => {
      const now = performance.now(), fps = frames / ((now - t0) / 1000); frames = 0; t0 = now;
      let dropped = 0, total = 0;
      for (const L of layers.values()) { for (const v of L.videos) { const q = v.getVideoPlaybackQuality(); dropped += q.droppedVideoFrames; total += q.totalVideoFrames; } }
      hud.textContent = `screen ${fps.toFixed(0)} fps | layers ${layers.size} | dropped ${dropped}/${total}\n` + sysLine;
    }, 1000);
    // CPU %, GPU % e temperatura vêm do servidor (lê /proc e os contadores do V3D).
    let sysLine = 'CPU - | GPU - | - °C | RAM -';
    setInterval(async () => {
      try {
        const s = await (await fetch('/api/stats', { cache: 'no-store' })).json();
        const gb = mb => (mb / 1024).toFixed(1);
        sysLine = `CPU ${s.cpu ?? '-'}% | GPU ${s.gpu ?? '-'}% | ${s.temp ?? '-'} °C | RAM ` + (s.ram ? `used ${gb(s.ram.used)} GB, free ${gb(s.ram.free)} GB / ${gb(s.ram.total)} GB` : '-');
      } catch {}
    }, 1000);
  }
  window.__player = {
    layers,
    loopGaps: () => Object.fromEntries([...layers].map(([id, L]) => [id, L.wraps])),
  };

  loadInfo();
  connect();
})();
