import { InputError, RefusalError } from './errors.ts';
import { isSha256Hex } from './identity.ts';
import { MAX_LABELS } from './scoring.ts';
import { NA, percentileInterval, toStat, wilson } from './stats.ts';
import type { BootstrapOptions, PercentileInterval, Stat } from './stats.ts';

function assertPaired(a: readonly string[], b: readonly string[]): void {
  if (a.length !== b.length) throw new InputError('INVALID_ARGUMENT', [`rating lists differ in length: ${a.length} vs ${b.length}`]);
  if (a.length === 0) throw new InputError('EMPTY_SAMPLE', ['no ratings']);
}

/** The one bound on categories, declared or observed: MAX_LABELS, as for a label set. */
function boundedCategories(cats: readonly string[]): string[] {
  if (cats.length > MAX_LABELS) throw new InputError('INVALID_ARGUMENT', [`categories: ${cats.length} categories; at most ${MAX_LABELS} are read`]);
  return [...cats];
}

function resolveCategories(values: readonly string[], categories?: readonly string[]): string[] {
  if (categories === undefined) return boundedCategories([...new Set(values)].sort());
  boundedCategories(categories);
  const set = new Set(categories);
  if (set.size !== categories.length) throw new InputError('INVALID_ARGUMENT', ['categories contain duplicates']);
  const unknown = [...new Set(values.filter((v) => !set.has(v)))];
  if (unknown.length > 0) throw new InputError('UNKNOWN_LABEL', unknown.map((u) => `"${u}" is not a declared category`));
  return [...categories];
}

