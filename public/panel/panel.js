'use strict';
/*
 * Painel de controlo. JavaScript simples, sem frameworks.
 * - Fala com o servidor por WebSocket (operações do modelo, ver docs/MODELO.md) e por HTTP (login, media, PIN).
 * - A pré-visualização usa /shared/geometry.js, o mesmo código do player, para coincidir com o ecrã.
 */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const h = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) e.append(kid);
    return e;
  };

  // ---------- estado ----------
  let cfg = null;                 // configuração atual (cópia local; o servidor é a fonte de verdade)
  let media = [];                 // biblioteca: [{name, kind, width, height, mtime}]
  let sel = null;                 // id da layer selecionada
  let ws = null, retry = 500;
  let boot = null;                // arranque do servidor; se mudar, recarrega (código novo)
  let awaitNew = false;           // depois de adicionar/duplicar, seleciona a layer nova
  const lastEdit = new Map();     // id -> hora da última edição local (evita "saltos" com ecos do servidor)
  const pending = new Map();      // id -> alterações ainda por enviar
  let flushTimer = null;
  let jobs = [];                  // conversões no servidor
  const uploads = [];             // envios deste browser: {name, pct, error, done}
  let editState = { editing: false, editUntil: 0 };   // modo RUN / EDIT (estado do servidor)
  let playerOn = null;            // vídeos a correr? (null = ainda não sei)
  const baseName = n => n;        // (sem pastas de cena: o nome é o próprio ficheiro)

  const layerById = id => cfg && cfg.layers.find(l => l.id === id);
  const mediaByName = n => media.find(m => m.name === n);
  const thumbUrl = m => `/api/thumb/${encodeURIComponent(m.name)}?v=${m.mtime}`;
  const maskUrl = n => `/media/${encodeURIComponent(n)}`;
  // Miniatura de máscara a preto e branco: a zona opaca (visível) a branco sobre preto, seja qual for a cor do PNG.
  const maskPreview = n => maskPreviewCss(`url("${maskUrl(n)}")`);
  const maskPreviewCss = u => h('i', { style: `-webkit-mask-image:${u};mask-image:${u}` });
  const layerMaskCss = l => l.vmask ? VMask.cssUrl(l.vmask) : l.mask ? `url("${maskUrl(l.mask)}")` : 'none';   // a desenhada substitui o PNG
  // vidDims: tamanho do vídeo; boxDims: tamanho da caixa (a máscara manda; sem máscara, o vídeo).
  const isColor = l => Geometry.isColor(l);       // layer de cor sólida (source = 'color')
  const vidDims = l => { if (isColor(l)) return Geometry.COLOR_SIZE; const m = mediaByName(l.video); return m && m.width ? [m.width, m.height] : [640, 480]; };
  const boxDims = l => {
    if (l.vmask) return [l.vmask.width, l.vmask.height];
    const m = l.mask && mediaByName(l.mask); return m && m.width ? [m.width, m.height] : vidDims(l);
  };
  const mediaSig = () => media.map(m => `${m.name}:${m.mtime}`).join('|');

  // ---------- rede ----------
  async function api(path, body, method) {
    const opt = body === undefined ? (method ? { method } : {}) : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const r = await fetch(path, opt);
    let json = null; try { json = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, json };
  }

  function setStatus(kind, text) {
    const s = $('#status'); s.className = 'status ' + kind; $('span', s).textContent = text;
  }

  function connect() {
    setStatus('', 'connecting');
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => { retry = 500; setStatus('on', 'connected'); if (debugOn) ws.send(JSON.stringify({ type: 'subscribe', stats: true })); if (editor.active) editor.announce(); };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'hello') { if (boot && m.boot !== boot) { flush(); location.reload(); return; } boot = m.boot; }
      else if (m.type === 'config') onConfig(m.config);
      else if (m.type === 'edit') onEdit(m);
      else if (m.type === 'player') { playerOn = !!m.on; renderPlayer(); }
      else if (m.type === 'jobs') { jobs = m.jobs; renderQueue(); }
      else if (m.type === 'media') refreshMedia();
      else if (m.type === 'stats') renderDebug(m);
      else if (m.type === 'error') toast(m.message);
    };
    ws.onclose = async () => {
      setStatus('off', 'disconnected');
      const s = await api('/api/session').catch(() => null);
      if (s && s.ok && s.json.hasPin && !s.json.authed) return showLogin();      // sessão terminada ou PIN alterado
      setTimeout(connect, retry); retry = Math.min(retry * 2, 5000);
    };
    ws.onerror = () => ws.close();
  }

  function sendOp(op) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'op', op }));
    else toast('No connection to the server');
  }

  // Alteração a uma layer: aplica-se já localmente e envia-se no máximo a cada 40 ms (o último valor vence).
  function patchLayer(id, patch) {
    const l = layerById(id); if (!l) return;
    Object.assign(l, patch);
    lastEdit.set(id, Date.now());
    pending.set(id, { ...(pending.get(id) || {}), ...patch });
    if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 40);
    scheduleRender();
  }
  function flush() {
    for (const [id, patch] of pending) sendOp({ op: 'updateLayer', id, patch });
    pending.clear();
  }

  function onConfig(next) {
    const old = cfg;
    if (old) {   // layers editadas há pouco mantêm o valor local (o eco do servidor pode vir atrasado)
      next.layers = next.layers.map(l => {
        const ol = old.layers.find(x => x.id === l.id);
        return ol && Date.now() - (lastEdit.get(l.id) || 0) < 400 ? ol : l;
      });
    }
    cfg = next;
    if (awaitNew && old) {
      const fresh = cfg.layers.find(l => !old.layers.some(o => o.id === l.id));
      if (fresh) { sel = fresh.id; awaitNew = false; }
    }
    if (!sel || !layerById(sel)) sel = cfg.layers.length ? cfg.layers[cfg.layers.length - 1].id : null;
    renderAll();
    syncSettings();
    editor.sync();
  }

  let mediaSeq = 0;               // respostas antigas (que chegam depois de uma mais recente) são descartadas
  async function refreshMedia() {
    const mine = ++mediaSeq;
    const r = await api('/api/media').catch(() => null);
    if (!r || !r.ok || mine !== mediaSeq) return;
    const before = mediaSig();
    media = r.json;
    if (before !== mediaSig() && cfg) renderAll();
    renderLibrary();
  }

  // Ícone de cadeado (SVG, para não depender de fontes de emojis).
  function lockIcon(locked) {
    const NS = 'http://www.w3.org/2000/svg', sv = document.createElementNS(NS, 'svg');
    sv.setAttribute('viewBox', '0 0 16 16'); sv.setAttribute('width', '14'); sv.setAttribute('height', '14'); sv.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('fill', locked ? 'currentColor' : 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.6');
    p.setAttribute('stroke-linejoin', 'round'); p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('d', locked ? 'M4.5 7V5a3.5 3.5 0 0 1 7 0v2M3 7h10v7H3z' : 'M4.5 7V5a3.5 3.5 0 0 1 6.8-1.2M3 7h10v7H3z');
    sv.append(p);
    return sv;
  }

  // ---------- lista de layers ----------
  let listSig = '';
  let reorder = null;             // arrastar uma layer na lista para mudar a ordem
  function renderList() {
    if (reorder) { reorder.stale = true; return; }          // não reconstruir a lista a meio de um arrasto
    const ul = $('#layer-list');
    const sig = JSON.stringify([cfg.layers.map(l => [l.id, l.name, l.visible, l.locked, l.source, l.color, l.video, l.mask, l.vmask, FX.badge(l)]), sel, mediaSig()]);
    if (sig === listSig) return;
    listSig = sig;
    ul.textContent = '';
    if (!cfg.layers.length) ul.append(h('li', { class: 'empty', text: 'No layers yet.' }));
    // O topo da lista é a layer de cima (último do array).
    [...cfg.layers].map((l, i) => [l, i]).reverse().forEach(([l, i]) => {
      const m = isColor(l) ? null : mediaByName(l.video);
      const li = h('li', { class: 'li' + (l.id === sel ? ' sel' : '') + (l.visible ? '' : ' hidden-layer') + (l.locked ? ' locked' : '') },
        h('div', { class: 'li-main', onclick: () => select(l.id) },
          h('div', { class: 'li-grip', title: 'Drag to reorder', 'aria-label': 'Drag to reorder', text: '⋮⋮', onpointerdown: e => startReorder(e, l.id) }),
          h('div', { class: 'li-thumb', style: isColor(l) ? `background:${l.color}` : m ? `background-image:url("${thumbUrl(m)}")` : '' }),
          l.vmask || l.mask ? h('div', { class: 'li-mask', title: l.vmask ? 'drawn mask' : l.mask }, maskPreviewCss(layerMaskCss(l))) : null,
          h('div', { class: 'li-name', text: l.name }),
          FX.badge(l) ? h('span', { class: 'li-fx', title: 'This layer has speed or FX applied', text: FX.badge(l) }) : null,
          h('button', { class: 'li-lock' + (l.locked ? ' on' : ''), title: l.locked ? 'Unlock: can be picked and moved in the preview' : 'Lock: cannot be picked or moved in the preview',
            'aria-label': l.locked ? 'Unlock' : 'Lock', 'aria-pressed': !!l.locked, onclick: e => { e.stopPropagation(); patchLayer(l.id, { locked: !l.locked }); } }, lockIcon(l.locked)),
          h('button', { class: 'li-eye', title: l.visible ? 'Hide' : 'Show', 'aria-label': l.visible ? 'Hide' : 'Show',
            text: l.visible ? '●' : '○', onclick: e => { e.stopPropagation(); patchLayer(l.id, { visible: !l.visible }); } })));
      if (l.id === sel) li.append(h('div', { class: 'li-actions' },
        h('button', { text: '▲', title: 'Move up', 'aria-label': 'Move up', disabled: i === cfg.layers.length - 1, onclick: () => sendOp({ op: 'moveLayer', id: l.id, index: i + 1 }) }),
        h('button', { text: '▼', title: 'Move down', 'aria-label': 'Move down', disabled: i === 0, onclick: () => sendOp({ op: 'moveLayer', id: l.id, index: i - 1 }) }),
        h('button', { text: '⧉', title: 'Duplicate', 'aria-label': 'Duplicate', onclick: () => { awaitNew = true; sendOp({ op: 'duplicateLayer', id: l.id }); } }),
        h('button', { class: 'danger', text: '✕', title: 'Delete', 'aria-label': 'Delete', onclick: () => { if (confirm(`Delete layer “${l.name}”?`)) sendOp({ op: 'removeLayer', id: l.id }); } })));
      ul.append(li);
    });
  }

  // Arrastar pela pega: a layer segue o dedo/rato e uma linha mostra onde vai ficar. Ao largar, envia moveLayer.
  // O topo da lista é a layer de cima, por isso a posição p na lista (0 = topo) corresponde ao índice n-1-p do array.
  function startReorder(e, id) {
    if (e.button > 0 || reorder) return;
    const ul = $('#layer-list'), items = [...ul.children].filter(x => x.classList.contains('li'));
    const li = e.currentTarget.closest('.li'), from = items.indexOf(li);
    if (from < 0 || items.length < 2) return;
    e.preventDefault(); e.stopPropagation();
    const grip = e.currentTarget; grip.setPointerCapture(e.pointerId);
    const rects = items.map(x => x.getBoundingClientRect());
    const mid = rects.map(r => (r.top + r.bottom) / 2);
    const line = h('div', { class: 'drop-line' }); ul.append(line);
    reorder = { id, stale: false };
    li.classList.add('dragging'); ul.classList.add('reordering');
    let to = from;
    const place = () => {                                    // linha entre o item to-1 e to (a ficar na posição "to" final)
      const ref = items.filter((_, k) => k !== from);
      const top = to === 0 ? rects[0].top : ref[to - 1].getBoundingClientRect().bottom;
      line.style.top = (top - ul.getBoundingClientRect().top + ul.scrollTop) + 'px';
    };
    place();
    const move = ev => {
      li.style.transform = `translateY(${ev.clientY - e.clientY}px)`;
      const others = items.map((_, k) => k).filter(k => k !== from);
      to = others.filter(k => mid[k] < ev.clientY).length;      // nº de itens (sem o arrastado) acima do ponteiro
      place();
    };
    const end = ev => {
      grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', end); grip.removeEventListener('pointercancel', end);
      const cancel = ev.type === 'pointercancel';
      line.remove(); li.classList.remove('dragging'); ul.classList.remove('reordering'); li.style.transform = '';
      const stale = reorder.stale; reorder = null;
      if (!cancel && to !== from) {
        const n = cfg.layers.length, idx = n - 1 - to, cur = cfg.layers.findIndex(x => x.id === id);
        if (cur >= 0) { const [m] = cfg.layers.splice(cur, 1); cfg.layers.splice(idx, 0, m); }   // já se vê; o servidor confirma
        sendOp({ op: 'moveLayer', id, index: idx });
        listSig = ''; renderAll();
      } else if (stale) { listSig = ''; renderList(); }
    };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
  }

  function select(id) { if (id !== sel) editor.stop(); sel = id; renderAll(); }

  // ---------- propriedades ----------
  const LIM = { rotation: [-360, 360], scale: [0.01, 20], maskScale: [0.01, 20], videoScale: [0.01, 20], videoOffset: [-5000, 5000], xy: [-10000, 10000], pin: [-3000, 3000], meshPt: [-3000, 3000] };
  let propsKey = '';
  let rows = [];                  // controlos numéricos, para sincronizar valores
  const selects = [];             // [{el, key}]

  const fmt = v => String(Math.round(v * 100) / 100);

  // Campo numérico: arrasta na horizontal para mudar o valor; um toque abre-o para escrever.
  // Setas ↑↓ ajustam um passo (Shift: dez passos). A barra de fundo mostra a posição no intervalo.
  function numRow(label, range, limit, step, get, set) {
    const fill = h('i', { class: 'fill' });
    const inp = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': label });
    const el = h('div', { class: 'nf' }, fill, h('span', { class: 'lb', text: label }), inp);
    const snap = v => +Math.min(limit[1], Math.max(limit[0], v)).toFixed(step < 1 ? 2 : 0);
    let d = null;
    el.addEventListener('pointerdown', e => {
      if (el.classList.contains('edit')) return;
      d = { x: e.clientX, v: get(), moved: false, w: el.clientWidth };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', e => {
      if (!d) return;
      const dx = e.clientX - d.x;
      if (!d.moved && Math.abs(dx) < 4) return;
      d.moved = true; el.classList.add('drag');
      set(snap(d.v + dx / Math.max(d.w, 320) * (range[1] - range[0]) * (e.shiftKey ? 0.1 : 1)));   // intervalo todo ≈ 320 px
    });
    el.addEventListener('pointerup', () => {
      if (!d) return;
      const moved = d.moved; d = null; el.classList.remove('drag');
      if (!moved) { el.classList.add('edit'); inp.focus(); inp.select(); }
    });
    el.addEventListener('pointercancel', () => { d = null; el.classList.remove('drag'); });
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value.replace(',', '.'));
      if (Number.isFinite(v)) { inp.classList.remove('bad'); set(snap(v)); } else inp.classList.add('bad');
    });
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === 'Escape') inp.blur();
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault(); set(snap(get() + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)));
      }
    });
    inp.addEventListener('blur', () => { el.classList.remove('edit'); inp.classList.remove('bad'); sync(); });
    const sync = () => {
      const v = get();
      if (document.activeElement !== inp) inp.value = fmt(v);
      fill.style.width = Math.max(0, Math.min(1, (v - range[0]) / (range[1] - range[0]))) * 100 + '%';
    };
    rows.push(sync);
    return el;
  }

  // Botão ligar/desligar.
  function toggle(label, get, set) {
    const b = h('button', { type: 'button', class: 'tog', text: label, onclick: () => set(!get()) });
    selects.push(() => { const on = get(); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    return b;
  }

  // Controlo segmentado (2 ou mais opções).
  function seg(options, get, set) {
    const btns = options.map(([val, text]) => h('button', { type: 'button', text, onclick: () => set(val) }));
    const el = h('div', { class: 'seg' }, btns);
    selects.push(() => btns.forEach((b, i) => b.classList.toggle('on', options[i][0] === get())));
    return el;
  }

  // Escolhe o ficheiro de uma layer (vídeo ou máscara).
  function pickMedia(key, value) {
    const l = layerById(sel), p = { [key]: value || null };
    // Sem máscara a caixa da layer é o próprio vídeo: trocar por um de outro tamanho (ex.: um _resized_) encolheria a layer no ecrã.
    // Compensa o scale e o offset do vídeo na proporção inversa para a layer ficar com o mesmo tamanho visual.
    if (key === 'video' && l && !l.mask && !l.vmask) {
      const o = mediaByName(l.video), n = mediaByName(value);
      if (o && n && o.width && n.width && o.width !== n.width) {
        const k = o.width / n.width;
        p.scale = +Math.min(LIM.scale[1], Math.max(LIM.scale[0], l.scale * k)).toFixed(4);
        p.videoOffsetX = +Math.min(5000, Math.max(-5000, l.videoOffsetX / k)).toFixed(2);
        p.videoOffsetY = +Math.min(5000, Math.max(-5000, l.videoOffsetY / k)).toFixed(2);
      }
    }
    patchLayer(sel, p);
  }

  const mediaSelect = (label, key, kind) => mediaPicker(label, key, kind);

  let pickerOpen = null;           // a lista de vídeos está aberta (sobrevive a reconstruir o painel, ex.: chega a lista de media)
  // Lista de vídeos ou máscaras com miniatura antes do nome (um <select> nativo não mostra imagens).
  function mediaPicker(label, key, kind) {
    const btn = h('button', { type: 'button', class: 'pick', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': label });
    const list = h('ul', { class: 'pick-list', role: 'listbox', hidden: true });
    const wrap = h('div', { class: 'pick-wrap' }, btn, list);
    const thumb = m => kind === 'mask'
      ? h('span', { class: 'pick-thumb mk' }, m ? maskPreview(m.name) : null)           // máscara: forma branca sobre preto
      : h('span', { class: 'pick-thumb', style: m ? `background-image:url("${thumbUrl(m)}")` : '' });
    const cell = (m, name, sub) => [thumb(m), h('span', { class: 'pick-name', text: name }), sub ? h('span', { class: 'pick-sub', text: sub }) : null];
    const close = () => { if (pickerOpen === key) pickerOpen = null; list.hidden = true; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); };
    const outside = e => { if (!wrap.contains(e.target)) close(); };
    const open = () => {
      pickerOpen = key; refreshMedia(); fillList();
      list.hidden = false; btn.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', outside, true);
      const on = list.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' });
    };
    const fillBtn = () => {
      const l = layerById(sel), cur = l ? l[key] : null, m = cur ? mediaByName(cur) : null;
      btn.textContent = '';
      btn.append(...(cur ? cell(m, m ? cur : `(missing) ${cur}`) : [thumb(null), h('span', { class: 'pick-name dim', text: '— none —' })]).filter(Boolean), h('span', { class: 'pick-caret', text: '⌄' }));
    };
    const fillList = () => {
      const l = layerById(sel), cur = l ? l[key] : null;
      list.textContent = '';
      const add = (value, kids) => list.append(h('li', { role: 'option', 'aria-selected': (cur || '') === value },
        h('button', { type: 'button', class: (cur || '') === value ? 'on' : '', onclick: () => { close(); if ((cur || '') !== value) pickMedia(key, value); btn.focus(); } }, ...kids)));
      add('', [thumb(null), h('span', { class: 'pick-name dim', text: '— none —' })]);
      const items = media.filter(m => m.kind === kind);
      if (cur && !items.some(m => m.name === cur)) add(cur, cell(null, `(missing) ${cur}`));
      for (const m of items) add(m.name, cell(m, m.name, m.width ? `${m.width}×${m.height}` : ''));
    };
    btn.addEventListener('click', () => (list.hidden ? open() : close()));
    wrap.addEventListener('keydown', e => { if (e.key === 'Escape' && !list.hidden) { e.stopPropagation(); close(); btn.focus(); } });
    fillBtn();
    selects.push(() => { fillBtn(); if (!list.hidden) fillList(); });
    if (pickerOpen === key) setTimeout(open, 0);       // o painel foi reconstruído com a lista aberta: reabre
    return h('div', { class: 'field pk' }, label, wrap);
  }

  // Área de cópia guardada no localStorage (sobrevive a um refresh do painel). get() devolve sempre uma cópia nova.
  function clipStore(key, migrate = v => v) {
    let v = null;
    try { v = migrate(JSON.parse(localStorage.getItem(key) || 'null')); } catch {}
    return {
      get: () => (v ? JSON.parse(JSON.stringify(v)) : null),
      set: m => { v = JSON.parse(JSON.stringify(m)); try { localStorage.setItem(key, JSON.stringify(v)); } catch {} },
    };
  }
  // Máscara copiada: a desenhada (vmask) ou o PNG, com o modo e a escala. Formato: { vmask, mask, maskMode, maskScale }
  // (uma cópia antiga, só com a vmask, também serve).
  const maskClip = clipStore('maskClip', v => (v && v.shapes ? { vmask: v } : v));
  // Layer copiada: todos os parâmetros (menos o id e o locked). Cola-se como layer nova ou por cima da selecionada.
  const LAYER_FIELDS = ['name', 'visible', 'source', 'color', 'video', 'mask', 'vmask', 'maskScale', 'maskMode', 'videoScale', 'videoOffsetX',
    'videoOffsetY', 'x', 'y', 'scale', 'rotation', 'pins', 'speed', 'fx', 'glitch', 'mirrorX', 'mirrorY', 'mesh'];
  const layerClip = clipStore('layerClip');
  const layerParams = l => Object.fromEntries(LAYER_FIELDS.filter(k => k in l).map(k => [k, l[k]]));
  function pasteLayerNew() {
    const c = layerClip.get(); if (!c) return;
    awaitNew = true;
    sendOp({ op: 'addLayer', layer: { ...c, name: (c.name + ' (copy)').slice(0, 80) } });
    toast('Layer pasted');
  }

  function buildProps() {
    const box = $('#props'), fxBox = $('#fx'); box.textContent = ''; fxBox.textContent = ''; rows = []; selects.length = 0;
    const l = layerById(sel);
    if (!l) { box.append(h('p', { class: 'empty', text: 'Select or add a layer.' })); fxBox.append(h('p', { class: 'empty', text: 'Select or add a layer.' })); return; }
    const L = () => layerById(sel);
    const patch = p => patchLayer(sel, p);
    const W = cfg.output.width, H = cfg.output.height;
    const group = (title, ...kids) => h('div', { class: 'group' }, title instanceof Node ? title : h('div', { class: 'gt', text: title }), ...kids);
    // Título "Layer Transform" com o tamanho atual da layer no ecrã (caixa × escala), a atualizar com o Scale.
    const sizeEl = h('span', { class: 'gt-size' });
    rows.push(() => {
      const ly = L(); if (!ly) return;
      const [bw, bh] = boxDims(ly);
      sizeEl.textContent = `${Math.round(bw * ly.scale)} × ${Math.round(bh * ly.scale)} px`;
    });
    const transformTitle = h('div', { class: 'gt' }, 'Layer Transform', sizeEl);
    const g2 = (...kids) => h('div', { class: 'g2' }, ...kids);

    const name = h('input', { type: 'text', maxlength: 80, 'aria-label': 'Name' });
    name.addEventListener('input', () => patch({ name: name.value || 'Layer' }));
    selects.push(() => { if (document.activeElement !== name) name.value = L().name; });

    // Fonte da layer: vídeo (ficheiro) ou cor sólida. Ao trocar, o vídeo escolhido fica guardado para voltar a ele.
    const srcSeg = seg([['video', 'VIDEO'], ['color', 'SOLID COLOR']], () => L().source || 'video', v => { patch({ source: v }); scheduleProps(); });
    const colorIn = h('input', { type: 'color', 'aria-label': 'Color' });
    const colorHex = h('input', { type: 'text', maxlength: 7, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Color (hex)' });
    colorIn.addEventListener('input', () => patch({ color: colorIn.value }));
    colorHex.addEventListener('input', () => {
      let v = colorHex.value.trim().toLowerCase(); if (v && v[0] !== '#') v = '#' + v;
      if (/^#[0-9a-f]{3}$/.test(v)) v = '#' + [...v.slice(1)].map(ch => ch + ch).join('');
      const ok = /^#[0-9a-f]{6}$/.test(v); colorHex.classList.toggle('bad', !ok);
      if (ok) patch({ color: v });
    });
    colorHex.addEventListener('blur', () => { colorHex.classList.remove('bad'); colorHex.value = L().color; });
    colorHex.addEventListener('keydown', e => { if (e.key === 'Enter') colorHex.blur(); });
    selects.push(() => { const c = L().color; if (document.activeElement !== colorIn) colorIn.value = c; if (document.activeElement !== colorHex) colorHex.value = c; });
    const SWATCHES = ['#ffffff', '#000000', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff'];
    const swatches = h('div', { class: 'swatches' }, SWATCHES.map(c => h('button', { type: 'button', class: 'sw', style: `background:${c}`, title: c, 'aria-label': c, onclick: () => patch({ color: c }) })));
    const colorField = h('div', { class: 'field' }, 'COLOR', h('div', { class: 'color-row' }, colorIn, colorHex), swatches);

    const modeSeg = seg([['alpha', 'ALPHA'], ['luminance', 'LUMINANCE']], () => L().maskMode, v => patch({ maskMode: v }));
    // Mesh: grelha de células (colunas × linhas). Mudar de grelha repõe os pontos na grelha direita.
    const gridSel = h('select', { 'aria-label': 'Mesh grid' }, Mesh.PRESETS.map(([c, r]) =>
      h('option', { value: `${c}x${r}`, text: `${c} × ${r}` + (c === 1 && r === 1 ? '  (corner pin)' : '') })));
    gridSel.addEventListener('change', () => {
      const [c, r] = gridSel.value.split('x').map(Number), m = L().mesh;
      if (Mesh.dirty(m) && !confirm('Changing the grid puts the mesh points back on the straight grid. Continue?')) { gridSel.value = `${m.cols}x${m.rows}`; return; }
      patch({ mesh: Mesh.flat(c, r, m.smooth) }); scheduleProps();
    });
    selects.push(() => { if (document.activeElement !== gridSel) gridSel.value = `${L().mesh.cols}x${L().mesh.rows}`; });
    const PIN_NAMES = ['TOP LEFT', 'TOP RIGHT', 'BOTTOM RIGHT', 'BOTTOM LEFT'];

    box.append(
      group('Layer',
        h('div', { class: 'row-btns tight' },
          h('button', { type: 'button', text: 'Copy layer', title: 'Copy this layer with all its parameters (video, mask, position, scale, rotation, corners, FX...)', onclick: () => {
            layerClip.set(layerParams(L())); toast('Layer copied'); scheduleProps(); syncPasteBtn();
          } }),
          layerClip.get() ? h('button', { type: 'button', class: 'push-right', text: 'Paste layer parameters', title: 'Replace all the parameters of this layer with the copied ones (the name stays)', onclick: () => {
            const c = layerClip.get(); if (!c) return;
            if (!confirm(`Replace all the parameters of "${L().name}" with the copied layer?`)) return;
            delete c.name; if (!('vmask' in c)) c.vmask = null;
            editor.stop(); patch(c); toast('Layer pasted'); scheduleProps();
          } }) : null),
        h('label', { class: 'field' }, 'NAME', name),
        h('div', { class: 'field' }, 'SOURCE', srcSeg),
        isColor(l) ? colorField : mediaSelect('VIDEO', 'video', 'video'),
        mediaSelect('MASK', 'mask', 'mask')),
      group(transformTitle,
        g2(numRow('X', [0, W], LIM.xy, 1, () => L().x, v => patch({ x: v })),
           numRow('Y', [0, H], LIM.xy, 1, () => L().y, v => patch({ y: v }))),
        numRow('Scale', [0, 1.5], LIM.scale, 0.01, () => L().scale, v => patch({ scale: v })),   // 1 fica a 2/3 da barra
        numRow('Rotate', [-180, 180], LIM.rotation, 0.1, () => L().rotation || 0, v => patch({ rotation: v })),
        g2(toggle('X Mirror', () => !!L().mirrorX, v => patch({ mirrorX: v })), toggle('Y Mirror', () => !!L().mirrorY, v => patch({ mirrorY: v })))),
      group('Mask',
        modeSeg,
        h('div', { class: 'row-btns tight' },
          h('button', { type: 'button', class: 'primary', text: l.vmask ? 'Edit drawing' : 'Draw mask', onclick: () => editor.start() }),
          l.vmask ? h('button', { type: 'button', class: 'danger', text: 'Delete drawing', onclick: () => {
            if (confirm('Delete the drawn mask of this layer?' + (l.mask ? ' It goes back to using the PNG.' : ''))) { editor.stop(); patch({ vmask: null }); scheduleProps(); }
          } }) : null),
        h('div', { class: 'row-btns tight' },
          l.vmask || l.mask ? h('button', { type: 'button', text: 'Copy mask', title: 'Copy this mask (drawn or PNG, with mode and scale), to paste it on another layer', onclick: () => {
            const ly = L();
            maskClip.set(ly.vmask ? { vmask: ly.vmask, maskMode: ly.maskMode, maskScale: ly.maskScale }
                                  : { mask: ly.mask, maskMode: ly.maskMode, maskScale: ly.maskScale });
            toast(ly.vmask ? 'Drawn mask copied' : 'PNG mask copied'); scheduleProps();
          } }) : null,
          maskClip.get() ? h('button', { type: 'button', text: 'Paste mask', title: 'Use the copied mask on this layer', onclick: () => {
            const c = maskClip.get(); if (!c) return;
            const ly = L();
            if ((ly.vmask || ly.mask) && !confirm('Replace the mask of this layer with the copied one?')) return;
            const p = c.vmask ? { vmask: c.vmask } : { mask: c.mask, vmask: null };   // um PNG colado tira a desenhada (senão ficava por cima)
            if (c.maskMode) p.maskMode = c.maskMode;
            if (c.maskScale != null) p.maskScale = c.maskScale;
            editor.stop(); patch(p); toast('Mask pasted'); scheduleProps();
          } }) : null),
        l.vmask && l.mask ? h('p', { class: 'hint', text: 'The drawn mask replaces the PNG chosen above.' }) : null,
        numRow('Scale', [0.1, 5], LIM.maskScale, 0.01, () => L().maskScale, v => patch({ maskScale: v }))),
      isColor(l) ? '' : group('Video',                       // ('' e não null: append() escreveria "null")
        g2(numRow('Offset X', [-500, 500], LIM.videoOffset, 1, () => L().videoOffsetX, v => patch({ videoOffsetX: v })),
           numRow('Offset Y', [-500, 500], LIM.videoOffset, 1, () => L().videoOffsetY, v => patch({ videoOffsetY: v }))),
        numRow('Scale', [0.1, 5], LIM.videoScale, 0.01, () => L().videoScale, v => patch({ videoScale: v }))),
      group('Mesh',
        h('div', { class: 'nf sel' }, h('span', { class: 'lb', text: 'Grid' }), gridSel),
        Mesh.active(l.mesh) ? h('div', { class: 'row-btns tight' },
          toggle('Smooth', () => !!L().mesh.smooth, v => patch({ mesh: { ...L().mesh, smooth: v } })),
          h('button', { type: 'button', text: 'Reset mesh', title: 'Put all the mesh points back on the straight grid (the corners stay as they are)',
            onclick: () => { const m = L().mesh; patch({ mesh: Mesh.flat(m.cols, m.rows, m.smooth) }); } })) : null,
        h('p', { class: 'hint', text: Mesh.active(l.mesh) ? 'Drag the extra points in the preview. The 4 corners are the corner pin below.' : '1 × 1 is the plain corner pin. Pick more cells to get a mesh.' })),
      group('Corner pin (px)',
        h('div', { class: 'pins' }, PIN_NAMES.map((t, i) =>
          h('div', { class: 'pin-block' }, h('b', { text: t }),
            ['x', 'y'].map(ax => numRow(ax.toUpperCase(), [-300, 300], LIM.pin, 1, () => L().pins[i][ax], v => {
              const pins = L().pins.map(p => ({ ...p })); pins[i][ax] = v; patch({ pins });
            }))))),
        h('button', { text: 'Reset corners', onclick: () => patch({ pins: [0, 1, 2, 3].map(() => ({ x: 0, y: 0 })) }) })));
    buildFx(fxBox, L, patch, group);
    syncProps(true);
  }

  // Coluna FX: velocidade e efeitos em tempo real da layer selecionada (filtros CSS + opacidade + blend; ver shared/fx.js).
  function buildFx(box, L, patch, group) {
    const fxPatch = p => patch({ fx: { ...L().fx, ...p } });
    const fxRow = (label, key, range, step) => numRow(label, range, FX.LIMITS[key], step, () => L().fx[key], v => fxPatch({ [key]: v }));
    const blend = h('select', { 'aria-label': 'Blend mode' }, FX.BLENDS.map(b => h('option', { value: b, text: b })));
    blend.addEventListener('change', () => fxPatch({ blend: blend.value }));
    selects.push(() => { if (document.activeElement !== blend) blend.value = L().fx.blend; });
    const bypass = h('button', { type: 'button', title: 'Turn all the FX of this layer off and on, glitch included (the speed is not affected)', onclick: () => fxPatch({ on: !L().fx.on }) });
    selects.push(() => { const on = L().fx.on; bypass.textContent = on ? 'Bypass FX' : 'FX bypassed'; bypass.classList.toggle('on', !on); });
    const reset = h('button', { type: 'button', text: 'Reset FX', onclick: () => patch({ speed: 1, fx: { ...FX.DEFAULTS, on: L().fx.on }, glitch: Glitch.fresh() }) });
    // Glitch (shared/glitch.js): cada efeito tem um botão ON/OFF e a sua intensidade. Só em layers de vídeo.
    const glSet = (k, p) => patch({ glitch: { ...L().glitch, [k]: { ...L().glitch[k], ...p } } });
    const glRow = k => {
      const btn = h('button', { type: 'button', class: 'tog gl-on', 'aria-label': `${Glitch.LABELS[k]} on/off`, onclick: () => glSet(k, { on: !L().glitch[k].on }) });
      const slider = numRow(Glitch.LABELS[k], [0, 100], [0, 100], 1, () => L().glitch[k].intensity, v => glSet(k, { intensity: Math.round(v) }));
      const row = h('div', { class: 'gl-row' }, btn, slider);
      selects.push(() => { const on = !!L().glitch[k].on; btn.textContent = on ? 'ON' : 'OFF'; btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', on); row.classList.toggle('off', !on); });
      return row;
    };
    const glitchGroup = isColor(L()) ? '' : group('Glitch',
      Glitch.KEYS.map(glRow),
      h('p', { class: 'hint', text: 'Each effect has its own ON/OFF and intensity. Stutter repeats the last frames, jitter shakes the image, slices and RGB split come in short bursts, noise adds grain and scanlines, roll slides the picture vertically. Seen on the output only (the preview is a still frame).' }));
    const presets = seg([[0.25, '¼'], [0.5, '½'], [1, '1×'], [2, '2×'], [4, '4×']], () => L().speed, v => patch({ speed: v }));
    box.append(
      isColor(L()) ? '' : group('Playback',                  // cor sólida: não há vídeo a tocar ('' e não null: append() escreveria "null")
        numRow('Speed', [0.1, 4], [0.1, 4], 0.05, () => L().speed, v => patch({ speed: v })),
        presets),
      group('Color',
        fxRow('Brightness', 'brightness', [0, 200], 1),
        fxRow('Contrast', 'contrast', [0, 200], 1),
        fxRow('Saturation', 'saturate', [0, 200], 1),
        fxRow('Hue', 'hue', [-180, 180], 1),
        fxRow('Invert', 'invert', [0, 100], 1),
        fxRow('Grayscale', 'grayscale', [0, 100], 1),
        fxRow('Sepia', 'sepia', [0, 100], 1),
        h('div', { class: 'row-btns' }, h('button', { type: 'button', text: 'Reset color', title: 'Put brightness, contrast, saturation, hue, invert, grayscale and sepia back to normal',
          onclick: () => { const D = FX.DEFAULTS, c = {}; for (const k of ['brightness', 'contrast', 'saturate', 'hue', 'invert', 'grayscale', 'sepia']) c[k] = D[k]; fxPatch(c); } }))),
      group('Blur & mix',
        fxRow('Blur', 'blur', [0, 40], 0.5),
        fxRow('Opacity', 'opacity', [0, 100], 1),
        h('div', { class: 'nf sel' }, h('span', { class: 'lb', text: 'Blend' }), blend)),
      glitchGroup,
      h('div', { class: 'row-btns' }, bypass, reset));
  }

  const scheduleProps = () => { propsKey = ''; scheduleRender(); };
  function syncProps(force) {
    if (!cfg) return;
    const l = layerById(sel);
    const key = [sel, cfg.output.width, mediaSig(), l && l.source, !!(l && l.vmask), !!(l && l.mask), l && l.mesh ? l.mesh.cols + 'x' + l.mesh.rows : ''].join('|');
    if (key !== propsKey && !force) { propsKey = key; buildProps(); return; }
    propsKey = key;
    if (!layerById(sel)) return;
    rows.forEach(f => f()); selects.forEach(f => f());
  }

  // ---------- pré-visualização ----------
  const preview = $('#preview'), pstage = $('#pstage'), wrap = $('#preview-wrap');
  const NS = 'http://www.w3.org/2000/svg';
  const overlay = document.createElementNS(NS, 'svg'); overlay.id = 'overlay';
  const poly = document.createElementNS(NS, 'polygon'); overlay.append(poly);
  const gridPath = document.createElementNS(NS, 'path'); overlay.append(gridPath);     // linhas da mesh
  pstage.append(overlay);
  const handles = [0, 1, 2, 3].map(i => { const e = h('div', { class: 'handle', 'data-i': i }); pstage.append(e); return e; });
  const mhandles = [];            // pegas dos pontos da mesh (os cantos são as pegas acima)
  const pl = new Map();           // id -> elemento .layer da pré-visualização
  const editor = MaskEditor({
    layer: () => layerById(sel), output: () => cfg.output, boxDims, geo: l => geo(l),
    patch: p => patchLayer(sel, p), scale: () => scale, svg: overlay, toolbar: $('#mask-tools'),
    send: msg => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); },
    render: () => scheduleRender(), toast: t => toast(t),
  });
  let scale = 1, raf = 0;

  function fitPreview() {
    const { width: W, height: H } = cfg.output;
    // Computador e telemóvel deitado: a pré-visualização ocupa a área que tem. Telemóvel de pé: uma fração do ecrã
    // (menos a desenhar máscaras, porque a barra de ferramentas também precisa de espaço).
    const fill = matchMedia('(min-width: 900px) and (min-height: 521px), (max-height: 520px) and (orientation: landscape)').matches;
    const maxH = fill ? wrap.clientHeight : innerHeight * (editor.active ? 0.32 : 0.38);
    scale = Math.max(0.05, Math.min(wrap.clientWidth / W, maxH / H));
    preview.style.width = W * scale + 'px'; preview.style.height = H * scale + 'px';
    pstage.style.width = W + 'px'; pstage.style.height = H + 'px';
    pstage.style.transform = `scale(${scale})`;
    overlay.setAttribute('width', W); overlay.setAttribute('height', H);
  }

  const geo = l => Geometry.compute(l, boxDims(l), vidDims(l));

  function renderPreview() {
    if (!cfg) return;
    fitPreview();
    const ids = new Set(cfg.layers.map(l => l.id));
    for (const [id, e] of pl) if (!ids.has(id)) { e.remove(); pl.delete(id); }
    cfg.layers.forEach((l, i) => {
      let e = pl.get(l.id);
      if (!e) { e = h('div', { class: 'layer' }); pl.set(l.id, e); pstage.insertBefore(e, overlay); }
      e.style.zIndex = i;
      e.style.display = l.visible ? '' : 'none';
      const m = isColor(l) ? null : mediaByName(l.video);
      const src = isColor(l) ? 'color:' + l.color : m ? thumbUrl(m) : '';
      if (e.dataset.src !== src) {            // miniatura (frame extraído pelo ffmpeg), não vídeo ao vivo
        e.dataset.src = src;
        if (e._mv) { e._mv.destroy(); e._mv = null; }      // o textContent apaga o canvas da mesh
        e.textContent = ''; e._solid = null;
        if (isColor(l)) { e.append(h('div', { style: `background:${l.color}` })); e._solid = Mesh.solid(l.color); }   // cor sólida (e a textura para a mesh)
        else if (src) { const img = h('img', { src, draggable: 'false', alt: '' }); img.addEventListener('load', scheduleRender); e.append(img); }
        else e.append(h('div', { class: 'ph' }));
      }
      const mk = layerMaskCss(l);
      if (e.dataset.mask !== mk) { e.dataset.mask = mk; e.style.webkitMaskImage = e.style.maskImage = mk; }
      const out = [cfg.output.width, cfg.output.height];
      const eg = Geometry.apply(e, [e.firstChild], l, boxDims(l), vidDims(l), out);
      if (eg.meshed) {                        // mesh: a miniatura e a máscara são texturas de um canvas WebGL
        if (!e._mv) e._mv = Mesh.view(e);
        if (!e._mv) scheduleRender();         // sem WebGL: volta ao corner pin
        else e._mv.update({ c: l, g: eg, out, media: e._solid || (e.firstChild && e.firstChild.tagName === 'IMG' ? e.firstChild : null),
          maskKey: mk, maskUrl: l.vmask ? VMask.toDataUrl(l.vmask) : l.mask ? maskUrl(l.mask) : null });
      } else if (e._mv) { e._mv.destroy(); e._mv = null; }
      FX.apply(e, l);
    });
    // contorno e pegas da layer selecionada
    const l = layerById(sel);
    overlay.style.zIndex = 1000;
    handles.forEach(e => { e.style.zIndex = 1001; e.style.display = l && !l.locked && !editor.active && editState.editing ? '' : 'none'; });   // a desenhar: sem pegas de canto
    poly.style.display = l ? '' : 'none';
    editor.render();
    if (!l) { gridPath.style.display = 'none'; mhandles.forEach(e => { e.style.display = 'none'; }); return; }
    const g = geo(l);
    poly.setAttribute('points', g.pinned.map(p => p.join(',')).join(' '));
    poly.setAttribute('fill', 'none'); poly.setAttribute('stroke', '#8fb3e6'); poly.setAttribute('stroke-width', 2 / scale);
    poly.setAttribute('stroke-dasharray', `${6 / scale} ${4 / scale}`);
    const hs = (matchMedia('(pointer: coarse)').matches ? 34 : 22) / scale;
    handles.forEach((e, i) => {
      e.style.width = e.style.height = hs + 'px';
      e.style.left = g.pinned[i][0] + 'px'; e.style.top = g.pinned[i][1] + 'px';
    });
    // mesh: linhas da grelha e pegas dos pontos que não são cantos
    const free = g.meshed ? Mesh.freePoints(l.mesh) : [];
    gridPath.style.display = g.meshed ? '' : 'none';
    if (g.meshed) {
      gridPath.setAttribute('d', Mesh.lines(g, l.mesh).map(pl => 'M' + pl.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('L')).join(''));
      gridPath.setAttribute('fill', 'none'); gridPath.setAttribute('stroke', '#8fb3e6'); gridPath.setAttribute('stroke-opacity', .7); gridPath.setAttribute('stroke-width', 1.5 / scale);
    }
    while (mhandles.length < free.length) { const e = h('div', { class: 'handle mh' }); pstage.append(e); mhandles.push(e); }
    mhandles.forEach((e, n) => {
      const k = free[n];
      if (k === undefined || l.locked || editor.active || !editState.editing) { e.style.display = 'none'; return; }
      const p = Mesh.pointByIndex(g, l.mesh, k);
      e.dataset.k = k; e.style.display = ''; e.style.zIndex = 1001;
      e.style.width = e.style.height = hs * 0.8 + 'px';
      e.style.left = p[0] + 'px'; e.style.top = p[1] + 'px';
    });
  }

  function scheduleRender() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; renderPreview(); syncProps(); });
  }

  const inQuad = ([x, y], q) => {            // ponto dentro do quadrilátero (ray casting)
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const [xi, yi] = q[i], [xj, yj] = q[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const point = e => { const r = preview.getBoundingClientRect(); return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale]; };

  let drag = null;
  preview.addEventListener('pointerdown', e => {
    if (!cfg || !editState.editing) return;                  // em RUN só se observa
    if (editor.active) { editor.down(point(e)); preview.setPointerCapture(e.pointerId); e.preventDefault(); return; }
    const p = point(e), hEl = e.target.closest && e.target.closest('.handle');
    if (hEl) {                                              // arrastar um canto (corner pin)
      const l = layerById(sel); if (!l || l.locked) return;
      const g = geo(l);
      if (hEl.dataset.k !== undefined && g.meshed) {          // ponto da mesh
        const k = +hEl.dataset.k, at = Mesh.pointByIndex(g, l.mesh, k);
        drag = { mode: 'mesh', k, grab: [p[0] - at[0], p[1] - at[1]], el: hEl };
      } else {
        const i = +hEl.dataset.i;
        drag = { mode: 'pin', i, grab: [p[0] - g.pinned[i][0], p[1] - g.pinned[i][1]], el: hEl };
      }
      hEl.classList.add('drag');
    } else {                                                // selecionar / mover a layer
      let l = layerById(sel);
      if (!(l && !l.locked && inQuad(p, geo(l).pinned))) {                    // layers bloqueadas não se escolhem nem se movem aqui
        l = [...cfg.layers].reverse().find(x => x.visible && !x.locked && inQuad(p, geo(x).pinned));
        if (!l) return;
        select(l.id);
      }
      drag = { mode: 'move', id: l.id, start: p, x0: l.x, y0: l.y };
    }
    preview.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  preview.addEventListener('pointermove', e => {
    if (editor.active) { editor.hover(point(e)); return editor.move(point(e)); }
    if (!drag) return;
    const p = point(e), l = layerById(sel); if (!l) return;
    const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
    if (drag.mode === 'pin') {
      const base = geo(l).base[drag.i];                      // posição do canto sem corner pin
      const pins = l.pins.map(q => ({ ...q }));
      pins[drag.i] = { x: Math.round(clamp(p[0] - drag.grab[0] - base[0], LIM.pin)), y: Math.round(clamp(p[1] - drag.grab[1] - base[1], LIM.pin)) };
      patchLayer(sel, { pins });
    } else if (drag.mode === 'mesh') {
      const g = geo(l); if (!g.meshed) return;
      const base = Mesh.baseByIndex(g, l.mesh, drag.k);      // onde o ponto estaria sem deslocamento
      const pts = l.mesh.pts.map(q => ({ ...q }));
      pts[drag.k] = { x: Math.round(clamp(p[0] - drag.grab[0] - base[0], LIM.meshPt)), y: Math.round(clamp(p[1] - drag.grab[1] - base[1], LIM.meshPt)) };
      patchLayer(sel, { mesh: { ...l.mesh, pts } });
    } else {
      patchLayer(drag.id, { x: Math.round(clamp(drag.x0 + p[0] - drag.start[0], LIM.xy)), y: Math.round(clamp(drag.y0 + p[1] - drag.start[1], LIM.xy)) });
    }
  });
  const endDrag = () => { if (editor.active) editor.up(); if (drag && drag.el) drag.el.classList.remove('drag'); drag = null; };
  preview.addEventListener('pointerup', endDrag);
  preview.addEventListener('pointerleave', () => { if (editor.active && !drag) editor.leave(); });
  preview.addEventListener('pointercancel', endDrag);
  new ResizeObserver(() => { if (cfg) scheduleRender(); }).observe(wrap);
  addEventListener('resize', () => { if (cfg) scheduleRender(); });

  function renderAll() { renderList(); syncProps(); renderPreview(); renderMonitor(); }

  // ---------- botões, separadores ----------
  const syncPasteBtn = () => { $('#btn-paste-layer').hidden = !layerClip.get(); };
  $('#btn-paste-layer').addEventListener('click', pasteLayerNew);
  syncPasteBtn();
  $('#btn-add').addEventListener('click', () => {
    awaitNew = true;
    const v = media.find(m => m.kind === 'video');
    sendOp({ op: 'addLayer', layer: { name: `Layer ${cfg.layers.length + 1}`, video: v ? v.name : null } });
  });
  // Colunas recolhíveis (só em ecrãs largos): Layers, Adjust e FX encolhem para uma tira estreita. O estado fica guardado neste browser.
  const COLS = ['layers', 'props', 'fx'];
  let collapsed = [];
  try { collapsed = JSON.parse(localStorage.getItem('collapsedCols') || '[]').filter(c => COLS.includes(c)); } catch {}
  function applyCollapsed() {
    for (const c of COLS) document.body.classList.toggle('collapse-' + c, collapsed.includes(c));
    for (const b of document.querySelectorAll('.col-toggle')) {
      const off = collapsed.includes(b.dataset.col);
      b.setAttribute('aria-expanded', !off); b.title = off ? 'Expand' : 'Collapse';
    }
    try { localStorage.setItem('collapsedCols', JSON.stringify(collapsed)); } catch {}
    if (cfg) scheduleRender();                               // a pré-visualização muda de largura
  }
  for (const b of document.querySelectorAll('.col-toggle')) b.addEventListener('click', () => {
    const c = b.dataset.col;
    collapsed = collapsed.includes(c) ? collapsed.filter(x => x !== c) : [...collapsed, c];
    applyCollapsed();
  });
  applyCollapsed();
  addEventListener('resize', () => { if (cfg) scheduleRender(); });

  for (const b of document.querySelectorAll('#tabs button')) b.addEventListener('click', () => {
    document.body.dataset.tab = b.dataset.tab;
    document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b));
    scheduleRender();
  });

  // ---------- definições ----------
  const dlg = $('#settings');
  function syncSettings() {
    if (!cfg) return;
    $('#set-res').value = `${cfg.output.width}x${cfg.output.height}`;
    const sz = `${cfg.convert.maxWidth}x${cfg.convert.maxHeight}`, csel = $('#set-conv-size');
    csel.value = sz;
    if (csel.value !== sz) csel.value = 'custom';              // tamanho que não é um preset
    $('#conv-custom').hidden = csel.value !== 'custom' || cfg.convert.process === false;
    if (document.activeElement !== $('#set-conv-w')) $('#set-conv-w').value = cfg.convert.maxWidth;
    if (document.activeElement !== $('#set-conv-h')) $('#set-conv-h').value = cfg.convert.maxHeight;
    $('#set-conv-fps').value = String(cfg.convert.fps);
    $('#set-conv-on').checked = cfg.convert.process !== false;
    $('#set-conv-size').disabled = $('#set-conv-fps').disabled = $('#set-conv-w').disabled = $('#set-conv-h').disabled = cfg.convert.process === false;
    $('#set-splash').checked = cfg.splash !== false;
    $('#pin-state').textContent = cfg.hasPin ? 'The panel is protected by a PIN.' : 'No PIN: anyone on the local network can control the screen.';
    $('#btn-pin-remove').hidden = !cfg.hasPin; $('#btn-logout').hidden = !cfg.hasPin;
  }
  $('#btn-settings').addEventListener('click', () => { $('#set-msg').textContent = ''; $('#set-pin').value = ''; syncSettings(); dlg.showModal(); });
  $('#set-res').addEventListener('change', e => { const [w, hh] = e.target.value.split('x').map(Number); sendOp({ op: 'setOutput', width: w, height: hh }); });
  $('#set-splash').addEventListener('change', e => sendOp({ op: 'setSplash', enabled: e.target.checked }));
  const sendConvert = () => {
    let w, hh;
    if ($('#set-conv-size').value === 'custom') { w = parseInt($('#set-conv-w').value, 10); hh = parseInt($('#set-conv-h').value, 10); }
    else [w, hh] = $('#set-conv-size').value.split('x').map(Number);
    const ok = v => Number.isInteger(v) && v >= 64 && v <= 4096;
    if (!ok(w) || !ok(hh)) { toast('Size must be between 64 and 4096'); $('#set-conv-w').value = cfg.convert.maxWidth; $('#set-conv-h').value = cfg.convert.maxHeight; syncSettings(); return; }
    sendOp({ op: 'setConvert', width: w, height: hh, fps: +$('#set-conv-fps').value, process: $('#set-conv-on').checked });
  };
  $('#set-conv-w').addEventListener('change', sendConvert);
  $('#set-conv-h').addEventListener('change', sendConvert);
  $('#set-conv-on').addEventListener('change', sendConvert);
  $('#set-conv-size').addEventListener('change', () => {
    if ($('#set-conv-size').value === 'custom') { $('#conv-custom').hidden = false; $('#set-conv-w').focus(); } else sendConvert();
  });
  $('#set-conv-fps').addEventListener('change', sendConvert);
  async function savePin(pin) {
    const r = await api('/api/pin', { pin });
    const msg = $('#set-msg');
    msg.style.color = r.ok ? 'var(--ok)' : 'var(--danger)';
    msg.textContent = r.ok ? (r.json.hasPin ? 'PIN saved.' : 'PIN removed.') : (r.json && r.json.error) || 'Could not save the PIN';
    if (r.ok) $('#set-pin').value = '';
  }
  $('#btn-pin-save').addEventListener('click', () => savePin($('#set-pin').value));
  $('#btn-pin-remove').addEventListener('click', () => savePin(''));
  $('#btn-logout').addEventListener('click', async () => { await api('/api/logout', {}); location.reload(); });

  // ---------- media: envio, fila e biblioteca ----------
  const mdlg = $('#media-dlg');
  const MB = n => n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n >= 10485760 ? Math.round(n / 1048576) : Math.round(n / 104857.6) / 10) + ' MB';

  function uploadFiles(files) {
    for (const f of files) {
      const up = { name: f.name, pct: 0, error: null, done: false };
      uploads.push(up); queueUploads.push([f, up]);
    }
    renderQueue(); runUploads();
  }
  // Dimensões (como se veem) de um vídeo local, lidas pelo browser; null se não as conseguir ler.
  function probeVideo(f) {
    return new Promise(resolve => {
      if (!f.type.startsWith('video/')) return resolve(null);
      const v = document.createElement('video'), u = URL.createObjectURL(f);
      const done = r => { clearTimeout(t); URL.revokeObjectURL(u); v.removeAttribute('src'); resolve(r); };
      const t = setTimeout(() => done(null), 2500);
      v.preload = 'metadata'; v.muted = true;
      v.onloadedmetadata = () => done(v.videoWidth && v.videoHeight ? [v.videoWidth, v.videoHeight] : null);
      v.onerror = () => done(null);
      v.src = u;
    });
  }
  // Caixa máxima deste ficheiro: a das definições, virada se o vídeo tiver a orientação oposta.
  function boxFor(dims) {
    let w = cfg.convert.maxWidth, hh = cfg.convert.maxHeight;
    if (dims && w !== hh && (dims[0] >= dims[1]) !== (w >= hh)) [w, hh] = [hh, w];
    return [w, hh];
  }
  const queueUploads = []; let uploading = false;
  async function runUploads() {          // um envio de cada vez (ligações móveis são lentas)
    if (uploading) return; uploading = true;
    while (queueUploads.length) {
      const [f, up] = queueUploads.shift();
      if (cfg.convert.process !== false && /\.(png)$/i.test(f.name) === false) { up.size = boxFor(await probeVideo(f)); renderQueue(); }
      await new Promise(resolve => {
        const x = new XMLHttpRequest();
        x.open('PUT', '/api/upload');
        x.setRequestHeader('X-Filename', encodeURIComponent(f.name));
        if (up.size) x.setRequestHeader('X-Max-Size', `${up.size[0]}x${up.size[1]}`);
        x.upload.onprogress = e => { if (e.lengthComputable) { up.pct = Math.round(100 * e.loaded / e.total); renderQueue(); } };
        x.onload = () => { if (x.status === 200) {
          up.done = true;
          try { up.kind = JSON.parse(x.responseText).kind; } catch {}
          if (up.kind === 'mask') { up.doneAt = Date.now(); setTimeout(renderQueue, 6200); }       // PNG: mostra "enviado" uns segundos
        } else { try { up.error = JSON.parse(x.responseText).error; } catch { up.error = 'erro ' + x.status; } } renderQueue(); resolve(); };
        x.onerror = () => { up.error = 'falha de rede'; renderQueue(); resolve(); };
        x.send(f);
      });
    }
    uploading = false;
    refreshMedia();                                   // garante a lista final, mesmo que alguma notificação se tenha perdido
  }

  function renderQueue() {
    const ul = $('#queue'); ul.textContent = '';
    const rows = [];
    uploads.forEach((u, i) => {
      if (u.done && u.kind === 'mask' && !u.error && Date.now() - u.doneAt < 6000)        // máscara enviada
        return rows.push(h('li', { class: 'mrow qrow' }, h('div', { class: 'info' }, h('div', { class: 'nm', text: u.name }),
          h('div', { class: 'sub', text: 'Mask uploaded ✓' }))));
      if (!u.done || u.error) rows.push(h('li', { class: 'mrow qrow' },
        h('div', { class: 'info' }, h('div', { class: 'nm', text: u.name }),
          u.error ? h('div', { class: 'sub err', text: 'Error: ' + u.error }) : h('div', { class: 'sub', text: `Uploading${u.size ? ` · max ${u.size[0]}×${u.size[1]}` : ''} · ${u.pct} %` }),
          u.error ? null : h('progress', { max: 100, value: u.pct })),
        u.error ? h('button', { text: '✕', 'aria-label': 'Remove', onclick: () => { uploads.splice(i, 1); renderQueue(); } }) : null)); });
    for (const j of jobs) {
      const rz = j.kind === 'resize';
      const txt = { queued: rz ? 'Queued to re-convert' : 'Queued', converting: `${rz ? `Re-converting to ${j.size[0]}×${j.size[1]}` : 'Converting'} ${j.progress} %`,
        done: rz && j.result ? `Done ✓ → ${j.result}` : 'Done ✓', error: 'Error: ' + j.error }[j.status];
      rows.push(h('li', { class: 'mrow qrow' },
        h('div', { class: 'info' }, h('div', { class: 'nm', text: j.name }), h('div', { class: 'sub' + (j.status === 'error' ? ' err' : ''), text: txt }),
          j.status === 'converting' ? h('progress', { max: 100, value: j.progress }) : null),
        j.status === 'done' ? null : h('button', { text: j.status === 'error' ? '✕' : 'Cancel', 'aria-label': 'Remove', onclick: () => api('/api/jobs/' + j.id, undefined, 'DELETE') })));
    }
    if (!rows.length) rows.push(h('li', { class: 'hint', text: 'Nothing in progress.' }));
    rows.forEach(r => ul.append(r));
    const active = jobs.filter(j => j.status === 'queued' || j.status === 'converting').length + uploads.filter(u => !u.done && !u.error).length;
    const b = $('#jobs-badge'); b.hidden = !active; b.textContent = active;
  }

  // Seleção de ficheiros (apagar / re-converter vários de uma vez).
  const picked = new Set();
  // Onde um ficheiro está a ser usado: [{ layer: 'Fundo' }]
  const usesOf = name => (cfg ? cfg.layers : []).filter(l => l.video === name || l.mask === name).map(l => ({ layer: l.name }));
  const usersOf = name => usesOf(name).map(u => u.layer);                         // para as confirmações
  function syncPicked() {
    for (const n of [...picked]) if (!media.some(m => m.name === n)) picked.delete(n);      // já não existem
    $('#lib-bar').hidden = !media.length;
    const all = $('#lib-all');
    all.checked = media.length > 0 && picked.size === media.length;
    all.indeterminate = picked.size > 0 && picked.size < media.length;
    $('#btn-resize-sel').disabled = !picked.size;
    $('#btn-resize-sel').textContent = picked.size ? `Re-convert selected (${picked.size})` : 'Re-convert selected';
    const b = $('#btn-del-sel');
    b.disabled = !picked.size; b.textContent = picked.size ? `Delete selected (${picked.size})` : 'Delete selected';
    document.querySelectorAll('#library .mrow.lib').forEach(li => li.classList.toggle('picked', picked.has(li.dataset.name)));
  }
  $('#lib-all').addEventListener('change', e => {
    picked.clear(); if (e.target.checked) media.forEach(m => picked.add(m.name));
    document.querySelectorAll('#library .mrow.lib input').forEach(c => { c.checked = e.target.checked; });
    syncPicked();
  });
  $('#btn-del-sel').addEventListener('click', async () => {
    const names = [...picked];
    if (!names.length) return;
    const used = names.map(n => [n, usersOf(n)]).filter(([, u]) => u.length);
    const list = names.length <= 6 ? names.map(n => `• ${n}`).join('\n') : `${names.length} files`;
    const warn = used.length ? `\n\n${used.length} of them ${used.length === 1 ? 'is' : 'are'} used by layers (${[...new Set(used.flatMap(([, u]) => u))].join(', ')}); those layers will be left without a file.` : '';
    if (!confirm(`Delete ${names.length} ${names.length === 1 ? 'file' : 'files'}?\n${list}${warn}`)) return;
    let failed = 0;
    for (const n of names) {
      const r = await api(`/api/media/${encodeURIComponent(n)}?force=1`, undefined, 'DELETE');
      if (r.ok) picked.delete(n); else failed++;
    }
    if (failed) toast(`Could not delete ${failed} ${failed === 1 ? 'file' : 'files'}`);
    await refreshMedia();
  });

  // ---------- re-converter (redimensionar) ----------
  const PRESETS_L = [[1920, 1080], [1280, 720], [960, 540], [640, 360], [480, 270]];
  const PRESETS_P = PRESETS_L.map(([w, hh]) => [hh, w]);
  const sizeText = ([w, hh]) => `${w} × ${hh}`;
  // Cabe numa caixa [bw, bh] sem ampliar? Devolve o tamanho resultante (aproximado) ou null se já cabe.
  function fitInside(iw, ih, bw, bh) {
    const k = Math.min(bw / iw, bh / ih);
    if (!(k < 1)) return null;
    return [2 * Math.round(iw * k / 2), 2 * Math.round(ih * k / 2)];
  }
  // Tamanho de que um vídeo realmente precisa: o maior que ocupa no ecrã (caixa do vídeo × scale da layer) nas layers que o usam.
  function needSize(m) {
    let w = 0, hh = 0;
    for (const l of cfg ? cfg.layers : []) {
      if (l.video !== m.name || isColor(l)) continue;
      const g = Geometry.compute(l, boxDims(l), vidDims(l));
      w = Math.max(w, g.video.width * l.scale); hh = Math.max(hh, g.video.height * l.scale);
    }
    if (!w) return null;
    return [Math.max(64, 2 * Math.ceil(w / 2)), Math.max(64, 2 * Math.ceil(hh / 2))];
  }
  // Se já existe a cópia com esse tamanho (nome_resized_LxA), a dica deixa de aparecer: já foi feita.
  const hasCopy = (m, need) => {
    const out = fitInside(m.width, m.height, need[0], need[1]);
    const stem = m.name.replace(/\.[^./]+$/, '').replace(/_resized_\d+x\d+$/, '');
    return !!out && media.some(x => x.name.startsWith(`${stem}_resized_${out[0]}x${out[1]}`));
  };
  // Só vale a pena sugerir quando o vídeo precisa claramente de menos que o ficheiro (menos de 90 %).
  const needsLess = m => { const need = m.kind === 'video' && m.width ? needSize(m) : null; return need && need[0] <= m.width * 0.9 && need[1] <= m.height * 0.9 && !hasCopy(m, need) ? need : null; };
  // Dica na linha do vídeo: "needs only 320 × 180 px · Fit to usage".
  function fitHint(m) {
    const need = needsLess(m);
    if (!need) return null;
    return h('div', { class: 'fits' }, h('div', { class: 'fit' }, `Needs only ${sizeText(need)} px`,
      h('button', { type: 'button', text: 'Fit to usage', title: 'Create a copy at the size the layers need', onclick: () => openResize([m], { fit: true }) })));
  }
  async function queueResize(items, box, replace = false) {
    let n = 0, fail = 0;
    for (const m of items) {
      if (!m.width || !fitInside(m.width, m.height, box[0], box[1])) continue;            // já cabe: nada a fazer
      const r = await api(`/api/media/${encodeURIComponent(m.name)}/resize`, { width: box[0], height: box[1], replace });
      if (r.ok) n++; else fail++;
    }
    if (n) toast(`Re-converting ${n} ${n === 1 ? 'file' : 'files'}${fail ? ` (${fail} failed)` : ''}. The player's videos are paused until it finishes${replace ? '; then the layers switch to the new video' : ''}.`, 'info');
    else toast(fail ? 'Could not re-convert' : 'Nothing to re-convert: the files already fit', fail ? undefined : 'info');
    renderQueue();
  }

  let rsItems = [];
  const rsBox = () => {
    const v = $('#rs-size').value;
    if (v === 'fit') return rsItems.length === 1 ? needSize(rsItems[0]) : null;
    if (v === 'custom') { const w = parseInt($('#rs-w').value, 10), hh = parseInt($('#rs-h').value, 10); return w >= 64 && w <= 4096 && hh >= 64 && hh <= 4096 ? [w, hh] : null; }
    return v.split('x').map(Number);
  };
  function renderResizePreview() {
    const box = rsBox(), ul = $('#rs-files'); ul.textContent = '';
    $('#rs-custom').hidden = $('#rs-size').value !== 'custom';
    let any = false;
    for (const m of rsItems) {
      const res = box && m.width ? fitInside(m.width, m.height, box[0], box[1]) : null;
      if (res) any = true;
      ul.append(h('li', {}, h('span', { text: `${m.name}  ${m.width ? sizeText([m.width, m.height]) : ''}` }),
        h('span', { class: 'res' + (res ? '' : ' skip'), text: !box ? 'choose a valid size' : res ? `→ ${sizeText(res)}` : 'already fits, skipped' })));
    }
    $('#rs-go').disabled = !any;
  }
  function openResize(items, opts = {}) {
    rsItems = items.filter(m => m.width);
    if (!rsItems.length) return toast('Could not read the size of this file');
    const sl = $('#rs-size'); sl.textContent = '';
    const one = rsItems.length === 1 && rsItems[0].kind === 'video' ? rsItems[0] : null;
    const need = one ? needsLess(one) : null;
    if (need) sl.append(h('option', { value: 'fit', text: `Fit to usage (${sizeText(need)})` }));
    for (const [label, list] of [['Landscape', PRESETS_L], ['Portrait', PRESETS_P]]) {
      const g = h('optgroup', { label });
      for (const p of list) g.append(h('option', { value: p.join('x'), text: sizeText(p) }));
      sl.append(g);
    }
    sl.append(h('option', { value: 'custom', text: 'Custom…' }));
    // Por omissão: o "Fit to usage"; senão o maior preset que realmente reduz o primeiro vídeo.
    const first = rsItems[0], pick = [...PRESETS_L, ...PRESETS_P].find(([w, hh]) => fitInside(first.width, first.height, w, hh));
    sl.value = need ? 'fit' : pick ? pick.join('x') : '640x360';
    // "Use the copy where the original is used": só com um vídeo que esteja em alguma layer.
    const used = one && cfg.layers.some(l => l.video === one.name);
    $('#rs-use-row').hidden = !used; $('#rs-use').checked = !!used; syncUseHint();
    $('#rs-w').value = 640; $('#rs-h').value = 360;
    renderResizePreview();
    $('#resize-dlg').showModal();
  }
  const syncUseHint = () => { $('#rs-use-hint').hidden = $('#rs-use-row').hidden || !$('#rs-use').checked; };
  $('#rs-use').addEventListener('change', syncUseHint);
  $('#rs-size').addEventListener('change', renderResizePreview);
  $('#rs-w').addEventListener('input', renderResizePreview); $('#rs-h').addEventListener('input', renderResizePreview);
  $('#rs-cancel').addEventListener('click', () => $('#resize-dlg').close());
  $('#rs-go').addEventListener('click', () => {
    const box = rsBox(); if (!box) return;
    const replace = !$('#rs-use-row').hidden && $('#rs-use').checked;
    $('#resize-dlg').close(); queueResize(rsItems, box, replace);
  });
  $('#btn-resize-sel').addEventListener('click', () => openResize(media.filter(m => picked.has(m.name))));

  function renderLibrary() {
    const ul = $('#library'); ul.textContent = '';
    if (!media.length) ul.append(h('li', { class: 'hint', text: 'The library is empty.' }));
    for (const m of media) {
      const users = usersOf(m.name), uses = usesOf(m.name);
      const img = m.kind === 'video' ? thumbUrl(m) : maskUrl(m.name);
      const cb = h('input', { type: 'checkbox', 'aria-label': `Select ${m.name}`, onchange: e => { e.target.checked ? picked.add(m.name) : picked.delete(m.name); syncPicked(); } });
      cb.checked = picked.has(m.name);
      ul.append(h('li', { class: 'mrow lib', 'data-name': m.name }, cb,
        m.kind === 'mask' ? h('div', { class: 'thumb mk' }, maskPreview(m.name))
          : h('div', { class: 'thumb', style: `background-image:url("${img}")` }),
        h('div', { class: 'info' }, h('div', { class: 'nm', text: m.name }),
          h('div', { class: 'sub', text: `${m.kind === 'video' ? 'video' : 'mask'}${m.width ? ` ${m.width}×${m.height}` : ''} · ${MB(m.size)}` }),
          uses.length ? h('div', { class: 'uses' }, h('b', { text: 'In use' }),
            uses.map(u => h('span', { class: 'use', title: `Used by the layer “${u.layer}”`, text: u.layer }))) : null,
          fitHint(m)),
        h('div', { class: 'btns' },
          h('button', { text: 'Rename', onclick: () => renameMedia(m) }),
          m.kind === 'video' ? h('button', { text: 'Re-convert', title: 'Create a smaller copy of this video', onclick: () => openResize([m]) }) : null,
          h('button', { class: 'danger', text: 'Delete', onclick: () => deleteMedia(m, users) }))));
    }
    syncPicked();
  }

  async function renameMedia(m) {
    const ext = m.name.slice(m.name.lastIndexOf('.'));
    const to = prompt('New name (without the extension):', m.name.slice(0, -ext.length));
    if (!to || !to.trim()) return;
    const r = await api(`/api/media/${encodeURIComponent(m.name)}/rename`, { name: to });
    if (!r.ok) toast((r.json && r.json.error) || 'Could not rename');
  }
  async function deleteMedia(m, users) {
    const aviso = users.length ? `“${m.name}” is used by these layers: ${users.join(', ')}.\nDelete anyway? (the layers will be left without a file)` : `Delete “${m.name}”?`;
    if (!confirm(aviso)) return;
    const r = await api(`/api/media/${encodeURIComponent(m.name)}?force=1`, undefined, 'DELETE');
    if (!r.ok) toast((r.json && r.json.error) || 'Could not delete');
  }

  $('#btn-media').addEventListener('click', () => { refreshMedia(); renderQueue(); renderLibrary(); mdlg.showModal(); });
  $('#media-close').addEventListener('click', () => mdlg.close());
  $('#file-input').addEventListener('change', e => { uploadFiles([...e.target.files]); e.target.value = ''; });
  // arrastar e largar ficheiros para qualquer ponto da página
  addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); document.body.classList.add('dragging'); } });
  addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  addEventListener('drop', e => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault(); document.body.classList.remove('dragging');
    if (!mdlg.open) { renderLibrary(); mdlg.showModal(); }
    uploadFiles([...e.dataTransfer.files]);
  });

  // ---------- debug: FPS, frames perdidos, CPU, GPU, temperatura ----------
  let debugOn = false;
  try { debugOn = localStorage.getItem('debug') === '1'; } catch {}
  const dbg = $('#debug'), dbtn = $('#btn-debug');
  const lvl = (v, warn, bad) => (v == null ? 'off' : v >= bad ? 'bad' : v >= warn ? 'warn' : '');
  const span = (cls, text) => h('span', { class: cls, text });
  // RAM: ocupada e livre (livre = disponível para programas). Avisa quando resta pouco.
  const GB = mb => (mb / 1024).toFixed(1) + ' GB';
  function ramLine(r) {
    if (!r) return [span('', 'RAM '), span('off', '-')];
    const freePct = 100 * r.free / r.total;
    return [span('', 'RAM used '), span('', GB(r.used)), span('', '  free '), span(freePct < 10 ? 'bad' : freePct < 20 ? 'warn' : '', GB(r.free)), span('off', ` / ${GB(r.total)}`)];
  }
  function renderDebug(m) {
    if (!debugOn) return;
    const p = m.player;
    dbg.textContent = '';
    const line1 = p ? [span('', 'FPS '), h('b', { text: p.fps.toFixed(0) }), span('', '  dropped '), span(p.recent > 0 ? 'warn' : '', `${p.recent}`), span('off', ` (10 s) / ${p.dropped}`)]
      : [span('off', 'player not responding')];
    dbg.append(
      ...line1,
      '\n',
      span('', 'CPU '), span(lvl(m.cpu, 70, 90), m.cpu == null ? '-' : m.cpu + '%'),
      span('', '  GPU '), span(lvl(m.gpu, 80, 95), m.gpu == null ? '-' : m.gpu + '%'),
      span('', '  '), span(lvl(m.temp, 70, 80), m.temp == null ? '- °C' : m.temp + ' °C'),
      '\n', ...ramLine(m.ram));
  }
  function setDebug(on) {
    debugOn = on;
    try { localStorage.setItem('debug', on ? '1' : '0'); } catch {}
    dbtn.classList.toggle('on', on); dbtn.setAttribute('aria-pressed', on);
    dbg.hidden = !on;
    if (on) { dbg.textContent = 'measuring…'; dbg.className = ''; }
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'subscribe', stats: on }));
  }
  dbtn.addEventListener('click', () => setDebug(!debugOn));
  setDebug(debugOn);

  // ---------- output: o player real dentro da pré-visualização ----------
  let outOn = false, outFrame = null;
  try { outOn = localStorage.getItem('output') === '1'; } catch {}
  const obtn = $('#btn-output');
  function setOutput(on) {
    outOn = on;
    try { localStorage.setItem('output', on ? '1' : '0'); } catch {}
    obtn.classList.toggle('on', on); obtn.setAttribute('aria-pressed', on);
    preview.classList.toggle('out-on', on);
    if (on && !outFrame) {                 // splash quase 0: sem o ecrã do QR dentro da pré-visualização
      outFrame = h('iframe', { id: 'outframe', src: '/player/?splash=0.001', title: 'Output', tabindex: '-1', 'aria-hidden': 'true' });
      preview.insertBefore(outFrame, pstage);
    } else if (!on && outFrame) { outFrame.remove(); outFrame = null; }   // desligado: o player pára e deixa de gastar CPU
  }
  obtn.addEventListener('click', () => setOutput(!outOn));
  setOutput(outOn);

  // ---------- login ----------
  function showLogin() {
    $('#app').hidden = true; $('#login').hidden = false; $('#login-msg').textContent = ''; $('#login-pin').value = ''; $('#login-pin').focus();
  }
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const r = await api('/api/login', { pin: $('#login-pin').value });
    const msg = $('#login-msg');
    if (r.ok) { msg.textContent = ''; $('#login').hidden = true; start(); }
    else if (r.status === 429) msg.textContent = `Too many attempts. Try again in ${r.json.retryAfter} s.`;
    else msg.textContent = 'Wrong PIN.';
    $('#login-pin').value = '';
  });

  // ---------- ligar e desligar o player ----------
  // Desligado: só pára os vídeos (o output continua visível, parado) e o Pi descodifica menos. Não pára o Chromium nem o servidor.
  function renderPlayer() {
    const b = $('#btn-player');
    b.hidden = playerOn === null;
    b.textContent = playerOn ? 'Turn off player' : 'Turn on player';
    b.classList.toggle('danger-ghost', !!playerOn);
    b.classList.toggle('on', playerOn === false);
    renderMonitor();
  }
  $('#btn-player').addEventListener('click', async () => {
    const r = await api('/api/player', { on: !playerOn });
    if (!r.ok) toast((r.json && r.json.error) || 'Could not change the player');
  });

  // ---------- modo RUN / EDIT ----------
  // RUN: só se observa o output (sem layers, propriedades nem arrastar). EDIT: tudo editável; desliga sozinho após 5 min sem atividade.
  function renderEdit() {
    const on = !!editState.editing;
    document.body.classList.toggle('editing', on);
    $('#btn-run').classList.toggle('on', !on); $('#btn-run').setAttribute('aria-pressed', !on);
    $('#btn-edit').classList.toggle('on', on); $('#btn-edit').setAttribute('aria-pressed', on);
    const note = $('#edit-note');
    const left = Math.max(0, Math.round(((editState.editUntil || 0) - Date.now()) / 1000));
    note.hidden = !(on && left < 60);                  // só avisa no último minuto
    if (!note.hidden) note.textContent = `Edit mode ends in ${left} s without activity. Touch the panel to keep it.`;
    renderMonitor();
  }
  function renderMonitor() {
    const el = $('#monitor');
    if (!el || editState.editing || !cfg) return;
    const vis = cfg.layers.filter(l => l.visible).length;
    el.replaceChildren(
      h('div', {}, 'Mode: ', h('b', { text: 'RUN' }), h('span', { class: 'off', text: '  press EDIT to change layers and media' })),
      h('div', { class: 'off', text: `${cfg.layers.length} ${cfg.layers.length === 1 ? 'layer' : 'layers'} (${vis} visible) · output ${cfg.output.width}×${cfg.output.height}` }),
      h('div', { class: 'off', text: playerOn === null ? '' : playerOn ? 'Videos running' : 'Videos stopped (player off)' }));
  }
  function onEdit(m) {
    const was = !!editState.editing;
    editState = { editing: !!m.editing, editUntil: m.editUntil || 0 };
    if (was && !m.editing) {
      flush(); editor.stop(); sel = null;
      if (m.reason === 'inactivity') toast('Edit mode ended after 5 minutes without activity');
    }
    if (!was && m.editing && cfg && !sel) sel = cfg.layers.length ? cfg.layers[cfg.layers.length - 1].id : null;
    listSig = ''; propsKey = '';
    renderEdit(); renderAll();
  }
  $('#btn-run').addEventListener('click', () => { if (editState.editing) wsSend({ type: 'edit', on: false }); });
  $('#btn-edit').addEventListener('click', () => { if (!editState.editing) wsSend({ type: 'edit', on: true }); });
  setInterval(() => { if (editState.editing) renderEdit(); }, 1000);
  let lastPing = 0;                                                       // atividade no painel: adia o fim automático da edição
  const ping = () => {
    if (!editState.editing || Date.now() - lastPing < 5000) return;
    lastPing = Date.now(); editState.editUntil = Date.now() + 5 * 60 * 1000;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'edit-ping' }));
  };
  addEventListener('pointerdown', ping, true); addEventListener('keydown', ping, true);
  function wsSend(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); else toast('No connection to the server'); }

  // ---------- aviso ----------
  let toastTimer = null;
  // Um <dialog> aberto com showModal() fica numa camada acima de tudo, por isso um aviso no <body> ficava escondido atrás dele.
  // Enquanto houver um diálogo aberto, o aviso passa a viver dentro dele. `kind` = 'info' para avisos que não são erros.
  function toast(text, kind) {
    const t = $('#toast'), host = document.querySelector('dialog[open]') || document.body;
    if (t.parentNode !== host) host.append(t);
    t.textContent = text; t.classList.toggle('info', kind === 'info'); t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), kind === 'info' ? 6000 : 3500);
  }

  // ---------- versão (vem do servidor, de server/package.json) ----------
  api('/api/info').then(r => { if (r.ok && r.json.version) $('#version').textContent = 'v' + r.json.version; }).catch(() => {});

  // ---------- arranque ----------
  let started = false;
  async function start() {
    $('#app').hidden = false;
    await refreshMedia();
    if (started) { if (ws) ws.close(); return; }
    started = true;
    connect();
  }
  addEventListener('focus', () => { if (started) refreshMedia(); });

  (async () => {
    const s = await api('/api/session').catch(() => null);
    if (s && s.ok && s.json.hasPin && !s.json.authed) showLogin(); else start();
  })();
})();
