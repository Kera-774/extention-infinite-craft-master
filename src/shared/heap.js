/**
 * File de priorité (tas binaire max) sur la propriété `score`.
 * - push / pop / peek en O(log n) / O(1)
 * - trimTo(n) : conserve les n meilleurs éléments (borne la mémoire)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.ICX = root.ICX || {};
    root.ICX.heap = api;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  class MaxHeap {
    constructor(items) {
      this.a = [];
      if (items) for (const it of items) this.push(it);
    }

    get size() {
      return this.a.length;
    }

    peek() {
      return this.a[0];
    }

    push(item) {
      const a = this.a;
      a.push(item);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (a[p].score >= a[i].score) break;
        [a[p], a[i]] = [a[i], a[p]];
        i = p;
      }
    }

    pop() {
      const a = this.a;
      if (a.length === 0) return undefined;
      const top = a[0];
      const last = a.pop();
      if (a.length > 0) {
        a[0] = last;
        this._down(0);
      }
      return top;
    }

    _down(i) {
      const a = this.a;
      const n = a.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < n && a[l].score > a[m].score) m = l;
        if (r < n && a[r].score > a[m].score) m = r;
        if (m === i) return;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }

    /** Garde les `n` meilleurs ; renvoie les éléments retirés. */
    trimTo(n) {
      if (this.a.length <= n) return [];
      const sorted = this.a.slice().sort((x, y) => y.score - x.score);
      const removed = sorted.slice(n);
      this.a = sorted.slice(0, n); // un tableau trié décroissant est un tas valide
      return removed;
    }

    clear() {
      this.a = [];
    }

    toArray() {
      return this.a.slice();
    }
  }

  return { MaxHeap };
});