export function percentAgreement(a: readonly string[], b: readonly string[]): number {
  assertPaired(a, b);
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

export type KappaResult = { kappa: number; po: number; pe: number };

/** Cohen's κ for two raters. κ is NaN when chance agreement pe = 1. */
export function cohenKappa(a: readonly string[], b: readonly string[], categories?: readonly string[]): KappaResult {
  assertPaired(a, b);
  const cats = resolveCategories([...a, ...b], categories);
  const n = a.length;
  const po = percentAgreement(a, b);
  let pe = 0;
  for (const c of cats) {
    const pa = a.filter((x) => x === c).length / n;
    const pb = b.filter((x) => x === c).length / n;
    pe += pa * pb;
  }
  return { kappa: pe === 1 ? Number.NaN : (po - pe) / (1 - pe), po, pe };
}

export type Ac1Result = { ac1: number; pa: number; pe: number };

/** Refuses an undeclared category list where the count of categories enters the statistic. */
function assertDeclared(categories: unknown, what: string): void {
  if (!Array.isArray(categories)) {
    throw new InputError('INVALID_ARGUMENT', [`${what}: required. The number of categories enters AC1, so a list taken from the labels that happen to occur would give the same data a different AC1 than the declared scale`]);
  }
}

/**
 * Gwet's AC1 for two raters. K is the number of declared categories, and it enters the chance term
 * (the sum of pi(1 − pi) over K − 1), so the categories are required: the same ratings give a
 * different AC1 on a scale declared with one category more. Cohen's kappa does not depend on K.
 */
export function gwetAC1(a: readonly string[], b: readonly string[], categories: readonly string[]): Ac1Result {
  assertDeclared(categories, 'gwetAC1: categories');
  assertPaired(a, b);
  const cats = resolveCategories([...a, ...b], categories);
  const n = a.length;
  const pa = percentAgreement(a, b);
  const k = cats.length;
  let sum = 0;
  for (const c of cats) {
    const pi = (a.filter((x) => x === c).length + b.filter((x) => x === c).length) / (2 * n);
    sum += pi * (1 - pi);
  }
  const pe = k < 2 ? Number.NaN : sum / (k - 1);
  return { ac1: (pa - pe) / (1 - pe), pa, pe };
}

/** Validates a subjects × categories count matrix with a constant number of raters per subject. */
function checkCountMatrix(matrix: readonly (readonly number[])[]): { m: number; k: number } {
  const problems: string[] = [];
  if (matrix.length === 0) throw new InputError('EMPTY_SAMPLE', ['count matrix has no subjects']);
  const k = (matrix[0] as readonly number[]).length;
  if (k === 0) throw new InputError('INVALID_ARGUMENT', ['count matrix has no categories']);
  let m = -1;
  matrix.forEach((row, i) => {
    if (row.length !== k) problems.push(`row ${i}: ${row.length} columns, expected ${k}`);
    if (row.some((x) => !Number.isInteger(x) || x < 0)) problems.push(`row ${i}: counts must be non-negative integers`);
    const sum = row.reduce((s, x) => s + x, 0);
    if (m === -1) m = sum;
    else if (sum !== m) problems.push(`row ${i}: ${sum} raters, expected a constant ${m}`);
  });
  if (m < 2) problems.push(`need at least 2 raters per subject, got ${m}`);
  if (problems.length > 0) throw new InputError('INVALID_ARGUMENT', problems);
  return { m, k };
}

function observedAgreement(matrix: readonly (readonly number[])[], m: number): number {
  let total = 0;
  for (const row of matrix) total += (row.reduce((s, x) => s + x * x, 0) - m) / (m * (m - 1));
  return total / matrix.length;
}

function categoryShares(matrix: readonly (readonly number[])[], m: number, k: number): number[] {
  const shares = new Array<number>(k).fill(0);
  for (const row of matrix) row.forEach((x, j) => (shares[j] = (shares[j] as number) + x));
  return shares.map((s) => s / (matrix.length * m));
}

export type FleissResult = { kappa: number; pBar: number; peBar: number };

/** Fleiss' κ from a subjects × categories count matrix (Fleiss 1971). */
export function fleissKappa(matrix: readonly (readonly number[])[]): FleissResult {
  const { m, k } = checkCountMatrix(matrix);
  const pBar = observedAgreement(matrix, m);
  const peBar = categoryShares(matrix, m, k).reduce((s, p) => s + p * p, 0);
  return { kappa: peBar === 1 ? Number.NaN : (pBar - peBar) / (1 - peBar), pBar, peBar };
}

/** Gwet's AC1 for any number of raters, from the same count matrix as fleissKappa. K is the number of columns, used or not. */
export function gwetAC1Multi(matrix: readonly (readonly number[])[]): Ac1Result {
  const { m, k } = checkCountMatrix(matrix);
  const pa = observedAgreement(matrix, m);
  const sum = categoryShares(matrix, m, k).reduce((s, p) => s + p * (1 - p), 0);
  const pe = k < 2 ? Number.NaN : sum / (k - 1);
  return { ac1: (pa - pe) / (1 - pe), pa, pe };
}

/** Share of each category among the labels, in category order. */
export function prevalence(labels: readonly string[], categories?: readonly string[]): Record<string, number> {
  if (labels.length === 0) throw new InputError('EMPTY_SAMPLE', ['no labels']);
  const cats = resolveCategories(labels, categories);
  // Object.fromEntries defines each share as the record's own property. An assignment (out[c] = share) would, for a category named "__proto__", set the record's prototype and leave the category out.
  return Object.fromEntries(cats.map((c) => [c, labels.filter((x) => x === c).length / labels.length]));
}

/** |A ∩ B| / |A ∪ B|. Two empty sets are defined as identical (1). */
export function jaccard<T>(a: Iterable<T>, b: Iterable<T>): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Converts per-rater label lists (aligned by item) into a subjects × categories count matrix. */
export function toCountMatrix(ratingsByItem: readonly (readonly string[])[], categories: readonly string[]): number[][] {
  return ratingsByItem.map((row) => categories.map((c) => row.filter((x) => x === c).length));
}

export type RaterItems = Readonly<Record<string, Readonly<Record<string, string>>>>;

export type AgreementOptions = {
  /** rater → item → sha256 of the packet that rater saw. */
  packetHashes: RaterItems;
  /** The declared scale, required: its length enters AC1 (see gwetAC1), so it is never taken from the labels that happen to occur. */
  categories: readonly string[];
  bootstrap?: Partial<BootstrapOptions>;
};

/**
 * Two readers on the same items: kappa is never given without AC1, the plain agreeing share, the
 * prevalence that interprets it, and an interval for each coefficient.
 */
export type PairAgreement = {
  kappa: Stat;
  ac1: Stat;
  percentAgreement: number;
  /** Wilson 95% score interval of the agreeing share, the items taken as independent. It does not collapse when no item disagrees. */
  percentAgreementWilson: { lo: number; hi: number };
  /** Share of each category among the two readers' labels, pooled: the chance term of AC1 uses it. */
  prevalence: Record<string, number>;
  /** Each reader's own share of each category: the chance term of Cohen's kappa uses these, and kappa and AC1 part where they differ. */
  marginals: { a: Record<string, number>; b: Record<string, number> };
  /** Seeded percentile bootstrap over items. Both intervals use one seed, so they come from the same resamples. */
  kappaCI: PercentileInterval | typeof NA;
  ac1CI: PercentileInterval | typeof NA;
};

export type AgreementReport = {
  raters: string[];
  itemCount: number;
  categories: string[];
  kappaKind: 'cohen' | 'fleiss';
  kappa: Stat;
  ac1: Stat;
  /** What this is depends on the number of raters: see `percentAgreementKind`. */
  percentAgreement: number;
  /**
   * 'agreeing-share' with two raters: the share of items on which the two gave the same label.
   * 'mean-pairwise' with three or more: Fleiss' P-bar, the share of agreeing pairs of raters on an item,
   * averaged over items. It is not the share of items on which every rater agrees, which is lower
   * whenever any item splits.
   */
  percentAgreementKind: 'agreeing-share' | 'mean-pairwise';
  /** Share of each category among all raters' labels, pooled. */
  prevalence: Record<string, number>;
  /** Seeded percentile bootstrap over items. Every interval of the report uses `bootstrap`, so all come from the same resamples. */
  kappaCI: PercentileInterval | typeof NA;
  ac1CI: PercentileInterval | typeof NA;
  /** The resampling behind every interval of this report, stated even where an interval is NA. */
  bootstrap: BootstrapOptions;
  pairwise: ({ a: string; b: string } & PairAgreement)[];
};

/** Frozen: a caller that wants another resampling passes its own options. */
export const DEFAULT_BOOTSTRAP: BootstrapOptions = Object.freeze({ iterations: 2000, seed: 0, alpha: 0.05 });

/**
 * The one two-reader agreement block: Cohen's kappa with Gwet's AC1, the agreeing share, pooled
 * prevalence, each reader's marginals, and a percentile bootstrap interval over items for each
 * coefficient. Items are resampled; the readers and their labels are held fixed, so an interval says
 * nothing about another draw of a judge. Every resample is scored on the declared categories, never
 * on the labels it happens to hold. Behind the pairwise rows of agreementReport and behind
 * driftReport. Internal: not re-exported from index.ts.
 */
export function pairAgreement(a: readonly string[], b: readonly string[], categories: readonly string[], bootstrap: BootstrapOptions): PairAgreement {
  assertPaired(a, b);
  const rows = a.map((x, i) => [x, b[i] as string] as const);
  const left = (s: readonly (readonly [string, string])[]): string[] => s.map((r) => r[0]);
  const right = (s: readonly (readonly [string, string])[]): string[] => s.map((r) => r[1]);
  return {
    kappa: toStat(cohenKappa(a, b, categories).kappa),
    ac1: toStat(gwetAC1(a, b, categories).ac1),
    percentAgreement: percentAgreement(a, b),
    percentAgreementWilson: (({ lo, hi }) => ({ lo, hi }))(wilson(a.filter((x, i) => x === b[i]).length, a.length)),
    prevalence: prevalence([...a, ...b], categories),
    marginals: { a: prevalence(a, categories), b: prevalence(b, categories) },
    kappaCI: percentileInterval(rows, (s) => cohenKappa(left(s), right(s), categories).kappa, bootstrap),
    ac1CI: percentileInterval(rows, (s) => gwetAC1(left(s), right(s), categories).ac1, bootstrap),
  };
}

/**
 * Agreement between raters who saw the same packets. Refuses when raters rated different items or
 * when any item's packet hash differs between raters (or is missing). Reports κ with AC1, percent
 * agreement, prevalence and a seeded percentile bootstrap interval for κ and for AC1, overall and for
 * every pair of raters: never κ alone. With three or more raters the overall `percentAgreement` is the
 * mean pairwise agreement, and `percentAgreementKind` says so. The categories are required.
 */
export function agreementReport(ratingsByRater: RaterItems, opts: AgreementOptions): AgreementReport {
  assertDeclared(opts?.categories, 'agreementReport: categories');
  const isMap = (x: unknown): boolean => typeof x === 'object' && x !== null && !Array.isArray(x);
  // A caller without types may hand over anything: the argument is named, and never a TypeError from a property read.
  if (!isMap(ratingsByRater) || !Object.values(ratingsByRater).every(isMap)) {
    throw new InputError('INVALID_ARGUMENT', ['agreementReport: ratingsByRater: must map rater -> item -> label']);
  }
  const raters = Object.keys(ratingsByRater).sort();
  if (raters.length < 2) throw new InputError('INVALID_ARGUMENT', ['agreement needs at least 2 raters']);
  const itemsOf = (r: string): string[] => Object.keys(ratingsByRater[r] as Record<string, string>);
  const items = [...new Set(raters.flatMap(itemsOf))].sort();
  if (items.length === 0) throw new InputError('EMPTY_SAMPLE', ['no rated items']);
  // Name the items, not the raters: with the first rater as the reference, the odd one out would be named as the others.
  const rated = new Map(raters.map((r) => [r, new Set(itemsOf(r))]));
  const lacking = items.map((item) => ({ item, raters: raters.filter((r) => !(rated.get(r) as Set<string>).has(item)) })).filter((x) => x.raters.length > 0);
  if (lacking.length > 0) {
    throw new RefusalError(
      'ITEM_SET_MISMATCH',
      lacking.map((x) => x.item),
      `raters did not rate the same items: ${lacking.map((x) => `${x.item} (not rated by ${x.raters.join(', ')})`).join(', ')}`,
    );
  }

  // Every item needs a packet hash for every rater, and the hashes must be equal. No hashes at all is refused like any other gap (as in driftReport).
  const badPackets: string[] = [];
  for (const item of items) {
    const hashes = raters.map((r) => opts.packetHashes?.[r]?.[item]);
    const first = hashes[0];
    if (hashes.some((h) => !isSha256Hex(h) || h !== first)) badPackets.push(item);
  }
  if (badPackets.length > 0) {
    throw new RefusalError(
      'PACKET_MISMATCH',
      badPackets,
      `packet hash missing, malformed or different between raters for: ${badPackets.join(', ')}`,
    );
  }

  const rows = items.map((item) => raters.map((r) => (ratingsByRater[r] as Record<string, string>)[item] as string));
  const all = rows.flat();
  const categories = resolveCategories(all, opts.categories);
  const byRater = raters.map((_, j) => rows.map((row) => row[j] as string));

  const boot: BootstrapOptions = { ...DEFAULT_BOOTSTRAP, ...opts.bootstrap };
  const pairwise: AgreementReport['pairwise'] = [];
  for (let i = 0; i < raters.length; i++) {
    for (let j = i + 1; j < raters.length; j++) {
      pairwise.push({ a: raters[i] as string, b: raters[j] as string, ...pairAgreement(byRater[i] as string[], byRater[j] as string[], categories, boot) });
    }
  }

  const two = raters.length === 2;
  const kappaOf = (sample: readonly (readonly string[])[]): number =>
    two
      ? cohenKappa(sample.map((r) => r[0] as string), sample.map((r) => r[1] as string), categories).kappa
      : fleissKappa(toCountMatrix(sample, categories)).kappa;
  const ac1Of = (sample: readonly (readonly string[])[]): number =>
    two
      ? gwetAC1(sample.map((r) => r[0] as string), sample.map((r) => r[1] as string), categories).ac1
      : gwetAC1Multi(toCountMatrix(sample, categories)).ac1;
  const pa = two ? percentAgreement(byRater[0] as string[], byRater[1] as string[]) : fleissKappa(toCountMatrix(rows, categories)).pBar;

  return {
    raters,
    itemCount: items.length,
    categories,
    kappaKind: two ? 'cohen' : 'fleiss',
    kappa: toStat(kappaOf(rows)),
    ac1: toStat(ac1Of(rows)),
    percentAgreement: pa,
    percentAgreementKind: two ? 'agreeing-share' : 'mean-pairwise',
    prevalence: prevalence(all, categories),
    kappaCI: percentileInterval(rows, kappaOf, boot),
    ac1CI: percentileInterval(rows, ac1Of, boot),
    bootstrap: boot,
    pairwise,
  };
}
