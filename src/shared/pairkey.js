/**
 * Clés de paires non ordonnées et normalisation des noms d'éléments.
 *
 * Le serveur d'Infinite Craft traite les noms sans tenir compte de la casse
 * (normalisation « Title Case ») et trie la paire avant de chercher la recette :
 * A+B et B+A donnent le même résultat. On identifie donc une paire par la
 * concaténation triée de ses deux noms normalisés : "a|b".
 *
 * Module UMD : utilisable dans la page (globalThis.ICX.pairkey), dans un Web
 * Worker (self.ICX.pairkey) et sous Node (require) pour les tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.ICX = root.ICX || {};
    root.ICX.pairkey = api;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /** Normalise un nom : trim, espaces multiples réduits, minuscules. */
  function normName(name) {
    return String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  /** Échappe "\" et "|" pour que la clé reste réversible sans ambiguïté. */
  function escapePart(s) {
    return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
  }

  function unescapePart(s) {
    return s.replace(/\\(.)/g, '$1');
  }

  /** Comparaison stable par points de code (indépendante de la locale). */
  function cmp(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /**
   * Clé de paire non ordonnée : pairKey(a,b) === pairKey(b,a).
   * Les auto-fusions (a+a) sont autorisées : "a|a".
   */
  function pairKey(a, b) {
    const x = normName(a);
    const y = normName(b);
    return cmp(x, y) <= 0 ? escapePart(x) + '|' + escapePart(y) : escapePart(y) + '|' + escapePart(x);
  }

  /** Découpe une clé en ses deux noms normalisés. */
  function splitPairKey(key) {
    for (let i = 0; i < key.length; i++) {
      if (key[i] === '\\') { i++; continue; }
      if (key[i] === '|') return [unescapePart(key.slice(0, i)), unescapePart(key.slice(i + 1))];
    }
    throw new Error('Clé de paire invalide : ' + key);
  }

  /**
   * Ordre d'envoi à l'API : premier = plus petit nom normalisé.
   * Le jeu (et les scripts communautaires) trient aussi la paire avant l'appel.
   */
  function orderPair(a, b) {
    return cmp(normName(a), normName(b)) <= 0 ? [a, b] : [b, a];
  }

  return { normName, pairKey, splitPairKey, orderPair };
});
