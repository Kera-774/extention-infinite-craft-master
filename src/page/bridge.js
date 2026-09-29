/**
 * Pont monde MAIN <-> content script isolé (window.postMessage).
 * - request(cmd, payload) : requête vers le content script (ex. chrome.storage) ;
 * - emit(event, payload)  : événement poussé vers le side panel ;
 * - onCommand(handler)    : commandes reçues du side panel.
 */
(function () {
  'use strict';
  const ICX = (window.ICX = window.ICX || {});
  const pending = new Map();
  let seq = 0;
  let handler = null;

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.icx !== 'cs2page') return;
    const m = ev.data;
    if (m.replyTo) {
      const p = pending.get(m.replyTo);
      if (p) {
        pending.delete(m.replyTo);
        clearTimeout(p.timer);
        m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
      }
      return;
    }
    if (m.cmd && handler) {
      Promise.resolve()
        .then(() => handler(m.cmd, m.payload))
        .then(
          (result) => window.postMessage({ icx: 'page2cs', replyTo: m.id, result }, location.origin),
          (err) => window.postMessage({ icx: 'page2cs', replyTo: m.id, error: String((err && err.message) || err) }, location.origin)
        );
    }
  });

  ICX.bridge = {
    request(cmd, payload, timeoutMs = 20000) {
      const id = 'p' + ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('pont : délai dépassé pour ' + cmd));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        window.postMessage({ icx: 'page2cs', id, cmd, payload }, location.origin);
      });
    },
    emit(event, payload) {
      window.postMessage({ icx: 'page2cs', event, payload }, location.origin);
    },
    onCommand(fn) {
      handler = fn;
    }
  };
})();
