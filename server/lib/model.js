'use strict';
/*
 * Modelo de dados: valores por defeito, limites, normalização e operações sobre a configuração.
 * Funções puras (não tocam no disco). A persistência está em config.js.
 * Descrição completa e ordem das transformações: docs/MODELO.md
 */
const crypto = require('crypto');

const SCHEMA_VERSION = 2;
const RESOLUTIONS = [[1920, 1080], [1280, 720]];
const MAX_LAYERS = 32;
const MESH_MAX = 4;                            // células por eixo da mesh (1 a 4). 1x1 = corner pin normal. Tem de coincidir com public/shared/mesh.js
const CONVERT_SIZE = [64, 4096];                  // largura e altura máximas da conversão (qualquer inteiro neste intervalo)
const DEFAULT_CONVERT_SIZE = [960, 540];
const CONVERT_FPS = [25, 30];

// [mínimo, máximo] aceites por campo numérico; valores fora do intervalo são cortados.
const LIMITS = {
  maskScale: [0.01, 20],
  videoScale: [0.01, 20],
  scale: [0.01, 20],
  rotation: [-360, 360],       // graus
  videoOffsetX: [-5000, 5000],
  videoOffsetY: [-5000, 5000],
  x: [-10000, 10000],
  y: [-10000, 10000],
  pin: [-3000, 3000],          // cada deslocamento de canto (corner pin), em píxeis de saída
  meshPt: [-3000, 3000],       // cada deslocamento de um ponto da mesh, em píxeis de saída
  vmaskSize: [16, 4096],       // máscara desenhada: largura e altura
  vmaskCoord: [-20000, 20000], // coordenadas dos pontos (podem sair da caixa; o excesso é cortado)
  feather: [0, 200],           // desfoque das bordas, em píxeis da máscara
  speed: [0.1, 4],             // velocidade de reprodução do vídeo (1 = normal)
};
// Efeitos em tempo real por layer (filtros CSS + opacidade + modo de mistura). Têm de coincidir com public/shared/fx.js.
const FX_LIMITS = {
  brightness: [0, 300], contrast: [0, 300], saturate: [0, 300],   // %, 100 = normal
  hue: [-180, 180],                                                // graus
  invert: [0, 100], grayscale: [0, 100], sepia: [0, 100],          // %
  blur: [0, 100],                                                  // píxeis
  opacity: [0, 100],                                               // %
};
const FX_DEFAULTS = { brightness: 100, contrast: 100, saturate: 100, hue: 0, invert: 0, grayscale: 0, sepia: 0, blur: 0, opacity: 100 };
const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];
// Limites da máscara desenhada (mantêm cada mensagem bem abaixo do limite do WebSocket).
const VMASK_MAX_SHAPES = 32;
const VMASK_MAX_POINTS = 256;    // por polígono
const VMASK_MAX_TOTAL = 1500;    // em toda a máscara
const NAME_MAX = 80;
const SOURCES = ['video', 'color'];   // de onde vem o conteúdo da layer: ficheiro de vídeo ou cor sólida
const COLOR_RE = /^#[0-9a-f]{6}$/;
// Cor sólida: aceita #rgb ou #rrggbb (qualquer caixa) e guarda sempre #rrggbb em minúsculas.
function colorHex(v, d = '#ffffff') {
  if (typeof v !== 'string') return d;
  let x = v.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(x)) x = '#' + x.slice(1).split('').map(ch => ch + ch).join('');
  return COLOR_RE.test(x) ? x : d;
}
const PIN_RE = /^\d{4,8}$/;

const validConvertSize = (w, h) => [w, h].every(v => Number.isInteger(v) && v >= CONVERT_SIZE[0] && v <= CONVERT_SIZE[1]);
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const num = (v, d, lim) => (typeof v === 'number' && Number.isFinite(v) ? (lim ? clamp(v, lim) : v) : d);
const newId = () => crypto.randomBytes(6).toString('hex');

// Nome de ficheiro de media: só o nome base, sem caminhos (evita ../ e subpastas).
function mediaName(v) {
  if (typeof v !== 'string' || !v || v.length > 200) return null;
  if (/[\/\\\0]/.test(v) || v.startsWith('.')) return null;
  return v;
}

