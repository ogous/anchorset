import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DRIFT_BASIS, driftReport, judgeControlledDelta, rateShiftMinItems } from '../src/drift.ts';
import { cohenKappa, gwetAC1 } from '../src/agreement.ts';
import { InputError, RefusalError } from '../src/errors.ts';
import { hashOf } from '../src/identity.ts';
import { mulberry32 } from '../src/rng.ts';
import { assertNoRateBesideRepeatedReading } from './helpers.ts';

const labels = ['none', 'review', 'handoff'];
const ids = Array.from({ length: 20 }, (_, i) => `a${String(i).padStart(2, '0')}`);
const base = new Map(ids.map((id, i) => [id, i < 10 ? 'none' : i < 16 ? 'review' : 'handoff']));
/** Both readings were shown the same packet for every anchor item. */
const packets = new Map(ids.map((id) => [id, hashOf({ packet: id })]));
const packetHashes = { old: packets, new: packets };

// The drift classification is defined by this library, so the four tests below are hand-worked fixtures, not
// published reference values; no published reference is claimed. The rule, as src/drift.ts states it:
//   maxRateShift = the largest |new count − old count| / n over the labels
//   overlap      = |old flagged ∩ new flagged| / min(|old flagged|, |new flagged|), taken as 1 when the smaller set is empty
//   jaccard      = |old flagged ∩ new flagged| / |old flagged ∪ new flagged|
//   class        = item-shift if overlap < 0.8; otherwise threshold-shift if maxRateShift >= 0.05; otherwise counts-stable
// The old reading of the 20 items: a00–a09 none (10), a10–a15 review (6), a16–a19 handoff (4).
//
// This test: a10, a11, a12 move from review to handoff. Flagged = review or handoff.
//   counts: none 10 -> 10, review 6 -> 3, handoff 4 -> 7; the shifts are 0, 3/20, 3/20, so maxRateShift = 0.15
//   flagged: a10–a19 before and after; 10 shared of 10 together, jaccard = 1; overlap 10 / 10 = 1
//   overlap 1 is not below 0.8, and 0.15 >= 0.05: threshold-shift
//   review: 6 before, 3 after, 3 of the 6 kept, kept rate 3 / 6 = 0.5
//   transition (rows old, columns new; none, review, handoff): [10, 0, 0], [0, 3, 3], [0, 0, 4]
test('drift: rates move but the same items stay flagged => threshold-shift (a hand-worked fixture: rate shift 3/20 = 0.15, jaccard 1)', () => {
  const next = new Map(base);
  for (const id of ['a10', 'a11', 'a12']) next.set(id, 'handoff');
  const r = driftReport(base, next, { labels, flagLabels: ['review', 'handoff'], packetHashes });
  assert.equal(r.flaggedJaccard, 1);
  assert.equal(r.maxRateShift, 0.15);
  assert.equal(r.classification, 'threshold-shift');
  const review = r.perLabel.find((p) => p.label === 'review');
  assert.equal(review?.oldCount, 6);
  assert.equal(review?.newCount, 3);
  assert.equal(review?.keptRate, 0.5);
  assert.deepEqual(r.transition.counts, [[10, 0, 0], [0, 3, 3], [0, 0, 4]]);
});

// Defined by this library; a hand-worked fixture (the rule is written out above the first test). The two halves
// trade places: a10–a19 become none, a00–a05 become review, a06–a09 become handoff. Flagged = review or handoff.
//   counts: none 10 -> 10, review 6 -> 6, handoff 4 -> 4: maxRateShift = 0
//   flagged: a10–a19 before, a00–a09 after; 0 shared of 20 together, jaccard = 0; overlap 0 / 10 = 0
//   overlap 0 < 0.8: item-shift
//   kappa: no item keeps its label, so po = 0; pe = 0.5·0.5 + 0.3·0.3 + 0.2·0.2 = 0.38;
//          (0 − 0.38) / (1 − 0.38) = −0.38 / 0.62 = −0.6129, below 0
test('drift: same rates, different items flagged => item-shift (a hand-worked fixture: rate shift 0, jaccard 0, kappa below 0)', () => {
  const next = new Map(base);
  for (const id of ['a10', 'a11', 'a12', 'a13', 'a14', 'a15', 'a16', 'a17', 'a18', 'a19']) next.set(id, 'none');
  for (const [i, id] of ['a00', 'a01', 'a02', 'a03', 'a04', 'a05', 'a06', 'a07', 'a08', 'a09'].entries()) next.set(id, i < 6 ? 'review' : 'handoff');
  const r = driftReport(base, next, { labels, flagLabels: ['review', 'handoff'], packetHashes });
  assert.equal(r.maxRateShift, 0);
  assert.equal(r.flaggedJaccard, 0);
  assert.equal(r.classification, 'item-shift');
  assert.ok(typeof r.kappa === 'number' && r.kappa < 0);
});

