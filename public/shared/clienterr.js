// Envia os erros de JavaScript do browser (painel e player) para o terminal do servidor. No máximo 10 por página.
(function () {
  var sent = 0;
  function send(msg) {
    if (sent++ >= 10) return;
    try {
      var body = JSON.stringify({ page: location.pathname, msg: String(msg).slice(0, 500) });
      if (navigator.sendBeacon) navigator.sendBeacon('/api/clientlog', new Blob([body], { type: 'application/json' }));
      else fetch('/api/clientlog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true });
    } catch (e) { /* nunca deve causar mais erros */ }
  }
  addEventListener('error', function (e) { send((e.message || 'erro') + ' @ ' + String(e.filename || '').split('/').pop() + ':' + e.lineno); });
  addEventListener('unhandledrejection', function (e) { send('promise: ' + (e.reason && e.reason.message || e.reason)); });
})();
