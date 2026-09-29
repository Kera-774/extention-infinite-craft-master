/**
 * Horloge du moteur.
 *
 * Dans un onglet en arrière-plan, Chrome regroupe les timers de la page à un
 * réveil par seconde (voire une par minute après 5 min). Les timers d'un
 * Web Worker dédié ne subissent pas ce bridage agressif : on y délègue donc
 * les attentes de la boucle. Si la CSP de la page interdit les workers Blob,
 * repli transparent sur setTimeout.
 */
(function () {
  'use strict';
  const ICX = (window.ICX = window.ICX || {});
  const callbacks = new Map();
  let seq = 0;
  let worker = null;

  try {
    const src = 'const t=new Map();onmessage=e=>{const[m,id,ms]=e.data;if(m==="s")t.set(id,setTimeout(()=>{t.delete(id);postMessage(id)},ms));else{clearTimeout(t.get(id));t.delete(id)}}';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = (e) => {
      const fn = callbacks.get(e.data);
      callbacks.delete(e.data);
      if (fn) fn();
    };
    worker.onerror = () => {
      worker = null; // repli : les prochains appels passent par setTimeout
    };
  } catch (_) {
    worker = null;
  }

  ICX.clock = {
    get kind() {
      return worker ? 'worker' : 'page';
    },
    set(fn, ms) {
      if (!worker) return { t: setTimeout(fn, ms) };
      const id = ++seq;
      callbacks.set(id, fn);
      worker.postMessage(['s', id, Math.max(0, ms | 0)]);
      return { id };
    },
    clear(h) {
      if (!h) return;
      if (h.t !== undefined) clearTimeout(h.t);
      if (h.id !== undefined) {
        callbacks.delete(h.id);
        if (worker) worker.postMessage(['c', h.id]);
      }
    }
  };
})();