// Defined by this library; a hand-worked fixture (the rule is written out above the first test). Flagged = handoff,
// which is a16–a19 in the old reading. Five comparisons:
//   1. old against itself: maxRateShift 0, overlap 4 / 4 = 1: counts-stable
//   2. a16 moves to review: review 6 -> 7, handoff 4 -> 3, maxRateShift 1/20 = 0.05; flagged a16–a19 and a17–a19,
//      3 shared, the smaller set has 3, overlap 3 / 3 = 1; 0.05 >= 0.05: threshold-shift
//   3. the same with the rate threshold at 0.1: 0.05 < 0.1: counts-stable
//   4. a16 moves to none and a00 to handoff: none 10 -> 10, handoff 4 -> 4, maxRateShift 0; flagged a16–a19 and
//      a00, a17, a18, a19; 3 shared, the smaller set has 4, overlap 3 / 4 = 0.75 < 0.8: item-shift
//   5. the same with the overlap threshold at 0.7: 0.75 is not below 0.7, and 0 < 0.05: counts-stable
test('drift: nothing moved => counts-stable; thresholds are parameters (a hand-worked fixture: rate shift 1/20 = 0.05 at the bar, overlap 3/4 = 0.75 below it)', () => {
  assert.equal(driftReport(base, base, { labels, flagLabels: ['handoff'], packetHashes }).classification, 'counts-stable');
  const next = new Map(base);
  next.set('a16', 'review');
  assert.equal(driftReport(base, next, { labels, flagLabels: ['handoff'], packetHashes }).classification, 'threshold-shift');
  assert.equal(driftReport(base, next, { labels, flagLabels: ['handoff'], packetHashes, rateShiftThreshold: 0.1 }).classification, 'counts-stable');
  const swapped = new Map(base);
  swapped.set('a16', 'none');
  swapped.set('a00', 'handoff');
  assert.equal(driftReport(base, swapped, { labels, flagLabels: ['handoff'], packetHashes }).classification, 'item-shift');
  assert.equal(driftReport(base, swapped, { labels, flagLabels: ['handoff'], packetHashes, overlapThreshold: 0.7 }).classification, 'counts-stable');
});

// Defined by this library; a hand-worked fixture (the rule is written out above the first test). a10–a14 move from
// review to handoff. Flagged = handoff.
//   flagged: a16–a19 before (4), a10–a14 and a16–a19 after (9); 4 shared of 9 together, jaccard 4 / 9 = 0.444 < 0.5
//   the smaller set has 4, overlap 4 / 4 = 1
//   counts: review 6 -> 1, handoff 4 -> 9, maxRateShift 5/20 = 0.25
//   overlap 1 is not below 0.8, and 0.25 >= 0.05: threshold-shift
test('drift: a stricter judge flagging a superset is a threshold shift even when Jaccard is low (a hand-worked fixture: jaccard 4/9, overlap 4/4 = 1)', () => {
  const next = new Map(base);
  for (const id of ['a10', 'a11', 'a12', 'a13', 'a14']) next.set(id, 'handoff');
  const r = driftReport(base, next, { labels, flagLabels: ['handoff'], packetHashes });
  assert.ok(r.flaggedJaccard < 0.5);
  assert.equal(r.flaggedOverlap, 1);
  assert.equal(r.classification, 'threshold-shift');
});

test('drift refuses different anchor sets and differing packet hashes', () => {
  const fewer = new Map(base);
  fewer.delete('a00');
  assert.throws(() => driftReport(base, fewer, { labels, flagLabels: ['handoff'], packetHashes }), (e: unknown) => e instanceof RefusalError && e.code === 'ITEM_SET_MISMATCH');
  const ph2 = new Map(packets);
  ph2.set('a05', 'b'.repeat(64));
  assert.doesNotThrow(() => driftReport(base, base, { labels, flagLabels: ['handoff'], packetHashes }));
  assert.throws(
    () => driftReport(base, base, { labels, flagLabels: ['handoff'], packetHashes: { old: packets, new: ph2 } }),
    (e: unknown) => e instanceof RefusalError && e.code === 'PACKET_MISMATCH' && e.fields.join() === 'a05',
  );
});

test('drift refuses unknown packets: no hashes at all, one missing item, a value that is not a sha256, a hash for an item outside the set', () => {
  const refused = (old: Map<string, string>, next: Map<string, string>, fields: string): void => {
    assert.throws(
      () => driftReport(base, base, { labels, flagLabels: ['handoff'], packetHashes: { old, new: next } }),
      (e: unknown) => e instanceof RefusalError && e.code === 'PACKET_MISMATCH' && e.fields.join() === fields,
      fields,
    );
  };
  // Neither side recorded what it was shown: equal by absence is not equal.
  refused(new Map(), new Map(), ids.join());
  const short = new Map(packets);
  short.delete('a03');
  refused(short, short, 'a03');
  // "UNKNOWN" on both sides is the same string and still not a packet.
  const gap = new Map(packets);
  gap.set('a07', 'UNKNOWN');
  refused(gap, gap, 'a07');
  const extra = new Map(packets);
  extra.set('zz', 'c'.repeat(64));
  refused(extra, extra, 'zz');
  // The option itself is required: a caller that passes none is refused, not waved through.
  assert.throws(
    () => driftReport(base, base, { labels, flagLabels: ['handoff'] } as unknown as Parameters<typeof driftReport>[2]),
    (e: unknown) => e instanceof RefusalError && e.code === 'PACKET_MISMATCH',
  );
});

