'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFilters } = require('../lib/convert');

test('filtros: encaixa na caixa (retrato ou paisagem), nunca amplia, pares e fps constante', () => {
  assert.match(buildFilters({ maxWidth: 360, maxHeight: 640, fps: 30 }, false),
    /^scale=w='min\(360,iw\)':h='min\(640,ih\)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30,format=yuv420p$/);
  assert.match(buildFilters({ maxWidth: 1920, maxHeight: 1080, fps: 25 }, true), /^zscale=.*tonemap.*,scale=w='min\(1920,iw\)'/);
});
