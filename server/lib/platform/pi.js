'use strict';
// Adaptador Raspberry Pi / Linux: lê /proc e /sys. Qualquer leitura que falhe devolve null.
const fs = require('fs');

function cpuTimes() {
  try {
    const f = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    return { total: f.reduce((a, b) => a + b, 0), idle: f[3] + (f[4] || 0) };
  } catch { return null; }
}

// Tempo ocupado (ns) do motor de render do V3D, somado por cliente DRM (lido de /proc/<pid>/fdinfo).
function gpuRenderNs() {
  const seen = new Set();
  let ns = 0;
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter(p => /^\d+$/.test(p)); } catch { return null; }
  for (const pid of pids) {
    let fds;
    try { fds = fs.readdirSync(`/proc/${pid}/fdinfo`); } catch { continue; }
    for (const fd of fds) {
      let t;
      try { t = fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8'); } catch { continue; }
      if (!t.includes('drm-driver:\tv3d')) continue;
      const id = (t.match(/drm-client-id:\s*(\d+)/) || [])[1];
      const key = pid + ':' + id;
      if (seen.has(key)) continue;
      seen.add(key);
      const m = t.match(/drm-engine-render:\s*(\d+)\s*ns/);
      if (m) ns += Number(m[1]);
    }
  }
  return ns;
}

// Memória do sistema (MB usados = total - disponível).
function memory() {
  try {
    const t = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = k => Number((t.match(new RegExp(k + ':\\s+(\\d+)')) || [])[1]);
    const total = kb('MemTotal'), avail = kb('MemAvailable');
    if (!total || !avail) return null;
    return { used: Math.round((total - avail) / 1024), free: Math.round(avail / 1024), total: Math.round(total / 1024) };
  } catch { return null; }
}

// Soma do RSS dos processos do Chromium (aprox.: partilhas contam várias vezes).
function chromiumMb() {
  let pages = 0, found = false;
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter(p => /^\d+$/.test(p)); } catch { return null; }
  for (const pid of pids) {
    try {
      if (!/chrom/i.test(fs.readFileSync(`/proc/${pid}/comm`, 'utf8'))) continue;
      pages += Number(fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]); found = true;
    } catch { /* processo terminou */ }
  }
  return found ? Math.round(pages * 4096 / 1048576) : null;
}

function temperature() {
  try { return Number(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000; } catch { return null; }
}

module.exports = { name: 'pi', mdns: true, cpuTimes, gpuRenderNs, memory, chromiumMb, temperature };