// A hand-worked fixture: the first test's readings, 20 items, old 10 none / 6 review / 4 handoff, new 10 / 3 / 7,
// with three review -> handoff. The transition table is [[10,0,0],[0,3,3],[0,0,4]].
//   po = (10 + 3 + 4) / 20                                  = 0.85
//   kappa: pe = 0.5·0.5 + 0.3·0.15 + 0.2·0.35               = 0.365;   (0.85 − 0.365) / 0.635      = 0.76378
//   pooled shares over the 40 verdicts: none 20/40 = 0.5, review 9/40 = 0.225, handoff 11/40 = 0.275
//   AC1: pe = (0.5·0.5 + 0.225·0.775 + 0.275·0.725) / (3−1) = 0.62375 / 2 = 0.311875;
//        (0.85 − 0.311875) / (1 − 0.311875)                  = 0.538125 / 0.688125 = 0.78202
test('drift never reports a lone kappa, a hand-worked fixture: kappa 0.7638 with AC1 0.7820, pooled prevalence 0.5 / 0.225 / 0.275 and a seeded interval for each', () => {
  const next = new Map(base);
  for (const id of ['a10', 'a11', 'a12']) next.set(id, 'handoff');
  const boot = { iterations: 400, seed: 9 };
  const r = driftReport(base, next, { labels, flagLabels: ['review', 'handoff'], packetHashes, bootstrap: boot });
  const close = (x: unknown, want: number): void => assert.ok(typeof x === 'number' && Math.abs(x - want) < 5e-5, `${String(x)} != ${want}`);
  close(r.percentAgreement, 0.85);
  close(r.kappa, 0.7638);
  close(r.ac1, 0.782);
  assert.deepEqual(r.prevalence, { none: 0.5, review: 0.225, handoff: 0.275 });
  assert.deepEqual(r.marginals, { old: { none: 0.5, review: 0.3, handoff: 0.2 }, new: { none: 0.5, review: 0.15, handoff: 0.35 } });
  // Wilson on 17/20: centre (0.85 + 3.8415/40) / (1 + 3.8415/20) = 0.946037 / 1.192073 = 0.79361;
  //   half-width (1.95996 / 1.192073) · sqrt(0.85·0.15/20 + 3.8415/1600) = 1.644166 · 0.093679 = 0.15402; so [0.6396, 0.9476].
  close(r.percentAgreementWilson.lo, 0.6396);
  close(r.percentAgreementWilson.hi, 0.9476);
  // The same numbers as the one agreement module gives: drift has no second kappa.
  const order = [...ids].sort();
  const a = order.map((id) => base.get(id) as string);
  const b = order.map((id) => next.get(id) as string);
  assert.equal(r.kappa, cohenKappa(a, b, labels).kappa);
  assert.equal(r.ac1, gwetAC1(a, b, labels).ac1);
  assert.deepEqual(r.bootstrap, { iterations: 400, seed: 9, alpha: 0.05 });
  for (const ci of [r.kappaCI, r.ac1CI]) {
    assert.ok(ci !== 'NA' && ci.seed === 9 && ci.iterations === 400 && ci.alpha === 0.05);
    assert.ok(ci.lo <= ci.hi && ci.lo >= -1 && ci.hi <= 1);
  }
  assert.ok(r.kappaCI !== 'NA' && r.kappaCI.lo <= 0.7638 && r.kappaCI.hi >= 0.7638);
  assert.ok(r.ac1CI !== 'NA' && r.ac1CI.lo <= 0.782 && r.ac1CI.hi >= 0.782);
  // Deterministic per seed, and the seed is what moves it.
  assert.deepEqual(driftReport(base, next, { labels, flagLabels: ['review', 'handoff'], packetHashes, bootstrap: boot }), r);
  assert.notDeepEqual(driftReport(base, next, { labels, flagLabels: ['review', 'handoff'], packetHashes, bootstrap: { ...boot, seed: 10 } }).kappaCI, r.kappaCI);
  // The default seed is stated, never implicit.
  assert.deepEqual(driftReport(base, next, { labels, flagLabels: ['handoff'], packetHashes }).bootstrap, { iterations: 2000, seed: 0, alpha: 0.05 });
});

test('drift: where kappa is undefined (one label on both sides) the interval is NA and the resampling is still stated', () => {
  const flat = new Map(ids.map((id) => [id, 'none']));
  const r = driftReport(flat, flat, { labels, flagLabels: ['handoff'], packetHashes, bootstrap: { iterations: 50, seed: 3 } });
  assert.equal(r.kappa, 'NA');
  assert.equal(r.kappaCI, 'NA');
  assert.equal(r.bootstrap.seed, 3);
  assert.equal(r.ac1, 1);
});

