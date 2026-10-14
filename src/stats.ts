import { InputError } from './errors.ts';
import { mulberry32, randomInt } from './rng.ts';
import type { Rng } from './rng.ts';

/** Marker for a statistic that is undefined on the given data (e.g. κ when chance agreement is 1). */
export const NA = 'NA';
export type Stat = number | typeof NA;

export function toStat(x: number): Stat {
  return Number.isFinite(x) ? x : NA;
}

export const Z_95 = 1.959963984540054;

export type Interval = { lo: number; hi: number; p: number };

/** Wilson score interval. n = 0 throws InputError('EMPTY_SAMPLE'): there is no proportion to bound. */
export function wilson(successes: number, n: number, z: number = Z_95): Interval {
  if (!Number.isInteger(n) || n < 0 || !Number.isInteger(successes) || successes < 0 || successes > n) {
    throw new InputError('INVALID_ARGUMENT', [`wilson: need integers 0 <= successes <= n, got ${successes}/${n}`]);
  }
  if (n === 0) throw new InputError('EMPTY_SAMPLE', ['wilson: n = 0']);
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half), p };
}

// Wichura (1988), Algorithm AS 241, routine PPND16: coefficients as printed, accurate to about 1 part in 10^16.
const PPND_A = [3.3871328727963666080, 1.3314166789178437745e2, 1.9715909503065514427e3, 1.3731693765509461125e4, 4.5921953931549871457e4, 6.7265770927008700853e4, 3.3430575583588128105e4, 2.5090809287301226727e3];
const PPND_B = [1, 4.2313330701600911252e1, 6.8718700749205790830e2, 5.3941960214247511077e3, 2.1213794301586595867e4, 3.9307895800092710610e4, 2.8729085735721942674e4, 5.2264952788528545610e3];
const PPND_C = [1.42343711074968357734, 4.63033784615654529590, 5.76949722146069140550, 3.64784832476320460504, 1.27045825245236838258, 2.41780725177450611770e-1, 2.27238449892691845833e-2, 7.74545014278341407640e-4];
const PPND_D = [1, 2.05319162663775882187, 1.67638483018380384940, 6.89767334985100004550e-1, 1.48103976427480074590e-1, 1.51986665636164571966e-2, 5.47593808499534494600e-4, 1.05075007164441684324e-9];
const PPND_E = [6.65790464350110377720, 5.46378491116411436990, 1.78482653991729133580, 2.96560571828504891230e-1, 2.65321895265761230930e-2, 1.24266094738807843860e-3, 2.71155556874348757815e-5, 2.01033439929228813265e-7];
const PPND_F = [1, 5.99832206555887937690e-1, 1.36929880922735805310e-1, 1.48753612908506148525e-2, 7.86869131145613259100e-4, 1.84631831751005468180e-5, 1.42151175831644588870e-7, 2.04426310338993978564e-15];

/** Horner evaluation, lowest coefficient first. */
const poly = (c: readonly number[], x: number): number => c.reduceRight((acc, k) => acc * x + k, 0);

/** The standard normal quantile Φ⁻¹(p), 0 < p < 1, by Wichura's AS 241 (PPND16). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new InputError('INVALID_ARGUMENT', [`normalQuantile: p must be in (0, 1), got ${p}`]);
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    return (q * poly(PPND_A, r)) / poly(PPND_B, r);
  }
  const r = Math.sqrt(-Math.log(q < 0 ? p : 1 - p));
  const tail = r <= 5 ? poly(PPND_C, r - 1.6) / poly(PPND_D, r - 1.6) : poly(PPND_E, r - 5) / poly(PPND_F, r - 5);
  return q < 0 ? -tail : tail;
}

/** Paired counts over n cases: n10 passed under the baseline and failed under the candidate; n01 the reverse. */
export type PairedCounts = { n: number; n10: number; n01: number };

export type GateState = 'PASS' | 'REGRESSION' | 'INCONCLUSIVE';

export type NonInferiority = {
  /** Tango's score statistic for the null "candidate pass rate − baseline pass rate = −margin"; NA when its variance is 0. */
  z: Stat;
  /** Φ⁻¹(1 − alpha): the one-sided critical value. */
  critical: number;
  /** PASS: z above the critical value. REGRESSION: z below its negative. Otherwise, and at either boundary, INCONCLUSIVE: neither threshold is crossed, whatever the reason. */
  state: GateState;
  margin: number;
  alpha: number;
};

