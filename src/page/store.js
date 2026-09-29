/**
 * Cache persistant de l'extension.
 *
 * Stockage principal : IndexedDB « icx-cache » (dans l'origine neal.fun, donc
 * séparé de la base « infinite-craft » du jeu qu'on ne touche jamais ici).
 * Secours : chrome.storage.local, via le pont du content script (si IndexedDB
 * est indisponible : navigation privée restreinte, quota, etc.).
 *
 * Écritures par lots : les enregistrements sont bufferisés et écrits dans UNE
 * transaction (atomique) dès que `batchSize` est atteint ou toutes les 2 s.
 * Au déchargement de la page, le buffer est copié de façon synchrone dans un
 * journal localStorage, rejoué au démarrage suivant.
 */
(function () {
  'use strict';
  const ICX = (window.ICX = window.ICX || {});

  const DB_NAME = 'icx-cache';
  const JOURNAL_KEY = 'icx-journal';
  const DB_VERSION = 1;

  function reqP(req) {
    return new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  function txDone(tx) {
    return new Promise((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error('transaction annulée'));
    });
  }

  /** Backend IndexedDB. */
  class IdbBackend {
    async open() {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('pairs')) db.createObjectStore('pairs', { keyPath: 'k' });
        if (!db.objectStoreNames.contains('elements')) db.createObjectStore('elements', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
        if (!db.objectStoreNames.contains('backups')) db.createObjectStore('backups', { keyPath: 'id', autoIncrement: true });
      };
      this.db = await reqP(req);
      this.name = 'IndexedDB';
    }

    async loadAll() {
      const tx = this.db.transaction(['pairs', 'elements', 'meta'], 'readonly');
      const [pairs, elements, metaRows] = await Promise.all([
        reqP(tx.objectStore('pairs').getAll()),
        reqP(tx.objectStore('elements').getAll()),
        reqP(tx.objectStore('meta').getAll())
      ]);
      const meta = {};
      for (const r of metaRows) meta[r.k] = r.v;
      return { pairs, elements, meta };
    }

    async write(pairs, elements, meta) {
      const tx = this.db.transaction(['pairs', 'elements', 'meta'], 'readwrite');
      const ps = tx.objectStore('pairs');
      const es = tx.objectStore('elements');
      const ms = tx.objectStore('meta');
      for (const p of pairs) ps.put(p);
      for (const e of elements) es.put(e);
      for (const [k, v] of meta) ms.put({ k, v });
      await txDone(tx);
    }

    async clear() {
      const tx = this.db.transaction(['pairs', 'elements', 'meta'], 'readwrite');
      tx.objectStore('pairs').clear();
      tx.objectStore('elements').clear();
      tx.objectStore('meta').clear();
      await txDone(tx);
    }

    async addBackup(obj, keep = 3) {
      const tx = this.db.transaction('backups', 'readwrite');
      const st = tx.objectStore('backups');
      st.add({ t: Date.now(), data: obj });
      const keys = await reqP(st.getAllKeys());
      for (let i = 0; i < keys.length - keep + 1; i++) st.delete(keys[i]);
      await txDone(tx);
    }
  }

  /** Backend de secours : chrome.storage.local via le pont (clé par enregistrement). */
  class ChromeStorageBackend {
    async open() {
      await ICX.bridge.request('kv.ping');
      this.name = 'chrome.storage.local';
    }
    async loadAll() {
      const all = (await ICX.bridge.request('kv.getAll')) || {};
      const pairs = [];
      const elements = [];
      const meta = {};
      for (const [k, v] of Object.entries(all)) {
        if (k.startsWith('p:')) pairs.push(v);
        else if (k.startsWith('e:')) elements.push(v);
        else if (k.startsWith('m:')) meta[k.slice(2)] = v;
      }
      return { pairs, elements, meta };
    }
    async write(pairs, elements, meta) {
      const obj = {};
      for (const p of pairs) obj['p:' + p.k] = p;
      for (const e of elements) obj['e:' + e.id] = e;
      for (const [k, v] of meta) obj['m:' + k] = v;
      await ICX.bridge.request('kv.setMany', obj);
    }
    async clear() {
      await ICX.bridge.request('kv.clear');
    }
    async addBackup(obj) {
      await ICX.bridge.request('kv.setMany', { ['b:' + Date.now()]: obj });
    }
  }

  class CacheStore {
    constructor() {
      this.batchSize = 50;
      this.pendingPairs = [];
      this.pendingElements = new Map();
      this.pendingMeta = new Map();
      this.flushing = null;
      this.timer = null;
      this.lastError = null;
    }

    async open() {
      try {
        this.backend = new IdbBackend();
        await this.backend.open();
      } catch (err) {
        console.warn('[ICX] IndexedDB indisponible, secours chrome.storage.local', err);
        this.backend = new ChromeStorageBackend();
        await this.backend.open();
      }
      this.timer = setInterval(() => this.flush(), 2000);
      return this.backend.name;
    }

    /**
     * Charge le cache et rejoue le journal d'urgence (écritures bufferisées
     * non encore validées au moment d'un rechargement / d'une fermeture).
     */
    async loadAll() {
      const data = await this.backend.loadAll();
      const journal = this._readJournal();
      if (journal) {
        const known = new Set(data.pairs.map((p) => p.k));
        for (const p of journal.pairs || []) if (!known.has(p.k)) (data.pairs.push(p), this.pendingPairs.push(p));
        const byId = new Map(data.elements.map((e) => [e.id, e]));
        for (const e of journal.elements || []) {
          byId.set(e.id, { ...(byId.get(e.id) || {}), ...e });
          this.pendingElements.set(e.id, e);
        }
        data.elements = [...byId.values()];
        await this.flush();
        try {
          localStorage.removeItem(JOURNAL_KEY);
        } catch (_) {
          /* rien */
        }
      }
      return data;
    }

    _readJournal() {
      try {
        return JSON.parse(localStorage.getItem(JOURNAL_KEY) || 'null');
      } catch (_) {
        return null;
      }
    }

    /**
     * Appelé sur pagehide : IndexedDB est asynchrone et peut ne pas valider
     * avant le déchargement ; localStorage est synchrone. On y copie le buffer
     * (≤ un lot, donc petit) pour ne perdre aucun résultat.
     */
    emergencySync() {
      if (this.pendingCount === 0 && !this.flushing) return;
      try {
        const prev = this._readJournal() || { pairs: [], elements: [] };
        const pairs = prev.pairs.concat(this.pendingPairs, this.inFlightWrite ? this.inFlightWrite.pairs : []);
        const elements = prev.elements.concat([...this.pendingElements.values()], this.inFlightWrite ? this.inFlightWrite.elements : []);
        localStorage.setItem(JOURNAL_KEY, JSON.stringify({ t: Date.now(), pairs, elements }));
      } catch (err) {
        console.warn('[ICX] journal d’urgence impossible', err);
      }
      this.flush();
    }

    get pendingCount() {
      return this.pendingPairs.length + this.pendingElements.size + this.pendingMeta.size;
    }

    queuePair(rec) {
      this.pendingPairs.push(rec);
      if (this.pendingCount >= this.batchSize) this.flush();
    }

    queueElement(rec) {
      this.pendingElements.set(rec.id, rec);
      if (this.pendingCount >= this.batchSize) this.flush();
    }

    setMeta(k, v) {
      this.pendingMeta.set(k, v);
    }

    /** Écrit tout le buffer dans une transaction ; les écritures se sérialisent. */
    async flush() {
      if (this.flushing) {
        await this.flushing;
        if (this.pendingCount === 0) return;
      }
      if (this.pendingCount === 0) return;
      const pairs = this.pendingPairs;
      const elements = [...this.pendingElements.values()].map((e) => ({ ...e }));
      const meta = [...this.pendingMeta.entries()];
      this.pendingPairs = [];
      this.pendingElements = new Map();
      this.pendingMeta = new Map();
      this.inFlightWrite = { pairs, elements };
      this.flushing = this.backend
        .write(pairs, elements, meta)
        .catch((err) => {
          // on remet en file : rien n'est perdu, nouvel essai au prochain flush
          this.lastError = String(err && err.message ? err.message : err);
          console.warn('[ICX] échec écriture cache, nouvel essai plus tard', err);
          this.pendingPairs = pairs.concat(this.pendingPairs);
          for (const e of elements) if (!this.pendingElements.has(e.id)) this.pendingElements.set(e.id, e);
          for (const [k, v] of meta) if (!this.pendingMeta.has(k)) this.pendingMeta.set(k, v);
        })
        .finally(() => {
          this.flushing = null;
          this.inFlightWrite = null;
        });
      await this.flushing;
    }

    async clear() {
      this.pendingPairs = [];
      this.pendingElements.clear();
      this.pendingMeta.clear();
      await this.backend.clear();
    }

    addBackup(obj) {
      return this.backend.addBackup(obj);
    }
  }

  ICX.CacheStore = CacheStore;
})();
