/**
 * Cœur algorithmique : valeur des éléments (bandit) et génération de paires
 * candidates. Partagé entre le thread principal et les Web Workers.
 *
 * Idée : le score d'une paire se décompose presque entièrement en une valeur
 * par élément (rendement bandit + fraîcheur + profondeur − pénalités). Pour un
 * élément « ancre », les meilleurs partenaires sont donc simplement les éléments
 * de plus forte valeur, qu'on parcourt dans l'ordre en sautant les paires déjà
 * testées. Cela évite de matérialiser l'espace N(N+1)/2.
 */
(function (root, factory) {
  const pk = typeof module === 'object' && module.exports ? require('./pairkey.js') : root.ICX.pairkey;
  const api = factory(pk);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.ICX = root.ICX || {};
    root.ICX.scoring = api;
  }
})(typeof self !== 'undefined' ? self : globalThis, function (pk) {
  'use strict';

  /** Poids par défaut (tous réglables dans l'interface). */
  const DEFAULT_WEIGHTS = {
    yield: 1.0, // rendement bandit (UCB1 ou Thompson)
    explorationC: 0.5, // constante d'exploration UCB1
    fresh: 0.8, // fraîcheur (éléments récemment découverts)
    freshTau: 60, // demi-vie de fraîcheur, en nombre de découvertes
    depth: 0.35, // bonus faible profondeur
    dead: 1.5, // pénalité éléments « morts »
    length: 0.5, // pénalité noms longs / très spécifiques
    saturation: 0.6, // pénalité éléments saturés
    fertile: 0.6, // bonus zones fertiles (isNew, bon rendement récent)
    whitelist: 3.0, // bonus liste blanche
    selfPair: 0.05, // léger bonus auto-fusion
    family: 0.3, // pénalité : élément × l'un de ses propres ingrédients (redonne souvent du connu)
    noise: 0.08 // bruit aléatoire (anti-boucle déterministe)
  };

  const DEFAULT_SETTINGS = {
    bandit: 'ucb', // 'ucb' | 'thompson'
    deadMinTries: 15, // essais sans résultat avant d'être « mort »
    saturationMinTries: 10,
    saturationThreshold: 0.04, // rendement récent (EWMA) sous lequel l'élément est saturé
    maxNameLength: 30, // au-delà, le serveur renvoie toujours "Nothing" (observé sur la réimplémentation communautaire)
    longNameSoft: 18, // pénalité progressive au-delà de 18 caractères
    maxScanPerAnchor: 4000 // borne de parcours par ancre
  };

  /** Mulberry32 : PRNG rapide et déterministe si on fournit une graine. */
  function rng(seed) {
    let s = seed >>> 0 || (Math.random() * 2 ** 32) >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Tirage Gamma(k,1) (Marsaglia-Tsang), pour Thompson sampling. */
  function gamma(k, rand) {
    if (k < 1) return gamma(k + 1, rand) * Math.pow(rand(), 1 / k);
    const d = k - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x, v;
      do {
        // Box-Muller
        x = Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = rand();
      if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  function betaSample(a, b, rand) {
    const x = gamma(a, rand);
    const y = gamma(b, rand);
    return x / (x + y);
  }

  /**
   * Crée un enregistrement d'élément avec toutes les statistiques du graphe.
   * `id` = nom normalisé ; `text` = nom affiché tel que renvoyé par le jeu.
   */
  function makeElement(text, emoji, depth, born) {
    return {
      id: pk.normName(text),
      text,
      emoji: emoji || '',
      depth: depth ?? 3,
      born: born ?? 0,
      tried: 0, // paires testées impliquant l'élément
      produced: 0, // résultats nouveaux (pour nous) produits
      firsts: 0, // premières découvertes mondiales (isNew)
      fails: 0, // "Nothing"
      recent: 0.25, // EWMA du rendement récent (a priori optimiste)
      pairsDone: 0, // paires connues impliquant l'élément (testées + importées)
      owned: true // possédé dans la sauvegarde courante du jeu
    };
  }

  class Planner {
    constructor(opts = {}) {
      this.elements = new Map(); // id -> élément
      this.tested = new Set(); // clés de paires connues
      this.reserved = new Set(); // clés déjà en file côté moteur
      this.seq = 0; // compteur de découvertes (âge relatif)
      this.mode = 'balanced'; // 'explore' | 'balanced' | 'exploit'
      this.whitelist = new Set();
      this.blacklist = new Set();
      this.weights = { ...DEFAULT_WEIGHTS };
      this.settings = { ...DEFAULT_SETTINGS };
      this.rand = rng(opts.seed);
      this.setConfig(opts);
    }

    setConfig(c = {}) {
      if (c.weights) Object.assign(this.weights, c.weights);
      if (c.settings) Object.assign(this.settings, c.settings);
      if (c.mode) this.mode = c.mode;
      if (c.whitelist) this.whitelist = new Set(c.whitelist.map(pk.normName));
      if (c.blacklist) this.blacklist = new Set(c.blacklist.map(pk.normName));
    }

    upsertElement(rec) {
      const cur = this.elements.get(rec.id);
      if (cur) Object.assign(cur, rec);
      else this.elements.set(rec.id, { ...rec });
      if (rec.born > this.seq) this.seq = rec.born;
    }

    /** Enregistre une paire connue et met à jour le compteur pairsDone. */
    markTested(key) {
      if (this.tested.has(key)) return;
      this.tested.add(key);
      this.reserved.delete(key);
      const [a, b] = pk.splitPairKey(key);
      const ea = this.elements.get(a);
      if (ea) ea.pairsDone++;
      if (b !== a) {
        const eb = this.elements.get(b);
        if (eb) eb.pairsDone++;
      }
    }

    reserve(key) {
      this.reserved.add(key);
    }

    unreserve(key) {
      this.reserved.delete(key);
    }

    /** Élément exclu de toute paire (liste noire, nom trop long). */
    isExcluded(e) {
      return e.owned === false || this.blacklist.has(e.id) || e.text.length > this.settings.maxNameLength;
    }

    /** Valeur intrinsèque d'un élément (indépendante du partenaire). */
    elementValue(e) {
      const w = this.weights;
      const s = this.settings;
      const T = this.tested.size + 2;
      const n = e.tried;

      // Réglage des poids selon le mode (détection de saturation globale)
      let C = w.explorationC;
      let fresh = w.fresh;
      let fert = w.fertile;
      if (this.mode === 'explore') {
        C *= 1.8;
        fresh *= 1.2;
      } else if (this.mode === 'exploit') {
        C *= 0.5;
        fert *= 2;
      }

      // 1) Bandit : taux de nouveaux résultats avec a priori Beta(1,1)
      let banditScore;
      if (s.bandit === 'thompson') {
        banditScore = betaSample(e.produced + 1, Math.max(0, n - e.produced) + 1, this.rand);
      } else {
        const mean = (e.produced + 1) / (n + 2);
        banditScore = mean + C * Math.sqrt(Math.log(T) / (n + 1));
      }

      // 2) Fraîcheur : exp(-âge / tau), âge mesuré en découvertes
      const age = Math.max(0, this.seq - e.born);
      const freshness = Math.exp(-age / w.freshTau);

      // 3) Faible profondeur
      const depthScore = 1 / (1 + Math.max(0, e.depth));

      // 4) Pénalités
      const dead = n >= s.deadMinTries && e.produced === 0 ? 1 : 0;
      const words = e.text.split(' ').length;
      const lengthPenalty = Math.max(0, e.text.length - s.longNameSoft) / 12 + Math.max(0, words - 3) * 0.25;
      const saturated = n >= s.saturationMinTries && e.recent < s.saturationThreshold ? 1 : 0;

      // 5) Bonus zones fertiles
      const fertile = Math.min(1, e.firsts * 0.5 + e.recent * 2);

      let v =
        w.yield * banditScore +
        fresh * freshness +
        w.depth * depthScore -
        w.dead * dead -
        w.length * lengthPenalty -
        w.saturation * saturated +
        fert * fertile;
      if (this.whitelist.has(e.id)) v += w.whitelist;
      return v;
    }

    /** Score d'une paire à partir des valeurs des deux éléments. */
    pairScoreFromValues(va, vb, self) {
      return 0.5 * (va + vb) + (self ? this.weights.selfPair : 0) + this.rand() * this.weights.noise;
    }

    /** Vrai si l'un des deux éléments est un ingrédient direct de l'autre. */
    related(ea, eb) {
      return !!((ea.parents && ea.parents.includes(eb.id)) || (eb.parents && eb.parents.includes(ea.id)));
    }

    pairScore(ea, eb) {
      if (!ea || !eb || this.isExcluded(ea) || this.isExcluded(eb)) return -Infinity;
      return this.pairScoreFromValues(this.elementValue(ea), this.elementValue(eb), ea.id === eb.id) - (this.related(ea, eb) ? this.weights.family : 0);
    }

    /**
     * Génère des paires candidates.
     * @param {object} o
     * @param {string[]} [o.anchors] ids d'ancres imposées (ex. nouvel élément)
     * @param {number} [o.anchorCount=32] nb d'ancres si non imposées
     * @param {number} [o.perAnchor=64]  paires max par ancre
     * @param {number} [o.limit=2000]    paires max au total
     * @param {boolean} [o.forceAnchors] ancres utilisées même exclues / « épuisées » (One object)
     * @param {number} [o.maxScan]       borne de parcours par ancre (Infinity = tous les partenaires)
     * @returns {{a:string,b:string,key:string,score:number}[]}
     */
    generate(o = {}) {
      const perAnchor = o.perAnchor ?? 64;
      const limit = o.limit ?? 2000;
      const maxScan = o.maxScan ?? this.settings.maxScanPerAnchor;

      // Classement de tous les éléments éligibles par valeur décroissante
      const ranked = [];
      for (const e of this.elements.values()) {
        if (this.isExcluded(e)) continue;
        ranked.push({ e, v: this.elementValue(e) });
      }
      if (ranked.length === 0) return [];
      ranked.sort((x, y) => y.v - x.v);
      const valueOf = new Map(ranked.map((r) => [r.e.id, r.v]));
      const N = ranked.length;
      const exhausted = (e) => e.pairsDone >= N;

      // Choix des ancres
      const anchors = [];
      const seen = new Set();
      const addAnchor = (e) => {
        if (!e || seen.has(e.id)) return;
        if (!o.forceAnchors && (this.isExcluded(e) || exhausted(e))) return;
        seen.add(e.id);
        anchors.push(e);
      };
      if (o.anchors && o.anchors.length) {
        for (const id of o.anchors) addAnchor(this.elements.get(id));
      } else {
        const count = o.anchorCount ?? 32;
        // (a) frontière : les plus récents d'abord
        const byBorn = ranked.map((r) => r.e).sort((x, y) => y.born - x.born);
        for (let i = 0; i < byBorn.length && anchors.length < Math.ceil(count * 0.4); i++) addAnchor(byBorn[i]);
        // (b) liste blanche
        for (const id of this.whitelist) addAnchor(this.elements.get(id));
        // (c) meilleures valeurs (exploitation)
        for (let i = 0; i < N && anchors.length < Math.ceil(count * 0.8); i++) addAnchor(ranked[i].e);
        // (d) un peu d'aléatoire (exploration)
        for (let tries = 0; tries < count * 4 && anchors.length < count; tries++) {
          addAnchor(ranked[Math.floor(this.rand() * N)].e);
        }
      }

      // Parcours des partenaires par valeur décroissante
      const out = [];
      const emitted = new Set();
      for (const anc of anchors) {
        if (out.length >= limit) break;
        const va = valueOf.has(anc.id) ? valueOf.get(anc.id) : this.elementValue(anc);
        let taken = 0;
        let scanned = 0;
        for (let i = 0; i < N && taken < perAnchor && scanned < maxScan; i++) {
          const p = ranked[i].e;
          scanned++;
          const key = pk.pairKey(anc.text, p.text);
          if (this.tested.has(key) || this.reserved.has(key) || emitted.has(key)) continue;
          emitted.add(key);
          const [a, b] = pk.orderPair(anc.text, p.text);
          const fam = this.related(anc, p) ? this.weights.family : 0;
          out.push({ a, b, key, score: this.pairScoreFromValues(va, ranked[i].v, anc.id === p.id) - fam });
          taken++;
          if (out.length >= limit) break;
        }
      }
      return out;
    }
  }

  return { DEFAULT_WEIGHTS, DEFAULT_SETTINGS, Planner, makeElement, rng, betaSample };
});