/**
 * Tango's (1998) score test of paired non-inferiority, asymptotic. The candidate is non-inferior
 * (PASS) when its pass rate is shown to be no more than `margin` below the baseline's, at nominal
 * one-sided level `alpha`: the test is asymptotic, and its actual error rate can exceed alpha at any
 * n. PASS does not say the candidate is no worse: a candidate that is worse by less than the margin
 * can pass. REGRESSION is the other tail of the same statistic: the candidate is shown to be more
 * than `margin` worse. INCONCLUSIVE means the statistic crossed neither threshold; it does not say why.
 * Tango's b is n01 and his c is n10.
 * There are no defaults: the margin and the level are the caller's to declare.
 */
export function nonInferiority(counts: PairedCounts, opts: { margin: number; alpha: number }): NonInferiority {
  const { n, n10, n01 } = counts;
  const { margin, alpha } = opts;
  const problems: string[] = [];
  if (![n, n10, n01].every((x) => Number.isInteger(x) && x >= 0) || n10 + n01 > n) problems.push(`nonInferiority: need integers n10, n01 >= 0 with n10 + n01 <= n, got n ${n}, n10 ${n10}, n01 ${n01}`);
  if (!(typeof margin === 'number' && margin >= 0 && margin < 1)) problems.push(`nonInferiority: margin must be in [0, 1), got ${margin}`);
  if (!(typeof alpha === 'number' && alpha > 0 && alpha < 0.5)) problems.push(`nonInferiority: alpha must be in (0, 0.5), got ${alpha}`);
  if (problems.length > 0) throw new InputError('INVALID_ARGUMENT', problems);
  if (n === 0) throw new InputError('EMPTY_SAMPLE', ['nonInferiority: n = 0']);
  const critical = normalQuantile(1 - alpha);
  return { ...tangoState(counts, margin, critical), critical, margin, alpha };
}

/**
 * The statistic and its state against a critical value already computed: the arithmetic of
 * nonInferiority, for a caller that evaluates many tables at one margin and level. Internal: it does
 * not check its input and is not re-exported from index.ts.
 */
export function tangoState(counts: PairedCounts, margin: number, critical: number): { z: Stat; state: GateState } {
  const { n, n10, n01 } = counts;
  // The restricted maximum-likelihood estimate under the null difference d0 = −margin (Tango's equations 24–26).
  const d0 = -margin;
  const a = 2 * n;
  const b = -(n10 + n01) + (2 * n - n01 + n10) * d0;
  const c = -n10 * d0 * (1 - d0);
  // The discriminant is exactly 0 for some tables, and rounding can leave it just below.
  const p = (-b + Math.sqrt(Math.max(0, b * b - 4 * a * c))) / (2 * a);
  const variance = n * (2 * p + d0 * (1 - d0));
  const z = variance > 0 ? toStat((n01 - n10 - n * d0) / Math.sqrt(variance)) : NA;
  const state: GateState = z === NA ? 'INCONCLUSIVE' : z > critical ? 'PASS' : z < -critical ? 'REGRESSION' : 'INCONCLUSIVE';
  return { z, state };
}

const LOG_FACTORIALS: number[] = [0];
const logFactorial = (k: number): number => {
  for (let i = LOG_FACTORIALS.length; i <= k; i++) LOG_FACTORIALS.push((LOG_FACTORIALS[i - 1] as number) + Math.log(i));
  return LOG_FACTORIALS[k] as number;
};

/** Above this n the exact rates are not computed: the enumeration grows with n squared. */
export const NOMINAL_CHECK_MAX_N = 400;

/**
 * How far the gate's actual error rates can exceed its nominal level, at one n, margin and alpha.
 * The paired table is trinomial. On the null boundary the candidate's pass rate is exactly `margin`
 * below the baseline's, with one free nuisance, the share of pairs that improve; the function
 * enumerates every table and returns the largest probability of PASS over a grid of that nuisance
 * (step 0.001). `falseRegression` is the same for REGRESSION on the boundary where the candidate is
 * exactly `margin` worse, which is the same boundary: both tails are read from it. NA above
 * NOMINAL_CHECK_MAX_N.
 */
