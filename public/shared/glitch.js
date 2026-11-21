'use strict';
/*
 * Glitch: efeitos em tempo real desenhados em canvas 2D, por layer (vindos do AliciaOla, onde corriam com o vídeo congelado).
 *   stutter  repete em ciclo os últimos 3 a 10 frames (guarda 12, a no máximo 640 de largura)
 *   jitter   o frame treme uns píxeis
 *   slices   faixas horizontais empurradas para o lado, em rajadas curtas
 *   rgb      os canais vermelho, verde e azul separam-se, em rajadas
 *   noise    grão e scanlines
 *   roll     a imagem desliza na vertical
 * Cada efeito tem o seu interruptor e a sua intensidade (0 a 100): { stutter: { on, intensity }, ... }. Com algum efeito ligado, o player desenha o vídeo num <canvas> com o mesmo tamanho
 * e posição do vídeo na caixa (o resto da cadeia — máscara, transform, corner pin, mesh, filtros CSS — fica igual).
 * Os campos têm de coincidir com normalizeGlitch() em server/lib/model.js.
 */
const Glitch = (() => {
  const KEYS = ['stutter', 'jitter', 'slices', 'rgb', 'noise', 'roll'];
  const LABELS = { stutter: 'Stutter', jitter: 'Jitter', slices: 'Slices', rgb: 'RGB split', noise: 'Noise', roll: 'Roll' };
  const DEFAULTS = Object.fromEntries(KEYS.map(k => [k, { on: false, intensity: 50 }]));
  const fresh = () => JSON.parse(JSON.stringify(DEFAULTS));
  const MAX_W = 960;                // largura máxima do canvas de desenho (poupa o Pi; o CSS estica-o até ao tamanho do vídeo)
  const HIST = 12, HIST_W = 640;    // frames guardados para o stutter

  const on = (g, k) => !!(g && g[k] && g[k].on);
  const amt = (g, k) => (g && g[k] ? g[k].intensity : 50) / 100;
  const any = g => KEYS.some(k => on(g, k));
  // A layer precisa do canvas? Só layers de vídeo, com os FX ligados (o Bypass FX também desliga o glitch).
  const active = c => !!c && c.source !== 'color' && !!c.video && !(c.fx && c.fx.on === false) && any(c.glitch);

  // Peças de ruído e de scanlines: feitas uma vez e repetidas (desenhar milhares de pontos por frame é caro no Pi).
  let tiles = null, scan = null;
  function makeTiles() {
    tiles = [];
    for (let i = 0; i < 4; i++) {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const cx = c.getContext('2d'), d = cx.createImageData(128, 128);
      for (let p = 0; p < d.data.length; p += 4) { const v = Math.random() * 255; d.data[p] = d.data[p + 1] = d.data[p + 2] = v; d.data[p + 3] = 255; }
      cx.putImageData(d, 0, 0); tiles.push(c);
    }
    scan = document.createElement('canvas'); scan.width = 2; scan.height = 3;
    const sc = scan.getContext('2d'); sc.fillStyle = '#000'; sc.fillRect(0, 0, 2, 1);
  }

  const rnd = () => Math.random();
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

  // Desenha uma layer no `canvas` dado. Devolve { capture(video), draw(video, g, now) }.
  function renderer(canvas) {
    const ctx = canvas.getContext('2d');
    let W = 0, H = 0, base = null, tmp = null, pats = null, scanPat = null;
    const hist = []; let head = -1, histN = 0;
    const st = { burst: false, burstUntil: 0, nextBurst: 0, k: 0, kT: 0 };

    function size(vw, vh) {
      const w = Math.min(vw, MAX_W), h = Math.max(1, Math.round(w * vh / vw));
      if (w === W && h === H) return;
      W = canvas.width = w; H = canvas.height = h;
      base = mk(W, H); tmp = mk(W, H);
    }

    // Guarda o frame acabado de chegar (só com o stutter ligado).
    function capture(v) {
      if (!v.videoWidth) return;
      const hw = Math.min(v.videoWidth, HIST_W), hh = Math.max(1, Math.round(hw * v.videoHeight / v.videoWidth));
      head = (head + 1) % HIST;
      let c = hist[head];
      if (!c || c.width !== hw || c.height !== hh) c = hist[head] = mk(hw, hh);
      c.getContext('2d').drawImage(v, 0, 0, hw, hh);
      histN = Math.min(histN + 1, HIST);
    }

    function draw(v, g, now) {
      if (v.readyState < 2 || !v.videoWidth) return false;
      size(v.videoWidth, v.videoHeight);
      if (!tiles) makeTiles();
      if (!pats) { pats = tiles.map(t => ctx.createPattern(t, 'repeat')); scanPat = ctx.createPattern(scan, 'repeat'); }
      const aS = amt(g, 'stutter'), aJ = amt(g, 'jitter'), aSl = amt(g, 'slices'), aR = amt(g, 'rgb'), aN = amt(g, 'noise'), aRo = amt(g, 'roll');

      // ritmo: rajadas curtas com pausas (RGB e faixas; manda a maior das duas intensidades) e o passo do stutter
      const aB = Math.max(on(g, 'rgb') ? aR : 0, on(g, 'slices') ? aSl : 0);
      if (!st.burst && now >= st.nextBurst) {
        st.burst = true; st.burstUntil = now + 60 + rnd() * (120 + aB * 260);
        st.nextBurst = st.burstUntil + (1 - aB) * 700 * (0.3 + rnd()) + 60;
      } else if (st.burst && now >= st.burstUntil) st.burst = false;
      if (now - st.kT > 230 - 170 * aS) { st.kT = now; st.k++; }

      let img = v;                                             // fonte: o frame atual ou (stutter) um dos últimos, em ciclo
      if (on(g, 'stutter') && histN >= 2) {
        const K = Math.min(histN, 3 + Math.round(aS * 8));
        img = hist[(head - (st.k % K) + HIST) % HIST];
      } else if (!on(g, 'stutter')) { histN = 0; head = -1; }
      const bctx = base.getContext('2d');
      bctx.clearRect(0, 0, W, H); bctx.drawImage(img, 0, 0, W, H);

      const sx = W * (0.003 + aJ * 0.03);
      const dx = on(g, 'jitter') ? (rnd() - 0.5) * 2 * sx : 0, dy = on(g, 'jitter') ? (rnd() - 0.5) * sx : 0;
      const roll = on(g, 'roll') ? Math.round(((now / (1800 - aRo * 1500)) % 1) * H) : 0;
      const blit = (src, ox, oy) => {
        if (roll) { ctx.drawImage(src, 0, 0, W, H - roll, ox, oy + roll, W, H - roll); ctx.drawImage(src, 0, H - roll, W, roll, ox, oy, W, roll); }
        else ctx.drawImage(src, ox, oy);
      };

      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, W, H);                                // transparente: o que fica a descoberto mostra as layers de baixo
      if (st.burst && on(g, 'rgb')) {                           // 3 cópias, uma por canal, desalinhadas
        const sp = W * (0.006 + aR * 0.045), tctx = tmp.getContext('2d');
        ctx.globalCompositeOperation = 'lighter';
        for (const [col, o] of [['#f00', -sp], ['#0f0', 0], ['#00f', sp]]) {
          tctx.globalCompositeOperation = 'source-over'; tctx.clearRect(0, 0, W, H); tctx.drawImage(base, 0, 0);
          tctx.globalCompositeOperation = 'multiply'; tctx.fillStyle = col; tctx.fillRect(0, 0, W, H);
          tctx.globalCompositeOperation = 'destination-in'; tctx.drawImage(base, 0, 0);   // mantém a transparência da imagem
          blit(tmp, dx + o, dy);
        }
        ctx.globalCompositeOperation = 'source-over';
      } else blit(base, dx, dy);

      if (st.burst && on(g, 'slices')) {                        // faixas horizontais deslocadas
        const n = 2 + Math.round(aSl * 10), k = H / 382;
        for (let i = 0; i < n; i++) {
          const sh = Math.max(2, (4 + rnd() * (10 + aSl * 50)) * k), y = rnd() * (H - sh), o = (rnd() - 0.5) * (40 + aSl * 260) * (W / 680);
          ctx.drawImage(base, 0, y, W, sh, o, y, W, sh);
        }
      }
      if (on(g, 'noise')) {                                            // grão (peça repetida, com deslocamento aleatório) e scanlines
        const s = Math.max(1, Math.round(W / 640)), ox = rnd() * 128, oy = rnd() * 128;
        ctx.save(); ctx.scale(s, s); ctx.translate(-ox, -oy);
        ctx.globalAlpha = 0.05 + aN * 0.3; ctx.fillStyle = pats[(rnd() * 4) | 0];
        ctx.fillRect(ox, oy, W / s + 128, H / s + 128);
        ctx.restore();
        ctx.save(); ctx.scale(s, s); ctx.globalAlpha = 0.1 + aN * 0.3; ctx.fillStyle = scanPat; ctx.fillRect(0, 0, W / s, H / s); ctx.restore();
        ctx.globalAlpha = 1;
      }
      return true;
    }

    return { capture, draw };
  }

  return { KEYS, LABELS, DEFAULTS, fresh, on, any, active, renderer };
})();
