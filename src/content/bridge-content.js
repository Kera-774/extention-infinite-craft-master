/**
 * Content script (monde ISOLÉ) : relais entre le side panel (chrome.runtime)
 * et le moteur dans la page (window.postMessage). Il fournit aussi :
 *  - le code source des Web Workers (fichiers de l'extension) ;
 *  - le stockage de secours chrome.storage.local.
 */
(function () {
  'use strict';
  const pending = new Map();
  let seq = 0;
  let workerSource = null;
  let helloAcked = false;

  function toPage(msg) {
    window.postMessage({ icx: 'cs2page', ...msg }, location.origin);
  }

  function requestPage(cmd, payload, timeoutMs = 30000) {
    const id = 'c' + ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('la page ne répond pas (' + cmd + ')'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      toPage({ id, cmd, payload });
    });
  }

  async function loadWorkerSource() {
    const files = ['src/shared/pairkey.js', 'src/shared/scoring.js', 'src/worker/scorer-worker.js'];
    const parts = await Promise.all(files.map((f) => fetch(chrome.runtime.getURL(f)).then((r) => r.text())));
    return parts.join('\n;\n');
  }

  async function sendHello() {
    if (helloAcked) return;
    try {
      if (!workerSource) workerSource = await loadWorkerSource();
      await requestPage('hello', { workerSource }, 3000);
      helloAcked = true;
    } catch (_) {
      /* page pas encore prête : nouvel essai sur « page-ready » */
    }
  }

  // Stockage de secours pour le cache (si IndexedDB est indisponible dans la page)
  async function kv(cmd, payload) {
    switch (cmd) {
      case 'kv.ping':
        return true;
      case 'kv.getAll':
        return chrome.storage.local.get(null);
      case 'kv.setMany':
        await chrome.storage.local.set(payload);
        return true;
      case 'kv.clear': {
        const all = await chrome.storage.local.get(null);
        const keys = Object.keys(all).filter((k) => /^[pemb]:/.test(k));
        await chrome.storage.local.remove(keys);
        return true;
      }
      default:
        throw new Error('commande kv inconnue');
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.icx !== 'page2cs') return;
    const m = ev.data;
    if (m.replyTo) {
      const p = pending.get(m.replyTo);
      if (!p) return;
      pending.delete(m.replyTo);
      clearTimeout(p.timer);
      m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
    } else if (m.cmd) {
      kv(m.cmd, m.payload).then(
        (result) => toPage({ replyTo: m.id, result }),
        (err) => toPage({ replyTo: m.id, error: String(err && err.message) })
      );
    } else if (m.event) {
      if (m.event === 'page-ready') sendHello();
      chrome.runtime.sendMessage({ type: 'icx-event', event: m.event, payload: m.payload }).catch(() => {
        /* aucun panneau ouvert */
      });
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'icx-cmd') return;
    requestPage(msg.cmd, msg.payload, msg.cmd === 'exportCache' || msg.cmd === 'importCache' || msg.cmd === 'diagnose' ? 120000 : 30000).then(
      (result) => sendResponse({ ok: true, result }),
      (err) => sendResponse({ ok: false, error: String(err && err.message) })
    );
    return true; // réponse asynchrone
  });

  sendHello();
})();