export function nominalLevelCheck(n: number, opts: { margin: number; alpha: number }): { falsePass: Stat; falseRegression: Stat; grid: number } {
  const { margin, alpha } = opts;
  if (!Number.isInteger(n) || n < 1 || !(margin > 0 && margin < 1) || !(alpha > 0 && alpha < 0.5)) {
    throw new InputError('INVALID_ARGUMENT', [`nominalLevelCheck: need a positive integer n, margin in (0, 1) and alpha in (0, 0.5), got ${n}, ${margin}, ${alpha}`]);
  }
  const grid = 0.001;
  if (n > NOMINAL_CHECK_MAX_N) return { falsePass: NA, falseRegression: NA, grid };
  const critical = normalQuantile(1 - alpha);
  const tables: { n10: number; n01: number; state: GateState; logCoef: number }[] = [];
  for (let n10 = 0; n10 <= n; n10++) {
    for (let n01 = 0; n10 + n01 <= n; n01++) {
      const state = tangoState({ n, n10, n01 }, margin, critical).state;
      if (state !== 'INCONCLUSIVE') tables.push({ n10, n01, state, logCoef: logFactorial(n) - logFactorial(n10) - logFactorial(n01) - logFactorial(n - n10 - n01) });
    }
  }
  const xlogy = (k: number, p: number): number => (k === 0 ? 0 : p > 0 ? k * Math.log(p) : Number.NEGATIVE_INFINITY);
  let falsePass = 0;
  let falseRegression = 0;
  // On the boundary p10 = p01 + margin; p01 runs from 0 up to (1 − margin) / 2.
  for (let i = 0; i * grid <= (1 - margin) / 2 + 1e-12; i++) {
    const p01 = i * grid;
    const p10 = p01 + margin;
    const rest = Math.max(0, 1 - p01 - p10);
    let pass = 0;
    let regression = 0;
    for (const t of tables) {
      const p = Math.exp(t.logCoef + xlogy(t.n10, p10) + xlogy(t.n01, p01) + xlogy(n - t.n10 - t.n01, rest));
      if (t.state === 'PASS') pass += p;
      else regression += p;
    }
    falsePass = Math.max(falsePass, pass);
    falseRegression = Math.max(falseRegression, regression);
  }
  return { falsePass, falseRegression, grid };
}

/**
 * The smallest n at which a table with no discordant pair passes: a candidate identical to its
 * baseline is INCONCLUSIVE below it. It is not the smallest n at which PASS is possible, since a
 * candidate that fixes cases can pass with fewer. NA at margin 0, where no such table ever passes,
 * for a margin so small that the answer is beyond the exact integers, and where the statistic is undefined
 * at n (a variance of exactly 0 in floating point), since no n changes that.
 */
export function smallestConcordantPassN(opts: { margin: number; alpha: number }): number | typeof NA {
  const { margin, alpha } = opts;
  if (!(margin >= 0 && margin < 1) || !(alpha > 0 && alpha < 0.5)) throw new InputError('INVALID_ARGUMENT', [`smallestConcordantPassN: need margin in [0, 1) and alpha in (0, 0.5), got ${margin}, ${alpha}`]);
  if (margin === 0) return NA;
  // With no discordance z = sqrt(n·margin / (1 − margin)), and PASS is strict.
  const z = normalQuantile(1 - alpha);
  let n = Math.max(1, Math.floor((z * z * (1 - margin)) / margin));
  if (n >= Number.MAX_SAFE_INTEGER) return NA;
  for (;;) {
    const at = nonInferiority({ n, n10: 0, n01: 0 }, opts);
    if (at.state === 'PASS') return n;
    if (at.z === NA || n >= Number.MAX_SAFE_INTEGER) return NA;
    n++;
  }
}

/** Linear-interpolation quantile (Hyndman–Fan type 7) of an ascending-sorted array. */
export function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) throw new InputError('EMPTY_SAMPLE', ['quantile of empty array']);
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const a = sorted[lo] as number;
  const b = sorted[Math.min(lo + 1, sorted.length - 1)] as number;
  return a + (h - lo) * (b - a);
}

/** The one resample-index generator: n indices drawn with replacement from 0..n-1, in draw order. */
export function resampleIndices(rng: Rng, n: number): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = randomInt(rng, n);
  return out;
}

/**
 * The one resampling driver. Each iteration draws one index list per stratum, in the order the
 * strata are given, and hands them to `visit`. A stratum of size 0 draws nothing. Every resampled
 * statistic in the library goes through here, so two of them under one seed see the same resamples.
 */
export function forEachResample(seed: number, sizes: readonly number[], iterations: number, visit: (indices: number[][]) => void): void {
  const rng = mulberry32(seed);
  for (let it = 0; it < iterations; it++) visit(sizes.map((n) => (n === 0 ? [] : resampleIndices(rng, n))));
}

