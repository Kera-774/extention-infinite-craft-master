'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Planner, makeElement } = require('../src/shared/scoring.js');
const { pairKey } = require('../src/shared/pairkey.js');

function base(p) {
  ['Water', 'Fire', 'Wind', 'Earth'].forEach((t) => p.upsertElement(makeElement(t, '', 0, 0)));
}

test('génère exactement N(N+1)/2 paires distinctes puis s’épuise', () => {
  const p = new Planner({ seed: 1 });
  base(p);
  const list = p.generate({ anchorCount: 10, perAnchor: 100, limit: 100 });
  assert.equal(list.length, 10); // 4*5/2
  assert.equal(new Set(list.map((c) => c.key)).size, 10);
  for (const c of list) p.markTested(c.key);
  assert.equal(p.generate({ anchorCount: 10, perAnchor: 100 }).length, 0);
});

test('ne propose jamais une paire testée ou réservée', () => {
  const p = new Planner({ seed: 2 });
  base(p);
  p.markTested(pairKey('Water', 'Fire'));
  p.reserve(pairKey('Earth', 'Earth'));
  const keys = p.generate({ anchorCount: 10, perAnchor: 100 }).map((c) => c.key);
  assert.ok(!keys.includes('fire|water'));
  assert.ok(!keys.includes('earth|earth'));
  assert.equal(keys.length, 8);
});

test('génération incrémentale : ancre = nouvel élément seulement', () => {
  const p = new Planner({ seed: 3 });
  base(p);
  p.upsertElement(makeElement('Steam', '', 1, 1));
  const list = p.generate({ anchors: ['steam'], perAnchor: 100 });
  assert.equal(list.length, 5);
  assert.ok(list.every((c) => c.key.split('|').includes('steam')));
});

test('liste noire et noms > 30 caractères exclus ; non possédés exclus', () => {
  const p = new Planner({ seed: 4, blacklist: ['Fire'] });
  base(p);
  p.upsertElement(makeElement('X'.repeat(31), '', 1, 1));
  p.upsertElement({ ...makeElement('Ghost', '', 1, 1), owned: false });
  const keys = p.generate({ anchorCount: 10, perAnchor: 100 }).map((c) => c.key);
  assert.ok(keys.every((k) => !k.includes('fire') && !k.includes('xxx') && !k.includes('ghost')));
});

test('fraîcheur, fertilité et pénalités ordonnent les éléments', () => {
  const p = new Planner({ seed: 5, weights: { noise: 0 } });
  base(p);
  const fresh = makeElement('Steam', '', 1, 100);
  const old = makeElement('Mud', '', 1, 1);
  p.upsertElement(fresh);
  p.upsertElement(old);
  p.seq = 100;
  assert.ok(p.elementValue(p.elements.get('steam')) > p.elementValue(p.elements.get('mud')));

  const dead = { ...makeElement('Dust', '', 1, 100), tried: 40, produced: 0, recent: 0 };
  const fertile = { ...makeElement('Life', '', 1, 100), tried: 40, produced: 20, firsts: 3, recent: 0.5 };
  p.upsertElement(dead);
  p.upsertElement(fertile);
  assert.ok(p.elementValue(p.elements.get('life')) > p.elementValue(p.elements.get('dust')) + 1);

  const longName = makeElement('Very Long Specific Element Name', '', 1, 100);
  p.upsertElement(longName);
  assert.ok(p.elementValue(p.elements.get('steam')) > p.elementValue(p.elements.get('very long specific element name')));
});

test('UCB : bonus d’exploration pour les éléments peu testés', () => {
  const p = new Planner({ seed: 6, weights: { noise: 0, fresh: 0, depth: 0, fertile: 0 } });
  const a = { ...makeElement('A', '', 1, 0), tried: 1, produced: 0 };
  const b = { ...makeElement('B', '', 1, 0), tried: 100, produced: 0, recent: 0.3 };
  for (let i = 0; i < 200; i++) p.tested.add('k' + i);
  p.upsertElement(a);
  p.upsertElement(b);
  assert.ok(p.elementValue(p.elements.get('a')) > p.elementValue(p.elements.get('b')));
});

test('pairsDone et épuisement d’une ancre', () => {
  const p = new Planner({ seed: 7 });
  base(p);
  for (const t of ['Water', 'Fire', 'Wind', 'Earth']) p.markTested(pairKey('Water', t));
  assert.equal(p.elements.get('water').pairsDone, 4);
  const list = p.generate({ anchors: ['water'], perAnchor: 10 });
  assert.equal(list.length, 0);
});

test('Thompson sampling produit des valeurs finies', () => {
  const p = new Planner({ seed: 8, settings: { bandit: 'thompson' } });
  base(p);
  for (const e of p.elements.values()) assert.ok(Number.isFinite(p.elementValue(e)));
});

test('One object : ancre forcée, tous les partenaires parcourus sans limite', () => {
  const p = new Planner({ seed: 9, settings: { maxScanPerAnchor: 3 }, blacklist: ['Target'] });
  base(p);
  p.upsertElement(makeElement('Target', '', 1, 1));
  for (let i = 0; i < 20; i++) p.upsertElement(makeElement('E' + i, '', 2, 2 + i));
  // sans forçage : l'ancre en liste noire est ignorée, et le parcours est borné à 3
  assert.equal(p.generate({ anchors: ['target'], perAnchor: 100 }).length, 0);
  const list = p.generate({ anchors: ['target'], forceAnchors: true, perAnchor: 100, maxScan: Infinity });
  assert.equal(list.length, 24); // 4 de base + 20 (la cible elle-même est en liste noire comme partenaire)
  assert.ok(list.every((c) => c.key.split('|').includes('target')));
});

test('pénalité « même famille » : élément × son propre ingrédient', () => {
  const p = new Planner({ seed: 10, weights: { noise: 0 } });
  base(p);
  p.upsertElement({ ...makeElement('Steam', '', 1, 1), parents: ['water', 'fire'] });
  const steam = p.elements.get('steam');
  assert.ok(p.related(steam, p.elements.get('water')));
  assert.ok(!p.related(steam, p.elements.get('earth')));
  const withParent = p.pairScore(steam, p.elements.get('water'));
  const withOther = p.pairScore(steam, p.elements.get('earth'));
  assert.ok(withOther - withParent > 0.25);
});
