/**
 * Contrôle de débit AIMD (Additive Increase / Multiplicative Decrease),
 * le même principe que TCP : on augmente doucement la concurrence tant que le
 * serveur répond bien, on la divise dès qu'il signale une surcharge (429).
 *
 * Deux leviers :
 *  - `limit`   : nombre de requêtes simultanées autorisées (entier, borné [min,max]) ;
 *  - `delayMs` : délai minimal entre deux lancements (doublé sur 429, décroît sinon).
 *
 * Une seule réduction par fenêtre de refroidissement : une rafale de 429 venant
 * du même « tour » de requêtes ne divise pas la concurrence 5 fois de suite.
 * Le niveau ayant provoqué le dernier 429 est mémorisé (`ceiling`) : à son
 * approche, la croissance est 10x plus lente, ce qui espace fortement les 429
 * tout en continuant à sonder (le plafond remonte doucement).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.ICX = root.ICX || {};
    root.ICX.aimd = api;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  class Aimd {
    /**
     * @param {object} o
     * @param {number} o.min            concurrence minimale
     * @param {number} o.max            concurrence maximale (plafond)
     * @param {number} [o.initial]      concurrence de départ (défaut : min)
     * @param {number} [o.increase=1]   +increase par « fenêtre » de succès (≈ +increase/limit par succès)
     * @param {number} [o.decrease=0.5] facteur multiplicatif sur 429
     * @param {number} [o.errorDecrease=0.8] facteur sur timeout / erreur réseau
     * @param {number} [o.cooldownMs=2000]   pas plus d'une réduction par fenêtre
     * @param {number} [o.baseDelayMs=0]     délai plancher entre lancements
     * @param {number} [o.maxDelayMs=8000]   délai plafond
     * @param {boolean} [o.adaptive=true]    false = concurrence fixe (ÉCO/NORMAL)
     */
    constructor(o) {
      this.increase = o.increase ?? 1;
      this.decrease = o.decrease ?? 0.5;
      this.errorDecrease = o.errorDecrease ?? 0.8;
      this.cooldownMs = o.cooldownMs ?? 2000;
      this.maxDelayMs = o.maxDelayMs ?? 8000;
      this.lastDecrease = -Infinity;
      this.ceiling = Infinity; // dernier niveau ayant déclenché un 429 (≈ ssthresh TCP)
      this.pausedUntil = 0;
      this.stats = { successes: 0, rateLimits: 0, errors: 0 };
      this.configure(o);
      this.cwnd = Math.min(this.max, Math.max(this.min, o.initial ?? this.min));
      this.delayMs = this.baseDelayMs;
    }

    /** Changement de niveau à chaud : conserve l'état courant, le borne seulement. */
    configure(o) {
      const oldBase = this.baseDelayMs;
      this.min = Math.max(1, o.min ?? this.min ?? 1);
      this.max = Math.max(this.min, o.max ?? this.max ?? this.min);
      this.baseDelayMs = Math.max(0, o.baseDelayMs ?? this.baseDelayMs ?? 0);
      this.adaptive = o.adaptive ?? this.adaptive ?? true;
      if (this.cwnd !== undefined) this.cwnd = Math.min(this.max, Math.max(this.min, this.cwnd));
      if (this.delayMs !== undefined) {
        // changement de niveau : on garde le facteur de backoff courant (délai / plancher)
        const factor = oldBase > 0 ? this.delayMs / oldBase : 1;
        this.delayMs = Math.min(this.maxDelayMs, Math.max(this.baseDelayMs, this.baseDelayMs * factor));
      }
      if (!this.adaptive && this.cwnd !== undefined) this.cwnd = this.max;
    }

    /** Nombre de requêtes simultanées autorisé maintenant. */
    get limit() {
      return this.adaptive ? Math.max(this.min, Math.floor(this.cwnd)) : this.max;
    }

    onSuccess() {
      this.stats.successes++;
      if (this.adaptive) {
        let inc = this.increase / Math.max(1, this.cwnd);
        // près du dernier niveau ayant provoqué un 429 : on sonde 10x plus lentement
        if (this.cwnd >= this.ceiling - 1) inc *= 0.1;
        this.cwnd = Math.min(this.max, this.cwnd + inc);
        // le plafond mémorisé remonte lentement pour re-sonder si le serveur s'est libéré
        this.ceiling = Math.min(this.max + 1, this.ceiling * 1.0005);
      }
      // retour progressif vers le délai plancher
      this.delayMs = Math.max(this.baseDelayMs, this.delayMs * 0.95);
    }

    /** 429 : division de la concurrence, doublement du délai, pause Retry-After. */
    onRateLimit(now, retryAfterMs) {
      this.stats.rateLimits++;
      if (retryAfterMs > 0) this.pausedUntil = Math.max(this.pausedUntil, now + retryAfterMs);
      if (now - this.lastDecrease < this.cooldownMs) return false;
      this.lastDecrease = now;
      this.ceiling = Math.max(this.min, this.cwnd); // niveau de saturation observé
      if (this.adaptive) this.cwnd = Math.max(this.min, this.cwnd * this.decrease);
      this.delayMs = Math.min(this.maxDelayMs, Math.max(250, this.delayMs * 2, this.baseDelayMs));
      // sans Retry-After, petite pause proportionnelle au délai
      if (!(retryAfterMs > 0)) this.pausedUntil = Math.max(this.pausedUntil, now + this.delayMs);
      return true;
    }

    /** Timeout / erreur réseau / 5xx : réduction plus douce. */
    onError(now) {
      this.stats.errors++;
      if (now - this.lastDecrease < this.cooldownMs) return false;
      this.lastDecrease = now;
      if (this.adaptive) this.cwnd = Math.max(this.min, this.cwnd * this.errorDecrease);
      this.delayMs = Math.min(this.maxDelayMs, Math.max(this.baseDelayMs, this.delayMs * 1.5));
      return true;
    }

    /**
     * Relance après un arrêt : on oublie le backoff transitoire (délai gonflé,
     * pause Retry-After, fenêtre de refroidissement) mais on garde ce qui a été
     * appris sur le serveur (concurrence courante et plafond mémorisé).
     */
    resetTransient(now = 0) {
      this.delayMs = this.baseDelayMs;
      if (this.pausedUntil < now) this.pausedUntil = 0;
      this.lastDecrease = -Infinity;
      this.cwnd = Math.min(this.max, Math.max(this.min, this.cwnd));
    }

    /** Réduit d'un cran (garde-fou thermique) sans toucher au délai. */
    stepDown() {
      this.cwnd = Math.max(this.min, this.cwnd - 1);
    }

    /** Millisecondes à attendre avant le prochain lancement (0 = possible). */
    waitMs(now, lastStart) {
      return Math.max(0, this.pausedUntil - now, lastStart + this.delayMs - now);
    }
  }

  return { Aimd };
});