// Máscara desenhada (formas vetoriais). null = a layer não tem (usa o PNG, se houver).
function normalizeVmask(v) {
  if (!v || typeof v !== 'object') return null;
  const coord = x => Math.round(num(x, 0, LIMITS.vmaskCoord) * 10) / 10;
  const radius = x => Math.round(Math.abs(num(x, 0, LIMITS.vmaskCoord)) * 10) / 10;
  const shapes = [];
  let total = 0;
  for (const s of Array.isArray(v.shapes) ? v.shapes : []) {
    if (shapes.length >= VMASK_MAX_SHAPES) break;
    if (!s || typeof s !== 'object') continue;
    const op = s.op === 'sub' ? 'sub' : 'add';
    if (s.type === 'ellipse') {
      shapes.push({ type: 'ellipse', op, cx: coord(s.cx), cy: coord(s.cy), rx: radius(s.rx), ry: radius(s.ry) });
    } else if (s.type === 'poly' && Array.isArray(s.points)) {
      const points = s.points.filter(p => Array.isArray(p) && p.length >= 2)
        .slice(0, Math.min(VMASK_MAX_POINTS, VMASK_MAX_TOTAL - total)).map(p => [coord(p[0]), coord(p[1])]);
      if (!points.length) continue;
      total += points.length;
      shapes.push({ type: 'poly', op, points });
    }
  }
  return {
    width: Math.round(num(v.width, 1920, LIMITS.vmaskSize)),
    height: Math.round(num(v.height, 1080, LIMITS.vmaskSize)),
    feather: num(v.feather, 0, LIMITS.feather),
    invert: v.invert === true,
    shapes,
  };
}

function normalizeFx(v) {
  v = v && typeof v === 'object' ? v : {};
  const fx = { on: v.on !== false };                // on=false: ignora os efeitos sem perder os valores (bypass)
  for (const k in FX_DEFAULTS) fx[k] = Math.round(num(v[k], FX_DEFAULTS[k], FX_LIMITS[k]) * 100) / 100;
  fx.blend = BLEND_MODES.includes(v.blend) ? v.blend : 'normal';
  return fx;
}

// Mesh: grelha de cols x rows células; pts = deslocamento (px de saída) de cada ponto, linha a linha. Os cantos ficam sempre a 0 (são o corner pin).
function normalizeMesh(v) {
  v = v && typeof v === 'object' ? v : {};
  const cols = Math.round(num(v.cols, 1, [1, MESH_MAX])), rows = Math.round(num(v.rows, 1, [1, MESH_MAX]));
  const src = Array.isArray(v.pts) ? v.pts : [], pts = [];
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
    const corner = (i === 0 || i === cols) && (j === 0 || j === rows), p = src[j * (cols + 1) + i];
    pts.push(corner ? { x: 0, y: 0 } : { x: num(p && p.x, 0, LIMITS.meshPt), y: num(p && p.y, 0, LIMITS.meshPt) });
  }
  return { cols, rows, smooth: v.smooth === true, pts };
}

