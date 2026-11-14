'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const platform = require('../lib/platform');
const { createSampler } = require('../lib/sysstats');

test('auto: Linux -> pi, macOS/Windows -> generic', () => {
  assert.equal(platform.resolveName({}, 'linux'), 'pi');
  assert.equal(platform.resolveName({}, 'darwin'), 'generic');
  assert.equal(platform.resolveName({ VIDEO_PLATFORM: 'auto' }, 'win32'), 'generic');
});

test('VIDEO_PLATFORM força o adaptador; valor desconhecido volta ao auto', () => {
  assert.equal(platform.resolveName({ VIDEO_PLATFORM: 'off' }, 'linux'), 'off');
  assert.equal(platform.resolveName({ VIDEO_PLATFORM: 'GENERIC' }, 'linux'), 'generic');
  assert.equal(platform.resolveName({ VIDEO_PLATFORM: 'xyz' }, 'darwin'), 'generic');
});

test('todos os adaptadores carregam e têm a interface completa', () => {
  for (const n of platform.names) {
    const a = platform.load(n);
    for (const k of ['cpuTimes', 'gpuRenderNs', 'memory', 'chromiumMb', 'temperature']) assert.equal(typeof a[k], 'function', `${n}.${k}`);
  }
});

test('sampler nunca lança, mesmo com um adaptador avariado, e devolve nulls', () => {
  const boom = () => { throw new Error('boom'); };
  const s = createSampler({ name: 'x', mdns: true, cpuTimes: boom, gpuRenderNs: boom, memory: boom, temperature: boom });
  const r = s.sample();
  assert.deepEqual(r, { cpu: null, gpu: null, temp: null, ram: null });
});

test('adaptador genérico dá CPU e memória reais (só com `os`)', async () => {
  const s = createSampler(platform.load('generic'));
  s.sample();
  await new Promise(r => setTimeout(r, 900));
  const r = s.sample();
  assert.ok(r.ram && r.ram.total > 0);
  assert.ok(r.cpu === null || (r.cpu >= 0 && r.cpu <= 100));
  assert.equal(r.gpu, null);
  assert.equal(r.temp, null);
});
