'use strict';
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const { ConfigStore, publicConfig } = require('./lib/config');
const { OpError, validConvertSize } = require('./lib/model');
const { Auth } = require('./lib/auth');
const { Media } = require('./lib/media');
const { Converter } = require('./lib/convert');
const fs = require('fs');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
require('./lib/log').install();          // hora em cada linha, erros a vermelho
const sysstats = require('./lib/sysstats');
process.on('uncaughtException', e => console.error('[servidor] uncaughtException:', e));
process.on('unhandledRejection', e => console.error('[servidor] unhandledRejection:', e));

const PORT = Number(process.env.PORT) || 8080;
const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

const store = new ConfigStore(DATA_DIR);
const auth = new Auth(DATA_DIR);
const media = new Media(path.join(DATA_DIR, 'media'), path.join(DATA_DIR, 'thumbs'));

const converter = new Converter({
  uploadDir: path.join(DATA_DIR, 'uploads'), mediaDir: media.dir,
  getSettings: () => { const c = store.get().convert; return { maxWidth: c.maxWidth, maxHeight: c.maxHeight, fps: c.fps, process: c.process }; },
});
converter.recover();

const MAX_UPLOAD = 4 * 1024 ** 3;        // 4 GB por ficheiro
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const app = express();
app.disable('x-powered-by');
// Log: só os pedidos à API que falham (erros 401 do login não contam).
app.use((req, res, next) => {
  res.on('finish', () => { if (res.statusCode >= 400 && res.statusCode !== 401 && req.originalUrl.startsWith('/api/') && req.originalUrl !== '/api/clientlog') console.warn(`[http] ${req.method} ${req.originalUrl.split('?')[0]} -> ${res.statusCode}`); });
  next();
});

// ---------- utilitários ----------
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}

// Autorizado se: não há PIN, ou o pedido vem do próprio Pi (player), ou traz uma sessão válida.
function isAuthorized(req) {
  if (!store.get().pinHash) return true;
  if (Auth.isLoopback(req.socket.remoteAddress)) return true;
  return auth.verify(Auth.cookie(req.headers.cookie, 'session'));
}
const requireAuth = (req, res, next) => (isAuthorized(req) ? next() : res.status(401).json({ error: 'auth' }));

// ---------- rotas abertas ----------
const VERSION = require('./package.json').version;       // fonte única da versão da app

app.get('/api/info', async (_req, res) => {
  const ips = lanAddresses();
  const urls = ips.map(ip => `http://${ip}:${PORT}`);
  const mdns = sysstats.mdns ? `http://${os.hostname().replace(/\.local$/i, '')}.local:${PORT}` : null;     // null = não mostrar (ex.: Windows)
  const qr = urls[0] ? await QRCode.toString(urls[0], { type: 'svg', margin: 1 }) : null;
  res.set('Cache-Control', 'no-store').json({ version: VERSION, port: PORT, ips, urls, mdns, qr });
});

app.get('/api/session', (req, res) =>
  res.set('Cache-Control', 'no-store').json({ hasPin: !!store.get().pinHash, authed: isAuthorized(req) }));

app.post('/api/login', express.json({ limit: '1kb' }), (req, res) => {
  const ip = req.socket.remoteAddress;
  const wait = auth.lockedFor(ip);
  if (wait) return res.status(429).json({ error: 'locked', retryAfter: wait });
  const pin = req.body && req.body.pin;
  if (typeof pin !== 'string' || !store.verifyPin(pin)) {
    auth.fail(ip);
    return res.status(401).json({ error: 'pin' });
  }
  auth.success(ip);
  res.set('Set-Cookie', auth.setCookieHeader()).json({ ok: true });
});

app.post('/api/logout', (_req, res) => res.set('Set-Cookie', Auth.clearCookieHeader()).json({ ok: true }));

// ---------- rotas protegidas ----------
app.get('/api/stats', requireAuth, (_req, res) => res.set('Cache-Control', 'no-store').json(sysstats.sample()));
app.get('/api/config', requireAuth, (_req, res) => res.set('Cache-Control', 'no-store').json(publicConfig(store.get())));