function normalizeLayer(l, output) {
  l = l && typeof l === 'object' ? l : {};
  const pins = Array.isArray(l.pins) ? l.pins : [];
  return {
    id: typeof l.id === 'string' && /^[\w-]{1,40}$/.test(l.id) ? l.id : newId(),
    name: (typeof l.name === 'string' && l.name.trim() ? l.name : 'Layer').slice(0, NAME_MAX),
    visible: l.visible !== false,
    locked: l.locked === true,                       // só impede escolher/mover a layer na pré-visualização do painel
    source: SOURCES.includes(l.source) ? l.source : 'video',   // 'color': cor sólida em vez de vídeo (o vídeo escolhido fica guardado)
    video: mediaName(l.video),
    color: colorHex(l.color),
    mask: mediaName(l.mask),
    maskScale: num(l.maskScale, 1, LIMITS.maskScale),
    maskMode: l.maskMode === 'luminance' ? 'luminance' : 'alpha',
    vmask: normalizeVmask(l.vmask),                  // se existir, substitui o PNG da máscara
    videoScale: num(l.videoScale, 1, LIMITS.videoScale),
    speed: Math.round(num(l.speed, 1, LIMITS.speed) * 100) / 100,   // velocidade de reprodução
    fx: normalizeFx(l.fx),
    videoOffsetX: num(l.videoOffsetX, 0, LIMITS.videoOffsetX),
    videoOffsetY: num(l.videoOffsetY, 0, LIMITS.videoOffsetY),
    x: num(l.x, output.width / 2, LIMITS.x),         // centro da layer, em píxeis de saída
    y: num(l.y, output.height / 2, LIMITS.y),
    scale: num(l.scale, 1, LIMITS.scale),
    mesh: normalizeMesh(l.mesh),                     // 1x1 = só corner pin; mais células = grelha de pontos por cima dele
    mirrorX: l.mirrorX === true,                     // espelho horizontal / vertical (vira a layer dentro do quadrilátero final)
    mirrorY: l.mirrorY === true,
    rotation: num(l.rotation, 0, LIMITS.rotation),   // em torno do centro, graus, sentido horário
    pins: [0, 1, 2, 3].map(i => ({                    // TL, TR, BR, BL
      x: num(pins[i] && pins[i].x, 0, LIMITS.pin),
      y: num(pins[i] && pins[i].y, 0, LIMITS.pin),
    })),
  };
}

// Normaliza uma configuração qualquer (lida do disco ou recebida) para o formato atual.
function normalize(c) {
  c = c && typeof c === 'object' ? c : {};
  const o = c.output || {};
  const ok = RESOLUTIONS.some(([w, h]) => w === o.width && h === o.height);
  const output = ok ? { width: o.width, height: o.height } : { width: 1920, height: 1080 };
  const seen = new Set();
  const layers = [];
  for (const raw of Array.isArray(c.layers) ? c.layers : []) {
    if (layers.length >= MAX_LAYERS) break;
    const l = normalizeLayer(raw, output);
    if (seen.has(l.id)) continue;
    seen.add(l.id); layers.push(l);
  }
  const cv = c.convert || {};
  const okSize = validConvertSize(cv.maxWidth, cv.maxHeight);
  const convert = { maxWidth: okSize ? cv.maxWidth : DEFAULT_CONVERT_SIZE[0], maxHeight: okSize ? cv.maxHeight : DEFAULT_CONVERT_SIZE[1], fps: CONVERT_FPS.includes(cv.fps) ? cv.fps : 30,
    process: cv.process !== false };      // false = guarda os vídeos como vêm (já comprimidos, ex.: HandBrake)
  return {
    version: SCHEMA_VERSION,
    rev: Number.isInteger(c.rev) && c.rev >= 0 ? c.rev : 0,    // sobe a cada alteração (sincronização)
    output,
    convert,
    splash: c.splash !== false,                                 // ecrã inicial com o QR code (endereço do painel)
    pinHash: typeof c.pinHash === 'string' ? c.pinHash : '',    // '' = sem PIN
    layers,
  };
}

