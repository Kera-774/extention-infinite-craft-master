'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Aimd } = require('../src/shared/aimd.js');

test('augmentation additive jusqu’au plafond', () => {
  const a = new Aimd({ min: 2, max: 6, cooldownMs: 0 });
  assert.equal(a.limit, 2);
  for (let i = 0; i < 200; i++) a.onSuccess();
  assert.equal(a.limit, 6);
});

test('~ +1 par fenêtre complète de succès', () => {
  const a = new Aimd({ min: 2, max: 12 });
  for (let i = 0; i < 2; i++) a.onSuccess(); // une fenêtre de 2
  assert.equal(a.limit, 2); // 2 + 1/2 + 1/2.5 < 3
  a.onSuccess();
  assert.equal(a.limit, 3);
});

test('diminution multiplicative sur 429, bornée au minimum', () => {
  const a = new Aimd({ min: 4, max: 12, initial: 12, cooldownMs: 0 });
  a.onRateLimit(1000, 0);
  assert.equal(a.limit, 6);
  a.onRateLimit(2000, 0);
  assert.equal(a.limit, 4);
  a.onRateLimit(3000, 0);
  assert.equal(a.limit, 4);
});

test('une seule réduction par fenêtre de refroidissement', () => {
  const a = new Aimd({ min: 1, max: 12, initial: 12, cooldownMs: 2000 });
  assert.equal(a.onRateLimit(1000, 0), true);
  assert.equal(a.onRateLimit(1500, 0), false);
  assert.equal(a.limit, 6);
  assert.equal(a.onRateLimit(3100, 0), true);
  assert.equal(a.limit, 3);
});

test('Retry-After met en pause et le délai double', () => {
  const a = new Aimd({ min: 1, max: 4, baseDelayMs: 200 });
  a.onRateLimit(10_000, 5000);
  assert.equal(a.waitMs(10_000, 0), 5000);
  assert.ok(a.delayMs >= 400);
  for (let i = 0; i < 500; i++) a.onSuccess();
  assert.equal(Math.round(a.delayMs), 200); // retour au plancher
});

test('mode non adaptatif = concurrence fixe (ÉCO/NORMAL)', () => {
  const a = new Aimd({ min: 2, max: 2, adaptive: false, cooldownMs: 0 });
  a.onRateLimit(1, 0);
  assert.equal(a.limit, 2);
});

test('convergence : trouve le débit max toléré sans 429 répétés', () => {
  // serveur simulé : 429 si plus de 7 requêtes simultanées
  const CAP = 7;
  const a = new Aimd({ min: 4, max: 12, cooldownMs: 0 });
  let r429 = 0;
  const history = [];
  for (let round = 0; round < 400; round++) {
    const c = a.limit;
    if (c > CAP) {
      a.onRateLimit(round * 1000, 0);
      r429++;
    } else for (let i = 0; i < c; i++) a.onSuccess();
    history.push(a.limit);
  }
  const tail = history.slice(-100);
  const avg = tail.reduce((x, y) => x + y, 0) / tail.length;
  assert.ok(avg >= 4 && avg <= CAP + 1, 'moyenne ' + avg);
  assert.ok(r429 < 40, '429 trop fréquents : ' + r429); // sawtooth AIMD : ~1 toutes les ~7-10 rondes
});

test('changement de niveau : le délai suit le nouveau plancher', () => {
  const a = new Aimd({ min: 1, max: 1, baseDelayMs: 1500, adaptive: false });
  a.configure({ min: 4, max: 12, baseDelayMs: 80, adaptive: true });
  assert.equal(a.delayMs, 80);
  a.onRateLimit(0, 0); // backoff x2 (min 250)
  const f = a.delayMs / 80;
  a.configure({ baseDelayMs: 200 });
  assert.equal(Math.round(a.delayMs), Math.round(200 * f)); // facteur de backoff conservé
});

test('configure à chaud conserve l’état en le bornant', () => {
  const a = new Aimd({ min: 4, max: 12, initial: 10 });
  a.configure({ min: 2, max: 6, baseDelayMs: 200, adaptive: true });
  assert.equal(a.limit, 6);
  a.configure({ min: 4, max: 12 });
  assert.equal(a.limit, 6); // pas de saut brutal
});