/**
 * How a statistic varied over resamples. It describes the replicates and is not a confidence
 * interval. Everything but the two counts is NA when fewer than two replicates were computed.
 */
export type Spread = {
  /** Replicates on which the statistic was computed. */
  replicates: number;
  /** Replicates on which it was undefined (non-finite). They are counted, never dropped silently. */
  undefinedReplicates: number;
  /** Standard deviation of the computed replicates, with n − 1 in the denominator. */
  sd: Stat;
  p025: Stat;
  p50: Stat;
  p975: Stat;
  /** Mean of the computed replicates minus the point value. On a thresholded count this can be large, and it is not an estimator's bias. */
  meanMinusPoint: Stat;
  shareBelow0: Stat;
  shareAt0: Stat;
  shareAbove0: Stat;
};

/** `point` is the statistic at the observed data, NaN where it is undefined there: then `meanMinusPoint` is NA, as every other undefined statistic is. */
export function spreadOf(point: number, values: readonly number[]): Spread {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const undefinedReplicates = values.length - xs.length;
  if (xs.length < 2) return { replicates: xs.length, undefinedReplicates, sd: NA, p025: NA, p50: NA, p975: NA, meanMinusPoint: NA, shareBelow0: NA, shareAt0: NA, shareAbove0: NA };
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const share = (f: (x: number) => boolean): number => xs.filter(f).length / xs.length;
  return {
    replicates: xs.length,
    undefinedReplicates,
    sd: Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1)),
    p025: quantileSorted(xs, 0.025),
    p50: quantileSorted(xs, 0.5),
    p975: quantileSorted(xs, 0.975),
    meanMinusPoint: toStat(mean - point),
    shareBelow0: share((x) => x < 0),
    shareAt0: share((x) => x === 0),
    shareAbove0: share((x) => x > 0),
  };
}

export type BootstrapOptions = { iterations: number; seed: number; alpha: number };

/**
 * The fewest resamples from which a percentile bracket is given a level, in every report. Below it the
 * bracket is still computed and printed, as percentiles of that many resamples with no level: a 2.5th
 * percentile read from a handful of resamples is one of the resamples, or a point between two of them.
 * The number is a convention of this library, not a result. It counts the resamples the percentiles are
 * read from, which are the ones on which the statistic was defined, not the ones asked for.
 */
export const MIN_LEVEL_RESAMPLES = 1000;

/**
 * The fewest resamples that must lie beyond each of the two percentiles for the bracket to be given a
 * level: (defined resamples) x alpha / 2 must reach it. At alpha 0.05 it is met from 1,000 resamples,
 * which is where MIN_LEVEL_RESAMPLES comes from; at alpha 0.01 it asks for 5,000 and at alpha 0.001 for
 * 50,000. Without it a small alpha puts both percentiles on the smallest and the largest resample, and
 * a level would be read off two extremes. A convention of this library, like the floor above.
 */
export const MIN_TAIL_RESAMPLES = 25;

/** The largest alpha a bracket may be asked at: a level below 80% is not printed as an interval. */
export const MAX_BRACKET_ALPHA = 0.2;

/**
 * The fewest defined resamples from which a bracket at `alpha` is given a level: MIN_LEVEL_RESAMPLES, or
 * the count that puts MIN_TAIL_RESAMPLES beyond each percentile when that is larger. It can exceed
 * MAX_RESAMPLES, and then no bracket at that alpha is ever given a level.
 */
export const levelFloorAt = (alpha: number): number => Math.max(MIN_LEVEL_RESAMPLES, Math.ceil((2 * MIN_TAIL_RESAMPLES) / alpha - 1e-9));

/**
 * The level a bracket at `alpha` is named with: 1 − alpha, or NA when the resamples its percentiles are
 * read from (`iterations` less `undefinedResamples`) are fewer than levelFloorAt(alpha). The level is
 * rounded to eight decimal places, as levelText prints it, so that a recorded report holds 0.93 and not
 * the floating-point remainder of 1 − 0.07.
 */
export const nominalLevelOf = (b: { iterations: number; alpha: number; undefinedResamples?: number }): Stat =>
  b.iterations - (b.undefinedResamples ?? 0) >= levelFloorAt(b.alpha) ? Number((1 - b.alpha).toFixed(8)) : NA;

/** The most resamples one bootstrap or one resampling block may ask for. The count comes from a file or a flag, and each resample costs a pass over the data. */
export const MAX_RESAMPLES = 1_000_000;

