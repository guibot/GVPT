'use strict';
// Adaptador desligado: nenhuma estatística do sistema (tudo null). Útil para excluir a camada de plataforma.
module.exports = {
  name: 'off', mdns: true,
  cpuTimes: () => null, gpuRenderNs: () => null, memory: () => null, chromiumMb: () => null, temperature: () => null,
};
