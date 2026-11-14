'use strict';
// Escolhe o adaptador de plataforma (estatísticas do sistema, endereço mDNS).
//   VIDEO_PLATFORM=auto     (por defeito) Linux -> pi, macOS/Windows -> generic
//   VIDEO_PLATFORM=pi       força a leitura de /proc e /sys (Raspberry Pi)
//   VIDEO_PLATFORM=generic  força só o módulo `os` (macOS, Windows)
//   VIDEO_PLATFORM=off      sem estatísticas do sistema
// Para acrescentar uma plataforma: criar platform/<nome>.js com a mesma forma e registá-la em ADAPTERS.
const ADAPTERS = {
  pi: () => require('./pi'),
  generic: () => require('./generic'),
  off: () => require('./off'),
};

function resolveName(env = process.env, platform = process.platform) {
  const want = String(env.VIDEO_PLATFORM || 'auto').trim().toLowerCase();
  if (ADAPTERS[want]) return want;
  return platform === 'linux' ? 'pi' : 'generic';        // auto (e valor desconhecido)
}

function load(name = resolveName()) {
  try { return ADAPTERS[name](); } catch { return require('./off'); }   // um adaptador avariado nunca derruba o servidor
}

module.exports = { load, resolveName, names: Object.keys(ADAPTERS) };
