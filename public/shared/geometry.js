'use strict';
/*
 * Geometria de uma layer, partilhada pelo player e pela pré-visualização do painel (para coincidirem).
 * A CAIXA da layer tem o tamanho nativo da máscara (ou o do vídeo, se não houver máscara): é a máscara que
 * define a posição e a proporção da layer. O vídeo encaixa na caixa em modo "cover" (enche-a sem deformar).
 * Ordem das transformações: ver docs/MODELO.md
 *   1. vídeo dentro da caixa (cover × videoScale, videoOffsetX/Y)   2. máscara no espaço da layer (maskScale)
 *   3. posição, escala e rotação da layer (x,y = centro)             4. corner pin final (pins[i])
 *   5. espelho X/Y (mirrorX, mirrorY): vira o resultado dentro do quadrilátero final
 *   6. mesh (opcional, ver mesh.js): com mais de 1 × 1 células, ajusta cada ponto da grelha por cima do corner pin
 */
const Geometry = (() => {
  // Layer de cor sólida (source = 'color'): sem máscara, a caixa tem este tamanho; a cor enche sempre a caixa toda.
  const COLOR_SIZE = [1920, 1080];
  const isColor = c => !!c && c.source === 'color';
  // Homografia que leva o retângulo (0,0,w,h) para o quadrilátero dst (TL, TR, BR, BL).
  function homography(w, h, dst) {
    const src = [[0, 0], [w, 0], [w, h], [0, h]];
    const A = [];
    for (let k = 0; k < 4; k++) {
      const [x, y] = src[k], [X, Y] = dst[k];
      A.push([x, y, 1, 0, 0, 0, -x * X, -y * X, X]);
      A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y, Y]);
    }
    for (let c = 0; c < 8; c++) {
      let p = c;
      for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]];
      for (let r = 0; r < 8; r++) if (r !== c) {
        const f = A[r][c] / A[c][c];
        for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
      }
    }
    const s = A.map((row, i) => row[8] / row[i]);
    return [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]];
  }

  // Aplica a homografia m (8 coeficientes) a um ponto.
  function mapPoint(m, x, y) {
    const d = m[6] * x + m[7] * y + 1;
    return [(m[0] * x + m[1] * y + m[2]) / d, (m[3] * x + m[4] * y + m[5]) / d];
  }
  // Inversa de uma homografia (matriz 3x3 com o último elemento a 1), normalizada da mesma forma.
  function invert(m) {
    const [a, b, c, d, e, f, g, h] = m, i = 1;
    const A = e * i - f * h, B = c * h - b * i, C = b * f - c * e;
    const D = f * g - d * i, E = a * i - c * g, F = c * d - a * f;
    const G = d * h - e * g, H = b * g - a * h, I = a * e - b * d;
    return [A / I, B / I, C / I, D / I, E / I, F / I, G / I, H / I];
  }

  // c = layer da configuração; box = [largura, altura] da caixa (máscara ou, sem máscara, vídeo);
  // vid = [largura, altura] nativas do vídeo.
  function compute(c, box, vid) {
    const [vw, vh] = box;
    const color = isColor(c);                                               // cor sólida: enche a caixa (sem cover, escala nem offset do vídeo)
    const cover = Math.max(vw / vid[0], vh / vid[1]) * c.videoScale;       // "cover": enche a caixa sem deformar
    const vidW = color ? vw : vid[0] * cover, vidH = color ? vh : vid[1] * cover;
    const half = [[-vw / 2, -vh / 2], [vw / 2, -vh / 2], [vw / 2, vh / 2], [-vw / 2, vh / 2]];
    const th = (c.rotation || 0) * Math.PI / 180, cos = Math.cos(th), sin = Math.sin(th);   // rotação em torno do centro (graus, sentido horário)
    const base = half.map(([px, py]) => {                                                  // sem corner pin
      const sx = px * c.scale, sy = py * c.scale;
      return [c.x + sx * cos - sy * sin, c.y + sx * sin + sy * cos];
    });
    const pinned = base.map(([x, y], i) => [x + c.pins[i].x, y + c.pins[i].y]);          // com corner pin
    // Espelho: o conteúdo da caixa vira-se dentro do quadrilátero (os cantos e as pegas do corner pin ficam onde estão).
    // Basta trocar os cantos de destino: X troca esquerda/direita, Y troca cima/baixo.
    const P = pinned;
    const dst = c.mirrorX && c.mirrorY ? [P[2], P[3], P[0], P[1]] : c.mirrorX ? [P[1], P[0], P[3], P[2]] : c.mirrorY ? [P[3], P[2], P[1], P[0]] : P;
    const m = homography(vw, vh, dst);
    const meshed = !!(c.mesh && typeof Mesh !== 'undefined' && Mesh.active(c.mesh) && Mesh.usable());   // desenhada em WebGL
    return {
      meshed, meshData: meshed ? c.mesh : null,
      box: { width: vw, height: vh },
      video: color ? { width: vw, height: vh, left: 0, top: 0 } : { width: vidW, height: vidH, left: (vw - vidW) / 2 + c.videoOffsetX, top: (vh - vidH) / 2 + c.videoOffsetY },
      maskSize: c.maskScale * 100 + '%',
      transform: `matrix3d(${m[0]},${m[3]},0,${m[6]},${m[1]},${m[4]},0,${m[7]},0,0,1,0,${m[2]},${m[5]},0,1)`,
      base, pinned, m,
    };
  }

  // Espaço da máscara (píxeis do PNG ou da máscara desenhada) <-> espaço do ecrã de saída.
  // A máscara está centrada na caixa e escalada por maskScale; depois aplica-se a homografia da layer.
  function toScreen(g, c, [x, y]) {
    const W = g.box.width, H = g.box.height, k = c.maskScale;
    const bx = W / 2 + (x - W / 2) * k, by = H / 2 + (y - H / 2) * k;
    return g.meshed ? Mesh.eval(g, g.meshData, bx / W, by / H) : mapPoint(g.m, bx, by);
  }
  function toMask(g, c, [x, y]) {
    const W = g.box.width, H = g.box.height, k = c.maskScale;
    const [bx, by] = g.meshed ? Mesh.inverse(g, g.meshData, x, y) : mapPoint(g.inv || (g.inv = invert(g.m)), x, y);
    return [W / 2 + (bx - W / 2) / k, H / 2 + (by - H / 2) / k];
  }

  // Aplica a geometria a um elemento-caixa (.layer) e aos elementos de média (vídeos ou miniaturas) lá dentro.
  // out = [largura, altura] da saída. Com mesh (g.meshed) a layer ocupa a saída toda, sem transform nem máscara CSS
  // (a máscara e o vídeo passam a ser texturas): quem chama desenha-a com Mesh.view().
  function apply(boxEl, mediaEls, c, box, vid, out) {
    const g = compute(c, box, vid);
    boxEl.classList.toggle('meshed', g.meshed);
    if (g.meshed) {
      boxEl.style.width = out[0] + 'px'; boxEl.style.height = out[1] + 'px';
      boxEl.style.transform = 'none';
      return g;
    }
    boxEl.style.width = g.box.width + 'px';
    boxEl.style.height = g.box.height + 'px';
    for (const el of mediaEls) {
      const s = el.style;
      s.width = g.video.width + 'px'; s.height = g.video.height + 'px';
      s.left = g.video.left + 'px'; s.top = g.video.top + 'px';
    }
    boxEl.style.webkitMaskSize = boxEl.style.maskSize = `${g.maskSize} ${g.maskSize}`;
    boxEl.style.maskMode = c.maskMode;
    boxEl.style.transform = g.transform;
    return g;
  }

  return { COLOR_SIZE, isColor, homography, mapPoint, invert, compute, apply, toScreen, toMask };
})();
