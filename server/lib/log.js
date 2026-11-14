'use strict';
// Log minimalista no terminal: acrescenta a hora a cada linha de console.log/warn/error e pinta os erros a vermelho.
// Chamar install() uma só vez, no arranque, antes de criar o resto. NO_COLOR=1 desliga as cores.
const pad = n => String(n).padStart(2, '0');
const ts = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  const rawLog = console.log.bind(console), rawErr = console.error.bind(console);
  console.log = (...a) => rawLog(paint(90, ts()), ...a);
  console.info = console.log;
  console.warn = (...a) => rawErr(paint(90, ts()), paint(33, 'AVISO'), ...a);
  console.error = (...a) => rawErr(paint(90, ts()), paint(31, 'ERRO'), ...a);
}

module.exports = { install, ts };
