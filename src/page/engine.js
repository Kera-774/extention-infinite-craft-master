/**
 * Moteur d'exploration (monde MAIN). La boucle tourne dans la page, jamais
 * dans le service worker (tué par MV3 après ~30 s d'inactivité).
 *
 * Cycle : file de priorité (tas) de paires candidates → lancement sous contrôle
 * AIMD → mémorisation du résultat (succès ou "Nothing") → mise à jour du graphe
 * et des statistiques bandit → génération incrémentale des paires du nouvel
 * élément → ré-alimentation de la file quand elle se vide.
 */
(function () {
  'use strict';
  const ICX = (window.ICX = window.ICX || {});
  const pk = ICX.pairkey;
  const { MaxHeap } = ICX.heap;
  const { Aimd } = ICX.aimd;
  const { makeElement, DEFAULT_WEIGHTS, DEFAULT_SETTINGS } = ICX.scoring;
  const P = ICX.power;

  const BACKENDS = ['game', 'api', 'fetch', 'dom'];

  function defaultSettings(hw) {
    return {
      level: P.defaultLevel(hw),
      backend: 'auto', // auto | game | api | fetch | dom
      autoResume: true, // reprise après rechargement de l'onglet
      cooldown: true, // pause de refroidissement en MAX
      reloadOnStop: false, // recharge le jeu à l'arrêt si l'inventaire n'a pas pu être mis à jour à chaud
      delayMs: {}, // surcharges de délai par niveau { eco: 1500, … }
      timeoutMs: 20000,
      maxRetries: 3,
      exploreThreshold: 0.06, // rendement global sous lequel on passe en exploration
      exploitThreshold: 0.25, // rendement au-dessus duquel on exploite
      weights: { ...DEFAULT_WEIGHTS },
      planner: { ...DEFAULT_SETTINGS },
      blacklist: [],
      whitelist: []
    };
  }

  class Engine {
    constructor() {
      this.hw = P.detectHardware();
      this.settings = defaultSettings(this.hw);
      this.store = new ICX.CacheStore();
      this.game = new ICX.GameAdapter();
      this.planner = new ICX.PlannerService();
      this.heap = new MaxHeap();
      this.aimd = new Aimd({ min: 1, max: 1, baseDelayMs: 1500, adaptive: false });
      this.guard = new P.PowerGuard({
        onBattery: (low) => {
          this.log(low ? 'Batterie < 30 % : passage automatique en NORMAL' : 'Batterie OK : niveau choisi rétabli');
          this.applyLevel();
        },
        onLag: (high) => this.onLag(high),
        onCooldown: () => this.log('Pause de refroidissement (10 s)')
      });
      this.pairs = new Map(); // clé -> { k, a, b, r, e, n, t, s }
      this.inflight = new Map(); // clé -> { ctrl, t }
      this.state = 'init'; // init | idle | running | paused
      this.backend = null;
      this.lastStart = 0;
      this.tickTimer = null;
      this.refilling = null;
      this.pendingAnchors = new Set();
      this.emptyRefills = 0;
      this.throttleSteps = 0;
      this.yieldEwma = 0.2;
      this.mode = 'balanced';
      this.completions = []; // horodatages pour req/s
      this.recent = []; // dernières découvertes
      this.logs = [];
      this.consecutiveErrors = 0;
      this.forbiddenStreak = 0;
      this.invalidStreak = 0;
      this.stats = {
        failsKnown: 0,
        sessionRequests: 0,
        sessionResults: 0,
        sessionNew: 0,
        sessionFirst: 0,
        sessionFails: 0,
        s429: 0,
        errors: 0,
        dropped: 0,
        external: 0
      };
    }

    get L() {
      return this._L;
    }

    get elements() {
      return this.planner.local.elements;
    }

    log(msg) {
      const line = new Date().toLocaleTimeString() + ' ' + msg;
      this.logs.unshift(line);
      if (this.logs.length > 50) this.logs.pop();
      console.info('[ICX]', msg);
    }

    // ------------------------------------------------------------------
    // Initialisation : cache + inventaire du jeu
    // ------------------------------------------------------------------
    async init() {
      const storageName = await this.store.open();
      this.storageName = storageName;
      const { pairs, elements, meta } = await this.store.loadAll();
      if (meta.settings) this.settings = this._mergeSettings(this.settings, meta.settings);

      const ready = await this.game.waitReady();
      if (!ready) this.log('Jeu non détecté : seuls les éléments de base seront utilisés');
      this.game.onCapture = (a, b, r) => this.onExternal(a, b, r);

      // 1) éléments mémorisés (statistiques du graphe)
      for (const e of elements) this.planner.upsertElement({ ...makeElement(e.text, e.emoji), ...e, owned: false });

      // 2) inventaire actuel du jeu : possédés, ordre = âge relatif
      const items = this.game.getItems();
      const byGameId = new Map();
      let born = 0;
      for (const e of this.elements.values()) born = Math.max(born, e.born || 0);
      items.forEach((it, i) => {
        if (!it || !it.text) return;
        byGameId.set(it.id, it);
        const id = pk.normName(it.text);
        const cur = this.elements.get(id);
        if (cur) this.planner.upsertElement({ ...cur, owned: true, text: it.text, emoji: it.emoji || cur.emoji });
        else this.planner.upsertElement(makeElement(it.text, it.emoji, undefined, born + i + 1));
      });
      for (const b of ICX.BASE_ELEMENTS) {
        const id = pk.normName(b.text);
        const cur = this.elements.get(id);
        this.planner.upsertElement(cur ? { ...cur, depth: 0, owned: true } : makeElement(b.text, b.emoji, 0, 0));
      }

      // 3a) parents (première recette connue) : sert à la pénalité « même famille »
      for (const it of items) {
        if (!Array.isArray(it.recipes) || !it.recipes.length) continue;
        const e = this.elements.get(pk.normName(it.text));
        const A = byGameId.get(it.recipes[0] && it.recipes[0][0]);
        const B = byGameId.get(it.recipes[0] && it.recipes[0][1]);
        if (e && A && B && !e.parents) e.parents = [pk.normName(A.text), pk.normName(B.text)];
      }

      // 3b) profondeurs à partir des recettes du jeu (relaxation type Bellman-Ford)
      this._computeDepths(items, byGameId);

      // 4) paires déjà connues : cache + recettes de la sauvegarde du jeu (jamais retestées)
      for (const p of pairs) {
        this.pairs.set(p.k, p);
        if (p.r == null) this.stats.failsKnown++;
      }
      let imported = 0;
      for (const it of items) {
        if (!Array.isArray(it.recipes)) continue;
        for (const rc of it.recipes) {
          const A = byGameId.get(rc && rc[0]);
          const B = byGameId.get(rc && rc[1]);
          if (!A || !B) continue;
          const k = pk.pairKey(A.text, B.text);
          if (this.pairs.has(k)) continue;
          const rec = { k, a: A.text, b: B.text, r: it.text, e: it.emoji || '', n: false, t: 0, s: 'game' };
          this.pairs.set(k, rec);
          this.store.queuePair(rec);
          imported++;
        }
      }
      for (const k of this.pairs.keys()) this.planner.markTested(k);
      if (imported) this.log(imported + ' recettes importées depuis la sauvegarde du jeu');

      this._applyPlannerConfig();
      await this.guard.start();
      this.applyLevel();
      this.state = 'idle';
      this.log(`Prêt : ${this.ownedCount()} éléments, ${this.pairs.size} paires connues (stockage : ${storageName})`);
      this._startUiTimer();

      addEventListener('pagehide', () => this.store.emergencySync());
      document.addEventListener('visibilitychange', () => document.hidden && this.store.flush());

      if (meta.running && this.settings.autoResume) {
        this.log('Reprise automatique après rechargement');
        this.start();
      }
    }

    _mergeSettings(base, saved) {
      return {
        ...base,
        ...saved,
        weights: { ...base.weights, ...(saved.weights || {}) },
        planner: { ...base.planner, ...(saved.planner || {}) },
        delayMs: { ...(saved.delayMs || {}) }
      };
    }

    _computeDepths(items, byGameId) {
      const depth = new Map();
      for (const b of ICX.BASE_ELEMENTS) depth.set(pk.normName(b.text), 0);
      const withRecipes = items.filter((it) => Array.isArray(it.recipes) && it.recipes.length);
      for (let pass = 0; pass < 30; pass++) {
        let changed = false;
        for (const it of withRecipes) {
          const id = pk.normName(it.text);
          for (const rc of it.recipes) {
            const A = byGameId.get(rc[0]);
            const B = byGameId.get(rc[1]);
            if (!A || !B) continue;
            const da = depth.get(pk.normName(A.text));
            const db = depth.get(pk.normName(B.text));
            if (da === undefined || db === undefined) continue;
            const d = Math.max(da, db) + 1;
            if (!(depth.get(id) <= d)) {
              depth.set(id, d);
              changed = true;
            }
          }
        }
        if (!changed) break;
      }
      for (const [id, d] of depth) {
        const e = this.elements.get(id);
        if (e && (e.depth === undefined || d < e.depth || e.depth === 3)) this.planner.upsertElement({ ...e, depth: d });
      }
    }

    ownedCount() {
      let n = 0;
      for (const e of this.elements.values()) if (e.owned !== false) n++;
      return n;
    }

    _applyPlannerConfig() {
      this.planner.setConfig({
        weights: this.settings.weights,
        settings: this.settings.planner,
        mode: this.mode,
        whitelist: this.settings.whitelist,
        blacklist: this.settings.blacklist
      });
    }

    // ------------------------------------------------------------------
    // Niveaux de puissance (changement à chaud, sans perte d'état)
    // ------------------------------------------------------------------
    effectiveLevelName() {
      const lvl = this.settings.level;
      if (this.guard.batteryLow && P.ORDER.indexOf(lvl) > P.ORDER.indexOf('normal')) return 'normal';
      return lvl;
    }

    applyLevel() {
      const L = P.effectiveLevel(this.effectiveLevelName(), this.hw, { delayMs: this.settings.delayMs }, this.throttleSteps);
      this._L = L;
      this.aimd.configure({ min: L.minConc, max: L.maxConc, baseDelayMs: L.delayMs, adaptive: L.adaptive });
      this.planner.setWorkerCount(L.workers);
      this.store.batchSize = L.batch;
      this.guard.cooldownEnabled = !!this.settings.cooldown;
      this._startUiTimer();
      // borne la file au nouveau lookahead
      if (this.heap.size > L.lookahead * 2) for (const r of this.heap.trimTo(L.lookahead)) this.planner.unreserve(r.key);
    }

    onLag(high) {
      if (high) {
        if (this.throttleSteps < 11) this.throttleSteps++;
        this.aimd.stepDown();
        this.planner.suspendOne();
        this.log(`Retard de boucle soutenu (${Math.round(this.guard.lagMs)} ms) : concurrence −1, un worker suspendu`);
      } else if (this.throttleSteps > 0) {
        this.throttleSteps--;
        this.planner.resumeOne();
        this.log('Charge CPU normale : un cran de concurrence rétabli');
      }
      this.applyLevel();
    }

    // ------------------------------------------------------------------
    // Contrôles
    // ------------------------------------------------------------------
    resolveBackend() {
      const want = this.settings.backend;
      const caps = this.game.capabilities();
      const ok = { game: caps.icCraft && caps.craftApi, api: caps.craftApi, fetch: true, dom: caps.vue };
      if (want !== 'auto' && ok[want]) return want;
      if (want !== 'auto') this.log(`Backend « ${want} » indisponible, sélection automatique`);
      return BACKENDS.find((b) => ok[b] && b !== 'dom') || 'fetch';
    }

    start() {
      if (this.state === 'running' || this.state === 'init') return;
      // un arrêt encore en cours d'écriture : on relance juste après lui
      if (this.stopping) {
        this.stopping.then(() => this.start());
        return;
      }
      const now = Date.now();
      this.backend = this.resolveBackend();
      // relance propre : on oublie le backoff et les compteurs transitoires de la
      // session précédente (sinon un délai gonflé par des 429 anciens ralentissait tout)
      this.aimd.resetTransient(now);
      this.guard.resetCooldown(now);
      this.consecutiveErrors = this.forbiddenStreak = this.invalidStreak = 0;
      this.emptyRefills = 0;
      this.lastStart = 0;
      this.state = 'running';
      this.store.setMeta('running', true);
      this.store.flush();
      this.log(`Démarrage — niveau ${this.L.label}, méthode ${this.backend}` + (this.focus ? `, One object : ${this.focus.text}` : ''));
      this.scheduleTick(0);
    }

    pause() {
      if (this.state !== 'running') return;
      this.state = 'paused';
      ICX.clock.clear(this.tickTimer);
      this.store.setMeta('running', false);
      this.store.flush();
      this.log('Pause (les requêtes en cours se terminent)');
    }

    /** Arrêt instantané : annule les requêtes en vol, vide la file, sauvegarde. */
    async stop() {
      if (this.state === 'init') return;
      if (this.stopping) return this.stopping;
      this.state = 'idle';
      ICX.clock.clear(this.tickTimer);
      for (const { ctrl } of this.inflight.values()) ctrl.abort();
      this.inflight.clear(); // les réponses tardives seront quand même mémorisées (onExternal)
      this._clearQueue();
      // pendingAnchors est conservé : à la relance, les nouveaux éléments restent prioritaires
      this.store.setMeta('running', false);
      this.stopping = (async () => {
        try {
          // les instances temporaires encore en fusion sont retirées par le jeu dès
          // la fin de leur fusion (voir craftGame) : rien à arracher ici
          await Promise.all([this.store.flush(), this.game.flushMaterialize()]);
          this.log('Arrêté, progression sauvegardée');
        } finally {
          this.stopping = null;
        }
      })();
      await this.stopping;
      if (this.state === 'idle' && this.game.needsReload && this.settings.reloadOnStop) this.game.reloadGame();
    }

    _clearQueue() {
      for (const c of this.heap.toArray()) this.planner.unreserve(c.key);
      this.heap.clear();
    }

    // ------------------------------------------------------------------
    // Mode « One object » : un objet choisi fusionné avec chaque élément possédé
    // ------------------------------------------------------------------
    startFocus(text, thenExplore) {
      if (this.state === 'init') throw new Error('moteur pas encore prêt');
      const id = pk.normName(text);
      const e = this.elements.get(id);
      if (!e || e.owned === false) throw new Error('élément non possédé : ' + text);
      this._clearQueue();
      this.focus = {
        id,
        text: e.text,
        emoji: e.emoji,
        thenExplore: !!thenExplore,
        startedAt: Date.now(),
        requests: 0,
        newCount: 0,
        firstCount: 0,
        fails: 0,
        found: []
      };
      this.log(`One object : ${e.text} × chaque élément possédé`);
      if (this.state === 'running') this.scheduleTick(0);
      else this.start();
    }

    cancelFocus() {
      if (!this.focus) return;
      this.log(`One object annulé (${this.focus.text})`);
      this.lastFocus = { ...this.focusSnapshot(), cancelled: true };
      this.focus = null;
      this._clearQueue();
      if (this.state === 'running') this.scheduleTick(0);
    }

    _finishFocus() {
      const f = this.focusSnapshot();
      this.log(`One object terminé : ${f.text} fusionné avec ${f.done} éléments → ${f.newCount} nouveaux, ${f.firstCount} premières découvertes`);
      this.lastFocus = { ...f, finished: true };
      const then = this.focus.thenExplore;
      this.focus = null;
      if (then) this.scheduleTick(0);
      else this.stop();
    }

    /** Progression : partenaires éligibles déjà fusionnés avec l'objet / total. */
    focusSnapshot() {
      const f = this.focus;
      if (!f) return null;
      const pl = this.planner.local;
      let total = 0;
      let done = 0;
      for (const e of this.elements.values()) {
        if (e.id !== f.id && pl.isExcluded(e)) continue;
        total++;
        if (this.pairs.has(pk.pairKey(f.text, e.text))) done++;
      }
      return { text: f.text, emoji: f.emoji, done, total, requests: f.requests, newCount: f.newCount, firstCount: f.firstCount, fails: f.fails, thenExplore: f.thenExplore, found: f.found.slice(0, 30) };
    }

    /** Recherche d'éléments possédés (sélecteur du side panel). */
    searchElements(q, limit = 40) {
      const n = pk.normName(q || '');
      const exact = [];
      const prefix = [];
      const contains = [];
      for (const e of this.elements.values()) {
        if (e.owned === false) continue;
        if (!n) prefix.push(e);
        else if (e.id === n) exact.push(e);
        else if (e.id.startsWith(n)) prefix.push(e);
        else if (e.id.includes(n)) contains.push(e);
        if (!n && prefix.length >= limit) break;
      }
      const byLen = (a, b) => a.text.length - b.text.length;
      return exact
        .concat(prefix.sort(byLen), contains.sort(byLen))
        .slice(0, limit)
        .map((e) => ({ text: e.text, emoji: e.emoji }));
    }

    setLevel(level) {
      if (!P.LEVELS[level]) throw new Error('niveau inconnu');
      this.settings.level = level;
      this.store.setMeta('settings', this.settings);
      this.applyLevel();
      this.log('Niveau : ' + this.L.label + (this.L.name !== level ? ' (forcé par la batterie)' : ''));
    }

    setSettings(partial) {
      this.settings = this._mergeSettings(this.settings, partial);
      this.store.setMeta('settings', this.settings);
      this.store.flush();
      this._applyPlannerConfig();
      // listes modifiées : les candidats en file sont recalculés
      for (const c of this.heap.toArray()) this.planner.unreserve(c.key);
      this.heap.clear();
      if (partial.backend && this.state === 'running') this.backend = this.resolveBackend();
      this.applyLevel();
    }

    // ------------------------------------------------------------------
    // Boucle
    // ------------------------------------------------------------------
    scheduleTick(ms) {
      ICX.clock.clear(this.tickTimer);
      this.tickTimer = ICX.clock.set(() => this.tick(), ms);
    }

    tick() {
      if (this.state !== 'running') return;
      const now = Date.now();
      if (this.guard.cooling(now, this.L.name)) return this.scheduleTick(Math.max(250, this.guard.coolingUntil - now));
      if (this.inflight.size >= this.aimd.limit) return; // une fin de requête relancera le tick
      const wait = this.aimd.waitMs(now, this.lastStart);
      if (wait > 0) return this.scheduleTick(wait);

      if (this.heap.size < this.L.lookahead / 2 || (!this.focus && this.pendingAnchors.size)) this.refill();
      // Rythme par jetons : si le timer s'est réveillé en retard (onglet en arrière-plan,
      // où Chrome regroupe les timers à 1 réveil/s), on rattrape en lançant plusieurs
      // requêtes d'un coup, sans jamais dépasser la concurrence autorisée.
      const d = Math.max(1, this.aimd.delayMs);
      const slots = this.aimd.limit - this.inflight.size;
      // pas de rafale juste après un 429 : on repart une requête à la fois
      const recent429 = now - this.aimd.lastDecrease < 10000;
      const burst = recent429 ? 1 : Math.min(slots, Math.max(1, Math.floor((now - this.lastStart) / d)));
      let launched = 0;
      while (launched < burst) {
        const c = this.popBest();
        if (!c) break;
        this.launch(c);
        launched++;
      }
      if (launched) {
        this.lastStart = now;
        return this.scheduleTick(this.aimd.delayMs > 0 ? this.aimd.delayMs : 0);
      }
      // file vide : on attend la génération en cours (ou on en lance une)
      (this.refilling || this.refill()).then((added) => {
        if (this.state !== 'running') return;
        if (added > 0 || this.heap.size > 0) {
          this.emptyRefills = 0;
          return this.scheduleTick(0);
        }
        // une requête en vol peut encore créer un élément : sa fin relancera le tick
        if (this.inflight.size > 0) return;
        // file et requêtes en vol vides : toute réservation restante est périmée
        // (filet de sécurité) → on la libère et on régénère avant de conclure
        if (this.planner.local.reserved.size) {
          this.planner.releaseAll();
          return this.scheduleTick(0);
        }
        if (this.focus) return this._finishFocus();
        // ancres en partie aléatoires : on insiste un peu avant de conclure
        if (++this.emptyRefills < 3) return this.scheduleTick(200);
        this.log('Plus aucune paire candidate : exploration terminée pour les éléments autorisés');
        this.stop();
      });
    }

    /** Dépile la meilleure paire avec re-scoring paresseux (stats à jour). */
    popBest() {
      const pl = this.planner.local;
      for (let guard = 0; guard < 256 && this.heap.size; guard++) {
        const c = this.heap.pop();
        if (this.pairs.has(c.key) || this.inflight.has(c.key)) continue;
        const ea = this.elements.get(pk.normName(c.a));
        const eb = this.elements.get(pk.normName(c.b));
        const inFocus = this.focus && ((ea && ea.id === this.focus.id) || (eb && eb.id === this.focus.id));
        if (this.focus && !inFocus) {
          this.planner.unreserve(c.key); // reste d'une file précédente
          continue;
        }
        if (inFocus) return c; // ordre déjà fixé par la valeur du partenaire
        const s = pl.pairScore(ea, eb);
        if (s === -Infinity) {
          this.planner.unreserve(c.key);
          continue;
        }
        const top = this.heap.peek();
        if (top && s < top.score - 0.05 && (c.rescored || 0) < 2) {
          c.score = s;
          c.rescored = (c.rescored || 0) + 1;
          this.heap.push(c);
          continue;
        }
        return c;
      }
      return null;
    }

    /** Alimente la file : ancres = nouveaux éléments en priorité, sinon sélection générale. */
    refill() {
      if (this.refilling) return this.refilling;
      const L = this.L;
      let opts;
      if (this.focus) {
        // tous les partenaires, meilleurs d'abord, sans limite de parcours
        opts = { anchors: [this.focus.id], forceAnchors: true, perAnchor: L.lookahead, limit: L.lookahead, maxScan: Infinity };
      } else if (this.pendingAnchors.size) {
        const anchors = [...this.pendingAnchors];
        this.pendingAnchors.clear();
        opts = { anchors, perAnchor: Math.max(24, Math.floor(L.lookahead / Math.max(4, anchors.length))), limit: L.lookahead };
      } else {
        const anchorCount = Math.min(64, Math.max(8, Math.round(L.lookahead / 32)));
        opts = { anchorCount, perAnchor: Math.ceil(L.lookahead / anchorCount), limit: L.lookahead };
      }
      this.refilling = Promise.resolve(this.planner.generate(opts))
        .then((list) => {
          const reserved = this.planner.local.reserved;
          let added = 0;
          for (const c of list) {
            if (this.pairs.has(c.key) || reserved.has(c.key) || this.inflight.has(c.key)) continue;
            this.planner.reserve(c.key);
            this.heap.push(c);
            added++;
          }
          if (this.heap.size > L.lookahead * 2) for (const r of this.heap.trimTo(L.lookahead)) this.planner.unreserve(r.key);
          return added;
        })
        .catch((err) => {
          this.log('Erreur de génération : ' + err.message);
          return 0;
        })
        .finally(() => {
          this.refilling = null;
        });
      return this.refilling;
    }

    launch(c) {
      const ctrl = new AbortController();
      this.inflight.set(c.key, { ctrl, t: Date.now() });
      this.stats.sessionRequests++;
      this.game
        .craft(this.backend, c.a, c.b, { signal: ctrl.signal, timeoutMs: this.settings.timeoutMs })
        .then((r) => this.onResult(c, r))
        .catch((err) => this.onError(c, err))
        .finally(() => {
          this.inflight.delete(c.key);
          if (this.state === 'running') this.scheduleTick(0);
        });
    }

    // ------------------------------------------------------------------
    // Résultats
    // ------------------------------------------------------------------
    onResult(c, r) {
      this.aimd.onSuccess();
      this.consecutiveErrors = this.forbiddenStreak = this.invalidStreak = 0;
      this.completions.push(Date.now());
      // game / dom : le jeu ajoute lui-même l'élément ; api / fetch : c'est à nous
      this.record(c.a, c.b, r, this.backend === 'api' || this.backend === 'fetch' || !!r.needMaterialize);
    }

    /** Fusion faite à la main par le joueur (vue via craftApi) : donnée gratuite. */
    onExternal(a, b, raw) {
      const key = pk.pairKey(a, b);
      if (this.pairs.has(key) || this.inflight.has(key) || this.state === 'init') return;
      const r = ICX.normalizeResult(raw);
      if (!r) return;
      this.stats.external++;
      this.record(a, b, r, false);
    }

    /** Mémorise la paire et met à jour le graphe. */
    record(a, b, r, materialize) {
      const key = pk.pairKey(a, b);
      if (this.pairs.has(key)) return;
      const now = Date.now();
      const rec = { k: key, a, b, r: r.nothing ? null : r.text, e: r.emoji || '', n: !!r.isNew, t: now };
      this.pairs.set(key, rec);
      this.store.queuePair(rec);
      this.planner.markTested(key);
      this.stats.sessionResults++;

      const ea = this.elements.get(pk.normName(a));
      const eb = this.elements.get(pk.normName(b));
      const parents = ea === eb ? [ea] : [ea, eb];
      const rid = r.nothing ? null : pk.normName(r.text);
      const existing = rid ? this.elements.get(rid) : null;
      const isNewForUs = !!rid && (!existing || existing.owned === false) && rid !== ea?.id && rid !== eb?.id;
      const reward = isNewForUs ? 1 : 0;

      for (const p of parents) {
        if (!p) continue;
        p.tried++;
        if (r.nothing) p.fails++;
        if (isNewForUs) p.produced++;
        if (isNewForUs && r.isNew) p.firsts++;
        p.recent = p.recent * 0.85 + reward * 0.15;
      }
      if (r.nothing) {
        this.stats.failsKnown++;
        this.stats.sessionFails++;
      }

      const parentDepth = Math.max(ea ? ea.depth : 3, eb ? eb.depth : 3) + 1;
      if (isNewForUs) {
        const seq = this.planner.local.seq + 1;
        const el = existing ? { ...existing, owned: true, born: seq, depth: Math.min(existing.depth, parentDepth) } : makeElement(r.text, r.emoji, parentDepth, seq);
        if (!el.parents && ea && eb) el.parents = [ea.id, eb.id];
        this.planner.upsertElement(el);
        this.store.queueElement(this.elements.get(rid));
        this.pendingAnchors.add(rid); // génération incrémentale de ses paires
        this.stats.sessionNew++;
        if (r.isNew) this.stats.sessionFirst++;
        this.recent.unshift({ text: r.text, emoji: r.emoji, isNew: !!r.isNew, a, b, t: now });
        if (this.recent.length > 30) this.recent.pop();
        if (materialize) this.game.queueMaterialize({ text: r.text, emoji: r.emoji, isNew: r.isNew, parentA: a, parentB: b });
        // One object : le nouvel élément doit lui aussi être fusionné avec l'objet
        if (this.focus && rid !== this.focus.id) {
          const fk = pk.pairKey(this.focus.text, r.text);
          if (!this.pairs.has(fk) && !this.planner.local.reserved.has(fk)) {
            const [fa, fb] = pk.orderPair(this.focus.text, r.text);
            this.planner.reserve(fk);
            this.heap.push({ a: fa, b: fb, key: fk, score: 1e6 });
          }
        }
      } else if (existing && existing.depth > parentDepth) {
        this.planner.upsertElement({ ...existing, depth: parentDepth });
        this.store.queueElement(this.elements.get(rid));
      }
      for (const p of parents) if (p) (this.planner.upsertElement(p), this.store.queueElement(p));

      const f = this.focus;
      if (f && ((ea && ea.id === f.id) || (eb && eb.id === f.id))) {
        f.requests++;
        if (r.nothing) f.fails++;
        if (isNewForUs) {
          f.newCount++;
          if (r.isNew) f.firstCount++;
          const partner = ea && ea.id === f.id ? b : a;
          f.found.unshift({ partner, text: r.text, emoji: r.emoji, isNew: !!r.isNew });
          if (f.found.length > 50) f.found.pop();
        }
      }

      this._updateMode(reward);
    }

    /** Détection de saturation globale → bascule exploration / exploitation. */
    _updateMode(reward) {
      this.yieldEwma = this.yieldEwma * 0.97 + reward * 0.03;
      if (this.stats.sessionResults < 30) return;
      const s = this.settings;
      let mode = this.mode;
      if (this.yieldEwma < s.exploreThreshold) mode = 'explore';
      else if (this.yieldEwma > s.exploitThreshold) mode = 'exploit';
      else if (this.yieldEwma > s.exploreThreshold * 1.5 && this.yieldEwma < s.exploitThreshold * 0.8) mode = 'balanced';
      if (mode !== this.mode) {
        this.mode = mode;
        this.planner.setConfig({ mode });
        this.log(`Mode ${mode} (rendement récent ${(this.yieldEwma * 100).toFixed(1)} %)`);
      }
    }

    onError(c, err) {
      const now = Date.now();
      const kind = (err && err.kind) || 'network';
      const requeue = (penalty) => {
        c.score -= penalty;
        this.heap.push(c);
      };
      if (kind === 'aborted') {
        if (this.state !== 'idle') requeue(0);
        else this.planner.unreserve(c.key);
        return;
      }
      this.consecutiveErrors++;
      if (kind === 'rate') {
        this.stats.s429++;
        this.aimd.onRateLimit(now, err.retryAfterMs);
        requeue(0);
      } else if (kind === 'forbidden' || kind === 'unsupported' || kind === 'invalid') {
        this.stats.errors++;
        this.aimd.onError(now);
        if (kind === 'forbidden') this.forbiddenStreak++;
        else this.invalidStreak++;
        c.attempts = (c.attempts || 0) + 1;
        if (this.forbiddenStreak >= 3 || this.invalidStreak >= 8 || kind === 'unsupported') this._fallbackBackend(err);
        if (c.attempts <= this.settings.maxRetries) requeue(0.05);
        else this._drop(c);
      } else {
        // timeout / réseau / 5xx : reprise automatique avec backoff via AIMD
        this.stats.errors++;
        this.aimd.onError(now);
        c.attempts = (c.attempts || 0) + 1;
        if (c.attempts <= this.settings.maxRetries) requeue(0.1);
        else this._drop(c);
      }
      if (this.consecutiveErrors >= 20) {
        this.aimd.pausedUntil = now + 30000;
        this.consecutiveErrors = 0;
        this.log('20 erreurs consécutives : pause automatique de 30 s');
      }
      if (this.stats.errors % 10 === 1) this.log(`Erreur ${kind} : ${err.message}`);
    }

    _drop(c) {
      this.stats.dropped++;
      this.planner.unreserve(c.key);
    }

    _fallbackBackend(err) {
      const caps = this.game.capabilities();
      const ok = { game: caps.icCraft && caps.craftApi, api: caps.craftApi, fetch: true, dom: caps.vue };
      const i = BACKENDS.indexOf(this.backend);
      const next = BACKENDS.slice(i + 1).find((b) => ok[b]);
      this.forbiddenStreak = this.invalidStreak = 0;
      if (!next) {
        this.log('Aucun backend fonctionnel (' + err.message + ') : pause');
        this.pause();
        return;
      }
      this.log(`Backend ${this.backend} en échec (${err.message}) → ${next}`);
      this.backend = next;
    }

    // ------------------------------------------------------------------
    // Import / export du cache complet
    // ------------------------------------------------------------------
    async exportCache() {
      await this.store.flush();
      return JSON.stringify({
        format: 'icx-cache',
        version: 1,
        exportedAt: new Date().toISOString(),
        pairs: [...this.pairs.values()],
        elements: [...this.elements.values()],
        lists: { blacklist: this.settings.blacklist, whitelist: this.settings.whitelist }
      });
    }

    async importCache(json) {
      const data = typeof json === 'string' ? JSON.parse(json) : json;
      if (!data || data.format !== 'icx-cache' || !Array.isArray(data.pairs)) throw new Error('fichier non reconnu (format icx-cache attendu)');
      let addedPairs = 0;
      let addedElements = 0;
      for (const p of data.pairs) {
        if (!p || typeof p.k !== 'string' || this.pairs.has(p.k)) continue;
        try {
          pk.splitPairKey(p.k);
        } catch (_) {
          continue;
        }
        const rec = { k: p.k, a: p.a, b: p.b, r: p.r ?? null, e: p.e || '', n: !!p.n, t: p.t || 0, s: p.s || 'import' };
        this.pairs.set(rec.k, rec);
        this.store.queuePair(rec);
        this.planner.markTested(rec.k);
        if (rec.r == null) this.stats.failsKnown++;
        addedPairs++;
      }
      for (const e of data.elements || []) {
        if (!e || !e.text) continue;
        const id = pk.normName(e.text);
        const cur = this.elements.get(id);
        if (cur) continue;
        // statistiques conservées, mais non possédé tant que le jeu ne l'a pas
        this.planner.upsertElement({ ...makeElement(e.text, e.emoji, e.depth, e.born), ...e, id, owned: false });
        this.store.queueElement(this.elements.get(id));
        addedElements++;
      }
      if (data.lists) {
        const merge = (a, b) => [...new Set([...(a || []), ...(b || [])])];
        this.setSettings({ blacklist: merge(this.settings.blacklist, data.lists.blacklist), whitelist: merge(this.settings.whitelist, data.lists.whitelist) });
      }
      await this.store.flush();
      this.log(`Import : ${addedPairs} paires, ${addedElements} éléments`);
      return { addedPairs, addedElements };
    }

    async clearCache() {
      await this.stop();
      await this.store.clear();
      this.pairs.clear();
      this.stats.failsKnown = 0;
      this.log('Cache effacé : rechargement de la page pour repartir de l’inventaire du jeu');
      setTimeout(() => location.reload(), 300);
    }

    // ------------------------------------------------------------------
    // Statistiques (throttlées selon le niveau)
    // ------------------------------------------------------------------
    snapshot() {
      const now = Date.now();
      while (this.completions.length && this.completions[0] < now - 10000) this.completions.shift();
      const b = this.guard.battery;
      return {
        state: this.state,
        level: this.settings.level,
        effectiveLevel: this.L ? this.L.name : null,
        levelInfo: this.L,
        backend: this.backend || this.settings.backend,
        owned: this.ownedCount(),
        pairsTested: this.pairs.size,
        failsKnown: this.stats.failsKnown,
        ...this.stats,
        rps: this.completions.length / 10,
        concurrency: this.aimd.limit,
        delayMs: Math.round(this.aimd.delayMs),
        inflight: this.inflight.size,
        queue: this.heap.size,
        mode: this.mode,
        yieldPct: this.yieldEwma * 100,
        lagMs: Math.round(this.guard.lagMs),
        throttleSteps: this.throttleSteps,
        workers: this.planner.activeWorkers,
        workerError: this.planner.workerError,
        battery: b ? { level: b.level, charging: b.charging } : null,
        cooling: now < this.guard.coolingUntil,
        recent: this.recent.slice(0, 20),
        focus: this.focusSnapshot(),
        lastFocus: this.lastFocus || null,
        logs: this.logs.slice(0, 12),
        storage: this.storageName,
        storeError: this.store.lastError,
        needsReload: this.game.needsReload,
        materializeError: this.game.lastMaterializeError,
        caps: this.game.capabilities(),
        hw: this.hw
      };
    }

    _startUiTimer() {
      const hz = this.L ? this.L.uiHz : 2;
      if (this.uiHz === hz && this.uiTimer) return;
      this.uiHz = hz;
      clearInterval(this.uiTimer);
      this.uiTimer = setInterval(() => ICX.bridge.emit('stats', this.snapshot()), Math.round(1000 / hz));
    }
  }

  ICX.Engine = Engine;
})();