app.get('/api/media', requireAuth, async (_req, res) => {
  try { res.set('Cache-Control', 'no-store').json(await media.list()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/thumb/:name', requireAuth, async (req, res) => {
  try {
    const file = await media.thumb(req.params.name);
    res.set('Cache-Control', 'private, max-age=300').sendFile(file);
  } catch { res.status(404).end(); }
});

// Player ligado/desligado: "desligado" só PÁRA OS VÍDEOS (o output continua visível, parado) e o Pi descodifica menos.
// Não pára o Chromium nem o servidor. Estado do servidor (todos os painéis e o player veem o mesmo); arranca sempre ligado.
let playerOn = true;
let autoPaused = false;                              // parado automaticamente por um redimensionamento (e não à mão)
function setPlayer(on, auto = false) {
  if (!auto) autoPaused = false;                     // quem decide à mão fica com o controlo
  if (on === playerOn) return;
  playerOn = on;
  console.log(`[servidor] vídeos ${on ? 'a correr' : 'parados'}${auto ? ' (automático)' : ''}`);
  broadcast({ type: 'player', on });
}
// {"on": true|false} liga/desliga; {"toggle": true} alterna (é o que a tecla F9 usa, via deploy/toggle-player.sh).
app.post('/api/player', requireAuth, express.json({ limit: '1kb' }), (req, res) => {
  const b = req.body || {};
  if (b.toggle === true) setPlayer(!playerOn);
  else if (typeof b.on === 'boolean') setPlayer(b.on);
  else return res.status(400).json({ error: 'expected {"on": true|false} or {"toggle": true}' });
  res.json({ ok: true, on: playerOn });
});
app.get('/api/player', requireAuth, (_req, res) => res.set('Cache-Control', 'no-store').json({ on: playerOn }));

// Mudar o PIN: troca o segredo (termina as outras sessões) e dá uma sessão nova a quem o mudou.
app.post('/api/pin', requireAuth, express.json({ limit: '1kb' }), (req, res) => {
  try {
    store.apply({ op: 'setPin', pin: req.body && req.body.pin });
  } catch (e) {
    return res.status(400).json({ error: e instanceof OpError ? e.message : 'error' });
  }
  auth.rotate();
  for (const c of wss.clients) if (!c.loopback) c.close(4401, 'pin alterado');
  if (store.get().pinHash) res.set('Set-Cookie', auth.setCookieHeader());
  res.json({ ok: true, hasPin: !!store.get().pinHash });
});

// Quais layers usam um ficheiro de media.
const usageOf = name => store.get().layers.filter(l => l.video === name || l.mask === name);

app.get('/api/jobs', requireAuth, (_req, res) => res.set('Cache-Control', 'no-store').json(converter.list()));
app.delete('/api/jobs/:id', requireAuth, (req, res) => res.status(converter.dismiss(req.params.id) ? 200 : 404).json({}));

// Upload: o corpo do pedido é o próprio ficheiro (sem multipart); o nome vai no cabeçalho X-Filename.
app.put('/api/upload', requireAuth, async (req, res) => {
  const fail = (code, error) => { if (!res.headersSent) res.status(code).json({ error }); req.resume(); };
  let orig;
  try { orig = Media.sanitize(decodeURIComponent(req.headers['x-filename'] || '')); } catch { orig = ''; }
  const size = Number(req.headers['content-length']);
  if (!orig) return fail(400, 'missing file name');
  if (!size) return fail(411, 'missing size');
  if (size > MAX_UPLOAD) return fail(413, 'file too large (max 4 GB)');
  try { const f = fs.statfsSync(DATA_DIR); if (f.bavail * f.bsize < size * 2 + 512 * 1024 ** 2) return fail(507, 'not enough free space'); } catch {}
  // Tamanho máximo deste vídeo (ex.: "640x360"); sem cabeçalho usa o das definições.
  let maxSize = null;
  if (req.headers['x-max-size']) {
    const m = /^(\d{1,4})x(\d{1,4})$/.exec(String(req.headers['x-max-size']));
    if (!m || !validConvertSize(+m[1], +m[2])) return fail(400, 'invalid size');
    maxSize = [+m[1], +m[2]];
  } else { const c = store.get().convert; maxSize = [c.maxWidth, c.maxHeight]; }
  const ext = path.extname(orig).toLowerCase();
  const isPng = ext === '.png';
  const id = crypto.randomBytes(4).toString('hex');
  const part = path.join(converter.uploadDir, `${id}__${maxSize[0]}x${maxSize[1]}__${orig}.part`);
  let received = 0;
  const limit = new Transform({ transform(chunk, _e, cb) { received += chunk.length; cb(received > size ? new Error('exceeded the declared size') : null, chunk); } });
  try {
    await pipeline(req, limit, fs.createWriteStream(part));
  } catch { try { fs.unlinkSync(part); } catch {} return fail(400, 'upload interrupted'); }
  if (received !== size) { try { fs.unlinkSync(part); } catch {} return fail(400, 'upload incomplete'); }
  if (isPng) {                                          // máscara: valida e guarda diretamente
    const head = Buffer.alloc(8); const fd = fs.openSync(part, 'r'); fs.readSync(fd, head, 0, 8, 0); fs.closeSync(fd);
    if (!head.equals(PNG_MAGIC)) { fs.unlinkSync(part); return fail(415, 'not a valid PNG'); }
    const name = media.uniqueName(orig.slice(0, orig.length - ext.length), '.png');
    fs.renameSync(part, path.join(media.dir, name));
    broadcast({ type: 'media' });
    return res.json({ ok: true, kind: 'mask', name });
  }
  const final = path.join(converter.uploadDir, `${id}__${maxSize[0]}x${maxSize[1]}__${orig}`);
  fs.renameSync(part, final);
  converter.enqueue(id, final, orig, maxSize);                   // vídeo: vai para a fila de conversão
  res.json({ ok: true, kind: 'video', id });
});

app.delete('/api/media/:name', requireAuth, (req, res) => {
  const name = req.params.name, users = usageOf(name);
  if (users.length && req.query.force !== '1') return res.status(409).json({ error: 'in use', layers: users.map(l => l.name) });
  if (!media.remove(name)) return res.status(404).json({ error: 'not found' });
  for (const l of users) {                              // as layers deixam de apontar para um ficheiro que já não existe
    store.apply({ op: 'updateLayer', id: l.id, patch: { [l.video === name ? 'video' : 'mask']: null } });
  }
  broadcast({ type: 'media' });
  res.json({ ok: true });
});

app.post('/api/media/:name/rename', requireAuth, express.json({ limit: '1kb' }), (req, res) => {
  const from = req.params.name, ext = path.extname(from);
  const base = Media.sanitize(String((req.body && req.body.name) || '')).replace(new RegExp(ext.replace('.', '\\.') + '$', 'i'), '');
  if (!base) return res.status(400).json({ error: 'invalid name' });
  const to = base + ext;
  const r = to === from ? 'ok' : media.rename(from, to);
  if (r === 'inexistente') return res.status(404).json({ error: 'not found' });
  if (r === 'existe') return res.status(409).json({ error: 'a file with that name already exists' });
  for (const l of usageOf(from)) {                      // as layers continuam a apontar para o ficheiro renomeado
    const patch = {}; if (l.video === from) patch.video = to; if (l.mask === from) patch.mask = to;
    store.apply({ op: 'updateLayer', id: l.id, patch });
  }
  broadcast({ type: 'media' });
  res.json({ ok: true, name: to });
});

// Redimensionar um ficheiro da biblioteca para caber numa caixa; cria um ficheiro novo (nome_resized_LxA). Ver converter.enqueueResize.
app.post('/api/media/:name/resize', requireAuth, express.json({ limit: '1kb' }), (req, res) => {
  const name = req.params.name, b = req.body || {};
  if (!Media.safeName(name) || !fs.existsSync(media.file(name))) return res.status(404).json({ error: 'not found' });
  if (!['.mp4', '.m4v', '.mov', '.webm', '.png'].includes(path.extname(name).toLowerCase())) return res.status(400).json({ error: 'unsupported file' });
  if (!validConvertSize(b.width, b.height)) return res.status(400).json({ error: 'invalid size (64 to 4096)' });
  res.json({ ok: true, id: converter.enqueueResize(name, [b.width, b.height], b.replace === true) });
});

app.use('/media', requireAuth, express.static(media.dir, { fallthrough: false, maxAge: 0, etag: true }));
app.use('/player', express.static(path.join(ROOT, 'public', 'player'), { maxAge: 0 }));
app.use('/shared', express.static(path.join(ROOT, 'public', 'shared'), { maxAge: 0 }));
app.use('/', express.static(path.join(ROOT, 'public', 'panel'), { maxAge: 0 }));

// ---------- erros: terminal ----------
// Erros de JavaScript do browser (painel e player): chegam aqui para aparecerem no terminal. Máx. 30 por minuto.
let clientLogs = 0;
setInterval(() => { clientLogs = 0; }, 60000).unref();
app.post('/api/clientlog', express.json({ limit: '4kb' }), (req, res) => {
  if (clientLogs++ < 30 && req.body && typeof req.body.msg === 'string') console.error(`[browser ${String(req.body.page || '').slice(0, 40)}] ${req.body.msg.slice(0, 500)}`);
  res.status(204).end();
});
// Falhas de conversão (ffmpeg): uma linha por trabalho.
const loggedJobs = new Set();
converter.on('jobs', jobs => { for (const j of jobs) if (j.status === 'error' && !loggedJobs.has(j.id)) { loggedJobs.add(j.id); console.error(`[convert] ${j.name}: ${j.error}`); } });
// Erro dentro de um pedido: uma linha no terminal e resposta JSON (em vez da página com a stack).
app.use((err, req, res, next) => {
  if (!err.status || err.status >= 500) console.error(`[http] ${req.method} ${req.originalUrl.split('?')[0]}: ${err.message}`);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message });
});

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const refuse = code => { socket.write(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  if (new URL(req.url, 'http://x').pathname !== '/ws') return refuse('404 Not Found');
  // Impede que outro site aberto no browser use a sessão para falar com o servidor (CSWSH).
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(origin).host !== req.headers.host) return refuse('403 Forbidden'); } catch { return refuse('403 Forbidden'); } }
  if (!isAuthorized(req)) return refuse('401 Unauthorized');
  // O player identifica-se com ?role=player; tudo o resto é um painel (conta para o modo EDIT).
  const isPlayer = new URL(req.url, 'http://x').searchParams.get('role') === 'player';
  wss.handleUpgrade(req, socket, head, ws => { ws.loopback = Auth.isLoopback(req.socket.remoteAddress); ws.isPanel = !isPlayer; wss.emit('connection', ws, req); });
});

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
function broadcast(msg) {
  const text = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(text);
}

