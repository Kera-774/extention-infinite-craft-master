'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pairKey, splitPairKey, normName, orderPair } = require('../src/shared/pairkey.js');

test('clé non ordonnée : a|b === b|a', () => {
  assert.equal(pairKey('Water', 'Fire'), pairKey('Fire', 'Water'));
  assert.equal(pairKey('Water', 'Fire'), 'fire|water');
});

test('insensible à la casse et aux espaces', () => {
  assert.equal(pairKey('  steam ', 'FIRE'), pairKey('Fire', 'Steam'));
  assert.equal(normName('Hot   Air'), 'hot air');
});

test('auto-fusion', () => {
  assert.equal(pairKey('Fire', 'fire'), 'fire|fire');
  assert.deepEqual(splitPairKey('fire|fire'), ['fire', 'fire']);
});

test('noms contenant | ou \\ restent réversibles et sans collision', () => {
  const k1 = pairKey('a|b', 'c');
  const k2 = pairKey('a', 'b|c');
  assert.notEqual(k1, k2);
  assert.deepEqual(splitPairKey(k1), ['a|b', 'c']);
  assert.deepEqual(splitPairKey(k2), ['a', 'b|c']);
  assert.deepEqual(splitPairKey(pairKey('x\\', 'y')), ['x\\', 'y']);
});

test('orderPair trie pour la requête', () => {
  assert.deepEqual(orderPair('Water', 'Fire'), ['Fire', 'Water']);
  assert.deepEqual(orderPair('Fire', 'Water'), ['Fire', 'Water']);
});
