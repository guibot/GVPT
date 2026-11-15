'use strict';
/*
 * Efeitos em tempo real por layer, partilhados pelo player e pela pré-visualização do painel.
 * São filtros CSS + opacidade + mix-blend-mode aplicados ao elemento da layer (a seguir ao vídeo, antes da máscara):
 * um blur fica recortado pela máscara. Os limites têm de coincidir com FX_LIMITS em server/lib/model.js.
 */
const FX = (() => {
  const DEFAULTS = { on: true, brightness: 100, contrast: 100, saturate: 100, hue: 0, invert: 0, grayscale: 0, sepia: 0, blur: 0, opacity: 100, blend: 'normal' };
  const LIMITS = { brightness: [0, 300], contrast: [0, 300], saturate: [0, 300], hue: [-180, 180], invert: [0, 100], grayscale: [0, 100], sepia: [0, 100], blur: [0, 100], opacity: [0, 100] };
  const BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light',
    'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];

  const get = c => (c && c.fx) || DEFAULTS;
  // Há algum valor diferente do normal (ignora o interruptor `on`)?
  const dirty = fx => Object.keys(LIMITS).some(k => fx[k] !== DEFAULTS[k]) || fx.blend !== 'normal';

  function filterCss(fx) {
    const p = [];
    if (fx.brightness !== 100) p.push(`brightness(${fx.brightness}%)`);
    if (fx.contrast !== 100) p.push(`contrast(${fx.contrast}%)`);
    if (fx.saturate !== 100) p.push(`saturate(${fx.saturate}%)`);
    if (fx.hue !== 0) p.push(`hue-rotate(${fx.hue}deg)`);
    if (fx.invert !== 0) p.push(`invert(${fx.invert}%)`);
    if (fx.grayscale !== 0) p.push(`grayscale(${fx.grayscale}%)`);
    if (fx.sepia !== 0) p.push(`sepia(${fx.sepia}%)`);
    if (fx.blur !== 0) p.push(`blur(${fx.blur}px)`);
    return p.join(' ');
  }

  function apply(el, c) {
    const fx = get(c), s = el.style;
    if (!fx.on || !dirty(fx)) { s.filter = s.webkitFilter = ''; s.opacity = ''; s.mixBlendMode = ''; return; }
    s.filter = s.webkitFilter = filterCss(fx);
    s.opacity = fx.opacity === 100 ? '' : String(fx.opacity / 100);
    s.mixBlendMode = fx.blend === 'normal' ? '' : fx.blend;
  }

  // Texto curto para a lista de layers: velocidade e/ou "FX" quando há efeitos ativos.
  function badge(c) {
    const out = [];
    if (c.speed && c.speed !== 1) out.push(`${+c.speed.toFixed(2)}x`);
    const fx = get(c);
    if (fx.on && dirty(fx)) out.push('FX');
    return out.join(' ');
  }

  return { DEFAULTS, LIMITS, BLENDS, apply, badge, dirty };
})();
