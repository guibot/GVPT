'use strict';
// Adaptador genérico (macOS, Windows, qualquer sistema): só usa o módulo `os` do Node.
// GPU, temperatura e memória do Chromium não estão disponíveis: ficam null e o painel mostra "–".
const os = require('os');

function cpuTimes() {
  try {
    let total = 0, idle = 0;
    for (const c of os.cpus()) {
      const t = c.times;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
      idle += t.idle;
    }
    return total > 0 ? { total, idle } : null;
  } catch { return null; }
}

// Nota: no macOS o "livre" do `os` não conta a cache, por isso o "usado" aparece maior do que no Monitor de Atividade.
function memory() {
  try {
    const total = os.totalmem(), free = os.freemem();
    return { used: Math.round((total - free) / 1048576), free: Math.round(free / 1048576), total: Math.round(total / 1048576) };
  } catch { return null; }
}

// Windows não resolve nomes .local de forma fiável (sem Bonjour): nesse caso o endereço mDNS não é mostrado.
module.exports = {
  name: 'generic',
  mdns: process.platform !== 'win32',
  cpuTimes, memory,
  gpuRenderNs: () => null,
  chromiumMb: () => null,
  temperature: () => null,
};
