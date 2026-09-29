/**
 * Niveaux de puissance et garde-fous thermiques / énergétiques.
 *
 * Plafonds (jamais dépassés, même sur une machine plus puissante) :
 *   ÉCO    : 1 requête, 1,5 s entre lancements, 0 worker
 *   NORMAL : 2 requêtes, 600 ms, 0 worker
 *   TURBO  : AIMD 2→6, 1 worker, lots IndexedDB de 50, UI ≤ 2 Hz
 *   MAX    : AIMD 4→12, ≤ 2 workers (≤ hardwareConcurrency/3), lookahead 2000,
 *            lots de 200, UI 1 Hz, pause de refroidissement optionnelle
 */
(function () {
  'use strict';
  const ICX = (window.ICX = window.ICX || {});

  const LEVELS = {
    eco: { label: 'ÉCO', minConc: 1, maxConc: 1, delayMs: 1500, workers: 0, lookahead: 100, batch: 20, uiHz: 2, adaptive: false },
    normal: { label: 'NORMAL', minConc: 2, maxConc: 2, delayMs: 600, workers: 0, lookahead: 300, batch: 50, uiHz: 2, adaptive: false },
    turbo: { label: 'TURBO', minConc: 2, maxConc: 6, delayMs: 200, workers: 1, lookahead: 1000, batch: 50, uiHz: 2, adaptive: true },
    max: { label: 'MAX', minConc: 4, maxConc: 12, delayMs: 80, workers: 2, lookahead: 2000, batch: 200, uiHz: 1, adaptive: true, cooldown: true }
  };
  const ORDER = ['eco', 'normal', 'turbo', 'max'];

  function detectHardware() {
    return {
      cores: navigator.hardwareConcurrency || 4,
      memoryGb: navigator.deviceMemory || 4 // plafonné à 8 par Chrome
    };
  }

  /** Niveau par défaut selon le matériel (Intel U300 : 6 threads → TURBO). */
  function defaultLevel(hw) {
    if (hw.cores <= 2 || hw.memoryGb <= 2) return 'eco';
    if (hw.cores <= 4 || hw.memoryGb <= 4) return 'normal';
    return 'turbo';
  }

  /**
   * Paramètres effectifs d'un niveau, adaptés au matériel et aux
   * surcharges utilisateur, sans jamais dépasser les plafonds.
   */
  function effectiveLevel(name, hw, overrides = {}, throttleSteps = 0) {
    const base = LEVELS[name] || LEVELS.normal;
    const L = { ...base, name };
    L.workers = Math.min(base.workers, Math.floor(hw.cores / 3));
    if (hw.memoryGb <= 4) L.lookahead = Math.floor(L.lookahead / 2);
    if (overrides.delayMs && overrides.delayMs[name] != null) L.delayMs = Math.max(0, +overrides.delayMs[name]);
    // garde-fou thermique : un cran de concurrence en moins par pas
    L.maxConc = Math.max(1, Math.min(base.maxConc, base.maxConc - throttleSteps));
    L.minConc = Math.min(L.minConc, L.maxConc);
    return L;
  }

  /**
   * Surveille la batterie, le retard de la boucle d'événements et la pause de
   * refroidissement. Notifie le moteur via des callbacks.
   */
  class PowerGuard {
    constructor(cb) {
      this.cb = cb; // { onBattery(low), onLag(sustainedHigh), onCooldown(active) }
      this.battery = null;
      this.batteryLow = false;
      this.lagMs = 0; // EWMA du retard
      this.highSince = 0;
      this.okSince = 0;
      this.lagState = false;
      this.timer = null;
      this.cooldownEnabled = true;
      this.cooldownEveryMs = 10 * 60 * 1000;
      this.cooldownForMs = 10 * 1000;
      this.runningSince = 0;
      this.coolingUntil = 0;
    }

    async start() {
      try {
        if (navigator.getBattery) {
          this.battery = await navigator.getBattery();
          const upd = () => this._checkBattery();
          this.battery.addEventListener('levelchange', upd);
          this.battery.addEventListener('chargingchange', upd);
          this._checkBattery();
        }
      } catch (_) {
        /* API batterie absente */
      }
      // mesure du retard : un timer de 100 ms qui arrive en retard = CPU saturé/bridé
      const PERIOD = 100;
      let expected = performance.now() + PERIOD;
      this.timer = setInterval(() => {
        const now = performance.now();
        const lag = Math.max(0, now - expected);
        expected = now + PERIOD;
        // onglet en arrière-plan : Chrome regroupe les timers à 1 s, ce n'est pas du throttling CPU
        if (document.hidden) return;
        this.lagMs = this.lagMs * 0.9 + lag * 0.1;
        this._checkLag(Date.now());
      }, PERIOD);
    }

    stop() {
      clearInterval(this.timer);
    }

    _checkBattery() {
      const b = this.battery;
      const low = !!b && !b.charging && b.level < 0.3;
      if (low !== this.batteryLow) {
        this.batteryLow = low;
        this.cb.onBattery(low);
      }
    }

    _checkLag(now) {
      if (this.lagMs > 100) {
        this.okSince = 0;
        if (!this.highSince) this.highSince = now;
        // soutenu = plus de 5 s ; on réduit d'un cran, puis à nouveau toutes les 15 s
        if (now - this.highSince > 5000) {
          this.highSince = now + 10000;
          this.cb.onLag(true);
        }
      } else {
        this.highSince = 0;
        if (!this.okSince) this.okSince = now;
        if (now - this.okSince > 60000) {
          this.okSince = now;
          this.cb.onLag(false); // 60 s de calme : on relâche un cran
        }
      }
    }

    /** Appelé par le moteur à chaque tick en niveau MAX. Renvoie true si en pause. */
    cooling(now, level) {
      if (!this.cooldownEnabled || !LEVELS[level] || !LEVELS[level].cooldown) {
        this.runningSince = now;
        return false;
      }
      if (now < this.coolingUntil) return true;
      if (!this.runningSince) this.runningSince = now;
      if (now - this.runningSince >= this.cooldownEveryMs) {
        this.coolingUntil = now + this.cooldownForMs;
        this.runningSince = this.coolingUntil;
        this.cb.onCooldown(true);
        return true;
      }
      return false;
    }
  }

  ICX.power = { LEVELS, ORDER, detectHardware, defaultLevel, effectiveLevel, PowerGuard };
})();