export type BootstrapResult = {
  estimate: number;
  lo: number;
  hi: number;
  iterations: number;
  seed: number;
  alpha: number;
  /** 1 − alpha, or NA when the defined resamples (`iterations` less `undefinedResamples`) are fewer than levelFloorAt(alpha): `lo` and `hi` are then percentiles of the resamples and carry no level. */
  nominalLevel: Stat;
  /** Resamples where the statistic was undefined (non-finite); excluded from the percentiles. */
  undefinedResamples: number;
};

/**
 * Seeded percentile bootstrap. Resamples `data` (one element per unit; use tuples for paired data)
 * with replacement and returns the alpha/2 and 1 - alpha/2 percentiles of `statFn`. Any number of
 * resamples from 1 is computed, and `nominalLevel` says whether the two percentiles may be named with
 * a level: only when the resamples on which the statistic was defined reach levelFloorAt(alpha). alpha
 * is in (0, MAX_BRACKET_ALPHA].
 */
export function bootstrapCI<T>(
  data: readonly T[],
  statFn: (sample: readonly T[]) => number,
  opts: BootstrapOptions,
): BootstrapResult {
  const { iterations, seed, alpha } = opts;
  if (data.length === 0) throw new InputError('EMPTY_SAMPLE', ['bootstrap: empty data']);
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new InputError('INVALID_ARGUMENT', ['bootstrap: iterations must be a positive integer']);
  }
  if (iterations > MAX_RESAMPLES) throw new InputError('INVALID_ARGUMENT', [`bootstrap: iterations ${iterations}; at most ${MAX_RESAMPLES} are drawn`]);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new InputError('INVALID_ARGUMENT', ['bootstrap: seed must be a uint32 integer']);
  }
  if (!(alpha > 0 && alpha <= MAX_BRACKET_ALPHA)) throw new InputError('INVALID_ARGUMENT', [`bootstrap: alpha must be in (0, ${MAX_BRACKET_ALPHA}], got ${alpha}`]);
  const stats: number[] = [];
  forEachResample(seed, [data.length], iterations, ([idx]) => {
    const s = statFn((idx as number[]).map((i) => data[i] as T));
    if (Number.isFinite(s)) stats.push(s);
  });
  if (stats.length === 0) throw new InputError('EMPTY_SAMPLE', ['bootstrap: statistic undefined on every resample']);
  stats.sort((a, b) => a - b);
  return {
    estimate: statFn(data),
    lo: quantileSorted(stats, alpha / 2),
    hi: quantileSorted(stats, 1 - alpha / 2),
    iterations,
    seed,
    alpha,
    nominalLevel: nominalLevelOf({ iterations, alpha, undefinedResamples: iterations - stats.length }),
    undefinedResamples: iterations - stats.length,
  };
}

/**
 * What a report keeps of a seeded percentile bootstrap: the alpha/2 and 1 − alpha/2 percentiles of the
 * statistic over resamples of the units, with everything needed to draw them again. Where `nominalLevel`
 * is a number it is a percentile bootstrap interval and is named as one wherever it is printed; where
 * it is NA (fewer defined resamples than levelFloorAt(alpha)) it is two percentiles of the resamples, with no level.
 */
export type PercentileInterval = { lo: number; hi: number; alpha: number; iterations: number; seed: number; nominalLevel: Stat; undefinedResamples: number };

/**
 * The one wording for a bracket that comes from resampling, in every report: what was resampled, what
 * was held fixed, the nominal level, and that the level is nominal: its coverage was not checked. It says nothing
 * about which way the bracket errs: that would be a claim about a method on four
 * different statistics, and the wording states only what is true of this library. `unit` is "items"
 * or "cases"; `fixed` names what a resample does not redraw. Its type is the text itself, so a label
 * built from it keeps a literal type. Internal: not re-exported from index.ts.
 */
export const intervalWording = <U extends string, F extends string, N extends string>(
  unit: U,
  fixed: F,
  nominal: N,
): `a percentile bootstrap interval over ${U}, ${F} held fixed: nominal ${N}, coverage not checked` =>
  `a percentile bootstrap interval over ${unit}, ${fixed} held fixed: nominal ${nominal}, coverage not checked`;

/**
 * The wording for percentiles over resamples a file supplied in place of the library's
 * seeded generator. The rows are checked for length and range, not for how they were drawn, so they are
 * not called a bootstrap and carry no level. Its type is the text itself, like intervalWording's.
 * Internal: not re-exported from index.ts.
 */