const passRate = (v: readonly string[]): number => v.filter((x) => x === 'pass').length / v.length;
const ids20 = Array.from({ length: 20 }, (_, i) => `c${String(i).padStart(2, '0')}`);
/** The first `passes` ids pass, the rest fail. */
const verdicts = (passes: number, ids: readonly string[] = ids20): Map<string, string> => new Map(ids.map((id, i) => [id, i < passes ? 'pass' : 'fail']));
const boot = { iterations: 500, seed: 11, alpha: 0.05 };

// The judge and system split is defined by this library, so the four tests below are hand-worked fixtures, not
// published reference values; no published reference is claimed. The split, as src/drift.ts states it, on the
// same case ids in all three readings:
//   reported delta = score(candidate, new judge) − score(baseline, old judge)
//   judge effect   = score(baseline, new judge)  − score(baseline, old judge)
//   system effect  = score(candidate, new judge) − score(baseline, new judge)
// The score here is the pass rate over 20 cases, and verdicts(k) passes the first k ids (c00 upward).
//
// This test: 8, 13 and 16 passes of 20.
//   pass rates 8/20 = 0.40, 13/20 = 0.65, 16/20 = 0.80
//   reported delta = 0.80 − 0.40 = 0.40
//   judge effect   = 0.65 − 0.40 = 0.25
//   system effect  = 0.80 − 0.65 = 0.15
//   0.25 + 0.15 = 0.40, the reported delta
// The interval ends are not pinned to numbers: the test asserts only their order, seed and iteration count.
test('judgeControlledDelta separates judge movement from system movement, and the parts add up (a hand-worked fixture: 0.40 = 0.25 + 0.15)', () => {
  // Old judge passed 8/20 baseline outputs; the new judge passes 13/20 of the same outputs; the candidate gets 16/20.
  const r = judgeControlledDelta({ baselineOldJudge: verdicts(8), baselineNewJudge: verdicts(13), candidateNewJudge: verdicts(16) }, passRate, boot);
  assert.equal(r.itemCount, 20);
  assert.ok(Math.abs(r.reportedDelta.estimate - 0.4) < 1e-12);
  assert.ok(Math.abs(r.judgeEffect.estimate - 0.25) < 1e-12);
  assert.ok(Math.abs(r.systemEffect.estimate - 0.15) < 1e-12);
  assert.ok(Math.abs(r.reportedDelta.estimate - (r.judgeEffect.estimate + r.systemEffect.estimate)) < 1e-12);
  for (const e of [r.reportedDelta, r.judgeEffect, r.systemEffect]) {
    assert.ok(e.lo <= e.hi);
    assert.equal(e.seed, 11);
    assert.equal(e.iterations, 500);
  }
});

// Defined by this library; no published reference is claimed. This test asserts no number: a refusal and an
// equality. Renaming c19 to c99 in one reading leaves 20 verdicts in each, with c19 missing from one reading and c99
// from the other two, so both ids are named in the refusal. Reversing the insertion order of one reading leaves
// every case id with the same three verdicts, so the two results are equal in every field.
test('judgeControlledDelta matches items by case id, not by position or count', () => {
  const shifted = new Map([...verdicts(13)].map(([id, v]) => [id.replace('c19', 'c99'), v]));
  assert.throws(
    () => judgeControlledDelta({ baselineOldJudge: verdicts(8), baselineNewJudge: shifted, candidateNewJudge: verdicts(16) }, passRate, boot),
    (e: unknown) => e instanceof RefusalError && e.code === 'ITEM_SET_MISMATCH' && e.fields.includes('c19') && e.fields.includes('c99'),
  );
  // The same verdicts in a different insertion order give the same answer.
  const reversed = new Map([...verdicts(13)].reverse());
  const a = judgeControlledDelta({ baselineOldJudge: verdicts(8), baselineNewJudge: verdicts(13), candidateNewJudge: verdicts(16) }, passRate, boot);
  const b = judgeControlledDelta({ baselineOldJudge: verdicts(8), baselineNewJudge: reversed, candidateNewJudge: verdicts(16) }, passRate, boot);
  assert.deepEqual(a, b);
});

// Defined by this library; a hand-worked fixture (the split is written out above the first of these tests):
// 8, 13 and 13 passes of 20.
//   per case, new judge minus old judge on the baseline: c08–c12 are +1 (fail -> pass), the other 15 cases are 0,
//   and none is −1. A resample of 20 cases drawn with replacement holding m of those five has judge effect
//   m / 20 >= 0, so no percentile of the resamples, and so no lower bound, is below 0.
//   the candidate's verdicts equal the re-judged baseline's on every case, so the system effect is 0 on every
//   resample: both bounds are 0.
test('judgeControlledDelta resamples items jointly, so a one-directional judge move never gets a negative bound (a hand-worked fixture)', () => {
  // Every item the old judge passed, the new judge also passes: each paired difference is >= 0.
  const r = judgeControlledDelta({ baselineOldJudge: verdicts(8), baselineNewJudge: verdicts(13), candidateNewJudge: verdicts(13) }, passRate, boot);
  assert.ok(r.judgeEffect.lo >= 0, `lo ${r.judgeEffect.lo}`);
  assert.equal(r.systemEffect.lo, 0);
  assert.equal(r.systemEffect.hi, 0);
});

