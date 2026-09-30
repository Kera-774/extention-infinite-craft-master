/**
 * Adaptateur vers le jeu Infinite Craft (monde MAIN).
 *
 * Ce que l'on sait de la version actuelle du jeu (d'après les userscripts
 * communautaires maintenus en 2026, cf. README « Investigation ») :
 *  - `window.IC` : API exposée par le jeu (getItems, createInstance, craft,
 *    removeInstances, getInstances…) ;
 *  - `document.querySelector('.container').__vue__` : instance Vue 2 principale
 *    avec `items`, `craftApi(a, b)` → { text, emoji, discovery }, `craft`,
 *    `currSave`, `switchSave` ;
 *  - sauvegarde dans IndexedDB « infinite-craft » (store « items », clé
 *    [idSauvegarde, idÉlément], champ `recipes` = liste de [idA, idB]) — et
 *    plus dans localStorage « infinite-craft-data » (ancien format, toujours géré).
 *
 * Quatre backends de fusion, du plus fidèle au plus « brut » :
 *  - game  : IC.craft sur deux instances temporaires. Le jeu fait la requête
 *            (en-têtes, cookies Cloudflare) ET ajoute lui-même l'élément à
 *            l'inventaire + sa sauvegarde. Aucune écriture de notre part.
 *  - api   : v_container.craftApi(a, b) : requête faite par le jeu, mais
 *            l'ajout à l'inventaire passe par notre « materializer ».
 *  - fetch : GET /api/infinite-craft/pair direct + materializer.
 *  - dom   : simulation de glisser-déposer (secours si tout le reste échoue).
 */
