'use strict';
/*
 * Mesh de uma layer, partilhada pelo player e pela pré-visualização do painel (para coincidirem).
 *
 * A mesh é uma grelha de `cols` × `rows` células (1 a 4 em cada eixo) sobre a CAIXA da layer. 1 × 1 é o corner pin normal
 * (a layer continua a ser desenhada com uma única matrix3d). Com mais células, a layer passa a ser desenhada em WebGL.
 *
 * Os 4 cantos da grelha são sempre os do corner pin (pins[i]). Cada ponto da grelha tem um deslocamento (píxeis de saída)
 * por cima da posição que a homografia da layer lhe dá, por isso com todos os deslocamentos a 0 o resultado é exatamente
 * o do corner pin. Os deslocamentos dos cantos são sempre 0.
 *   { cols, rows, smooth, pts: [{x,y}, ...] }     pts: (cols+1)*(rows+1) pontos, linha a linha (índice = j*(cols+1)+i)
 * Entre pontos, o deslocamento interpola-se em linear (arestas retas entre células) ou suave (Catmull-Rom, passa pelos pontos).
 * A máscara e o vídeo deformam-se juntos. Ver docs/MODELO.md.
 */
const Mesh = (() => {
  const MAX = 4;
  const PRESETS = [];                                     // [colunas, linhas]: 1×1, 1×2 ... 4×4
  for (let c = 1; c <= MAX; c++) for (let r = 1; r <= MAX; r++) PRESETS.push([c, r]);

  const flat = (cols = 1, rows = 1, smooth = false) =>
    ({ cols, rows, smooth, pts: Array.from({ length: (cols + 1) * (rows + 1) }, () => ({ x: 0, y: 0 })) });
  const active = m => !!m && (m.cols > 1 || m.rows > 1);
  const dirty = m => !!m && m.pts.some(p => p.x || p.y);
  const ij = (m, k) => [k % (m.cols + 1), Math.floor(k / (m.cols + 1))];
  const isCorner = (m, k) => { const [i, j] = ij(m, k); return (i === 0 || i === m.cols) && (j === 0 || j === m.rows); };
  const freePoints = m => { const out = []; for (let k = 0; k < m.pts.length; k++) if (!isCorner(m, k)) out.push(k); return out; };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const cr = (p0, p1, p2, p3, t) => 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);

  // Deslocamento [dx, dy] no ponto (u, v) da caixa, u e v em 0..1.
  function disp(m, u, v) {
    const fu = clamp(u, 0, 1) * m.cols, fv = clamp(v, 0, 1) * m.rows;
    const i0 = Math.min(Math.floor(fu), m.cols - 1), j0 = Math.min(Math.floor(fv), m.rows - 1);
    const tx = fu - i0, ty = fv - j0;
    const P = (i, j) => m.pts[clamp(j, 0, m.rows) * (m.cols + 1) + clamp(i, 0, m.cols)];
    const out = [0, 0];
    for (let a = 0; a < 2; a++) {
      const k = a ? 'y' : 'x';
      if (!m.smooth) {
        const top = P(i0, j0)[k] + (P(i0 + 1, j0)[k] - P(i0, j0)[k]) * tx;
        const bot = P(i0, j0 + 1)[k] + (P(i0 + 1, j0 + 1)[k] - P(i0, j0 + 1)[k]) * tx;
        out[a] = top + (bot - top) * ty;
      } else {
        const c = [-1, 0, 1, 2].map(dj => cr(P(i0 - 1, j0 + dj)[k], P(i0, j0 + dj)[k], P(i0 + 1, j0 + dj)[k], P(i0 + 2, j0 + dj)[k], tx));
        out[a] = cr(c[0], c[1], c[2], c[3], ty);
      }
    }
    return out;
  }

  // Posição no ecrã do ponto (u, v) da caixa: homografia da layer (corner pin) + deslocamento da mesh.
  function evalAt(g, m, u, v) {
    const [x, y] = Geometry.mapPoint(g.m, u * g.box.width, v * g.box.height);
    const d = disp(m, u, v);
    return [x + d[0], y + d[1]];
  }

  // Inversa: que ponto da caixa (em píxeis da caixa) cai no ponto (X, Y) do ecrã? Newton a partir da inversa da homografia.
  function inverse(g, m, X, Y) {
    const W = g.box.width, H = g.box.height;
    const [bx, by] = Geometry.mapPoint(g.inv || (g.inv = Geometry.invert(g.m)), X, Y);
    let u = bx / W, v = by / H;
    for (let n = 0; n < 12; n++) {
      const [sx, sy] = evalAt(g, m, u, v), fx = sx - X, fy = sy - Y;
      if (Math.abs(fx) + Math.abs(fy) < 0.01) break;
      const e = 1e-3, [ax, ay] = evalAt(g, m, u + e, v), [cx, cy] = evalAt(g, m, u, v + e);
      const a = (ax - sx) / e, b = (cx - sx) / e, c = (ay - sy) / e, d = (cy - sy) / e, det = a * d - b * c;
      if (!isFinite(det) || Math.abs(det) < 1e-9) break;
      u -= (d * fx - b * fy) / det; v -= (-c * fx + a * fy) / det;
    }
    return [u * W, v * H];
  }

  const pointByIndex = (g, m, k) => { const [i, j] = ij(m, k); return evalAt(g, m, i / m.cols, j / m.rows); };           // onde está o ponto k
  const baseByIndex = (g, m, k) => { const [i, j] = ij(m, k); return Geometry.mapPoint(g.m, i / m.cols * g.box.width, j / m.rows * g.box.height); };   // onde estaria sem deslocamento

  // Linhas da grelha no ecrã (para o contorno na pré-visualização do painel).
  function lines(g, m) {
    const n = 12 * Math.max(m.cols, m.rows), out = [];
    for (let i = 0; i <= m.cols; i++) { const pl = []; for (let s = 0; s <= n; s++) pl.push(evalAt(g, m, i / m.cols, s / n)); out.push(pl); }
    for (let j = 0; j <= m.rows; j++) { const pl = []; for (let s = 0; s <= n; s++) pl.push(evalAt(g, m, s / n, j / m.rows)); out.push(pl); }
    return out;
  }

  // Malha de triângulos: cada célula é dividida em sub × sub (a perspetiva fica certa dentro da célula).
  function build(g, m, sub = 10) {
    const nx = m.cols * sub, ny = m.rows * sub, W = g.box.width, H = g.box.height;
    const pos = new Float32Array((nx + 1) * (ny + 1) * 2), box = new Float32Array(pos.length);
    const idx = new Uint16Array(nx * ny * 6);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++, n += 2) {
      const u = i / nx, v = j / ny, [x, y] = evalAt(g, m, u, v);
      pos[n] = x; pos[n + 1] = y; box[n] = u * W; box[n + 1] = v * H;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    n = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      idx.set([a, b, c, b, d, c], n); n += 6;
    }
    return { pos, box, idx, bbox: [x0, y0, x1, y1] };
  }

  // ---------- WebGL ----------
  let glOk = null;
  function usable() {                                      // este browser consegue WebGL?
    if (glOk === null) {
      try {
        const gl = document.createElement('canvas').getContext('webgl');
        glOk = !!gl;
        const ext = gl && gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext();
      } catch { glOk = false; }
    }
    return glOk;
  }

  const VS = `attribute vec2 aPos; attribute vec2 aBox; uniform vec4 uView; varying vec2 vBox;
void main() { vBox = aBox; vec2 p = (aPos - uView.xy) / uView.zw; gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0); }`;
  const FS = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vBox; uniform sampler2D uVideo; uniform sampler2D uMask;
