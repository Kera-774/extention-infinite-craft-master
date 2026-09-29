'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MaxHeap } = require('../src/shared/heap.js');

test('pop renvoie les éléments par score décroissant', () => {
  const h = new MaxHeap();
  const scores = Array.from({ length: 500 }, () => Math.random() * 100);
  scores.forEach((s, i) => h.push({ score: s, i }));
  assert.equal(h.size, 500);
  const out = [];
  while (h.size) out.push(h.pop().score);
  assert.deepEqual(out, scores.slice().sort((a, b) => b - a));
  assert.equal(h.pop(), undefined);
});

test('peek ne retire pas', () => {
  const h = new MaxHeap([{ score: 1 }, { score: 5 }, { score: 3 }]);
  assert.equal(h.peek().score, 5);
  assert.equal(h.size, 3);
});

test('trimTo garde les n meilleurs et reste un tas valide', () => {
  const h = new MaxHeap();
  for (let i = 0; i < 100; i++) h.push({ score: i });
  const removed = h.trimTo(10);
  assert.equal(removed.length, 90);
  assert.equal(h.size, 10);
  h.push({ score: 50.5 });
  const out = [];
  while (h.size) out.push(h.pop().score);
  assert.deepEqual(out, [99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 50.5]);
});

test('ré-insertion (re-scoring paresseux)', () => {
  const h = new MaxHeap([{ score: 10, k: 'a' }, { score: 8, k: 'b' }]);
  const top = h.pop();
  top.score = 5;
  h.push(top);
  assert.equal(h.pop().k, 'b');
  assert.equal(h.pop().k, 'a');
});