export const suppliedPercentilesWording = <U extends string>(unit: U): `percentiles over the supplied resamples of ${U}, with no level: the resamples were checked for length and range, not for how they were drawn` =>
  `percentiles over the supplied resamples of ${unit}, with no level: the resamples were checked for length and range, not for how they were drawn`;

/** "1 resample", "3 resamples": a count of resamples as every report prints it. */
export const resamplesText = (n: number): string => `${n} resample${n === 1 ? '' : 's'}`;

/**
 * The wording for percentiles over too few seeded resamples to be given a level at `alpha` (fewer than
 * levelFloorAt(alpha)). It names no level and no percentage. Internal: not re-exported from index.ts.
 */
export const fewResamplesWording = (unit: string, fixed: string, iterations: number, alpha: number): string =>
  `percentiles over ${resamplesText(iterations)} of ${unit}, ${fixed} held fixed, with no level: a level is named from ${levelFloorAt(alpha)} resamples on which the statistic is defined`;

/** 1 − alpha as a percentage, as every report prints a level: "95%", "97.5%". */
export const levelText = (alpha: number): string => `${Number(((1 - alpha) * 100).toFixed(6))}%`;

/**
 * The one choice of wording for a bracket the library's seeded generator produced: intervalWording
 * with its nominal level from levelFloorAt(alpha) resamples, fewResamplesWording below it. Every report
 * that prints such a bracket from a caller's resampling block names it through here, so none is given
 * a level from a handful of resamples. It is decided on the resamples asked for; a row whose statistic
 * was undefined on some of them can fall below the floor on its own, and noLevelNote marks that row.
 * Internal: not re-exported from index.ts.
 */
export const resampleBracketWording = (unit: string, fixed: string, b: { iterations: number; alpha: number }): string =>
  nominalLevelOf(b) === NA ? fewResamplesWording(unit, fixed, b.iterations, b.alpha) : intervalWording(unit, fixed, levelText(b.alpha));

/**
 * The mark on one bracket that carries no level although the report's resampling block asks for enough
 * resamples to name one: the statistic was undefined on so many of them that the percentiles are read
 * from fewer than the floor. Empty when the bracket has its level, and when the whole report has none
 * (its one wording already says so). Internal: not re-exported from index.ts.
 */
export const noLevelNote = (b: { iterations: number; alpha: number; undefinedResamples: number }): string =>
  nominalLevelOf({ iterations: b.iterations, alpha: b.alpha }) !== NA && nominalLevelOf(b) === NA
    ? `no level: read from ${resamplesText(b.iterations - b.undefinedResamples)}, and a level is named from ${levelFloorAt(b.alpha)}`
    : '';

/** Where a reported value sits among the values of the same quantity under other settings: how many are below it, equal to it and above it. */
export type Placement = { below: number; equal: number; above: number };

/**
 * Counts the values strictly below, exactly equal to and strictly above `reported`. A description of
 * the list, with no level: it is not a p-value. Every value must be finite, since an undefined value
 * has no side, and the list must not be empty.
 */
export function placeAmong(reported: number, values: readonly number[]): Placement {
  if (values.length === 0) throw new InputError('EMPTY_SAMPLE', ['placeAmong: no values']);
  if (!Number.isFinite(reported) || values.some((v) => !Number.isFinite(v))) throw new InputError('INVALID_ARGUMENT', ['placeAmong: the reported value and every value must be finite']);
  let below = 0;
  let equal = 0;
  for (const v of values) {
    if (v < reported) below++;
    else if (v === reported) equal++;
  }
  return { below, equal, above: values.length - below - equal };
}

/**
 * bootstrapCI as a report field: the interval, or NA when the statistic was undefined on every
 * resample. Internal: a wrapper around the one bootstrap, not re-exported from index.ts.
 */
export function percentileInterval<T>(data: readonly T[], statFn: (sample: readonly T[]) => number, opts: BootstrapOptions): PercentileInterval | typeof NA {
  try {
    const r = bootstrapCI(data, statFn, opts);
    return { lo: r.lo, hi: r.hi, alpha: r.alpha, iterations: r.iterations, seed: r.seed, nominalLevel: r.nominalLevel, undefinedResamples: r.undefinedResamples };
  } catch (e) {
    if (e instanceof InputError && e.code === 'EMPTY_SAMPLE' && data.length > 0) return NA;
    throw e;
  }
}