// ---- estatísticas para o painel (debug): só se medem enquanto houver painéis a pedir ----
let statsTimer = null, lastPlayer = null;
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
function updateStatsTimer() {
  const subs = [...wss.clients].filter(c => c.statsSub).length;
  const players = [...wss.clients].filter(c => c.loopback);
  if (subs && !statsTimer) {
    statsTimer = setInterval(() => {
      const sys = sysstats.sample();
      const player = lastPlayer && Date.now() - lastPlayer.t < 3500 ? lastPlayer.s : null;   // null = player sem resposta
      const text = JSON.stringify({ type: 'stats', cpu: sys.cpu, gpu: sys.gpu, temp: sys.temp, ram: sys.ram, player });
      for (const c of wss.clients) if (c.statsSub && c.readyState === 1) c.send(text);
    }, 1000);
  } else if (!subs && statsTimer) { clearInterval(statsTimer); statsTimer = null; lastPlayer = null; }
  for (const p of players) send(p, { type: 'debug', on: subs > 0 });     // o player só mede quando alguém vê
}

// Identifica este arranque: se mudar, o player e o painel recarregam-se (apanham o código novo).
const BOOT_ID = Date.now().toString(36);

// Estado efémero (não vai para a configuração): só interessa ao player local.
function relayMaskEdit(id, shape) {
  for (const c of wss.clients) if (c.loopback) send(c, { type: 'maskEdit', id, shape });
}

