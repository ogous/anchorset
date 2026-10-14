import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mulberry32, seedFromString, shuffle } from '../src/rng.ts';

test('mulberry32 is deterministic per seed and stays in [0, 1)', () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  const xs = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 1000 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05);
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
});

test('mulberry32 rejects seeds outside uint32', () => {
  assert.throws(() => mulberry32(-1), RangeError);
  assert.throws(() => mulberry32(2 ** 32), RangeError);
  assert.throws(() => mulberry32(1.5), RangeError);
});

test('seedFromString is the first 4 bytes of sha256', () => {
  // sha256("abc") = ba7816bf...
  assert.equal(seedFromString('abc'), 0xba7816bf);
  assert.equal(seedFromString('abc'), seedFromString('abc'));
});

test('shuffle returns a permutation copy, deterministic per seed', () => {
  const input = Array.from({ length: 50 }, (_, i) => i);
  const frozen = [...input];
  const s1 = shuffle(input, 7);
  assert.deepEqual(input, frozen);
  assert.deepEqual(shuffle(input, 7), s1);
  assert.deepEqual([...s1].sort((x, y) => x - y), input);
  assert.notDeepEqual(shuffle(input, 8), s1);
  assert.deepEqual(shuffle([], 1), []);
});
