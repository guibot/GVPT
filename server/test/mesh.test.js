'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// geometry.js e mesh.js são scripts de browser (definem `const Geometry` e `const Mesh`); carregam-se juntos num contexto isolado.
const read = f => fs.readFileSync(path.join(__dirname, '../../public/shared', f), 'utf8');
const { Geometry, Mesh } = vm.runInNewContext(read('geometry.js') + '\n' + read('mesh.js') + '\n({ Geometry, Mesh })');

const layer = (o = {}) => ({ x: 960, y: 540, scale: 1, videoScale: 1, videoOffsetX: 0, videoOffsetY: 0, maskScale: 1, maskMode: 'alpha', rotation: 0,
  pins: [{ x: -20, y: 10 }, { x: 15, y: -5 }, { x: 30, y: 25 }, { x: -10, y: 40 }], ...o });
const BOX = [800, 600], VID = [800, 600];
const G = o => Geometry.compute(layer(o), BOX, VID);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const meshOf = (cols, rows, smooth, set = {}) => { const m = Mesh.flat(cols, rows, smooth); for (const k in set) m.pts[k] = { x: set[k][0], y: set[k][1] }; return m; };

test('presets: 16 grelhas, 1x1 a 4x4, por colunas e depois linhas', () => {
  assert.equal(Mesh.PRESETS.length, 16);
  const P = Mesh.PRESETS.map(x => [...x]);
  assert.deepEqual([P[0], P[1], P[4], P[15]], [[1, 1], [1, 2], [2, 1], [4, 4]]);
  assert.equal(Mesh.active(Mesh.flat(1, 1)), false); assert.equal(Mesh.active(Mesh.flat(1, 2)), true); assert.equal(Mesh.active(null), false);
});

test('sem deslocamentos a mesh é exatamente o corner pin (a homografia)', () => {
  const g = G();
  for (const smooth of [false, true]) for (const [c, r] of Mesh.PRESETS) {
    const m = Mesh.flat(c, r, smooth);
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1], [0.3, 0.7], [0.5, 0.5]]) {
      const a = Mesh.eval(g, m, u, v), b = Geometry.mapPoint(g.m, u * 800, v * 600);
      near(a[0], b[0]); near(a[1], b[1]);
    }
  }
  const e = Mesh.eval(G(), Mesh.flat(3, 3), 0, 0); near(e[0], G().pinned[0][0]); near(e[1], G().pinned[0][1]);   // canto = pegas do corner pin
});

test('cada ponto da grelha fica no sítio da homografia mais o seu deslocamento (linear e suave)', () => {
  const g = G();
  for (const smooth of [false, true]) {
    const m = meshOf(3, 2, smooth, { 5: [30, -20], 6: [-15, 25] });         // 4x3 pontos; 5 = (1,1), 6 = (2,1)
    for (const k of [5, 6]) {
      const base = Mesh.baseByIndex(g, m, k), at = Mesh.pointByIndex(g, m, k);
      near(at[0], base[0] + m.pts[k].x); near(at[1], base[1] + m.pts[k].y);
    }
    const untouched = Mesh.pointByIndex(g, m, 4), b4 = Mesh.baseByIndex(g, m, 4);     // um ponto sem deslocamento
    near(untouched[0], b4[0], 1e-6);
  }
});

test('linear: entre dois pontos o deslocamento é a média; suave: é diferente mas contínuo', () => {
  const m = meshOf(2, 1, false, { 1: [0, -40] });                         // 3x2 pontos; o 1 é o meio da aresta de cima
  const d = Mesh.disp(m, 0.25, 0);                                        // a meio entre o canto (0) e o ponto 1
  near(d[0], 0); near(d[1], -20);
  const s = meshOf(2, 1, true, { 1: [0, -40] });
  const ds = Mesh.disp(s, 0.25, 0);
  assert.ok(Math.abs(ds[1] - -20) > 0.5 && ds[1] < 0, `suave devia curvar: ${ds[1]}`);
  const a = Mesh.disp(s, 0.5 - 1e-6, 0), b = Mesh.disp(s, 0.5 + 1e-6, 0);   // contínuo no ponto
  near(a[1], b[1], 1e-3); near(a[1], -40, 1e-3);
});

test('inverse: ecrã -> caixa desfaz a mesh (linear e suave)', () => {
  const g = G();
  for (const smooth of [false, true]) {
    const m = meshOf(3, 3, smooth, { 5: [25, -18], 6: [-20, 15], 9: [12, 30], 10: [-30, -10] });
    for (const [u, v] of [[0.1, 0.1], [0.5, 0.5], [0.8, 0.3], [0.35, 0.9], [1, 1]]) {
      const [x, y] = Mesh.eval(g, m, u, v), [bx, by] = Mesh.inverse(g, m, x, y);
      near(bx, u * 800, 0.05); near(by, v * 600, 0.05);
    }
  }
});

test('compute: g.meshed só com mesh ativa e WebGL; toScreen/toMask seguem a mesh', () => {
  assert.equal(G().meshed, false);                                        // sem mesh
  Mesh.usable = () => true;                                               // contexto de teste: sem WebGL real
  assert.equal(G({ mesh: Mesh.flat(1, 1) }).meshed, false);                // 1x1 = corner pin
  const c = layer({ mesh: meshOf(2, 2, false, { 4: [40, -30] }) });
  const g = Geometry.compute(c, BOX, VID);
  assert.equal(g.meshed, true);
  const p = Geometry.toScreen(g, c, [400, 300]);                          // centro da máscara = ponto 4 (centro da grelha)
  const base = Geometry.mapPoint(g.m, 400, 300);
  near(p[0], base[0] + 40, 1e-6); near(p[1], base[1] - 30, 1e-6);
  const back = Geometry.toMask(g, c, p);
  near(back[0], 400, 0.05); near(back[1], 300, 0.05);
});

test('build: malha completa dentro da caixa do ecrã, índices válidos', () => {
  const g = G();
  const m = meshOf(2, 3, true, { 4: [20, 20] });
  const b = Mesh.build(g, m, 6);
  const nv = (2 * 6 + 1) * (3 * 6 + 1);
  assert.equal(b.pos.length, nv * 2); assert.equal(b.box.length, nv * 2); assert.equal(b.idx.length, 2 * 6 * 3 * 6 * 6);
  assert.ok(b.idx.every(i => i < nv));
  const [x0, y0, x1, y1] = b.bbox;
  for (const [x, y] of g.pinned) assert.ok(x >= x0 - 1e-6 && x <= x1 + 1e-6 && y >= y0 - 1e-6 && y <= y1 + 1e-6);
  near(b.box[0], 0); near(b.box[1], 0); near(b.box[nv * 2 - 2], 800); near(b.box[nv * 2 - 1], 600);   // coordenadas da caixa: canto a canto
});