// ---- Modo RUN / EDIT (estado do servidor) ----
// RUN: o painel mostra só o output e o monitor (sem editar); EDIT: tudo editável. EDIT desliga sozinho sem atividade
// (5 min) ou quando o último painel se desliga (15 s de tolerância para recargas). Arranca sempre em RUN.
const EDIT_IDLE_MS = 5 * 60 * 1000;
let editing = false, editUntil = 0, editGrace = null;
const editState = reason => ({ type: 'edit', editing, editUntil: editing ? editUntil : 0, reason: reason || null });
function setEditing(on, reason) {
  on = !!on;
  if (on) editUntil = Date.now() + EDIT_IDLE_MS;
  if (on === editing) { if (on) broadcast(editState()); return; }
  editing = on; clearTimeout(editGrace); editGrace = null;
  console.log(`[servidor] modo ${on ? 'EDIT' : 'RUN'}${reason ? ` (${reason})` : ''}`);
  broadcast(editState(reason));
}
const touchEdit = () => { if (editing) editUntil = Date.now() + EDIT_IDLE_MS; };
function endEditIfNoPanels() {
  if (!editing || editGrace) return;
  if ([...wss.clients].some(c => c.isPanel && c.readyState === 1)) return;
  editGrace = setTimeout(() => {
    editGrace = null;
    if (![...wss.clients].some(c => c.isPanel && c.readyState === 1)) setEditing(false, 'no panels');
  }, 15000);
  editGrace.unref();
}
setInterval(() => {
  if (editing && Date.now() > editUntil) setEditing(false, 'inactivity');
  else if (editing) broadcast(editState());          // reenvia a contagem do tempo restante
}, 5000).unref();