uniform vec4 uVid; uniform vec2 uBox; uniform float uMaskScale, uHasMask, uLum, uHasVideo;
void main() {
  vec2 vu = (vBox - uVid.xy) / uVid.zw;
  float a = uHasVideo * step(0.0, vu.x) * step(vu.x, 1.0) * step(0.0, vu.y) * step(vu.y, 1.0);
  if (uHasMask > 0.5) {                                   // a máscara está centrada na caixa e escalada por maskScale
    vec2 mu = (vBox - uBox * 0.5) / (uBox * uMaskScale) + 0.5;
    float inside = step(0.0, mu.x) * step(mu.x, 1.0) * step(0.0, mu.y) * step(mu.y, 1.0);
    vec4 t = texture2D(uMask, mu);
    float lum = dot(t.rgb, vec3(0.2125, 0.7154, 0.0721)) * t.a;
    a *= inside * (uLum > 0.5 ? lum : t.a);
  }
  vec3 c = texture2D(uVideo, vu).rgb;
  gl_FragColor = vec4(c * a, a);
}`;

  // Desenha uma layer com mesh num <canvas> dentro de `host` (o elemento .layer). O canvas só tem o tamanho da mesh no ecrã.
  // Devolve null se o WebGL falhar (e passa a dar usable() = false: as layers voltam ao corner pin).
  function view(host) {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;display:block;pointer-events:none';
    host.appendChild(canvas);
    let gl = null, prog = null, loc = null, tex = null, bufs = null;
    let geom = null, built = null, params = null, key = '';
    let src = null, hasVideo = 0, maskKey = null, maskImg = null, wantMask = false, hasMask = 0;

    function setup() {
      gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true, depth: false, stencil: false });
      if (!gl) throw new Error('no webgl');
      const sh = (type, text) => { const s = gl.createShader(type); gl.shaderSource(s, text); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      loc = {};
      for (const n of ['aPos', 'aBox']) loc[n] = gl.getAttribLocation(prog, n);
      for (const n of ['uView', 'uVideo', 'uMask', 'uVid', 'uBox', 'uMaskScale', 'uHasMask', 'uLum', 'uHasVideo']) loc[n] = gl.getUniformLocation(prog, n);
      const mkTex = () => {
        const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };
      tex = { video: mkTex(), mask: mkTex() };
      bufs = { pos: gl.createBuffer(), box: gl.createBuffer(), idx: gl.createBuffer() };
      hasVideo = 0; hasMask = 0;
    }

    function uploadGeom() {
      if (!built) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.pos); gl.bufferData(gl.ARRAY_BUFFER, built.pos, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.box); gl.bufferData(gl.ARRAY_BUFFER, built.box, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufs.idx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, built.idx, gl.STATIC_DRAW);
    }
    function uploadMask() {
      if (!maskImg || !gl) return;
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tex.mask);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskImg);
      hasMask = 1;
    }
    function upload() {                                      // copia o frame atual do vídeo (ou da miniatura) para a textura
      if (!src || !gl || gl.isContextLost()) return;
      const ready = src.tagName === 'VIDEO' ? src.readyState >= 2 && src.videoWidth : src.tagName === 'CANVAS' ? src.width : src.complete && src.naturalWidth;
      if (!ready) return;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex.video);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      hasVideo = 1;
    }
    function draw() {
      if (!gl || gl.isContextLost() || !geom || !params) return;
      if (wantMask && !hasMask) return;                      // a máscara ainda está a carregar: não mostra a layer sem ela
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.pos); gl.enableVertexAttribArray(loc.aPos); gl.vertexAttribPointer(loc.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.box); gl.enableVertexAttribArray(loc.aBox); gl.vertexAttribPointer(loc.aBox, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufs.idx);
      gl.uniform4f(loc.uView, geom.x, geom.y, geom.w, geom.h);
      gl.uniform4f(loc.uVid, ...params.vid);
      gl.uniform2f(loc.uBox, ...params.box);
      gl.uniform1f(loc.uMaskScale, params.maskScale);
      gl.uniform1f(loc.uHasMask, hasMask); gl.uniform1f(loc.uLum, params.lum ? 1 : 0); gl.uniform1f(loc.uHasVideo, hasVideo);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex.video); gl.uniform1i(loc.uVideo, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tex.mask); gl.uniform1i(loc.uMask, 1);
      gl.drawElements(gl.TRIANGLES, built.idx.length, gl.UNSIGNED_SHORT, 0);
    }

    canvas.addEventListener('webglcontextlost', e => e.preventDefault());
    canvas.addEventListener('webglcontextrestored', () => { try { setup(); uploadGeom(); uploadMask(); upload(); draw(); } catch {} });
    try { setup(); } catch { canvas.remove(); glOk = false; return null; }

    return {
      // o: { c: layer, g: Geometry.compute(...), out: [largura, altura] da saída, media: <video>|<img>|null, maskKey, maskUrl }
      update(o) {
        const k = JSON.stringify([o.g.m, o.c.mesh, o.out]);
        if (k !== key) {
          key = k; built = Mesh.build(o.g, o.c.mesh);
          const x0 = Math.max(0, Math.floor(built.bbox[0])), y0 = Math.max(0, Math.floor(built.bbox[1]));
          const x1 = Math.min(o.out[0], Math.ceil(built.bbox[2])), y1 = Math.min(o.out[1], Math.ceil(built.bbox[3]));
          const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
          if (canvas.width !== w) canvas.width = w;
          if (canvas.height !== h) canvas.height = h;
          canvas.style.left = x0 + 'px'; canvas.style.top = y0 + 'px'; canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
          geom = { x: x0, y: y0, w, h };
          uploadGeom();
        }
        const g = o.g;
        params = { vid: [g.video.left, g.video.top, g.video.width, g.video.height], box: [g.box.width, g.box.height],
          maskScale: o.c.maskScale, lum: o.c.maskMode === 'luminance' };
        if (o.media !== undefined) src = o.media;
        if (o.maskKey !== maskKey) {
          maskKey = o.maskKey; maskImg = null; hasMask = 0; wantMask = !!o.maskUrl;
          if (o.maskUrl) {
            const img = new Image(), mk = o.maskKey;
            img.onload = () => { if (maskKey === mk) { maskImg = img; uploadMask(); draw(); } };
            img.onerror = () => { if (maskKey === mk) { wantMask = false; draw(); } };
            img.src = o.maskUrl;
          }
        }
        upload(); draw();
      },
      frame(el) { src = el; upload(); draw(); },              // chega um frame novo do vídeo
      destroy() {
        try { const ext = gl && gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); } catch {}
        canvas.remove(); gl = null;
      },
    };
  }

  // Fonte para uma layer de cor sólida: um canvas pequeno pintado com a cor (serve de textura, como um frame de vídeo).
  function solid(color) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 2;
    const ctx = cv.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 2, 2);
    return cv;
  }

  return { PRESETS, MAX, solid, flat, active, dirty, freePoints, isCorner, disp, eval: evalAt, inverse, pointByIndex, baseByIndex, lines, build, usable, view };
})();
