/**
 * Service de planification : un Planner local (toujours présent, utilisé pour
 * le re-scoring paresseux et en ÉCO/NORMAL) + 0 à 2 Web Workers miroirs qui
 * génèrent les candidats hors du thread principal (TURBO/MAX).
 *
 * Les workers sont créés depuis un Blob (le code est fourni par le content
 * script). Si la CSP de la page l'interdit, on retombe silencieusement sur le
 * Planner local.
 */
(function () {
  'use strict';
  const ICX = (window.ICX = window.ICX || {});
  const { Planner } = ICX.scoring;

  class PlannerService {
    constructor() {
      this.local = new Planner();
      this.workers = []; // { w, busy }
      this.workerSource = null;
      this.workerError = null;
      this.suspended = 0; // workers suspendus par le garde-fou thermique
      this.targetWorkers = 0;
      this.delta = { upsert: new Map(), tested: [], reserve: [], unreserve: [] };
      this.reqSeq = 0;
      this.waiters = new Map();
    }

    setWorkerSource(src) {
      this.workerSource = src;
      this._reconcile();
    }

    /** Nombre de workers voulu (0..2), appliqué à chaud. */
    setWorkerCount(n) {
      this.targetWorkers = n;
      this._reconcile();
    }

    /** Garde-fou thermique : suspend (termine) un worker ; resume le recrée. */
    suspendOne() {
      if (this.suspended < this.targetWorkers) this.suspended++;
      this._reconcile();
    }
    resumeOne() {
      if (this.suspended > 0) this.suspended--;
      this._reconcile();
    }

    get activeWorkers() {
      return this.workers.length;
    }

    _reconcile() {
      const want = Math.max(0, this.targetWorkers - this.suspended);
      while (this.workers.length > want) {
        const { w } = this.workers.pop();
        w.terminate();
      }
      if (!this.workerSource || this.workerError) return;
      while (this.workers.length < want) {
        const w = this._spawn();
        if (!w) break;
        this.workers.push({ w });
      }
    }

    _spawn() {
      let w;
      try {
        const url = URL.createObjectURL(new Blob([this.workerSource], { type: 'text/javascript' }));
        w = new Worker(url);
        URL.revokeObjectURL(url);
      } catch (err) {
        this.workerError = 'Web Worker bloqué (' + (err && err.message) + ') : scoring dans le thread principal';
        console.warn('[ICX]', this.workerError);
        return null;
      }
      w.onmessage = (ev) => {
        const m = ev.data;
        const cb = this.waiters.get(m.reqId);
        if (!cb) return;
        this.waiters.delete(m.reqId);
        m.type === 'error' ? cb.reject(new Error(m.message)) : cb.resolve(m.list);
      };
      w.onerror = (ev) => {
        this.workerError = 'Erreur worker : ' + (ev.message || 'inconnue');
        console.warn('[ICX]', this.workerError);
        for (const [, cb] of this.waiters) cb.reject(new Error(this.workerError));
        this.waiters.clear();
        this.targetWorkers = 0;
        this._reconcile();
      };
      // instantané complet de l'état
      const p = this.local;
      w.postMessage({
        type: 'init',
        config: { weights: p.weights, settings: p.settings, mode: p.mode, whitelist: [...p.whitelist], blacklist: [...p.blacklist] },
        elements: [...p.elements.values()],
        tested: [...p.tested],
        reserved: [...p.reserved]
      });
      return w;
    }

    // --- mutations : appliquées localement et bufferisées pour les workers ---
    upsertElement(e) {
      this.local.upsertElement(e);
      if (this.workers.length) this.delta.upsert.set(e.id, { ...e });
    }
    markTested(key) {
      this.local.markTested(key);
      if (this.workers.length) this.delta.tested.push(key);
    }
    reserve(key) {
      this.local.reserve(key);
      if (this.workers.length) this.delta.reserve.push(key);
    }
    unreserve(key) {
      this.local.unreserve(key);
      if (this.workers.length) this.delta.unreserve.push(key);
    }
    setConfig(c) {
      this.local.setConfig(c);
      for (const { w } of this.workers) w.postMessage({ type: 'config', config: c });
    }

    _flushDelta() {
      const d = this.delta;
      const msgs = [];
      if (d.upsert.size) msgs.push({ type: 'upsert', elements: [...d.upsert.values()] });
      if (d.tested.length) msgs.push({ type: 'tested', keys: d.tested });
      if (d.unreserve.length) msgs.push({ type: 'unreserve', keys: d.unreserve });
      if (d.reserve.length) msgs.push({ type: 'reserve', keys: d.reserve });
      for (const { w } of this.workers) for (const m of msgs) w.postMessage(m);
      this.delta = { upsert: new Map(), tested: [], reserve: [], unreserve: [] };
    }

    /** Génère des candidats (worker(s) si disponibles, sinon local). */
    async generate(opts) {
      if (!this.workers.length) return this.local.generate(opts);
      this._flushDelta();
      const n = opts.anchors ? 1 : this.workers.length;
      const parts = await Promise.all(
        this.workers.slice(0, n).map(({ w }, i) => {
          const reqId = ++this.reqSeq;
          const o = { ...opts };
          if (!opts.anchors) {
            o.anchorCount = Math.ceil((opts.anchorCount || 32) / n);
            o.limit = Math.ceil((opts.limit || 2000) / n);
          }
          return new Promise((resolve, reject) => {
            this.waiters.set(reqId, { resolve, reject });
            w.postMessage({ type: 'generate', reqId, opts: o, worker: i });
          });
        })
      ).catch((err) => {
        console.warn('[ICX] génération worker échouée, repli local', err);
        return [this.local.generate(opts)];
      });
      // fusion + dédoublonnage (deux workers peuvent proposer la même paire)
      const seen = new Set();
      const out = [];
      for (const list of parts) for (const c of list) if (!seen.has(c.key)) (seen.add(c.key), out.push(c));
      return out;
    }
  }

  ICX.PlannerService = PlannerService;
})();