wss.on('connection', (ws, req) => {
  const who = `${ws.loopback ? 'local' : req.socket.remoteAddress.replace(/^::ffff:/, '')}`;
  console.log(`[ws] ligado: ${who} (${wss.clients.size})`);
  ws.once('close', () => console.log(`[ws] desligado: ${who} (${wss.clients.size})`));
  ws.isAlive = true;
  ws.statsSub = false;
  ws.on('close', () => { updateStatsTimer(); endEditIfNoPanels(); if (ws.maskEdit) relayMaskEdit(null, -1);
    if (ws.maskCursor) for (const c of wss.clients) if (c.loopback) send(c, { type: 'maskCursor', x: null, y: null }); });
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});
  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (ws.isPanel && msg && ['edit', 'edit-ping', 'op', 'maskEdit', 'maskCursor'].includes(msg.type)) touchEdit();   // atividade no painel
    if (msg && msg.type === 'edit') { if (ws.isPanel) setEditing(!!msg.on, 'panel'); return; }
    if (msg && msg.type === 'edit-ping') return;
    if (msg && msg.type === 'subscribe') { ws.statsSub = !!msg.stats; updateStatsTimer(); return; }
    if (msg && msg.type === 'player-stats') {                    // só o player local (loopback) pode reportar
      if (ws.loopback) lastPlayer = { t: Date.now(), s: { fps: num(msg.fps), dropped: num(msg.dropped), recent: num(msg.recent), total: num(msg.total), layers: num(msg.layers) } };
      return;
    }
    if (msg && msg.type === 'maskEdit') {                        // o painel está a desenhar uma máscara: o player mostra os contornos
      ws.maskEdit = typeof msg.id === 'string' && msg.id.length <= 40 ? msg.id : null;
      relayMaskEdit(ws.maskEdit, Number.isInteger(msg.shape) ? msg.shape : -1);
      return;
    }
    if (msg && msg.type === 'maskCursor') {                      // posição do rato no painel (mira no ecrã de saída)
      const ok = v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e5;
      const pos = ok(msg.x) && ok(msg.y) ? { x: msg.x, y: msg.y } : null;
      ws.maskCursor = !!pos;
      for (const c of wss.clients) if (c.loopback) send(c, { type: 'maskCursor', ...(pos || { x: null, y: null }) });
      return;
    }
    if (!msg || msg.type !== 'op') return;
    // O PIN só se altera por /api/pin (precisa de renovar a sessão); a última alteração prevalece.
    if (msg.op && msg.op.op === 'setPin') return send(ws, { type: 'error', message: 'use /api/pin' });
    try { store.apply(msg.op); }
    catch (e) { send(ws, { type: 'error', message: e instanceof OpError ? e.message : 'invalid operation' }); }
  });
  send(ws, { type: 'hello', boot: BOOT_ID });
  send(ws, { type: 'config', config: publicConfig(store.get()) });
  send(ws, editState());
  send(ws, { type: 'player', on: playerOn });
  send(ws, { type: 'jobs', jobs: converter.list() });
  if (ws.loopback && statsTimer) send(ws, { type: 'debug', on: true });
});