// Defined by this library; a hand-worked fixture (the split is written out above the first of these tests).
// The first two assertions are determinism pins and hold no worked number. The flat case: 5, 5 and 5 passes of 20.
//   every case has the same verdict in all three readings, so on the sample and on every resample each of the
//   three differences is one pass rate minus itself = 0: estimate 0, lower bound 0, upper bound 0, three times.
test('judgeControlledDelta is deterministic per seed and has zero width when nothing moved (a hand-worked fixture: 0, 0, 0)', () => {
  const input = { baselineOldJudge: verdicts(8), baselineNewJudge: verdicts(13), candidateNewJudge: verdicts(16) };
  assert.deepEqual(judgeControlledDelta(input, passRate, boot), judgeControlledDelta(input, passRate, boot));
  assert.notDeepEqual(judgeControlledDelta(input, passRate, { ...boot, seed: 12 }).judgeEffect, judgeControlledDelta(input, passRate, boot).judgeEffect);
  const flat = judgeControlledDelta({ baselineOldJudge: verdicts(5), baselineNewJudge: verdicts(5), candidateNewJudge: verdicts(5) }, passRate, boot);
  for (const e of [flat.reportedDelta, flat.judgeEffect, flat.systemEffect]) assert.deepEqual([e.estimate, e.lo, e.hi], [0, 0, 0]);
  assert.throws(() => judgeControlledDelta({ baselineOldJudge: new Map(), baselineNewJudge: new Map(), candidateNewJudge: new Map() }, passRate, boot), InputError);
});

