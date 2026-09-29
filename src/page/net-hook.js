/**
 * Observateur réseau (monde MAIN, injecté à document_start).
 *
 * Installé AVANT les scripts du jeu pour que le client HTTP du jeu (qui peut
 * capturer `fetch` au chargement) passe par notre wrapper. Il n'altère rien :
 * il note seulement le statut HTTP (200, 429, 403, 5xx…) et l'en-tête
 * Retry-After de chaque appel à /api/infinite-craft/pair, afin que le moteur
 * puisse détecter la limitation même quand il passe par les fonctions du jeu
 * (qui, elles, ne remontent pas le code HTTP).
 */
(function () {
  'use strict';
  if (window.__ICX_NET) return;
  const PAIR_RE = /\/api\/infinite-craft\/pair\b/;
  const pk = window.ICX && window.ICX.pairkey;

  const net = {
    last: new Map(), // clé de paire -> { status, retryAfterMs, t }
    counts: { total: 0, ok: 0, s429: 0, s403: 0, s5xx: 0, other: 0 },
    lastRateLimitAt: 0,
    lastForbiddenAt: 0,
    record(url, status, retryAfterHeader) {
      let key = null;
      try {
        const u = new URL(url, location.href);
        const a = u.searchParams.get('first');
        const b = u.searchParams.get('second');
        if (a != null && b != null && pk) key = pk.pairKey(a, b);
      } catch (_) {
        /* URL non analysable */
      }
      let retryAfterMs = 0;
      if (retryAfterHeader) {
        const s = Number(retryAfterHeader);
        retryAfterMs = Number.isFinite(s) ? s * 1000 : Math.max(0, Date.parse(retryAfterHeader) - Date.now()) || 0;
      }
      const now = Date.now();
      const c = net.counts;
      c.total++;
      if (status >= 200 && status < 300) c.ok++;
      else if (status === 429) {
        c.s429++;
        net.lastRateLimitAt = now;
      } else if (status === 403) {
        c.s403++;
        net.lastForbiddenAt = now;
      } else if (status >= 500) c.s5xx++;
      else c.other++;
      if (key) {
        net.last.set(key, { status, retryAfterMs, t: now });
        if (net.last.size > 5000) net.last.delete(net.last.keys().next().value);
      }
    },
    /** Dernier statut observé pour une paire depuis `since` (ms epoch). */
    lastFor(key, since) {
      const r = net.last.get(key);
      return r && r.t >= (since || 0) ? r : null;
    }
  };
  Object.defineProperty(window, '__ICX_NET', { value: net, configurable: false });

  // --- fetch -------------------------------------------------------------
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      const p = origFetch.apply(this, arguments);
      if (PAIR_RE.test(url)) {
        p.then(
          (res) => net.record(url, res.status, res.headers.get('retry-after')),
          () => net.record(url, 0, null)
        );
      }
      return p;
    };
    // Accès au fetch d'origine pour le backend « fetch » (évite la double comptabilisation)
    net.origFetch = origFetch.bind(window);
  }

  // --- XMLHttpRequest ----------------------------------------------------
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__icxUrl = String(url);
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (this.__icxUrl && PAIR_RE.test(this.__icxUrl)) {
      this.addEventListener('loadend', () => net.record(this.__icxUrl, this.status, this.getResponseHeader('retry-after')));
    }
    return XS.apply(this, arguments);
  };
})();