setInterval(() => {
  for (const c of wss.clients) { if (!c.isAlive) { c.terminate(); continue; } c.isAlive = false; c.ping(); }
}, 15000).unref();

// Terminado um redimensionamento pedido com "usar nas layers": as layers que usavam o original passam a usar o novo.
// Sem máscara a caixa da layer é o próprio vídeo, por isso scale e offset do vídeo compensam-se (a layer fica com o mesmo tamanho no ecrã).
converter.on('resized', ({ from, to, replace, fromWidth, toWidth }) => {
  if (!replace) return;
  const k = fromWidth / toWidth;
  const hits = store.get().layers.filter(l => l.video === from);
  for (const l of hits) {
    const patch = { video: to };
    if (!l.mask && !l.vmask && Number.isFinite(k) && k !== 1) {
      patch.scale = +(l.scale * k).toFixed(4); patch.videoOffsetX = +(l.videoOffsetX / k).toFixed(2); patch.videoOffsetY = +(l.videoOffsetY / k).toFixed(2);
    }
    try { store.apply({ op: 'updateLayer', id: l.id, patch }); } catch (e) { console.error('[servidor] resize: não consegui atualizar a layer', l.id, e.message); }
  }
  if (hits.length) console.log(`[servidor] ${hits.length} layer(s) passaram a usar ${to}`);
});

// Enquanto se redimensiona (re-codificação pesada) os vídeos do player param, e retomam no fim se foi o redimensionamento a pará-los.
let resizeBusy = false;
converter.on('jobs', jobs => {
  broadcast({ type: 'jobs', jobs });
  const busy = jobs.some(j => j.kind === 'resize' && (j.status === 'queued' || j.status === 'converting'));
  if (busy && !resizeBusy) { resizeBusy = true; if (playerOn) { setPlayer(false, true); autoPaused = true; } }
  else if (!busy && resizeBusy) { resizeBusy = false; if (autoPaused) { autoPaused = false; setPlayer(true, true); } }
});
converter.on('media', name => { media.thumb(name).catch(() => {}); broadcast({ type: 'media' }); });
store.on('change', cfg => broadcast({ type: 'config', config: publicConfig(cfg) }));

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[servidor] http://0.0.0.0:${PORT}  (dados: ${DATA_DIR})`);
    for (const ip of lanAddresses()) console.log(`[servidor] painel: http://${ip}:${PORT}`);
    console.log(`[servidor] plataforma: ${sysstats.platform}`);
    require('child_process').execFile('ffmpeg', ['-version'], err => { if (err) console.error('[servidor] ffmpeg não encontrado: as conversões de vídeo vão falhar.'); });
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { store.flush(); server.close(); process.exit(0); });
}

module.exports = { app, server, store, auth };
