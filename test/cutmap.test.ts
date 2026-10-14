import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitCut, foldOfCase, sortItems, tieBreakU } from '../src/cutmap.ts';
import type { Cut, Scores } from '../src/cutmap.ts';
import { sha256Hex } from '../src/identity.ts';

test('foldOfCase takes the full sha256 of the case id as an integer, modulo the number of folds', () => {
  for (const id of ['a', 'case-17', 'ü']) {
    for (const folds of [2, 5, 7]) assert.equal(foldOfCase(id, folds), Number(BigInt(`0x${sha256Hex(id)}`) % BigInt(folds)));
  }
  // Golden values, computed outside this library: int(sha256("a"), 16) mod 5 and mod 2.
  assert.equal(foldOfCase('a', 5), Number(0xca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bbn % 5n));
  assert.equal(foldOfCase('a', 2), 1);
  // The whole digest counts, not its first bytes: the last hex digit decides the parity.
  assert.equal(foldOfCase('a', 2), Number.parseInt(sha256Hex('a').slice(-1), 16) % 2);
});

test('tieBreakU is a pure function of its key, in [0, 1), and no item depends on another', () => {
  const u = tieBreakU(7, 'old', 'estimate', 'A', 'c1');
  assert.equal(u, tieBreakU(7, 'old', 'estimate', 'A', 'c1'));
  assert.ok(u >= 0 && u < 1);
  const others = [tieBreakU(8, 'old', 'estimate', 'A', 'c1'), tieBreakU(7, 'new', 'estimate', 'A', 'c1'), tieBreakU(7, 'old', 'reask', 'A', 'c1'), tieBreakU(7, 'old', 'estimate', 'B', 'c1'), tieBreakU(7, 'old', 'estimate', 'A', 'c2')];
  assert.equal(new Set([u, ...others]).size, 6);
  // The key is not a concatenation: ("A", "c1x") and ("Ac1", "x") are different items.
  assert.notEqual(tieBreakU(7, 'old', 'estimate', 'Ac', '1'), tieBreakU(7, 'old', 'estimate', 'A', 'c1'));
});

// One system. Six scored cases in two folds (0, 0, 0, 1, 1, 1) and no fit-only case, unless a test adds one.
const foldOf = [0, 0, 0, 1, 1, 1];
const scores = (sum: number[], u: number[] = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]): Scores => ({ sum: [sum], u: [u] });
const fit = (src: Scores, target: boolean[], wScored = [1, 1, 1, 1, 1, 1], wFit: number[] = []) => fitCut(src, sortItems(src), [target], foldOf, 2, wScored, wFit);
const bits = (s: string): boolean[] => [...s].map((c) => c === '1');

// A hand-worked fixture, not a published reference value: the arithmetic is written out below.
test('fitCut: a six-item example, a hand-worked fixture', () => {
  // Sums 12, 9, 6, 11, 8, 5. The target passes items 0, 1 and 3.
  const src = scores([12, 9, 6, 11, 8, 5]);
  const r = fit(src, bits('110100'));
  // Fold 0 is fitted on items 3, 4, 5 (sums 11, 8, 5), of which the target passes one: the cut is the
  // largest sum with at least one fit item at or above it, 11. Items 0, 1, 2 (12, 9, 6) → pass, fail, fail.
  // Fold 1 is fitted on items 0, 1, 2 (12, 9, 6), of which the target passes two: the cut is 9.
  // Items 3, 4, 5 (11, 8, 5) → pass, fail, fail.
  assert.deepEqual(r.labels, [bits('100100')]);
  assert.equal(r.defined, true);
  assert.deepEqual(r.folds, [
    { fold: 0, labelled: 3, fit: 3, target: 1, achieved: 1, cut: { sum: 11, u: 0.4 }, decidedByTieBreak: 0 },
    { fold: 1, labelled: 3, fit: 3, target: 2, achieved: 2, cut: { sum: 9, u: 0.2 }, decidedByTieBreak: 0 },
  ]);
});

test('fitCut: equal sums are split by the tie-break, which is compared, never rounded away', () => {
  // Fold 1 is fitted on items 0, 1, 2 with sums 9, 9, 9 and tie-breaks 0.1, 0.2, 0.3; the target passes one.
  // The cut is (9, 0.3). In fold 1 the sums are 9, 9, 8 with tie-breaks 0.4, 0.25, 0.9: only (9, 0.4) is at or above it.
  const r = fit(scores([9, 9, 9, 9, 9, 8], [0.1, 0.2, 0.3, 0.4, 0.25, 0.9]), bits('001000'));
  assert.deepEqual((r.folds[1] as { cut: Cut }).cut, { sum: 9, u: 0.3 });
  assert.deepEqual(r.labels[0]?.slice(3), [true, false, false]);
  // Two of the three labelled items have the cut's sum, so the tie-break decided them.
  assert.equal(r.folds[1]?.decidedByTieBreak, 2);
  // Fold 0 is fitted on items 3, 4, 5, none of which the target passes: every item of fold 0 fails.
  assert.equal(r.folds[0]?.cut, 'ALL_FAIL');
  assert.deepEqual(r.labels[0]?.slice(0, 3), [false, false, false]);
});