// ---------- PIN (hash com sal; nunca em texto simples) ----------
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pin, salt, 32).toString('hex')}`;
}
function verifyPin(pin, hash) {
  if (!hash) return true;                                      // sem PIN definido
  const [kind, saltHex, hashHex] = String(hash).split('$');
  if (kind !== 'scrypt' || typeof pin !== 'string') return false;
  const got = crypto.scryptSync(pin, Buffer.from(saltHex, 'hex'), 32);
  const want = Buffer.from(hashHex, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Versão enviada aos clientes: nunca inclui o hash do PIN.
const publicConfig = c => ({ version: c.version, rev: c.rev, output: c.output, hasPin: !!c.pinHash, convert: c.convert, splash: c.splash, layers: c.layers });

// ---------- operações ----------
class OpError extends Error {}
const findIndex = (c, id) => {
  const i = c.layers.findIndex(l => l.id === id);
  if (i < 0) throw new OpError(`no such layer: ${id}`);
  return i;
};
// Campos que o painel pode alterar (o id nunca muda).
const PATCHABLE = ['name', 'visible', 'locked', 'source', 'color', 'video', 'mask', 'vmask', 'maskScale', 'maskMode', 'videoScale', 'videoOffsetX',
  'videoOffsetY', 'x', 'y', 'scale', 'rotation', 'pins', 'speed', 'fx', 'mirrorX', 'mirrorY', 'mesh'];

// Aplica uma operação e devolve uma configuração nova (a original não é alterada).
function applyOp(config, op) {
  if (!op || typeof op !== 'object') throw new OpError('invalid operation');
  const c = JSON.parse(JSON.stringify(config));
  switch (op.op) {
    case 'addLayer': {
      if (c.layers.length >= MAX_LAYERS) throw new OpError(`maximum of ${MAX_LAYERS} layers`);
      const l = normalizeLayer({ ...(op.layer || {}), id: undefined }, c.output);
      c.layers.push(l);
      break;
    }
    case 'removeLayer':
      c.layers.splice(findIndex(c, op.id), 1);
      break;
    case 'duplicateLayer': {
      if (c.layers.length >= MAX_LAYERS) throw new OpError(`maximum of ${MAX_LAYERS} layers`);
      const i = findIndex(c, op.id);
      const copy = { ...c.layers[i], id: undefined, name: (c.layers[i].name + ' (copy)').slice(0, NAME_MAX),
        x: c.layers[i].x + 40, y: c.layers[i].y + 40, locked: false };   // a cópia é para mexer
      c.layers.splice(i + 1, 0, normalizeLayer(copy, c.output));   // fica logo acima do original
      break;
    }
    case 'moveLayer': {                                            // índice 0 = fundo, último = topo
      const i = findIndex(c, op.id);
      if (!Number.isInteger(op.index)) throw new OpError('invalid index');
      const [l] = c.layers.splice(i, 1);
      c.layers.splice(clamp(op.index, [0, c.layers.length]), 0, l);
      break;
    }
    case 'updateLayer': {
      const i = findIndex(c, op.id);
      const patch = {};
      for (const k of PATCHABLE) if (op.patch && k in op.patch) patch[k] = op.patch[k];
      c.layers[i] = normalizeLayer({ ...c.layers[i], ...patch, id: c.layers[i].id }, c.output);
      break;
    }
    case 'setOutput': {
      if (!RESOLUTIONS.some(([w, h]) => w === op.width && h === op.height)) throw new OpError('unsupported resolution');
      // Mantém a composição igual em proporção (as duas resoluções são 16:9): posição, escala e pins.
      const k = op.width / c.output.width;
      for (const l of c.layers) { l.x *= k; l.y *= k; l.scale *= k; for (const p of l.pins.concat(l.mesh.pts)) { p.x *= k; p.y *= k; } }
      c.output = { width: op.width, height: op.height };
      break;
    }
    case 'setSplash':
      c.splash = op.enabled !== false;
      break;
    case 'setConvert': {
      if (!validConvertSize(op.width, op.height) || !CONVERT_FPS.includes(op.fps)) throw new OpError('invalid conversion settings');
      c.convert = { maxWidth: op.width, maxHeight: op.height, fps: op.fps, process: op.process !== false };
      break;
    }
    case 'setPin':
      if (op.pin === '' || op.pin === null) c.pinHash = '';
      else if (typeof op.pin === 'string' && PIN_RE.test(op.pin)) c.pinHash = hashPin(op.pin);
      else throw new OpError('the PIN must have 4 to 8 digits');
      break;
    default:
      throw new OpError(`unknown operation: ${op.op}`);
  }
  const out = normalize(c);
  out.rev = config.rev + 1;
  return out;
}

module.exports = { validConvertSize, normalize, applyOp, publicConfig, verifyPin, hashPin, OpError, LIMITS, FX_LIMITS, FX_DEFAULTS, BLEND_MODES, SOURCES, RESOLUTIONS, MAX_LAYERS, SCHEMA_VERSION,
  VMASK_MAX_SHAPES, VMASK_MAX_POINTS, VMASK_MAX_TOTAL };
