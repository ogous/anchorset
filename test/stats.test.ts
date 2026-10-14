import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { InputError } from '../src/errors.ts';
import { bootstrapCI, fewResamplesWording, forEachResample, intervalWording, levelFloorAt, levelText, MAX_BRACKET_ALPHA, MAX_RESAMPLES, MIN_LEVEL_RESAMPLES, MIN_TAIL_RESAMPLES, NA, noLevelNote, resamplesText, nominalLevelCheck, nominalLevelOf, percentileInterval, placeAmong, resampleBracketWording, NOMINAL_CHECK_MAX_N, nonInferiority, normalQuantile, quantileSorted, resampleIndices, smallestConcordantPassN, spreadOf, tangoState, wilson, Z_95 } from '../src/stats.ts';
import { mulberry32, randomInt } from '../src/rng.ts';

const close = (a: number, b: number, dp: number): void => assert.ok(Math.abs(a - b) < 0.5 * 10 ** -dp, `${a} != ${b} to ${dp} dp`);

// The published reference values. R. G. Newcombe, "Two-sided confidence intervals for the single proportion:
// comparison of seven methods", Statistics in Medicine 17(8):857-872 (1998), Table I (p. 861), the row "Score method,
// 3 Without CC": 95 per cent limits for 81/263, 15/148, 0/20 and 1/29, printed to four places.
// Journal, volume, issue and pages checked against the Crossref record, 2026-10-07
// (doi:10.1002/(SICI)1097-0258(19980430)17:8<857::AID-SIM777>3.0.CO;2-E).
test('wilson matches Newcombe (1998), Table I, method 3, on all four of its examples', () => {
  const table: [number, number, number, number][] = [
    [81, 263, 0.2553, 0.3662],
    [15, 148, 0.0624, 0.1605],
    [0, 20, 0.0, 0.1611],
    [1, 29, 0.0061, 0.1718],
  ];
  for (const [r, n, lo, hi] of table) {
    const w = wilson(r, n);
    close(w.lo, lo, 4);
    close(w.hi, hi, 4);
  }
  assert.equal(wilson(0, 20).lo, 0);
});

// Hand-worked fixtures, not published reference values (an earlier version of this test named Newcombe (1998) for
// 0/10; the paper does not print that case). With z = 1.959964 and z^2 = 3.841459:
//   0/10: lo = 0, hi = z^2 / (n + z^2) = 3.841459 / 13.841459                    = 0.2775
//   5/10: centre 0.5, half-width z * sqrt(0.25/10 + z^2/400) / (1 + z^2/10)
//         = 1.959964 * sqrt(0.034604) / 1.384146 = 0.364594 / 1.384146           = 0.2634
test('wilson on 0/10 and 5/10, hand-worked: (0, 0.2775) and (0.2366, 0.7634)', () => {
  const b = wilson(0, 10);
  assert.equal(b.lo, 0);
  close(b.hi, 0.2775, 4);
  const w = wilson(5, 10);
  close(w.lo, 0.2366, 4);
  close(w.hi, 0.7634, 4);
  assert.equal(w.p, 0.5);
});

