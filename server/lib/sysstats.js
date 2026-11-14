'use strict';
// Estatísticas do sistema (CPU %, GPU %, temperatura e RAM) para o HUD de depuração do player.
// Calculadas a pedido: cada chamada compara com a anterior; chamadas muito próximas devolvem o valor em cache.
// As leituras vêm do adaptador de plataforma (lib/platform); nunca lançam erro: o que não existe fica null.
const platform = require('./platform');

const MIN_INTERVAL_MS = 800;

function createSampler(adapter = platform.load()) {
  const safe = fn => { try { return fn(); } catch { return null; } };
  let prev = null;
  let cached = { cpu: null, gpu: null, temp: null, ram: null };

  function sample() {
    const now = Date.now();
    if (prev && now - prev.t < MIN_INTERVAL_MS) return cached;
    const cpu = safe(adapter.cpuTimes);
    const gpu = safe(adapter.gpuRenderNs);
    const temp = safe(adapter.temperature);
    const base = { temp: temp != null ? Math.round(temp * 10) / 10 : null, ram: safe(adapter.memory) };
    if (prev) {
      const dCpu = cpu && prev.cpu ? cpu.total - prev.cpu.total : 0;
      const dWall = (now - prev.t) * 1e6;                       // ms -> ns
      cached = {
        cpu: dCpu > 0 ? Math.round(100 * (1 - (cpu.idle - prev.cpu.idle) / dCpu)) : null,
        gpu: gpu != null && prev.gpu != null ? Math.min(100, Math.round(100 * (gpu - prev.gpu) / dWall)) : null,
        ...base,
      };
    } else {
      cached = { cpu: null, gpu: null, ...base };
    }
    prev = { t: now, cpu, gpu };
    return cached;
  }
  return { sample, platform: adapter.name, mdns: adapter.mdns };
}

const def = createSampler();
module.exports = { sample: def.sample, platform: def.platform, mdns: def.mdns, createSampler };
