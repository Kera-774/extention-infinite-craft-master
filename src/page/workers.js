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
      this._resetDelta();
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
        this._failWaiters(w, 'worker arrêté');
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
        for (const x of this.workers) clearTimeout(x.timer);
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

    /** Rejette les demandes en attente d'un worker terminé (sinon la génération resterait bloquée). */
    _failWaiters(w, reason) {
      for (const [id, cb] of this.waiters) {
        if (cb.worker !== w) continue;
        this.waiters.delete(id);
        clearTimeout(cb.timer);
        cb.reject(new Error(reason));
      }
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
    // Réservations : état NET par clé (la dernière opération gagne). Envoyer
    // « toutes les libérations puis toutes les réservations » laissait réservée
    // à jamais une paire réservée puis libérée dans le même lot (ex. file vidée
    // par un Stop) : le worker ne la proposait plus jamais.
    reserve(key) {
      this.local.reserve(key);
      if (this.workers.length) this.delta.res.set(key, true);
    }
    unreserve(key) {
      this.local.unreserve(key);
      if (this.workers.length) this.delta.res.set(key, false);
    }
    /** Libère toutes les réservations (file et requêtes en vol vides : elles sont périmées). */
    releaseAll() {
      for (const k of [...this.local.reserved]) this.unreserve(k);
    }
    setConfig(c) {
      this.local.setConfig(c);
      for (const { w } of this.workers) w.postMessage({ type: 'config', config: c });
    }

    _resetDelta() {
      this.delta = { upsert: new Map(), tested: [], res: new Map() };
    }

    _flushDelta() {
      const d = this.delta;
      const msgs = [];
      const reserve = [];
      const unreserve = [];
      for (const [k, on] of d.res) (on ? reserve : unreserve).push(k);
      if (d.upsert.size) msgs.push({ type: 'upsert', elements: [...d.upsert.values()] });
      if (unreserve.length) msgs.push({ type: 'unreserve', keys: unreserve });
      if (reserve.length) msgs.push({ type: 'reserve', keys: reserve });
      if (d.tested.length) msgs.push({ type: 'tested', keys: d.tested }); // en dernier : « testé » l'emporte
      for (const { w } of this.workers) for (const m of msgs) w.postMessage(m);
      this._resetDelta();
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
            // délai de garde : un worker figé ne doit jamais bloquer la boucle
            const timer = setTimeout(() => {
              this.waiters.delete(reqId);
              reject(new Error('worker trop lent'));
            }, 8000);
            const done = (fn) => (v) => (clearTimeout(timer), fn(v));
            this.waiters.set(reqId, { resolve: done(resolve), reject: done(reject), worker: w, timer });
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