(function () {
  'use strict';
  const ICX = (window.ICX = window.ICX || {});
  const pk = ICX.pairkey;
  const LEGACY_KEY = 'infinite-craft-data';
  const BASE = [
    { text: 'Water', emoji: '💧' },
    { text: 'Fire', emoji: '🔥' },
    { text: 'Wind', emoji: '🌬️' },
    { text: 'Earth', emoji: '🌍' }
  ];

  /** Erreur de fusion typée, interprétée par le moteur (AIMD, reprise). */
  class CraftError extends Error {
    constructor(kind, message, retryAfterMs) {
      super(message || kind);
      this.kind = kind; // 'rate' | 'forbidden' | 'timeout' | 'network' | 'server' | 'invalid' | 'unsupported'
      this.retryAfterMs = retryAfterMs || 0;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function withTimeout(promise, ms, signal) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new CraftError('timeout', 'délai dépassé (' + ms + ' ms)')), ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new CraftError('aborted', 'annulé'));
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      promise.then(
        (v) => (clearTimeout(t), signal && signal.removeEventListener('abort', onAbort), resolve(v)),
        (e) => (clearTimeout(t), signal && signal.removeEventListener('abort', onAbort), reject(e))
      );
    });
  }

  /** Normalise les deux formats de réponse connus. */
  function normalizeResult(r) {
    if (!r || typeof r !== 'object') return null;
    const text = typeof r.result === 'string' ? r.result : typeof r.text === 'string' ? r.text : null;
    if (text == null) return null;
    return {
      text,
      emoji: r.emoji || '',
      isNew: !!(r.isNew ?? r.discovery ?? r.isFirstDiscovery ?? r.discovered),
      nothing: text === 'Nothing' || text === ''
    };
  }

  class GameAdapter {
    constructor() {
      this.net = window.__ICX_NET || null;
      this.captured = new Map(); // clé -> { r, t } (résultats vus via craftApi)
      this.capWaiters = new Map(); // clé -> [resolve]
      this.hooked = false;
      this.materializeQueue = [];
      this.materializeTimer = null;
      this.backupDone = false;
      this.needsReload = false;
      this.lastMaterializeError = null;
      this.ourInstances = new Set();
      this.spawnCounter = 0;
    }

    get vue() {
      const el = document.querySelector('.container');
      return el && el.__vue__ ? el.__vue__ : null;
    }

    get IC() {
      return window.IC || null;
    }

    /** Attend que le jeu soit chargé (IC ou instance Vue). */
    async waitReady(timeoutMs = 60000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const v = this.vue;
        if ((this.IC && typeof this.IC.getItems === 'function') || (v && Array.isArray(v.items) && v.items.length)) {
          this.installHook();
          return true;
        }
        await sleep(300);
      }
      return this.hasLegacySave();
    }

    capabilities() {
      const v = this.vue;
      const IC = this.IC;
      return {
        IC: !!IC,
        vue: !!v,
        craftApi: !!(v && typeof v.craftApi === 'function'),
        icCraft: !!(IC && typeof IC.craft === 'function' && typeof IC.createInstance === 'function'),
        legacySave: this.hasLegacySave(),
        currSave: v ? v.currSave : undefined
      };
    }

    hasLegacySave() {
      try {
        const d = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
        return !!(d && Array.isArray(d.elements));
      } catch (_) {
        return false;
      }
    }

    /** Enveloppe craftApi pour capturer TOUTES les réponses (y compris celles du DnD). */
    installHook() {
      const v = this.vue;
      if (this.hooked || !v || typeof v.craftApi !== 'function') return;
      const self = this;
      const orig = v.craftApi;
      v.craftApi = async function (a, b) {
        const r = await orig.apply(this, arguments);
        try {
          const key = pk.pairKey(a, b);
          self.captured.set(key, { r, t: Date.now() });
          if (self.onCapture) self.onCapture(a, b, r);
          if (self.captured.size > 2000) self.captured.delete(self.captured.keys().next().value);
          const ws = self.capWaiters.get(key);
          if (ws) {
            self.capWaiters.delete(key);
            for (const w of ws) w(r);
          }
        } catch (_) {
          /* ne jamais casser le jeu */
        }
        return r;
      };
      this.hooked = true;
    }

    waitCaptured(key, ms, signal) {
      return withTimeout(
        new Promise((resolve) => {
          const list = this.capWaiters.get(key) || [];
          list.push(resolve);
          this.capWaiters.set(key, list);
        }),
        ms,
        signal
      );
    }

    /** Éléments possédés : [{ id, text, emoji, discovery, recipes }]. */
    getItems() {
      try {
        if (this.IC && typeof this.IC.getItems === 'function') {
          const it = this.IC.getItems();
          if (Array.isArray(it) && it.length) return it;
        }
      } catch (_) {
        /* on tente la source suivante */
      }
      const v = this.vue;
      if (v && Array.isArray(v.items) && v.items.length) return v.items;
      try {
        const d = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
        if (d && Array.isArray(d.elements)) return d.elements.map((e, i) => ({ id: i, text: e.text, emoji: e.emoji, discovery: e.discovered }));
      } catch (_) {
        /* sauvegarde illisible */
      }
      return BASE.map((b, i) => ({ id: i, ...b }));
    }

    /**
     * Recherche par nom en O(1) : index reconstruit seulement quand l'inventaire
     * change (nouveau tableau ou nouvelle longueur), au lieu d'un parcours
     * complet de l'inventaire à chaque requête.
     */
    findItem(text) {
      const items = this.getItems();
      if (items !== this._idxSrc || items.length !== this._idxLen) {
        const idx = new Map();
        for (const it of items) if (it && it.text != null) {
          const k = pk.normName(it.text);
          if (!idx.has(k)) idx.set(k, it);
        }
        this._idx = idx;
        this._idxSrc = items;
        this._idxLen = items.length;
      }
      return this._idx.get(pk.normName(text)) || null;
    }

    // ------------------------------------------------------------------
    // Backends de fusion. Tous renvoient { text, emoji, isNew, nothing }
    // ou lèvent une CraftError.
    // ------------------------------------------------------------------

    async craft(backend, a, b, { signal, timeoutMs = 20000 } = {}) {
      switch (backend) {
        case 'game':
          return this.craftGame(a, b, signal, timeoutMs);
        case 'api':
          return this.craftApi(a, b, signal, timeoutMs);
        case 'fetch':
          return this.craftFetch(a, b, signal, timeoutMs);
        case 'dom':
          return this.craftDom(a, b, signal, timeoutMs);
        default:
          throw new CraftError('unsupported', 'backend inconnu ' + backend);
      }
    }

    /** Diagnostique une réponse vide du jeu à l'aide du statut HTTP observé. */
    _diagnose(key, since) {
      const s = this.net && this.net.lastFor(key, since);
      if (!s) return new CraftError('invalid', 'réponse vide du jeu (statut HTTP inconnu)');
      if (s.status === 429) return new CraftError('rate', 'HTTP 429', s.retryAfterMs);
      if (s.status === 403) return new CraftError('forbidden', 'HTTP 403');
      if (s.status >= 500) return new CraftError('server', 'HTTP ' + s.status);
      if (s.status === 0) return new CraftError('network', 'erreur réseau');
      return new CraftError('invalid', 'HTTP ' + s.status);
    }

    _spawnPoint() {
      // petite zone en bas à gauche du canevas ; instances supprimées aussitôt
      const i = this.spawnCounter++ % 12;
      return { x: 40 + (i % 4) * 30, y: Math.max(120, window.innerHeight - 80 - Math.floor(i / 4) * 30) };
    }

    async craftGame(a, b, signal, timeoutMs) {
      const IC = this.IC;
      if (!IC || typeof IC.craft !== 'function') throw new CraftError('unsupported', 'IC.craft absent');
      const ia = this.findItem(a);
      const ib = this.findItem(b);
      if (!ia || !ib) {
        // élément absent de l'inventaire (sauvegarde changée…) : requête directe + ajout par nos soins
        const n = await this.craftApi(a, b, signal, timeoutMs);
        return { ...n, needMaterialize: true };
      }
      const key = pk.pairKey(a, b);
      const since = Date.now();
      const p = this._spawnPoint();
      const mk = (it) => IC.createInstance({ text: it.text, emoji: it.emoji, itemId: it.id, discovery: it.discovery, x: p.x, y: p.y, animate: false });
      const created = [];
      // La vraie réponse est celle vue par craftApi. On s'y abonne AVANT la fusion :
      // IC.craft peut rendre la main avant la fin de la requête (animation), il ne
      // faut donc ni conclure trop tôt, ni retirer les instances pendant la fusion.
      const capP = this.waitCaptured(key, timeoutMs);
      let craftP = Promise.resolve();
      try {
        const i1 = await withTimeout(Promise.resolve(mk(ia)), 5000, signal);
        created.push(i1);
        const i2 = await withTimeout(Promise.resolve(mk(ib)), 5000, signal);
        created.push(i2);
        for (const i of created) this.ourInstances.add(i);
        craftP = Promise.resolve(IC.craft(i1, i2));
        const res = await withTimeout(craftP, timeoutMs, signal);
        const cap = this.captured.get(key);
        let r = cap && cap.t >= since ? cap.r : undefined;
        if (r === undefined) {
          const fromInstance = res && res.instance && res.instance.text ? { text: res.instance.text, emoji: res.instance.emoji, discovery: res.instance.discovery } : undefined;
          // résultat déjà visible sur l'instance : on laisse 300 ms à craftApi pour le drapeau isNew
          r = fromInstance
            ? await Promise.race([capP.catch(() => fromInstance), sleep(300).then(() => fromInstance)])
            : await withTimeout(capP, Math.max(1000, timeoutMs - (Date.now() - since)), signal).catch((err) => {
                if (err instanceof CraftError && err.kind === 'aborted') throw err;
                return undefined;
              });
        }
        const n = normalizeResult(r);
        if (!n) {
          const d = this._diagnose(key, since);
          if (r === undefined && d.kind === 'invalid') d.message = 'le jeu n’a renvoyé aucune réponse pour cette fusion';
          throw d;
        }
        return n;
      } finally {
        this._deferCleanup(created, craftP, capP, key);
      }
    }

    /**
     * Retire les instances temporaires quand la fusion est VRAIMENT finie
     * (réponse de craftApi reçue ou IC.craft terminé, au plus 30 s), y compris
     * l'instance résultat créée par le jeu.
     */
    _deferCleanup(created, craftP, capP, key) {
      const IC = this.IC;
      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        this.capWaiters.delete(key);
        const extra = [];
        try {
          const cap = this.captured.get(key);
          const text = cap && cap.r && (cap.r.text || cap.r.result);
          if (text && typeof IC.getInstances === 'function') {
            // instance résultat posée au même endroit que nos deux instances
            const at = created[0];
            for (const inst of IC.getInstances() || []) {
              if (!inst || created.includes(inst) || this.ourInstances.has(inst)) continue;
              if (inst.text === text && at && Math.abs((inst.x ?? 1e9) - at.x) < 80 && Math.abs((inst.y ?? 1e9) - at.y) < 80) extra.push(inst);
            }
          }
        } catch (_) {
          /* API d'instances différente : on ne retire que les nôtres */
        }
        try {
          const all = created.concat(extra).filter(Boolean);
          if (all.length && typeof IC.removeInstances === 'function') IC.removeInstances(all);
        } catch (_) {
          /* instance déjà retirée par le jeu */
        }
        for (const i of created) this.ourInstances.delete(i);
      };
      const guard = setTimeout(cleanup, 30000);
      Promise.allSettled([craftP, capP]).then((rs) => {
        clearTimeout(guard);
        const res = rs[0].status === 'fulfilled' ? rs[0].value : null;
        if (res && res.instance) {
          try {
            IC.removeInstances([res.instance]);
          } catch (_) {
            /* déjà retirée */
          }
        }
        // petit délai : le jeu pose l'instance résultat juste après la réponse
        setTimeout(cleanup, 150);
      });
    }

    async craftApi(a, b, signal, timeoutMs) {
      const v = this.vue;
      if (!v || typeof v.craftApi !== 'function') throw new CraftError('unsupported', 'craftApi absent');
      const [first, second] = pk.orderPair(a, b);
      const key = pk.pairKey(a, b);
      const since = Date.now();
      let r;
      try {
        r = await withTimeout(Promise.resolve(v.craftApi(first, second)), timeoutMs, signal);
      } catch (err) {
        if (err instanceof CraftError) throw err;
        throw this._diagnose(key, since);
      }
      const n = normalizeResult(r);
      if (!n) throw this._diagnose(key, since);
      return n;
    }

    async craftFetch(a, b, signal, timeoutMs) {
      const [first, second] = pk.orderPair(a, b);
      const url = '/api/infinite-craft/pair?first=' + encodeURIComponent(first) + '&second=' + encodeURIComponent(second);
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const f = (this.net && this.net.origFetch) || window.fetch.bind(window);
      let res;
      try {
        res = await f(url, { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: ctrl.signal });
      } catch (err) {
        if (signal && signal.aborted) throw new CraftError('aborted', 'annulé');
        throw new CraftError(ctrl.signal.aborted ? 'timeout' : 'network', String(err && err.message));
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
      if (res.status === 429) {
        const ra = res.headers.get('retry-after');
        throw new CraftError('rate', 'HTTP 429', ra ? (Number(ra) || 0) * 1000 : 0);
      }
      if (res.status === 403) throw new CraftError('forbidden', 'HTTP 403');
      if (res.status >= 500) throw new CraftError('server', 'HTTP ' + res.status);
      if (!res.ok) throw new CraftError('invalid', 'HTTP ' + res.status);
      let data;
      try {
        data = await res.json();
      } catch (_) {
        throw new CraftError('invalid', 'JSON invalide (page Cloudflare ?)');
      }
      const n = normalizeResult(data);
      if (!n) throw new CraftError('invalid', 'réponse sans champ result');
      return n;
    }

    // --- Secours : glisser-déposer simulé ----------------------------------

    _sidebarItem(text) {
      const n = pk.normName(text);
      const nodes = document.querySelectorAll('.sidebar .item, .items .item, [data-item-text], .item');
      for (const el of nodes) {
        const t = el.getAttribute('data-item-text') || (el.textContent || '').replace(/^\s*\S+\s+/u, '');
        const emoji = el.querySelector('.item-emoji');
        const clean = emoji ? (el.textContent || '').replace(emoji.textContent, '') : t;
        if (pk.normName(clean) === n || pk.normName(t) === n) return el;
      }
      return null;
    }

    async _search(text) {
      const input = document.querySelector('.sidebar-input, input[type="text"][placeholder*="earch"], .sidebar input');
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(80);
    }

    _fire(target, type, x, y) {
      const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type.endsWith('up') ? 0 : 1, pointerId: 1, isPrimary: true, pointerType: 'mouse' };
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      target.dispatchEvent(new Ctor(type, opts));
    }

    async _drag(el, to) {
      const r = el.getBoundingClientRect();
      const x0 = r.left + r.width / 2;
      const y0 = r.top + r.height / 2;
      this._fire(el, 'pointerdown', x0, y0);
      this._fire(el, 'mousedown', x0, y0);
      for (let s = 1; s <= 6; s++) {
        const x = x0 + ((to.x - x0) * s) / 6;
        const y = y0 + ((to.y - y0) * s) / 6;
        const t = document.elementFromPoint(x, y) || document;
        this._fire(t, 'pointermove', x, y);
        this._fire(t, 'mousemove', x, y);
        await sleep(16);
      }
      const t = document.elementFromPoint(to.x, to.y) || document;
      this._fire(t, 'pointerup', to.x, to.y);
      this._fire(t, 'mouseup', to.x, to.y);
    }

    async craftDom(a, b, signal, timeoutMs) {
      const key = pk.pairKey(a, b);
      const since = Date.now();
      const sidebar = document.querySelector('.sidebar');
      const left = sidebar ? sidebar.getBoundingClientRect().left : window.innerWidth * 0.7;
      const drop = { x: Math.max(80, left - 160), y: 160 };
      await this._search(a);
      const ea = this._sidebarItem(a);
      if (!ea) throw new CraftError('unsupported', 'élément introuvable dans la barre latérale : ' + a);
      await this._drag(ea, drop);
      await this._search(b);
      const eb = this._sidebarItem(b);
      if (!eb) throw new CraftError('unsupported', 'élément introuvable dans la barre latérale : ' + b);
      const wait = this.waitCaptured(key, timeoutMs, signal);
      await this._drag(eb, drop);
      await this._search('');
      let r;
      try {
        r = await wait;
      } catch (err) {
        throw err instanceof CraftError && err.kind !== 'timeout' ? err : this._diagnose(key, since);
      }
      const n = normalizeResult(r);
      if (!n) throw this._diagnose(key, since);
      return n;
    }

    /** Retire les instances temporaires restées sur le canevas (arrêt). */
    sweepInstances() {
      try {
        if (this.ourInstances.size && this.IC && this.IC.removeInstances) this.IC.removeInstances([...this.ourInstances]);
      } catch (_) {
        /* rien */
      }
      this.ourInstances.clear();
    }

    // ------------------------------------------------------------------
    // Materializer : ajout des nouveaux éléments dans l'inventaire du jeu
    // (uniquement pour les backends api / fetch ; le backend game n'en a pas besoin).
    // ------------------------------------------------------------------

    queueMaterialize(item) {
      this.materializeQueue.push(item);
      if (!this.materializeTimer) this.materializeTimer = setTimeout(() => this.flushMaterialize(), 1500);
    }

    async flushMaterialize() {
      clearTimeout(this.materializeTimer);
      this.materializeTimer = null;
      const batch = this.materializeQueue.splice(0);
      if (!batch.length) return;
      try {
        const fresh = batch.filter((it) => !this.findItem(it.text));
        if (!fresh.length) return;
        const records = this._buildRecords(fresh);
        await this._writeIdb(records);
        this._writeLegacy(fresh);
        this._pushMemory(records);
      } catch (err) {
        this.lastMaterializeError = String(err && err.message ? err.message : err);
        console.warn('[ICX] ajout à l’inventaire échoué', err);
        this.needsReload = true;
      }
    }

    _buildRecords(fresh) {
      const items = this.getItems();
      let maxId = -1;
      for (const it of items) if (typeof it.id === 'number' && it.id > maxId) maxId = it.id;
      const template = items.find((it) => it && typeof it.id === 'number') || {};
      return fresh.map((f) => {
        const pa = this.findItem(f.parentA);
        const pb = this.findItem(f.parentB);
        const rec = {};
        // on reprend la forme exacte d'un élément existant (valeurs neutres)
        for (const [k, v] of Object.entries(template)) {
          if (k.startsWith('_') || k.startsWith('$')) continue;
          rec[k] = Array.isArray(v) ? [] : typeof v === 'number' ? 0 : typeof v === 'boolean' ? false : typeof v === 'string' ? '' : v == null ? v : undefined;
          if (rec[k] === undefined) delete rec[k];
        }
        rec.id = ++maxId;
        rec.text = f.text;
        rec.emoji = f.emoji || '';
        rec.discovery = !!f.isNew;
        if ('discovered' in template) rec.discovered = !!f.isNew;
        if ('recipes' in template || pa) rec.recipes = pa && pb ? [[pa.id, pb.id]] : [];
        return rec;
      });
    }

    /** Écriture atomique dans IndexedDB « infinite-craft », après sauvegarde de secours. */
    async _writeIdb(records) {
      const v = this.vue;
      if (!v || v.currSave === undefined || !('indexedDB' in window)) return;
      const db = await new Promise((res, rej) => {
        const req = indexedDB.open('infinite-craft'); // sans version : n'entraîne jamais de migration
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
        req.onupgradeneeded = () => {
          // la base n'existait pas : on annule pour ne rien créer
          req.transaction.abort();
        };
      });
      try {
        if (!db.objectStoreNames.contains('items')) return;
        const store0 = db.transaction('items', 'readonly').objectStore('items');
        const keyPath = store0.keyPath; // ex. ["saveId","id"] ou "id"
        const all = await new Promise((res, rej) => {
          const r = store0.getAll();
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        const saveField = Array.isArray(keyPath) ? keyPath.find((k) => k !== 'id') : null;
        const mine = saveField ? all.filter((x) => x[saveField] === v.currSave) : all;
        if (!this.backupDone) {
          await ICX.engine.store.addBackup({ kind: 'infinite-craft-idb', currSave: v.currSave, keyPath, items: mine });
          this.backupDone = true;
        }
        const template = mine[0] || {};
        let maxId = mine.reduce((m, x) => (typeof x.id === 'number' && x.id > m ? x.id : m), -1);
        const byText = new Set(mine.map((x) => pk.normName(x.text)));
        const tx = db.transaction('items', 'readwrite');
        const st = tx.objectStore('items');
        for (const rec of records) {
          if (byText.has(pk.normName(rec.text))) continue;
          if (rec.id <= maxId) rec.id = ++maxId;
          else maxId = rec.id;
          const row = { ...rec };
          for (const k of Object.keys(template)) if (!(k in row)) row[k] = Array.isArray(template[k]) ? [] : template[k] === null ? null : undefined;
          if (saveField) row[saveField] = v.currSave;
          for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
          st.put(row);
        }
        await new Promise((res, rej) => {
          tx.oncomplete = res;
          tx.onerror = () => rej(tx.error);
          tx.onabort = () => rej(tx.error || new Error('transaction annulée'));
        });
      } finally {
        db.close();
      }
    }

    /** Ancien format localStorage : sauvegarde de secours puis setItem unique (atomique). */
    _writeLegacy(fresh) {
      const raw = localStorage.getItem(LEGACY_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.elements)) return;
      if (!localStorage.getItem(LEGACY_KEY + '.icx-backup')) localStorage.setItem(LEGACY_KEY + '.icx-backup', raw);
      const have = new Set(data.elements.map((e) => pk.normName(e.text)));
      for (const f of fresh) if (!have.has(pk.normName(f.text))) data.elements.push({ text: f.text, emoji: f.emoji || '', discovered: !!f.isNew });
      const out = JSON.stringify(data);
      JSON.parse(out); // vérification avant écriture
      localStorage.setItem(LEGACY_KEY, out);
    }

    /** Mise à jour de l'état réactif du jeu (affichage immédiat, sans rechargement). */
    _pushMemory(records) {
      const v = this.vue;
      if (!v || !Array.isArray(v.items)) {
        this.needsReload = true;
        return;
      }
      for (const rec of records) if (!this.findItem(rec.text)) v.items.push(rec);
    }

    reloadGame() {
      location.reload();
    }
  }

  ICX.CraftError = CraftError;
  ICX.GameAdapter = GameAdapter;
  ICX.normalizeResult = normalizeResult;
  ICX.BASE_ELEMENTS = BASE;
})();
