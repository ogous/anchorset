import { InputError, RefusalError } from './errors.ts';
import { GAP, isSha256Hex } from './identity.ts';
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

/** The kappa form, from observed and chance agreement. NaN when chance agreement is 1. */
const kappaFromChance = (observed: number, chance: number): number => (chance === 1 ? Number.NaN : (observed - chance) / (1 - chance));
/** AC1's chance term: the sum of pi(1 − pi) over the K − 1 declared categories. NaN with fewer than two. */
const ac1Chance = (shares: readonly number[]): number => (shares.length < 2 ? Number.NaN : shares.reduce((s, p) => s + p * (1 - p), 0) / (shares.length - 1));
const ac1FromChance = (observed: number, chance: number): number => (observed - chance) / (1 - chance);

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
  return { kappa: kappaFromChance(po, pe), po, pe };
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
  const pe = ac1Chance(cats.map((c) => (a.filter((x) => x === c).length + b.filter((x) => x === c).length) / (2 * n)));
  return { ac1: ac1FromChance(pa, pe), pa, pe };
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
  return { kappa: kappaFromChance(pBar, peBar), pBar, peBar };
}

/** Gwet's AC1 for any number of raters, from the same count matrix as fleissKappa. K is the number of columns, used or not. */
export function gwetAC1Multi(matrix: readonly (readonly number[])[]): Ac1Result {
  const { m, k } = checkCountMatrix(matrix);
  const pa = observedAgreement(matrix, m);
  const pe = ac1Chance(categoryShares(matrix, m, k));
  return { ac1: ac1FromChance(pa, pe), pa, pe };
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

/**
 * What a file's names are: raters who stay the same person or model across items, list positions, or not known. Only
 * `persistent` names can be compared with each other. It is the file's statement, and nothing can check it.
 */
export type RaterIdentity = 'persistent' | 'positional' | typeof GAP;

/** The accepted values of `raterIdentity`. Internal: not re-exported from index.ts. */
export const RATER_IDENTITIES: readonly unknown[] = ['persistent', 'positional', GAP];

/** True of every file, so it is on every report, in text and as `scope`. Internal: not re-exported from index.ts. */
export const AGREE_SCOPE = 'These figures describe this file only: the tool cannot see how the items or the raters were chosen, or why an item has the ratings it has.';

const SAME_FIGURES = "Fleiss' kappa, multi-rater AC1 and mean pairwise observed agreement";
/** Why a report whose names are not persistent raters has no pair row and no Cohen's kappa. */
const IDENTITY_NOTES = {
  positional: `no row for a pair: a list position is not a rater, so the figures are ${SAME_FIGURES} at any number of positions, two included`,
  [GAP]: `no row for a pair: the names are unknown, not shown to be raters or positions, so the figures are ${SAME_FIGURES} at any number of names, two included`,
} as const;

export type AgreementOptions = {
  /** rater → item → sha256 of the packet that rater saw. */
  packetHashes: RaterItems;
  /** Required, with no default: a default would state, for the caller, that the names are raters. */
  raterIdentity: RaterIdentity;
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
  /** The file's statement about its names. */
  raterIdentity: RaterIdentity;
  /** The file's names, sorted. They are raters only where `raterIdentity` is `persistent`. */
  raters: string[];
  itemCount: number;
  categories: string[];
  kappaKind: 'cohen' | 'fleiss';
  kappa: Stat;
  ac1: Stat;
  /** What this is depends on the number of raters: see `percentAgreementKind`. */
  percentAgreement: number;
  /**
   * 'agreeing-share' with two persistent raters: the share of items on which the two gave the same label.
   * 'mean-pairwise' with three or more, and at any number of names that are not persistent raters: Fleiss'
   * P-bar, the share of agreeing pairs of raters on an item, averaged over items. It is not the share of items
   * on which every rater agrees, which is lower whenever any item splits.
   */
  percentAgreementKind: 'agreeing-share' | 'mean-pairwise';
  /** Share of each category among all raters' labels, pooled. */
  prevalence: Record<string, number>;
  /** Seeded percentile bootstrap over items. Every interval of the report uses `bootstrap`, so all come from the same resamples. */
  kappaCI: PercentileInterval | typeof NA;
  ac1CI: PercentileInterval | typeof NA;
  /** The resampling behind every interval of this report, stated even where an interval is NA. */
  bootstrap: BootstrapOptions;
  /** Empty, and never computed, where `raterIdentity` is not `persistent`. */
  pairwise: ({ a: string; b: string } & PairAgreement)[];
  /** Present only where `raterIdentity` is not `persistent`: says that no pair row exists, and which figures are used instead. */
  identityNote?: string;
  /** What these figures describe, the same sentence on every report. */
  scope: string;
};

/** Two figures of one record, each computed from stored shares: they are equal up to rounding. */
const CLOSE = 1e-9;
const closeTo = (a: unknown, b: number): boolean => (Number.isFinite(b) ? typeof a === 'number' && Math.abs(a - b) <= CLOSE : a === NA);
const isMap = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNameList = (x: unknown): x is string[] => Array.isArray(x) && x.every((v) => typeof v === 'string' && v !== '');

/** The shares of `categories` in `x`, in their order, or undefined unless `x` holds exactly those keys, numbers that sum to 1. */
function sharesOf(x: unknown, categories: readonly string[]): number[] | undefined {
  if (!isMap(x) || Object.keys(x).length !== categories.length || !categories.every((c) => Object.hasOwn(x, c))) return undefined;
  const shares = categories.map((c) => x[c]);
  if (!shares.every((v): v is number => typeof v === 'number' && v >= 0 && v <= 1)) return undefined;
  return Math.abs(shares.reduce((s, v) => s + v, 0) - 1) <= CLOSE ? shares : undefined;
}
/** True when `share` of `total` things is a whole number of them. */
const wholeOf = (share: number, total: number): boolean => Math.abs(share * total - Math.round(share * total)) <= 1e-6;

/**
 * What an `agree` report in a ledger record must hold for its statement about its names and its contents to agree, in
 * every direction, read from the report alone. The record holds the shares the coefficients are computed from, so those
 * are computed again. An interval cannot be: it needs the ratings. Internal: not re-exported from index.ts. Pure.
 */
export function agreeReportProblems(r: Record<string, unknown>): string[] {
  const at = 'record.result';
  const out: string[] = [];
  const identity = r['raterIdentity'] as RaterIdentity;
  const persistent = identity === 'persistent';
  const raters = r['raters'];
  if (!isNameList(raters) || raters.length < 2 || new Set(raters).size !== raters.length || raters.some((x, i) => i > 0 && x <= (raters[i - 1] as string))) {
    return [`${at}.raters: must be at least two different names, sorted`];
  }
  const n = raters.length;
  const items = r['itemCount'];
  const categories = r['categories'];
  // An integer too large to read exactly has its own problem wherever the record holds one; nothing can be computed from it.
  if (typeof items === 'number' && Number.isInteger(items) && !Number.isSafeInteger(items)) return [];
  if (typeof items !== 'number' || !Number.isInteger(items) || items < 1) return [`${at}.itemCount: must be a positive whole number`];
  if (!isNameList(categories) || categories.length === 0 || new Set(categories).size !== categories.length) return [`${at}.categories: must be a non-empty list of different labels`];
  const two = persistent && n === 2;

  if (r['kappaKind'] !== (two ? 'cohen' : 'fleiss')) out.push(`${at}.kappaKind: must be "${two ? 'cohen' : 'fleiss'}" where raterIdentity is ${identity} over ${n} names`);
  if (r['percentAgreementKind'] !== (two ? 'agreeing-share' : 'mean-pairwise')) out.push(`${at}.percentAgreementKind: must be "${two ? 'agreeing-share' : 'mean-pairwise'}" where raterIdentity is ${identity} over ${n} names`);
  if (persistent) {
    if (Object.hasOwn(r, 'identityNote')) out.push(`${at}.identityNote: a report whose names are persistent raters holds none`);
  } else if (r['identityNote'] !== IDENTITY_NOTES[identity]) out.push(`${at}.identityNote: must be the report's own sentence for raterIdentity ${identity}`);

  const pairCount = n * (n - 1) / 2;
  const prevalence = sharesOf(r['prevalence'], categories);
  if (prevalence === undefined || !prevalence.every((p) => wholeOf(p, n * items))) out.push(`${at}.prevalence: must give each category a share of the ${n * items} labels, and no other key`);
  const agreeing = r['percentAgreement'];
  const agreeingOk = typeof agreeing === 'number' && agreeing >= 0 && agreeing <= 1 && wholeOf(agreeing, items * (two ? 1 : pairCount));
  if (!agreeingOk) out.push(`${at}.percentAgreement: must be a share of the ${items * (two ? 1 : pairCount)} ${two ? 'items' : 'pairs on the items'}`);

  const rows = r['pairwise'];
  const expected = persistent ? raters.flatMap((a, i) => raters.slice(i + 1).map((b) => [a, b])) : [];
  const rowsOk = Array.isArray(rows) && rows.length === expected.length && rows.every((row: unknown, i) => isMap(row) && row['a'] === expected[i]?.[0] && row['b'] === expected[i]?.[1]);
  if (!rowsOk) out.push(`${at}.pairwise: must hold ${expected.length} row(s), each pair of the sorted names once, in order, where raterIdentity is ${identity} over ${n} names`);
  const pairs = rowsOk ? (rows as Record<string, unknown>[]) : [];
  pairs.forEach((row, i) => {
    const on = `${at}.pairwise[${i}]`;
    const pooled = sharesOf(row['prevalence'], categories);
    const marginals = isMap(row['marginals']) ? row['marginals'] : {};
    const [ma, mb] = [sharesOf(marginals['a'], categories), sharesOf(marginals['b'], categories)];
    const po = row['percentAgreement'];
    if (typeof po !== 'number' || po < 0 || po > 1 || !wholeOf(po, items)) out.push(`${on}.percentAgreement: must be a share of the ${items} items`);
    if (ma === undefined || mb === undefined || !ma.every((p) => wholeOf(p, items)) || !mb.every((p) => wholeOf(p, items))) out.push(`${on}.marginals: must give each reader a share of the ${items} items for each category`);
    if (pooled === undefined || ma === undefined || mb === undefined || !pooled.every((p, c) => Math.abs(p - ((ma[c] as number) + (mb[c] as number)) / 2) <= CLOSE)) out.push(`${on}.prevalence: must be the two readers' shares, pooled`);
    if (typeof po === 'number' && ma !== undefined && mb !== undefined && !closeTo(row['kappa'], kappaFromChance(po, ma.reduce((s, p, c) => s + p * (mb[c] as number), 0)))) out.push(`${on}.kappa: differs from its agreement and marginals`);
    if (typeof po === 'number' && pooled !== undefined && !closeTo(row['ac1'], ac1FromChance(po, ac1Chance(pooled)))) out.push(`${on}.ac1: differs from its agreement and prevalence`);
  });

  if (two) {
    const row = pairs[0];
    if (row !== undefined) {
      for (const key of ['kappa', 'ac1', 'percentAgreement'] as const) if (row[key] !== r[key]) out.push(`${at}.${key}: differs from the one pair row`);
    }
  } else {
    if (prevalence !== undefined && agreeingOk) {
      if (!closeTo(r['kappa'], kappaFromChance(agreeing, prevalence.reduce((s, p) => s + p * p, 0)))) out.push(`${at}.kappa: differs from its agreement and prevalence`);
      if (!closeTo(r['ac1'], ac1FromChance(agreeing, ac1Chance(prevalence)))) out.push(`${at}.ac1: differs from its agreement and prevalence`);
    }
    if (pairs.length > 0 && agreeingOk && !closeTo(agreeing, pairs.reduce((s, row) => s + (typeof row['percentAgreement'] === 'number' ? row['percentAgreement'] : Number.NaN), 0) / pairs.length)) out.push(`${at}.percentAgreement: differs from the mean of the pair rows`);
  }
  return out;
}

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
 *
 * `raterIdentity` is required. Where the names are not persistent raters nothing that reads one name's own labels is
 * computed: no pair row, and Fleiss' kappa with multi-rater AC1 and the mean pairwise agreement at any number of names,
 * two included, since Cohen's chance term reads each rater's marginals and so depends on the order of a list. Those
 * three read per-item counts only, so shuffling the labels within items leaves the whole report as it was.
 */
export function agreementReport(ratingsByRater: RaterItems, opts: AgreementOptions): AgreementReport {
  assertDeclared(opts?.categories, 'agreementReport: categories');
  if (!RATER_IDENTITIES.includes(opts.raterIdentity)) throw new InputError('INVALID_ARGUMENT', ['agreementReport: raterIdentity: required: "persistent", "positional" or "UNKNOWN"']);
  const persistent = opts.raterIdentity === 'persistent';
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
  for (let i = 0; persistent && i < raters.length; i++) {
    for (let j = i + 1; j < raters.length; j++) {
      pairwise.push({ a: raters[i] as string, b: raters[j] as string, ...pairAgreement(byRater[i] as string[], byRater[j] as string[], categories, boot) });
    }
  }

  const two = persistent && raters.length === 2;
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
    raterIdentity: opts.raterIdentity,
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
    ...(opts.raterIdentity === 'persistent' ? {} : { identityNote: IDENTITY_NOTES[opts.raterIdentity] }),
    scope: AGREE_SCOPE,
  };
}