test('fitCut: weights are multiplicities; a case of weight 0 is absent, and fit-only cases only fit', () => {
  const src = scores([12, 9, 6, 11, 8, 5]);
  // Item 0 drawn three times, item 1 not at all. Fold 1 is fitted on sums 12 (weight 3) and 6: the target
  // passes weight 3 (item 0; item 1 is absent), so the cut is 12, and item 3 (11) now fails.
  const r = fit(src, bits('110100'), [3, 0, 1, 1, 1, 1]);
  assert.deepEqual((r.folds[1] as { cut: Cut }).cut.sum, 12);
  assert.deepEqual([r.folds[1]?.fit, r.folds[1]?.target, r.folds[1]?.achieved], [4, 3, 3]);
  assert.deepEqual(r.labels[0]?.slice(3), [false, false, false]);
  // An absent item is never the cut, even when its sum would be the natural one: the count reaches the target only at an item of positive weight.
  const absent = fit(src, bits('110100'), [0, 1, 1, 1, 1, 1]);
  assert.deepEqual((absent.folds[1] as { cut: Cut }).cut.sum, 9);
  assert.equal(absent.folds[1]?.target, 1);
  // A fit-only case (a seventh item, sum 10, passed by the target) enters every fold's fit set and gets no label.
  const seven: Scores = { sum: [[12, 9, 6, 11, 8, 5, 10]], u: [[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]] };
  const withFit = fitCut(seven, sortItems(seven), [bits('1101001')], foldOf, 2, [1, 1, 1, 1, 1, 1], [1]);
  // Fold 0: fitted on 11, 8, 5 and 10, the target passes two (11 and 10): the cut is 10. Items 12, 9, 6 → pass, fail, fail.
  assert.deepEqual([withFit.folds[0]?.fit, withFit.folds[0]?.target, (withFit.folds[0] as { cut: Cut }).cut.sum], [4, 2, 10]);
  assert.deepEqual(withFit.labels, [bits('100100')]);
  assert.equal(withFit.labels[0]?.length, 6);
});

test('fitCut: an empty fit set is undefined, a fold with nothing to label is skipped', () => {
  const src = scores([12, 9, 6, 11, 8, 5]);
  // Every case of fold 1 has weight 0: fold 0 has nothing to fit on, and fold 1 has nothing to label.
  const r = fit(src, bits('110100'), [1, 1, 1, 0, 0, 0]);
  assert.equal(r.defined, false);
  assert.deepEqual(r.folds.map((f) => f.cut), ['EMPTY_FIT_SET', 'NOTHING_TO_LABEL']);
  // With a fit-only case, the same weights are defined again.
  const seven: Scores = { sum: [[12, 9, 6, 11, 8, 5, 10]], u: [[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]] };
  assert.equal(fitCut(seven, sortItems(seven), [bits('1101001')], foldOf, 2, [1, 1, 1, 0, 0, 0], [1]).defined, true);
});

test('fitCut properties: a cut reproduces the target count on its fit set; more target passes never raise the cut', () => {
  // The target is "sum at or above 9". Each fold's cut is fitted on the other fold and reproduces the count there; the
  // labels it then gives its own fold may differ from the target's (here 100100 against 110100).
  const src = scores([12, 9, 6, 11, 8, 5]);
  const own = fit(src, src.sum[0]?.map((x) => x >= 9) ?? []);
  assert.deepEqual(own.folds.map((f) => f.achieved === f.target), [true, true]);
  assert.deepEqual(own.labels, [bits('100100')]);
  // Monotone in the target: passing more fit items lowers the cut, or leaves it.
  const order = ['000000', '100000', '100100', '110100', '110110', '111111'];
  const cuts = order.map((t) => fit(src, bits(t)).folds.map((f) => (typeof f.cut === 'string' ? Number.POSITIVE_INFINITY : f.cut.sum)));
  for (let i = 1; i < cuts.length; i++) for (const f of [0, 1]) assert.ok((cuts[i]?.[f] as number) <= (cuts[i - 1]?.[f] as number), `${order[i]} fold ${f}`);
  // Two systems pooled: one cut per fold for both, fitted on both systems' items.
  const two: Scores = { sum: [[12, 9, 6, 11, 8, 5], [10, 7, 4, 13, 3, 2]], u: [[0.1, 0.2, 0.3, 0.4, 0.5, 0.6], [0.15, 0.25, 0.35, 0.45, 0.55, 0.65]] };
  const pooled = fitCut(two, sortItems(two), [bits('110100'), bits('100100')], foldOf, 2, [1, 1, 1, 1, 1, 1], []);
  // Fold 0 is fitted on 11, 8, 5, 13, 3, 2, of which the target passes two (11 and 13): the cut is 11.
  // System 1: 12, 9, 6 → pass, fail, fail. System 2: 10, 7, 4 → all fail.
  assert.deepEqual((pooled.folds[0] as { cut: Cut }).cut.sum, 11);
  assert.deepEqual([pooled.labels[0]?.slice(0, 3), pooled.labels[1]?.slice(0, 3)], [[true, false, false], [false, false, false]]);
  assert.equal(pooled.folds[0]?.labelled, 6);
});