test('wilson n = 0 is a typed EMPTY_SAMPLE error; bad counts are invalid', () => {
  assert.throws(() => wilson(0, 0), (e: unknown) => e instanceof InputError && e.code === 'EMPTY_SAMPLE');
  assert.throws(() => wilson(3, 2), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT');
});

// A hand-worked fixture, not a published reference value; no published reference is claimed. The rule under test,
// as src/stats.ts states it: on n ascending values x[0..n−1] the quantile q sits at position h = (n − 1) · q and is
// x[floor(h)] + (h − floor(h)) · (x[floor(h) + 1] − x[floor(h)]). On 1, 2, 3, 4 (n = 4, so h = 3q):
//   q = 0.5:  h = 1.5,  x[1] + 0.5 · (x[2] − x[1])  = 2 + 0.5 · 1  = 2.5
//   q = 0:    h = 0,    x[0]                                        = 1
//   q = 1:    h = 3,    x[3] (no value above it; the weight is 0)   = 4
//   q = 0.25: h = 0.75, x[0] + 0.75 · (x[1] − x[0]) = 1 + 0.75 · 1 = 1.75
test('quantileSorted uses linear interpolation (type 7), a hand-worked fixture: on 1, 2, 3, 4 the quantiles 0.5, 0, 1 and 0.25 are 2.5, 1, 4 and 1.75', () => {
  assert.equal(quantileSorted([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantileSorted([1, 2, 3, 4], 0), 1);
  assert.equal(quantileSorted([1, 2, 3, 4], 1), 4);
  close(quantileSorted([1, 2, 3, 4], 0.25), 1.75, 9);
});

test('bootstrapCI is deterministic per seed and brackets the estimate', () => {
  const data = Array.from({ length: 40 }, (_, i) => (i * 7919) % 101);
  const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
  const opts = { iterations: 1000, seed: 3, alpha: 0.05 };
  const r1 = bootstrapCI(data, mean, opts);
  const r2 = bootstrapCI(data, mean, opts);
  assert.deepEqual(r1, r2);
  assert.ok(r1.lo < r1.estimate && r1.estimate < r1.hi);
  assert.notDeepEqual(bootstrapCI(data, mean, { ...opts, seed: 4 }), r1);
  const constant = bootstrapCI([5, 5, 5], mean, opts);
  assert.equal(constant.lo, 5);
  assert.equal(constant.hi, 5);
});

test('bootstrapCI works on paired data and counts undefined resamples', () => {
  const pairs: [number, number][] = [[1, 1], [0, 1], [1, 0], [1, 1], [0, 0]];
  const r = bootstrapCI(pairs, (s) => s.filter(([a, b]) => a === b).length / s.length, { iterations: 200, seed: 1, alpha: 0.1 });
  assert.ok(r.lo >= 0 && r.hi <= 1);
  const nanSometimes = bootstrapCI([0, 1], (s) => (s.every((x) => x === s[0]) ? Number.NaN : 1), { iterations: 200, seed: 1, alpha: 0.1 });
  assert.ok(nanSometimes.undefinedResamples > 0);
  assert.throws(() => bootstrapCI([], () => 1, { iterations: 10, seed: 1, alpha: 0.1 }), InputError);
  assert.throws(() => bootstrapCI([1], () => 1, { iterations: 10, seed: -1, alpha: 0.1 }), InputError);
});

// A published reference value: the check values printed with the algorithm itself. M. J. Wichura, "Algorithm AS 241:
// The Percentage Points of the Normal Distribution", Applied Statistics 37(3) (1988), from p. 477, doi:10.2307/2347330,
// routine PPND16. Title, journal, volume, issue and first page checked against the Crossref record, 2026-10-07; the
// record does not give the last page, so none is written here.
// The lines after the three check values are properties (symmetry, monotonicity), not reference values.
test('normalQuantile matches the check values printed with AS 241 (Wichura 1988), and the existing Z_95', () => {
  // PPND16's own test values: p = 0.25, 0.001 and 1e-20.
  assert.ok(Math.abs(normalQuantile(0.25) - -0.6744897501960817) < 1e-15);
  assert.ok(Math.abs(normalQuantile(0.001) - -3.090232306167814) < 1e-14);
  assert.ok(Math.abs(normalQuantile(1e-20) - -9.262340089798408) < 1e-13);
  assert.ok(Math.abs(normalQuantile(0.975) - Z_95) < 1e-14);
  assert.equal(normalQuantile(0.5), 0);
  // Symmetric, and increasing across the three branches of the algorithm.
  for (const p of [1e-6, 0.01, 0.074, 0.075, 0.3, 0.49]) assert.ok(Math.abs(normalQuantile(p) + normalQuantile(1 - p)) < 1e-9, String(p));
  const grid = [1e-30, 1e-12, 1e-11, 0.01, 0.0749, 0.0751, 0.5, 0.9249, 0.9251, 0.999];
  grid.slice(1).forEach((p, i) => assert.ok(normalQuantile(p) > normalQuantile(grid[i] as number), String(p)));
  for (const bad of [0, 1, -0.1, 1.5, Number.NaN]) assert.throws(() => normalQuantile(bad), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT');
});

const ni = (n: number, n10: number, n01: number, margin: number, alpha = 0.05) => nonInferiority({ n, n10, n01 }, { margin, alpha });
const zOf = (n: number, n10: number, n01: number, margin: number): number => ni(n, n10, n01, margin).z as number;

// The published reference values. T. Tango, "Equivalence test and confidence interval for the difference in
// proportions for the paired-sample design", Statistics in Medicine 17:891-908 (1998), section 6 (Tables V and VII),
// with the statistic and the p-value as the test's own comments quote them. The DOI is not on file.
test('nonInferiority matches Tango (1998): the two worked examples of section 6', () => {
  // Section 6.1, Table V: n = 44, one pair worse under the new condition, margin 0.1: Z = 1.709, one-sided p = 0.044.
  close(zOf(44, 1, 0, 0.1), 1.709, 3);
  assert.equal(ni(44, 1, 0, 0.1).state, 'PASS');
  // p = 0.044: the same table passes at level 0.044 and not at 0.043.
  assert.equal(ni(44, 1, 0, 0.1, 0.044).state, 'PASS');
  assert.equal(ni(44, 1, 0, 0.1, 0.043).state, 'INCONCLUSIVE');
  // Section 6.2, Table VII: n = 32, discordant 9 and 3, margin 0: Z = 1.73, which is McNemar's (9 − 3) / sqrt(12).
  close(zOf(32, 3, 9, 0), 1.73, 2);
  close(zOf(32, 3, 9, 0), 6 / Math.sqrt(12), 12);
});

test('nonInferiority: argument order, the three states and the boundary, worked by hand', () => {
  // n10 is "passed under the baseline, failed under the candidate". Swapping the two changes the answer.
  close(zOf(44, 0, 1, 0.1), 2.449, 3);
  close(zOf(32, 9, 3, 0), -1.73, 2);
  // n = 80, 12 worse and 6 better, margin 0.1: a = 160, b = −34.6, c = 1.32, p = 0.16678, variance 17.885.
  close((34.6 + Math.sqrt(34.6 ** 2 - 4 * 160 * 1.32)) / 320, 0.1668, 4);
  close(80 * (2 * 0.166785 - 0.1 * 1.1), 17.885, 2);
  close(zOf(80, 12, 6, 0.1), (6 - 12 + 8) / Math.sqrt(17.885), 3);
  close(zOf(80, 12, 6, 0.1), 0.4729, 4);
  assert.equal(ni(80, 12, 6, 0.1).state, 'INCONCLUSIVE');
  // No discordant pair: b = −2n·margin and c = 0, so p = margin, the variance is n·(2·margin − margin·(1 + margin))
  // = n·margin·(1 − margin), and z = n·margin / sqrt(n·margin·(1 − margin)) = sqrt(n·margin / (1 − margin)).
  close(zOf(80, 0, 0, 0.1), Math.sqrt((80 * 0.1) / 0.9), 12);
  close(zOf(80, 0, 0, 0.1), 2.9814, 4);
  // Twenty worse and two better of 80 is a regression. a = 160, b = −22 − 0.1·(160 − 2 + 20) = −39.8, c = 20·0.1·1.1 = 2.2;
  // the discriminant is 39.8² − 4·160·2.2 = 176.04, p = (39.8 + 13.268) / 320 = 0.16584, the variance is
  // 80·(0.33167 − 0.11) = 17.734, and z = (2 − 20 + 8) / sqrt(17.734) = −2.3746, below −1.645.
  close((39.8 + Math.sqrt(176.04)) / 320, 0.16584, 5);
  close(-10 / Math.sqrt(80 * (2 * 0.165837 - 0.11)), -2.3746, 4);
  close(zOf(80, 20, 2, 0.1), -2.3746, 4);
  assert.equal(ni(80, 20, 2, 0.1).state, 'REGRESSION');
  // PASS is strict. A z exactly at the critical value is INCONCLUSIVE: sqrt(n/9) = 2 at n = 36, and Φ⁻¹(1 − alpha) = 2 at this alpha.
  const alphaAtTwo = 0.022750131948179195;
  close(normalQuantile(1 - alphaAtTwo), 2, 12);
  assert.equal(zOf(36, 0, 0, 0.1), 2);
  assert.equal(nonInferiority({ n: 36, n10: 0, n01: 0 }, { margin: 0.1, alpha: 0.03 }).state, 'PASS');
  assert.equal(nonInferiority({ n: 36, n10: 0, n01: 0 }, { margin: 0.1, alpha: 0.02 }).state, 'INCONCLUSIVE');
  // Evaluated exactly at the critical value, in both tails: neither PASS nor REGRESSION.
  assert.deepEqual(tangoState({ n: 36, n10: 0, n01: 0 }, 0.1, 2), { z: 2, state: 'INCONCLUSIVE' });
  assert.equal(tangoState({ n: 36, n10: 0, n01: 0 }, 0.1, 2 - 1e-12).state, 'PASS');
  const worse = zOf(80, 20, 2, 0.1);
  assert.equal(tangoState({ n: 80, n10: 20, n01: 2 }, 0.1, -worse).state, 'INCONCLUSIVE');
  assert.equal(tangoState({ n: 80, n10: 20, n01: 2 }, 0.1, -worse - 1e-12).state, 'REGRESSION');
  // The discriminant is exactly 0 at (33, 6, 0) with margin 0.1; rounding must not turn it into NaN.
  close(zOf(33, 6, 0, 0.1), -1.5667, 4);
  // Margin 0 with no discordant pair: 0 / 0. The statistic is NA and nothing is concluded.
  assert.deepEqual([ni(50, 0, 0, 0).z, ni(50, 0, 0, 0).state], [NA, 'INCONCLUSIVE']);
  const r = ni(44, 1, 0, 0.1);
  assert.deepEqual([r.margin, r.alpha], [0.1, 0.05]);
  close(r.critical, 1.6448536269514722, 12);
});

test('nonInferiority has no defaults and refuses counts that are not a table', () => {
  const bad = (f: () => unknown, code = 'INVALID_ARGUMENT'): void => assert.throws(f, (e: unknown) => e instanceof InputError && e.code === code);
  bad(() => ni(10, 6, 5, 0.1));
  bad(() => ni(10, -1, 0, 0.1));
  bad(() => ni(10.5, 1, 0, 0.1));
  bad(() => ni(10, 1, 0, -0.1));
  bad(() => ni(10, 1, 0, 1));
  bad(() => ni(10, 1, 0, 0.1, 0));
  bad(() => ni(10, 1, 0, 0.1, 0.5));
  bad(() => nonInferiority({ n: 10, n10: 1, n01: 0 }, {} as { margin: number; alpha: number }));
  bad(() => ni(0, 0, 0, 0.1), 'EMPTY_SAMPLE');
});

// Defined by this library (the smallest n at which a table with no discordant pair passes the gate above); no
// published reference is claimed. A hand-worked fixture: with no discordant pair the statistic is
// sqrt(n · margin / (1 − margin)), and the arithmetic for each margin is written out in the test.
// Two corners the plan parser admits, in which the statistic is undefined at every n (the variance is exactly 0 at the
// margin 1 − 2⁻⁵³; the critical value is exactly 0 with a denormal margin): NA, and the call returns. A loop that never
// ends cannot be interrupted from inside its own process, so the call runs in a child that is killed after the timeout.
test('smallestConcordantPassN returns NA, and returns at all, where the statistic is undefined at every n', { timeout: 20000 }, () => {
  const src = fileURLToPath(new URL('../src/stats.ts', import.meta.url));
  const call = (margin: number, alpha: number): string => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { smallestConcordantPassN } from ${JSON.stringify(src)}; console.log(smallestConcordantPassN({ margin: ${margin}, alpha: ${alpha} }));`], { encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, `margin ${margin}, alpha ${alpha}: ${r.error?.message ?? r.stderr}`);
    return r.stdout.trim();
  };
  assert.equal(call(0.9999999999999999, 0.05), NA);
  assert.equal(call(5e-324, 0.49999999999999994), NA);
  assert.equal(call(0.1, 0.05), '25');
});

test('smallestConcordantPassN, defined by this library, a hand-worked fixture: 25, 52 and 133; it is not the smallest n at which PASS is possible', () => {
  // z² (1 − margin) / margin with z = 1.6449: 24.35, 51.40, 132.57. PASS is strict, so the next integer.
  assert.deepEqual([0.1, 0.05, 0.02].map((margin) => smallestConcordantPassN({ margin, alpha: 0.05 })), [25, 52, 133]);
  close(zOf(24, 0, 0, 0.1), 1.633, 3);
  close(zOf(25, 0, 0, 0.1), 1.667, 3);
  assert.deepEqual([ni(24, 0, 0, 0.1).state, ni(25, 0, 0, 0.1).state], ['INCONCLUSIVE', 'PASS']);
  assert.equal(smallestConcordantPassN({ margin: 0, alpha: 0.05 }), NA);
  // The level enters it: at alpha 0.01, z = 2.3263 and z²·0.9/0.1 = 48.7.
  assert.equal(smallestConcordantPassN({ margin: 0.1, alpha: 0.01 }), 49);
  // A margin too small for an exact integer answer returns at once, instead of counting upward for ever.
  assert.equal(smallestConcordantPassN({ margin: 1e-17, alpha: 0.05 }), NA);
  // The property that defines it, over a grid of margins and levels.
  for (const margin of [0.01, 0.03, 0.1, 0.25, 0.5]) {
    for (const alpha of [0.01, 0.025, 0.05, 0.1]) {
      const n = smallestConcordantPassN({ margin, alpha }) as number;
      assert.equal(ni(n, 0, 0, margin, alpha).state, 'PASS');
      if (n > 1) assert.equal(ni(n - 1, 0, 0, margin, alpha).state, 'INCONCLUSIVE');
    }
  }
  // A candidate that fixes cases passes far below it: three fixed of three is z = 1.9149; two of two is 1.5635.
  close(zOf(3, 0, 3, 0.1), 1.9149, 4);
  assert.equal(ni(3, 0, 3, 0.1).state, 'PASS');
  close(zOf(2, 0, 2, 0.1), 1.5635, 4);
  assert.equal(ni(2, 0, 2, 0.1).state, 'INCONCLUSIVE');
});

test('resampleIndices is the one index generator: the draws bootstrapCI makes, in the same order', () => {
  const a = mulberry32(11);
  const b = mulberry32(11);
  assert.deepEqual(resampleIndices(a, 7), Array.from({ length: 7 }, () => randomInt(b, 7)));
  assert.ok(resampleIndices(mulberry32(3), 50).every((i) => Number.isInteger(i) && i >= 0 && i < 50));
  // The bootstrap's own pins: the same seed gives the same interval as before the generator was lifted out.
  const data = Array.from({ length: 40 }, (_, i) => (i * 7919) % 101);
  const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
  const rng = mulberry32(3);
  const byHand = Array.from({ length: 200 }, () => mean(Array.from({ length: 40 }, () => data[randomInt(rng, 40)] as number))).sort((x, y) => x - y);
  const r = bootstrapCI(data, mean, { iterations: 200, seed: 3, alpha: 0.05 });
  assert.deepEqual([r.lo, r.hi], [quantileSorted(byHand, 0.025), quantileSorted(byHand, 0.975)]);
});

test('spreadOf describes the replicates: worked by hand on 1, 2, 3, 4 around a point of 2', () => {
  // Mean 2.5, so the bias is 0.5. Squared deviations 2.25 + 0.25 + 0.25 + 2.25 = 5, over n − 1 = 3: sd = sqrt(5/3).
  const s = spreadOf(2, [3, 1, 4, 2]);
  assert.deepEqual([s.replicates, s.undefinedReplicates, s.meanMinusPoint], [4, 0, 0.5]);
  close(s.sd as number, Math.sqrt(5 / 3), 12);
  // Type-7 percentiles of 1, 2, 3, 4: position 3q. 0.075 → 1.075; 1.5 → 2.5; 2.925 → 3.925.
  close(s.p025 as number, 1.075, 12);
  close(s.p50 as number, 2.5, 12);
  close(s.p975 as number, 3.925, 12);
  assert.deepEqual([s.shareBelow0, s.shareAt0, s.shareAbove0], [0, 0, 1]);
  assert.deepEqual(Object.values(spreadOf(0, [-1, 0, 0, 2])).slice(7), [0.25, 0.5, 0.25]);
  // An undefined replicate is counted; with fewer than two computed, nothing is reported.
  const u = spreadOf(1, [1, Number.NaN, 3]);
  assert.deepEqual([u.replicates, u.undefinedReplicates], [2, 1]);
  const none = spreadOf(1, [1, Number.NaN]);
  assert.deepEqual([none.replicates, none.undefinedReplicates, none.sd, none.p50, none.meanMinusPoint, none.shareAt0], [1, 1, NA, NA, NA, NA]);
  assert.equal(spreadOf(5, [5, 5, 5]).sd, 0);
});

test('forEachResample is the one driver: one index list per stratum, in order, from one generator', () => {
  const seen: number[][][] = [];
  forEachResample(5, [4, 0, 2], 3, (idx) => seen.push(idx));
  const rng = mulberry32(5);
  const byHand = Array.from({ length: 3 }, () => [resampleIndices(rng, 4), [], resampleIndices(rng, 2)]);
  assert.deepEqual(seen, byHand);
});

// A hand-worked fixture at n = 3 and an independent recomputation at n = 12; neither is a published reference value.
test('nominalLevelCheck: the gate\u2019s actual error rates, a hand-worked fixture at n = 3 and an independent recomputation at n = 12', () => {
  // n = 3, margin 0.1, alpha 0.05, a hand-worked fixture. What was worked by hand is the probability, not the gate's
  // calls: On the null boundary p10 = p01 + 0.1, so p01 is at most 0.45, and if "nobody worse, three better" is the
  // only table that passes, P(pass) = p01^3, which is largest there: 0.45^3 = 0.091125. That it is the only table, and
  // that none of the ten is a REGRESSION, is read from the gate's own output, not worked by hand. The z values it gives
  // at (worse, better) = (0,0) 0.577, (0,1) 1.202, (0,2) 1.599, (0,3) 1.915, (1,0) -0.798, (1,1) 0.213, (1,2) 0.754,
  // (2,0) -1.243, (2,1) -0.406, (3,0) -1.567, against the critical value 1.645: only (0,3) is above it, and none
  // is below -1.645. The equality below would fail if another table passed.
  const three = nominalLevelCheck(3, { margin: 0.1, alpha: 0.05 });
  close(three.falsePass as number, 0.45 ** 3, 12);
  assert.equal(three.falseRegression, 0);
  // An independent recomputation for n = 12, not a second definition: every table, every grid point, the trinomial
  // probability written out. It shares the author's reading of the definition and checks the arithmetic.
  const fact = (k: number): number => (k <= 1 ? 1 : k * fact(k - 1));
  const n = 12;
  let pass = 0;
  let regression = 0;
  for (let i = 0; i <= 450; i++) {
    const p01 = i / 1000;
    const p10 = p01 + 0.1;
    let pP = 0;
    let pR = 0;
    for (let a = 0; a <= n; a++) {
      for (let b = 0; a + b <= n; b++) {
        const state = nonInferiority({ n, n10: a, n01: b }, { margin: 0.1, alpha: 0.05 }).state;
        const prob = (fact(n) / (fact(a) * fact(b) * fact(n - a - b))) * p10 ** a * p01 ** b * (1 - p10 - p01) ** (n - a - b);
        if (state === 'PASS') pP += prob;
        if (state === 'REGRESSION') pR += prob;
      }
    }
    pass = Math.max(pass, pP);
    regression = Math.max(regression, pR);
  }
  const twelve = nominalLevelCheck(12, { margin: 0.1, alpha: 0.05 });
  close(twelve.falsePass as number, pass, 10);
  close(twelve.falseRegression as number, regression, 10);
  // Both rates are above the nominal 0.05 at n = 25 and n = 100: the level is nominal, at small n and at large n.
  // This is a bound, not a pinned value; the values at n = 25 and n = 100 are pinned in the next test, by an
  // independent recomputation.
  for (const m of [25, 100]) {
    const r = nominalLevelCheck(m, { margin: 0.1, alpha: 0.05 });
    assert.ok((r.falsePass as number) > 0.05 && (r.falseRegression as number) > 0.05, JSON.stringify(r));
  }
  assert.deepEqual(nominalLevelCheck(NOMINAL_CHECK_MAX_N + 1, { margin: 0.1, alpha: 0.05 }), { falsePass: NA, falseRegression: NA, grid: 0.001 });
  assert.throws(() => nominalLevelCheck(10, { margin: 0, alpha: 0.05 }), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT');
});

test('nominalLevelCheck: the false-PASS rates the docs print at margin 0.10 and alpha 0.05: 0.091 at n = 3, 0.072 at n = 25, 0.058 at n = 100', () => {
  // docs/JUDGE_CHANGE.md, prints these three numbers. No published table gives them: they are this
  // library's own enumeration, so the pin is a hand-worked fixture where one exists (n = 3) and, for n = 25 and
  // n = 100, an independent recomputation: a second enumeration written out here in plain products, with no code
  // shared with stats.ts but the gate itself (nonInferiority), whose two worked examples from Tango (1998) are
  // pinned above. It shares the author's reading of the definition, so it checks the arithmetic and not the definition.
  //
  // The enumeration. A table of n cases is (n10, n01, n − n10 − n01): cases where the baseline passes and the
  // candidate fails, the reverse, and the rest. On the null boundary the candidate is exactly the margin worse:
  // p10 = p01 + 0.10, with the nuisance share p01 on the grid 0, 0.001, ..., 0.450 (451 points; above 0.45 the
  // three shares would exceed 1). At each grid point the false-PASS rate is the sum, over every table the gate
  // calls PASS, of the trinomial probability n! / (n10! n01! rest!) · p10^n10 · p01^n01 · (1 − p10 − p01)^rest.
  // The reported rate is the largest of the 451 sums: the largest found on the grid, not a proven supremum.
  const fact = (k: number): number => (k <= 1 ? 1 : k * fact(k - 1));
  const largestFalsePass = (n: number): number => {
    const passing: [number, number][] = [];
    for (let a = 0; a <= n; a++) for (let b = 0; a + b <= n; b++) if (nonInferiority({ n, n10: a, n01: b }, { margin: 0.1, alpha: 0.05 }).state === 'PASS') passing.push([a, b]);
    let worst = 0;
    for (let i = 0; i <= 450; i++) {
      const p01 = i / 1000;
      const p10 = p01 + 0.1;
      let sum = 0;
      for (const [a, b] of passing) sum += (fact(n) / (fact(a) * fact(b) * fact(n - a - b))) * p10 ** a * p01 ** b * (1 - p10 - p01) ** (n - a - b);
      worst = Math.max(worst, sum);
    }
    return worst;
  };
  const rate = (n: number): number => nominalLevelCheck(n, { margin: 0.1, alpha: 0.05 }).falsePass as number;
  // n = 3, a hand-worked fixture: only "nobody worse, three better" passes (see the previous test for what was worked
  // by hand and what is the gate's own output), and p01^3 is largest at p01 = 0.45: 0.45^3 = 0.091125.
  close(rate(3), 0.091125, 12);
  // n = 25 and n = 100, an independent recomputation: 0.0718 and 0.0576 to four places, each equal to the plain
  // enumeration above.
  close(rate(25), 0.0718, 4);
  close(rate(100), 0.0576, 4);
  close(rate(25), largestFalsePass(25), 10);
  close(rate(100), largestFalsePass(100), 10);
  // As the document prints them, to three places.
  assert.deepEqual([3, 25, 100].map((n) => rate(n).toFixed(3)), ['0.091', '0.072', '0.058']);
});

// The floor is this library's convention, not a published value; the test pins the convention and what it does.
// A fixture worked by hand: with R resamples the type-7 quantile sits at position (R − 1) · q, counted from 0.
//   R = 3, alpha 0.05: positions 0.05 and 1.95, so "lo" and "hi" are nearly the smallest and the largest of three
//   numbers. Nothing about three numbers supports the words "95%".
//   R = 1,000: positions 24.975 and 974.025, so 25 resamples (the 25 at positions 0 to 24) lie below "lo".
test(`a bracket is named with a level only from ${MIN_LEVEL_RESAMPLES} resamples; from 1 to 999 it is percentiles of the resamples with no level (the floor is this library's convention)`, () => {
  assert.equal(MIN_LEVEL_RESAMPLES, 1000);
  assert.equal(MAX_BRACKET_ALPHA, 0.2);
  const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const mean = (s: readonly number[]): number => s.reduce((x, y) => x + y, 0) / s.length;
  for (const iterations of [1, 2, 3, 41, 200, 999]) {
    const r = bootstrapCI(data, mean, { iterations, seed: 3, alpha: 0.05 });
    assert.equal(r.nominalLevel, NA, `${iterations} resamples`);
    assert.ok(r.lo <= r.hi);
    const ci = percentileInterval(data, mean, { iterations, seed: 3, alpha: 0.05 });
    assert.ok(ci !== NA && ci.nominalLevel === NA && ci.iterations === iterations);
    const words = resampleBracketWording('items', 'the labels', { iterations, alpha: 0.05 });
    assert.equal(words, fewResamplesWording('items', 'the labels', iterations, 0.05));
    assert.doesNotMatch(words, /nominal|interval|bootstrap|%/);
    assert.match(words, /with no level/);
  }
  assert.equal(fewResamplesWording('items', 'the labels', 3, 0.05), 'percentiles over 3 resamples of items, the labels held fixed, with no level: a level is named from 1000 resamples on which the statistic is defined');
  assert.equal(fewResamplesWording('cases', 'the labels', 1, 0.05), 'percentiles over 1 resample of cases, the labels held fixed, with no level: a level is named from 1000 resamples on which the statistic is defined');
  // Three resamples, by hand: the percentiles are 0.05 and 1.95 of the way through the three sorted means.
  const three: number[] = [];
  forEachResample(3, [data.length], 3, ([idx]) => three.push(mean((idx as number[]).map((i) => data[i] as number))));
  three.sort((x, y) => x - y);
  const r3 = bootstrapCI(data, mean, { iterations: 3, seed: 3, alpha: 0.05 });
  const [s0, s1, s2] = three as [number, number, number];
  assert.ok(Math.abs(r3.lo - (s0 + 0.05 * (s1 - s0))) < 1e-12 && Math.abs(r3.hi - (s1 + 0.95 * (s2 - s1))) < 1e-12);
  // At the floor and above: the level is 1 − alpha, and the one wording names it.
  for (const iterations of [1000, 2000]) {
    assert.equal(bootstrapCI(data, mean, { iterations, seed: 3, alpha: 0.05 }).nominalLevel, 0.95);
    assert.equal(resampleBracketWording('items', 'the labels', { iterations, alpha: 0.05 }), intervalWording('items', 'the labels', '95%'));
  }
  assert.equal(nominalLevelOf({ iterations: 1000, alpha: 0.1 }), 0.9);
  assert.equal(nominalLevelOf({ iterations: 999, alpha: 0.1 }), NA);
  assert.equal(levelText(0.05), '95%');
  assert.equal(levelText(0.025), '97.5%');
  // At 1,000 resamples exactly 25 lie below the 2.5th percentile's position (24.975).
  assert.equal(Math.floor((1000 - 1) * 0.025) + 1, 25);
});

// The level is decided on the resamples the percentiles are read from. A hand-worked fixture, not a published value:
// the statistic is undefined on a resample whose first drawn value is 1 or 2 (it returns NaN), and the data are 1..10,
// so it is undefined with probability 2/10 on each resample. The count on a given seed is whatever the seeded
// generator gives, counted here by an independent pass over the same resamples (forEachResample, the one driver).
test('a bracket is given a level on the resamples its statistic was defined on, not on the resamples asked for: 1,000 asked with some undefined has no level (a hand-worked fixture)', () => {
  const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const stat = (s: readonly number[]): number => ((s[0] as number) <= 2 ? Number.NaN : s.reduce((x, y) => x + y, 0) / s.length);
  const undefinedAt = (iterations: number): number => {
    let n = 0;
    forEachResample(5, [data.length], iterations, ([idx]) => { if ((data[(idx as number[])[0] as number] as number) <= 2) n++; });
    return n;
  };
  const u1000 = undefinedAt(1000);
  assert.ok(u1000 > 150 && u1000 < 250, String(u1000));
  const r = bootstrapCI(data, stat, { iterations: 1000, seed: 5, alpha: 0.05 });
  assert.deepEqual([r.iterations, r.undefinedResamples, r.nominalLevel], [1000, u1000, NA]);
  const ci = percentileInterval(data, stat, { iterations: 1000, seed: 5, alpha: 0.05 });
  assert.ok(ci !== NA && ci.nominalLevel === NA && ci.undefinedResamples === u1000);
  // The mark a report puts on such a row, and only on such a row.
  assert.equal(noLevelNote(r), `no level: read from ${1000 - u1000} resamples, and a level is named from 1000`);
  assert.equal(noLevelNote({ iterations: 1000, alpha: 0.05, undefinedResamples: 0 }), '');
  assert.equal(noLevelNote({ iterations: 1000, alpha: 0.05, undefinedResamples: 1 }), 'no level: read from 999 resamples, and a level is named from 1000');
  // A report that already has no level anywhere does not mark its rows: its one wording says so.
  assert.equal(noLevelNote({ iterations: 500, alpha: 0.05, undefinedResamples: 100 }), '');
  // 2,000 asked: about 1,600 are defined, above the floor, and the level is back.
  const u2000 = undefinedAt(2000);
  const r2 = bootstrapCI(data, stat, { iterations: 2000, seed: 5, alpha: 0.05 });
  assert.ok(2000 - u2000 >= 1000);
  assert.deepEqual([r2.undefinedResamples, r2.nominalLevel], [u2000, 0.95]);
  // The boundary, on the function that decides it: 1,000 defined has the level, 999 does not.
  assert.equal(nominalLevelOf({ iterations: 1367, alpha: 0.05, undefinedResamples: 367 }), 0.95);
  assert.equal(nominalLevelOf({ iterations: 1366, alpha: 0.05, undefinedResamples: 367 }), NA);
  assert.equal(nominalLevelOf({ iterations: 1000, alpha: 0.05, undefinedResamples: 367 }), NA);
});

// A hand-worked fixture, not a published value: the tail rule is this library's convention, like the floor.
// A level is named only when (defined resamples) x alpha / 2 >= 25, and never from fewer than 1,000:
//   alpha 0.2:    2 x 25 / 0.2    =     250, below the floor, so 1,000
//   alpha 0.1:    2 x 25 / 0.1    =     500, below the floor, so 1,000
//   alpha 0.05:   2 x 25 / 0.05   =   1,000: the floor itself (1,000 x 0.025 = 25)
//   alpha 0.025:  2 x 25 / 0.025  =   2,000
//   alpha 0.01:   2 x 25 / 0.01   =   5,000   (at 1,000 resamples only 1,000 x 0.005 = 5 lie beyond each percentile)
//   alpha 0.001:  2 x 25 / 0.001  =  50,000   (at 1,000: 0.5)
//   alpha 0.0001: 2 x 25 / 0.0001 = 500,000   (at 1,000 the positions are 999 x 0.00005 = 0.04995 and 998.95005 of
//                                              0..999: the smallest and the largest resample, almost exactly)
//   alpha 0.00004: 1,250,000, above the 1,000,000 resamples that may be drawn: no bracket at this alpha has a level
test('a small alpha does not buy a level: one is named only with 25 resamples beyond each percentile, so alpha 0.01 needs 5,000 and alpha 0.0001 needs 500,000 (a hand-worked fixture)', () => {
  assert.equal(MIN_TAIL_RESAMPLES, 25);
  assert.deepEqual([0.2, 0.1, 0.05, 0.025, 0.01, 0.001, 0.0001].map(levelFloorAt), [1000, 1000, 1000, 2000, 5000, 50000, 500000]);
  assert.ok(levelFloorAt(0.00004) === 1250000 && levelFloorAt(0.00004) > MAX_RESAMPLES);
  for (const [alpha, floor, level] of [[0.025, 2000, 0.975], [0.01, 5000, 0.99], [0.001, 50000, 0.999], [0.0001, 500000, 0.9999]] as const) {
    assert.equal(nominalLevelOf({ iterations: floor, alpha }), level, String(alpha));
    assert.equal(nominalLevelOf({ iterations: floor - 1, alpha }), NA, String(alpha));
    assert.equal(nominalLevelOf({ iterations: 1000, alpha }), NA, String(alpha));
  }
  // The case: 1,000 resamples at alpha 0.0001 printed "nominal 99.99%" over the two extreme resamples.
  const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const mean = (s: readonly number[]): number => s.reduce((x, y) => x + y, 0) / s.length;
  const r = bootstrapCI(data, mean, { iterations: 1000, seed: 3, alpha: 0.0001 });
  assert.equal(r.nominalLevel, NA);
  const all: number[] = [];
  forEachResample(3, [data.length], 1000, ([idx]) => all.push(mean((idx as number[]).map((i) => data[i] as number))));
  all.sort((x, y) => x - y);
  // lo is within 5% of the gap between the two smallest resamples of the smallest; hi the same at the top.
  assert.ok(r.lo >= (all[0] as number) && r.lo <= (all[1] as number) && r.hi <= (all[999] as number) && r.hi >= (all[998] as number));
  const words = resampleBracketWording('items', 'the labels', { iterations: 1000, alpha: 0.0001 });
  assert.equal(words, 'percentiles over 1000 resamples of items, the labels held fixed, with no level: a level is named from 500000 resamples on which the statistic is defined');
  assert.doesNotMatch(words, /nominal|interval|bootstrap|%/);
  assert.equal(resampleBracketWording('items', 'the labels', { iterations: 5000, alpha: 0.01 }), intervalWording('items', 'the labels', '99%'));
  assert.equal(resampleBracketWording('items', 'the labels', { iterations: 4999, alpha: 0.01 }), fewResamplesWording('items', 'the labels', 4999, 0.01));
});

// 1 − 0.07 is 0.9299999999999999 in floating point; a recorded report is hashed, so the level is stored as printed.
test('the level a report records is 1 − alpha to eight places, never its floating-point remainder: alpha 0.07 gives 0.93', () => {
  assert.equal(1 - 0.07, 0.9299999999999999);
  assert.equal(nominalLevelOf({ iterations: 1000, alpha: 0.07 }), 0.93);
  assert.equal(bootstrapCI([1, 2, 3, 4], (s) => s[0] as number, { iterations: 1000, seed: 1, alpha: 0.07 }).nominalLevel, 0.93);
  assert.deepEqual([0.05, 0.1, 0.2, 0.15, 0.07, 0.06].map((alpha) => nominalLevelOf({ iterations: 1000, alpha })), [0.95, 0.9, 0.8, 0.85, 0.93, 0.94]);
  assert.equal(resamplesText(1), '1 resample');
  assert.equal(resamplesText(2), '2 resamples');
});

test('a bracket is refused at any alpha above 0.2, whatever the number of resamples: alpha 0.9 would print a 10% "interval"', () => {
  const bad = (alpha: number): void => assert.throws(() => bootstrapCI([1, 2, 3], (s) => s[0] as number, { iterations: 2000, seed: 1, alpha }), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && /alpha must be in \(0, 0\.2\]/.test(e.problems[0] as string), String(alpha));
  for (const alpha of [0, -0.05, 0.2000001, 0.5, 0.9, 0.999, 1, Number.NaN]) bad(alpha);
  for (const alpha of [0.001, 0.05, 0.1, 0.2]) assert.equal(bootstrapCI([1, 2, 3], (s) => s[0] as number, { iterations: 1000, seed: 1, alpha }).alpha, alpha);
  // percentileInterval turns "undefined on every resample" into NA, and nothing else: a bad alpha still throws.
  assert.throws(() => percentileInterval([1, 2, 3], (s) => s[0] as number, { iterations: 2000, seed: 1, alpha: 0.9 }), InputError);
});

// A hand-worked fixture, not a published reference value; the statistic is three counts.
//   values 3, 5, 5, 7, 9, 9, 9 around a reported 5: below {3} = 1, equal {5, 5} = 2, above {7, 9, 9, 9} = 4; 1 + 2 + 4 = 7
//   around a reported 6, which is not among them: below {3, 5, 5} = 3, equal 0, above 4
//   around a reported 2: 0, 0, 7.  Around 9: below 4, equal 3, above 0.
test('placeAmong, a hand-worked fixture: around 5 the values 3, 5, 5, 7, 9, 9, 9 are 1 below, 2 equal, 4 above; the three counts sum to the number of values', () => {
  const xs = [9, 3, 5, 9, 7, 5, 9];
  assert.deepEqual(placeAmong(5, xs), { below: 1, equal: 2, above: 4 });
  assert.deepEqual(placeAmong(6, xs), { below: 3, equal: 0, above: 4 });
  assert.deepEqual(placeAmong(2, xs), { below: 0, equal: 0, above: 7 });
  assert.deepEqual(placeAmong(9, xs), { below: 4, equal: 3, above: 0 });
  assert.deepEqual(placeAmong(-1, [-1]), { below: 0, equal: 1, above: 0 });
  // Properties: the order of the values does not matter, and mirroring swaps below and above.
  for (const r of [2, 3, 5, 6, 9, 10]) {
    const p = placeAmong(r, xs);
    assert.equal(p.below + p.equal + p.above, xs.length);
    assert.deepEqual(placeAmong(r, [...xs].reverse()), p);
    assert.deepEqual(placeAmong(-r, xs.map((x) => -x)), { below: p.above, equal: p.equal, above: p.below });
  }
  assert.throws(() => placeAmong(1, []), (e: unknown) => e instanceof InputError && e.code === 'EMPTY_SAMPLE');
  assert.throws(() => placeAmong(1, [1, Number.NaN]), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT');
  assert.throws(() => placeAmong(Number.NaN, [1]), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT');
});

// The one wording of a resampled bracket says what is true of this library: the level is nominal and its coverage was
// not checked. It states no direction of the error (too narrow, too wide): no source read in full supports one for a
// share, a difference of shares, kappa and AC1 alike.
test('the one bracket wording: what was resampled, what was held fixed, the nominal level, "coverage not checked", and no claim about its width', () => {
  assert.equal(intervalWording('items', 'the labels', '95%'), 'a percentile bootstrap interval over items, the labels held fixed: nominal 95%, coverage not checked');
  assert.equal(intervalWording('cases', 'the folded labels of the three runs', '90%'), 'a percentile bootstrap interval over cases, the folded labels of the three runs held fixed: nominal 90%, coverage not checked');
  for (const words of [intervalWording('items', 'x', '95%'), resampleBracketWording('items', 'x', { iterations: 2000, alpha: 0.05 }), resampleBracketWording('items', 'x', { iterations: 3, alpha: 0.05 })]) {
    assert.doesNotMatch(words, /narrow|small n|ceiling|wide/);
  }
});