// The classification is a description by fixed thresholds, and the report says so wherever it goes. Hand-worked
// fixtures, not published reference values; the rule is this library's.
//   The smallest net change in one label's count (new count minus old count) that reaches the rate threshold is
//   the least d with d / n >= threshold, the ceiling of threshold · n. It is the rate rule's count only: the
//   overlap rule is checked first (the assertions on the swapped readings below).
//     n = 20, threshold 0.05: 1 / 20 = 0.05 >= 0.05, so 1 item
//     n = 24, threshold 0.05: 1 / 24 = 0.0417 < 0.05; 2 / 24 = 0.0833, so 2 items
//     n = 60, threshold 0.05: 2 / 60 = 0.0333 < 0.05; 3 / 60 = 0.05, so 3 items
//     n = 100, threshold 0.07: 7 / 100 = 0.07, so 7 items (0.07 · 100 is 7.000000000000001 in floating point,
//                             whose ceiling is 8: the function must not return that)
//     n = 100, threshold 0.05: 5 items;  n = 7, threshold 0.3: 2 / 7 = 0.286 < 0.3; 3 / 7 = 0.429, so 3 items
//     threshold 1: all n items;  n = 20, threshold 0.1: 2 items  (a threshold of 0 is refused: it would call two identical readings a shift)
//   On the 20 anchor items one item read differently (a16 handoff -> review) moves two counts by 1 of 20 = 0.05 and
//   is classified threshold-shift: one changed reading of one item, which a judge read twice can produce on its own.
test('drift: every report carries what the classification is (fixed thresholds; a description, not a test; no repeat-reading baseline) and the smallest count change that reaches the rate threshold, hand-worked: 1 of 20, 2 of 24, 3 of 60', () => {
  const BASIS = 'fixed thresholds; a description, not a test; no repeat-reading baseline';
  assert.equal(DRIFT_BASIS, BASIS);
  assert.deepEqual([[20, 0.05], [24, 0.05], [60, 0.05], [100, 0.05], [100, 0.07], [7, 0.3], [20, 1], [20, 0.1]].map(([n, t]) => rateShiftMinItems(n as number, t as number)), [1, 2, 3, 5, 7, 3, 20, 2]);
  // The count is the classification's own boundary: one item fewer is below the threshold, this many is at or above it.
  for (const n of [1, 2, 19, 20, 21, 24, 39, 40, 41, 50, 60, 100, 139, 140, 1000]) {
    const d = rateShiftMinItems(n, 0.05) as number;
    assert.ok(d / n >= 0.05 && (d - 1) / n < 0.05, `n = ${n}: ${d}`);
  }
  for (const bad of [[0, 0.05], [1.5, 0.05], [20, 0], [20, -0.1], [20, 1.1], [20, Number.NaN]]) assert.throws(() => rateShiftMinItems(bad[0] as number, bad[1] as number), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT');

  // Every classification carries the sentence: counts-stable, threshold-shift and item-shift alike.
  const one = new Map(base);
  one.set('a16', 'review');
  const swapped = new Map(base);
  swapped.set('a16', 'none');
  swapped.set('a00', 'handoff');
  const reports = [base, one, swapped].map((next) => driftReport(base, next, { labels, flagLabels: ['handoff'], packetHashes, bootstrap: { iterations: 20 } }));
  assert.deepEqual(reports.map((r) => r.classification), ['counts-stable', 'threshold-shift', 'item-shift']);
  for (const r of reports) {
    assert.equal(r.classificationBasis, BASIS);
    assert.equal(r.rateShiftMinItems, 1);
    // In the JSON a ledger hashes, too.
    assert.equal((JSON.parse(JSON.stringify(r)) as { classificationBasis: string }).classificationBasis, BASIS);
  }
  // One item read differently is enough for threshold-shift on 20 items: the largest count change equals the smallest that counts.
  const shifted = reports[1] as (typeof reports)[number];
  assert.equal(shifted.maxRateShift * shifted.itemCount, shifted.rateShiftMinItems);
  // The count follows the threshold the caller set.
  assert.equal(driftReport(base, one, { labels, flagLabels: ['handoff'], packetHashes, rateShiftThreshold: 0.1, bootstrap: { iterations: 20 } }).rateShiftMinItems, 2);
  // The overlap rule is checked first, so reaching the count is not enough for threshold-shift. Hand-worked: a16
  // (handoff) is read as none and a00 (none) as handoff. Counts: none 10 -> 10, review 6 -> 6, handoff 4 -> 4, so
  // every net change is 0, below the count of 1. Flagged (handoff): a16–a19 before, a00 and a17–a19 after; 3 shared
  // of min(4, 4) = 0.75 < 0.8: item-shift with no count moved. And a16 -> review, a00 -> handoff moves two counts
  // by 1 (none 9, review 7), reaching the count, with the same overlap 0.75: still item-shift, not threshold-shift.
  const swappedReport = reports[2] as (typeof reports)[number];
  assert.deepEqual([swappedReport.classification, swappedReport.maxRateShift, swappedReport.flaggedOverlap], ['item-shift', 0, 0.75]);
  const both = new Map(base);
  both.set('a16', 'review');
  both.set('a00', 'handoff');
  const bothReport = driftReport(base, both, { labels, flagLabels: ['handoff'], packetHashes, bootstrap: { iterations: 20 } });
  assert.deepEqual([bothReport.classification, bothReport.maxRateShift * bothReport.itemCount >= (bothReport.rateShiftMinItems as number), bothReport.flaggedOverlap], ['item-shift', true, 0.75]);
  // A threshold outside its range is invalid input, not a classification nobody can reach or miss: the rate threshold
  // is in (0, 1] (at 0 every report, two identical readings included, would be a shift), the overlap threshold in [0, 1].
  for (const opts of [{ rateShiftThreshold: 1.5 }, { rateShiftThreshold: -0.01 }, { rateShiftThreshold: 0 }, { overlapThreshold: 2 }, { overlapThreshold: Number.NaN }]) {
    assert.throws(() => driftReport(base, one, { labels, flagLabels: ['handoff'], packetHashes, ...opts }), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && /Threshold: must be a number in [(\[]0, 1\]/.test(e.problems[0] as string));
  }
  // Two identical readings are counts-stable under any admitted rate threshold, the smallest positive one included.
  assert.equal(driftReport(base, base, { labels, flagLabels: ['handoff'], packetHashes, rateShiftThreshold: Number.MIN_VALUE, bootstrap: { iterations: 20 } }).classification, 'counts-stable');
});

// A hand-worked fixture, not a published reference value. The first drift fixture (a10, a11, a12 from review to
// handoff): 17 of 20 items keep their label, po = 0.85. Pooled shares over both readings: none 20/40 = 0.5,
// review 9/40 = 0.225, handoff 11/40 = 0.275.
//   three labels:  pe = (0.5·0.5 + 0.225·0.775 + 0.275·0.725) / 2 = 0.62375 / 2 = 0.311875
//                  AC1 = (0.85 − 0.311875) / (1 − 0.311875) = 0.538125 / 0.688125 = 0.78202
//   four labels, one of them never used: pe = 0.62375 / 3 = 0.207917
//                  AC1 = (0.85 − 0.207917) / (1 − 0.207917) = 0.642083 / 0.792083 = 0.81063
test('drift requires the declared labels, a hand-worked fixture: the same two readings give AC1 0.7820 on three labels and 0.8106 on four, so the labels are never taken from the verdicts', () => {
  const next = new Map(base);
  for (const id of ['a10', 'a11', 'a12']) next.set(id, 'handoff');
  const on = (l: string[]) => driftReport(base, next, { labels: l, flagLabels: ['review', 'handoff'], packetHashes, bootstrap: { iterations: 20 } });
  assert.ok(Math.abs((on(labels).ac1 as number) - 0.78202) < 5e-6);
  assert.ok(Math.abs((on([...labels, 'escalate']).ac1 as number) - 0.81063) < 5e-6);
  assert.equal(on(labels).kappa, on([...labels, 'escalate']).kappa);
  assert.equal(on(labels).classification, on([...labels, 'escalate']).classification);
  // Without the type check (plain JavaScript) an undeclared scale is refused, not read off the verdicts.
  assert.throws(
    () => (driftReport as unknown as (a: unknown, b: unknown, o: unknown) => unknown)(base, next, { flagLabels: ['handoff'], packetHashes }),
    (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && /labels: required/.test(e.problems[0] as string),
  );
});

test('drift: fewer than 1,000 resamples give percentiles with no level; from 1,000 the brackets carry 1 − alpha', () => {
  const next = new Map(base);
  for (const id of ['a10', 'a11', 'a12']) next.set(id, 'handoff');
  const at = (iterations: number) => driftReport(base, next, { labels, flagLabels: ['review', 'handoff'], packetHashes, bootstrap: { iterations } });
  for (const few of [1, 3, 999]) assert.deepEqual([at(few).kappaCI, at(few).ac1CI].map((ci) => ci !== 'NA' && ci.nominalLevel), ['NA', 'NA'], String(few));
  assert.deepEqual([at(1000).kappaCI, at(1000).ac1CI].map((ci) => ci !== 'NA' && ci.nominalLevel), [0.95, 0.95]);
});

// --- How often two readings of ONE judge state are classified other than counts-stable -------------------------------
//
// A SIMULATION OF THIS LIBRARY'S RULE, labelled as one. It is not a published reference value and not a
// measurement of any judge: the noise model below is made up, and the counts are what this seed gives under it.
// The rule is not re-implemented here: every simulated pair of readings goes through driftReport.
//
// Set-up (BOTH READINGS ARE NOISY: one state is read twice, and neither reading is the state itself):
//   labels    none, review, handoff, in that order
//   state     each item's label is drawn on its own: none 0.5, review 0.3, handoff 0.2
//   a reading each item, independently in each of the two readings, moves to an adjacent label with probability
//             `flip`: none -> review, handoff -> review, review -> none or handoff with equal chance
//   flagged   handoff (the rarest label); thresholds are the defaults (rate 0.05, overlap 0.8)
//   runs      10,000 pairs of readings per cell, one mulberry32 stream per cell, seed 20261007
// The bootstrap is asked for one resample: the classification does not read it.
//
// No public document quotes a rate of this kind: the pages say in words that an unchanged judge also gives different
// labels from one reading to the next, and the counts stay here. With noise in one
// reading only (the old reading is the state itself) the rule calls fewer pairs shifted; that arm is run below
// for the comparison and is quoted nowhere, because it is not "one state read twice".
const SIM_LABELS = ['none', 'review', 'handoff'] as const;
const SIM_MIX = [0.5, 0.3, 0.2] as const;
const SIM_RUNS = 10_000;
const SIM_SEED = 20261007;

/** P(a reading says label x | the state is label s) under the noise model above. */
function readingShare(s: number, x: number, flip: number): number {
  if (x === s) return 1 - flip;
  if (s === 1) return flip / 2;
  return x === 1 ? flip : 0;
}

type SimCounts = { 'counts-stable': number; 'threshold-shift': number; 'item-shift': number };

function simulateRepeatReadings(n: number, flip: number, noisyReadings: 'both' | 'new only'): SimCounts {
  const rng = mulberry32(SIM_SEED);
  const ids = Array.from({ length: n }, (_, i) => `s${String(i).padStart(3, '0')}`);
  const simPackets = new Map(ids.map((id) => [id, hashOf({ packet: id })]));
  const state = (): number => {
    const u = rng();
    return u < SIM_MIX[0] ? 0 : u < SIM_MIX[0] + SIM_MIX[1] ? 1 : 2;
  };
  const read = (s: number): number => {
    if (rng() >= flip) return s;
    if (s !== 1) return 1;
    return rng() < 0.5 ? 0 : 2;
  };
  const counts: SimCounts = { 'counts-stable': 0, 'threshold-shift': 0, 'item-shift': 0 };
  for (let r = 0; r < SIM_RUNS; r++) {
    const older = new Map<string, string>();
    const newer = new Map<string, string>();
    for (const id of ids) {
      const s = state();
      older.set(id, SIM_LABELS[noisyReadings === 'both' ? read(s) : s] as string);
      newer.set(id, SIM_LABELS[read(s)] as string);
    }
    counts[driftReport(older, newer, { labels: [...SIM_LABELS], flagLabels: ['handoff'], packetHashes: { old: simPackets, new: simPackets }, bootstrap: { iterations: 1 } }).classification]++;
  }
  return counts;
}

const notStable = (c: SimCounts): number => c['threshold-shift'] + c['item-shift'];

test('drift, a seeded simulation of this library\'s rule (not a reference value): one state read twice with BOTH readings noisy is classified other than counts-stable in 3,840 of 10,000 pairs at 24 items, 3,043 at 50 and 1,679 at 100 (flip 0.05), and 1,178 at 24 items with flip 0.02; no public document quotes a rate of this kind', () => {
  const cells = ([[24, 0.05], [50, 0.05], [100, 0.05], [24, 0.02]] as const).map(([n, flip]) => ({ n, flip, both: simulateRepeatReadings(n, flip, 'both'), one: simulateRepeatReadings(n, flip, 'new only') }));
  for (const c of cells) assert.equal(c.both['counts-stable'] + notStable(c.both), SIM_RUNS, `${c.n}, ${c.flip}`);
  // The pin: what this seed gives under this noise model. A change in the rule, the PRNG or the set-up moves it.
  assert.deepEqual(cells.map((c) => notStable(c.both)), [3840, 3043, 1679, 1178]);
  assert.deepEqual(cells.map((c) => c.both['item-shift']), [441, 202, 49, 77]);
  // Noise in one reading only gives fewer: a rate fitted to that arm understates "one state read twice".
  for (const c of cells) assert.ok(notStable(c.one) < notStable(c.both), `${c.n}, ${c.flip}: one noisy reading ${notStable(c.one)}, two ${notStable(c.both)}`);

  const flat = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const formatDoc = flat('../docs/RATINGS_FORMAT.md');
  const readme = flat('../README.md');
  // No public document puts a number on how often a repeated reading is called shifted.
  const rest = [
    formatDoc,
    readme,
    ...['../examples/refund-bot/README.md', '../CHANGELOG.md', '../docs/MIGRATIONS.md', '../src/drift.ts', '../src/cli.ts'].map(flat),
  ];
  for (const text of rest) assertNoRateBesideRepeatedReading(text);
});

// An independent recomputation of the SAMPLER, labelled as one: it shares driftReport with the simulation, so it
// checks that the simulated pairs follow the stated noise model, not the rule. On 4 items every pair of readings
// can be listed: an item's two readings (x, y) have probability sum over states s of mix(s) · P(x | s) · P(y | s),
// and the 9^4 = 6,561 combinations of four items carry the product. The exact share classified other than counts-stable
// is the sum over the combinations so classified; the simulated share of 10,000 pairs must lie within four
// standard errors, sqrt(p (1 − p) / 10,000), of it. The exact value is computed here, not typed in.
test('drift simulation, an independent recomputation of its sampler: on 4 items the simulated share of pairs classified other than counts-stable is within four standard errors of the share found by listing all 6,561 pairs of readings', () => {
  const flip = 0.05;
  const n = 4;
  const ids = Array.from({ length: n }, (_, i) => `s${String(i).padStart(3, '0')}`);
  const simPackets = new Map(ids.map((id) => [id, hashOf({ packet: id })]));
  const joint: { x: number; y: number; p: number }[] = [];
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) joint.push({ x, y, p: SIM_MIX.reduce((sum, m, s) => sum + m * readingShare(s, x, flip) * readingShare(s, y, flip), 0) });
  assert.ok(Math.abs(joint.reduce((sum, j) => sum + j.p, 0) - 1) < 1e-12);
  let exact = 0;
  let total = 0;
  const walk = (i: number, p: number, older: string[], newer: string[]): void => {
    if (i === n) {
      total += p;
      const r = driftReport(new Map(ids.map((id, k) => [id, older[k] as string])), new Map(ids.map((id, k) => [id, newer[k] as string])), { labels: [...SIM_LABELS], flagLabels: ['handoff'], packetHashes: { old: simPackets, new: simPackets }, bootstrap: { iterations: 1 } });
      if (r.classification !== 'counts-stable') exact += p;
      return;
    }
    for (const j of joint) walk(i + 1, p * j.p, [...older, SIM_LABELS[j.x] as string], [...newer, SIM_LABELS[j.y] as string]);
  };
  walk(0, 1, [], []);
  assert.ok(Math.abs(total - 1) < 1e-12);
  const simulated = notStable(simulateRepeatReadings(n, flip, 'both')) / SIM_RUNS;
  const se = Math.sqrt((exact * (1 - exact)) / SIM_RUNS);
  assert.ok(exact > 0.2 && exact < 0.5, `exact ${exact}`);
  assert.ok(Math.abs(simulated - exact) < 4 * se, `simulated ${simulated}, exact ${exact}, standard error ${se}`);
});

test('driftReport: flagLabels that are missing or not a list are invalid input naming the argument, never a bare TypeError', () => {
  for (const flagLabels of [undefined, null, 'handoff', 7, { 0: 'handoff' }]) {
    assert.throws(
      () => driftReport(base, base, { labels, flagLabels, packetHashes } as never),
      (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && e.problems.length === 1 && e.problems[0]?.startsWith('driftReport: flagLabels: required: a list of labels') === true,
      String(flagLabels),
    );
  }
  assert.throws(() => driftReport(base, base, { labels, packetHashes } as never), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT');
  // The empty list keeps its own message.
  assert.throws(() => driftReport(base, base, { labels, flagLabels: [], packetHashes }), (e: unknown) => e instanceof InputError && e.problems.join() === 'flagLabels must not be empty');
});
