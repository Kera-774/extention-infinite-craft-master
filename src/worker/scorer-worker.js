/**
 * Web Worker de scoring (niveaux TURBO / MAX).
 *
 * Il maintient un miroir du Planner (éléments + paires connues) mis à jour par
 * deltas, et calcule les paires candidates hors du thread principal pour ne pas
 * bloquer le jeu. Ce fichier est concaténé après pairkey.js et scoring.js dans
 * un Blob (voir src/page/workers.js), d'où l'accès direct à self.ICX.
 */
/* global self */
(function () {
  'use strict';
  const { Planner } = self.ICX.scoring;
  let planner = new Planner();

  self.onmessage = (ev) => {
    const m = ev.data;
    try {
      switch (m.type) {
        case 'init':
          planner = new Planner(m.config || {});
          for (const e of m.elements || []) planner.upsertElement(e);
          for (const k of m.tested || []) planner.markTested(k);
          for (const k of m.reserved || []) planner.reserve(k);
          break;
        case 'config':
          planner.setConfig(m.config);
          break;
        case 'upsert':
          for (const e of m.elements) planner.upsertElement(e);
          break;
        case 'tested':
          for (const k of m.keys) planner.markTested(k);
          break;
        case 'reserve':
          for (const k of m.keys) planner.reserve(k);
          break;
        case 'unreserve':
          for (const k of m.keys) planner.unreserve(k);
          break;
        case 'generate': {
          const t0 = performance.now();
          const list = planner.generate(m.opts);
          self.postMessage({ type: 'candidates', reqId: m.reqId, list, ms: performance.now() - t0 });
          break;
        }
      }
    } catch (err) {
      self.postMessage({ type: 'error', reqId: m.reqId, message: String((err && err.message) || err) });
    }
  };
})();
