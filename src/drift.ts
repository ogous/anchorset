import { DEFAULT_BOOTSTRAP, jaccard, pairAgreement } from './agreement.ts';
import { InputError, RefusalError } from './errors.ts';
import { isSha256Hex } from './identity.ts';
import { rank, validateLabelSet } from './scoring.ts';
import type { LabelSet } from './scoring.ts';
import { bootstrapCI, NA } from './stats.ts';
import type { BootstrapOptions, BootstrapResult, PercentileInterval, Stat } from './stats.ts';

export type DriftClass = 'counts-stable' | 'threshold-shift' | 'item-shift';

/** True of every pair of files, so it is on every report, in text and as `scope`. Internal: not re-exported from index.ts. */
export const DRIFT_SCOPE = 'A rating file names no judge, so the tool cannot show that both sets of ratings came from one judge.';

export type DriftOptions = {
  /** The declared, ordered labels. Required: their number enters AC1, so they are never taken from the verdicts that happen to occur. */
  labels: LabelSet;
  /** Labels whose item sets are compared for item shift (e.g. every label that triggers an action). */
  flagLabels: readonly string[];
  /**
   * item → sha256 of the packet each reading was shown. Required: agreement between two
   * readings is defined only where both were shown the same packet, and an unrecorded packet is not
   * an equal one.
   */
  packetHashes: { old: ReadonlyMap<string, string>; new: ReadonlyMap<string, string> };
  /** The resampling behind the intervals of kappa and AC1. Defaults to DEFAULT_BOOTSTRAP; the report states what was used. */
  bootstrap?: Partial<BootstrapOptions>;
  /** A label's count moving by at least this share of the anchor set counts as a rate shift. In (0, 1]: at 0 two identical readings would be a shift. Default 0.05. */
  rateShiftThreshold?: number;
  /**
   * Flagged-set overlap coefficient |A ∩ B| / min(|A|, |B|) below this counts as item shift. Default 0.8.
   * Overlap, not Jaccard: a judge that only grew or shrank its flagged set (one contains the other) moved
   * its threshold; Jaccard would drop for that too and misread it as flagging different items.
   */
  overlapThreshold?: number;
};

export type LabelDrift = { label: string; oldCount: number; newCount: number; delta: number; kept: number; keptRate: Stat };

export type DriftReport = {
  itemCount: number;
  labels: string[];
  /** transition.counts[i][j] = items that were labels[i] and are now labels[j]. */
  transition: { labels: string[]; counts: number[][] };
  perLabel: LabelDrift[];
  /** Cohen's kappa of old against new. Never reported alone: AC1, prevalence and the intervals sit beside it. */
  kappa: Stat;
  ac1: Stat;
  percentAgreement: number;
  /** Wilson 95% score interval of the agreeing share. */
  percentAgreementWilson: { lo: number; hi: number };
  /** Share of each label among the old and the new verdicts, pooled. */
  prevalence: Record<string, number>;
  /** Each reading's own share of each label. */
  marginals: { old: Record<string, number>; new: Record<string, number> };
  /** Seeded percentile bootstrap over anchor items, one seed for both. */
  kappaCI: PercentileInterval | typeof NA;
  ac1CI: PercentileInterval | typeof NA;
  bootstrap: BootstrapOptions;
  maxRateShift: number;
  flagLabels: string[];
  flaggedOld: number;
  flaggedNew: number;
  flaggedJaccard: number;
  /** |A ∩ B| / min(|A|, |B|): 1 when one flagged set contains the other, and when both are empty; NA when only one is empty. */
  flaggedOverlap: Stat;
  /** A description by fixed thresholds: read it with `classificationBasis`, never alone. */
  classification: DriftClass;
  /** What the classification is and is not. Printed beside it in every report. */
  classificationBasis: typeof DRIFT_BASIS;
  /** What this report cannot show, the same sentence on every report. */
  scope: typeof DRIFT_SCOPE;
  thresholds: { rateShift: number; overlap: number };
  /**
   * The smallest net change in one label's count (new count minus old count, in either direction) that
   * reaches the rate-shift threshold on this anchor set: the least d with d / itemCount >= thresholds.rateShift,
   * which is the ceiling of thresholds.rateShift times itemCount. NA when no change of at most itemCount does.
   * It is the rate rule's count only: the overlap rule is checked first, so a report that reaches it is
   * 'threshold-shift' only when the overlap rule has not already made it 'item-shift'. On a small set it is one
   * or two items, which two readings of one judge state can move. How often they do is not stated here: a rate
   * is quoted only from a seeded simulation in which both readings are noisy.
   */
  rateShiftMinItems: Stat;
};

/**
 * What a drift classification is. The thresholds are fixed numbers, not derived from how much one
 * judge moves between two readings of the same items, so 'threshold-shift' or 'item-shift' on its own
 * does not show that the judge changed: nothing here measured the judge against itself.
 */
export const DRIFT_BASIS = 'fixed thresholds; a description, not a test; no repeat-reading baseline' as const;

/**
 * The least integer d >= 0 with d / n >= threshold, by the same division the classification uses; NA when none
 * is at most n. d is a net change in one label's count. Reaching it is the rate rule alone: the classification
 * checks the overlap rule first.
 */
export function rateShiftMinItems(n: number, threshold: number): Stat {
  if (!Number.isInteger(n) || n < 1) throw new InputError('INVALID_ARGUMENT', [`rateShiftMinItems: n must be a positive integer, got ${n}`]);
  if (!(threshold > 0 && threshold <= 1)) throw new InputError('INVALID_ARGUMENT', [`rateShiftMinItems: the threshold must be in (0, 1], got ${threshold}`]);
  // Start one below the rounded product: 0.07 · 100 is 7.000000000000001 in floating point, and its ceiling would be 8.
  let d = Math.max(0, Math.ceil(threshold * n) - 1);
  while (d <= n && d / n < threshold) d++;
  return d > n ? NA : d;
}

export const DRIFT_DEFAULTS = { rateShiftThreshold: 0.05, overlapThreshold: 0.8 } as const;

function sameKeys(a: ReadonlyMap<string, unknown>, b: ReadonlyMap<string, unknown>): string[] {
  const diff: string[] = [];
  for (const k of a.keys()) if (!b.has(k)) diff.push(k);
  for (const k of b.keys()) if (!a.has(k)) diff.push(k);
  return diff.sort();
}

/**
 * Drift of a judge on a frozen anchor set: the same items judged before and after. Separates a rate
 * shift (counts moved, the same items still flagged: 'threshold-shift') from an item shift (different
 * items flagged: 'item-shift'). The overlap rule is checked first, then the rate rule. The classification
 * is a description by fixed thresholds (DRIFT_BASIS): the report carries that sentence and the smallest net
 * change in one label's count that reaches the rate threshold. The labels are required.
 */
export function driftReport(
  oldVerdicts: ReadonlyMap<string, string>,
  newVerdicts: ReadonlyMap<string, string>,
  opts: DriftOptions,
): DriftReport {
  const offIds = sameKeys(oldVerdicts, newVerdicts);
  if (offIds.length > 0) {
    throw new RefusalError('ITEM_SET_MISMATCH', offIds, `anchor item sets differ: ${offIds.join(', ')}`);
  }
  if (oldVerdicts.size === 0) throw new InputError('EMPTY_SAMPLE', ['empty anchor set']);
  // Every item needs a packet hash on both sides, and the two must be equal. No hashes at all is refused like any other gap.
  const ph0 = opts.packetHashes?.old ?? new Map<string, string>();
  const ph1 = opts.packetHashes?.new ?? new Map<string, string>();
  const bad = [...oldVerdicts.keys()].filter((id) => {
    const h = ph0.get(id);
    return !isSha256Hex(h) || h !== ph1.get(id);
  });
  const extra = [...sameKeys(ph0, oldVerdicts), ...sameKeys(ph1, oldVerdicts)];
  if (bad.length > 0 || extra.length > 0) {
    const fields = [...new Set([...bad, ...extra])].sort();
    throw new RefusalError('PACKET_MISMATCH', fields, `packet hash missing, malformed or different between the old and the new reading for: ${fields.join(', ')}`);
  }

  const ids = [...oldVerdicts.keys()].sort();
  const oldList = ids.map((id) => oldVerdicts.get(id) as string);
  const newList = ids.map((id) => newVerdicts.get(id) as string);
  if (!Array.isArray(opts.labels)) {
    throw new InputError('INVALID_ARGUMENT', ['driftReport: labels: required. The number of labels enters AC1, so a list taken from the verdicts that happen to occur would give the same data a different AC1 than the declared scale']);
  }
  const labels = [...opts.labels];
  const labelProblems = validateLabelSet(labels);
  if (labelProblems.length > 0) throw new InputError('INVALID_ARGUMENT', labelProblems);
  if (!Array.isArray(opts.flagLabels)) throw new InputError('INVALID_ARGUMENT', ['driftReport: flagLabels: required: a list of labels, each one of the declared labels']);
  for (const f of opts.flagLabels) rank(labels, f);
  if (opts.flagLabels.length === 0) throw new InputError('INVALID_ARGUMENT', ['flagLabels must not be empty']);

  const n = ids.length;
  const counts = labels.map(() => labels.map(() => 0));
  for (let i = 0; i < n; i++) {
    const row = counts[rank(labels, oldList[i] as string)] as number[];
    const j = rank(labels, newList[i] as string);
    row[j] = (row[j] as number) + 1;
  }
  const perLabel: LabelDrift[] = labels.map((label, i) => {
    const oldCount = (counts[i] as number[]).reduce((s, x) => s + x, 0);
    const newCount = counts.reduce((s, row) => s + (row[i] as number), 0);
    const kept = (counts[i] as number[])[i] as number;
    return { label, oldCount, newCount, delta: newCount - oldCount, kept, keptRate: oldCount === 0 ? NA : kept / oldCount };
  });

  const flag = new Set(opts.flagLabels);
  const flaggedOldSet = ids.filter((_, i) => flag.has(oldList[i] as string));
  const flaggedNewSet = ids.filter((_, i) => flag.has(newList[i] as string));
  const flaggedNewIds = new Set(flaggedNewSet);
  const inter = flaggedOldSet.filter((id) => flaggedNewIds.has(id)).length;
  const minSize = Math.min(flaggedOldSet.length, flaggedNewSet.length);
  const flaggedJaccard = jaccard(flaggedOldSet, flaggedNewSet);
  // A reduce, not Math.max(...list): the labels come from the files, and an argument list as long as an input overflows the call stack.
  const maxRateShift = perLabel.reduce((most, p) => Math.max(most, Math.abs(p.delta) / n), 0);

  const rateShift = opts.rateShiftThreshold ?? DRIFT_DEFAULTS.rateShiftThreshold;
  const ovl = opts.overlapThreshold ?? DRIFT_DEFAULTS.overlapThreshold;
  const thresholdProblems = [
    ...(typeof rateShift === 'number' && rateShift > 0 && rateShift <= 1 ? [] : [`rateShiftThreshold: must be a number in (0, 1], got ${rateShift}`]),
    ...(typeof ovl === 'number' && ovl >= 0 && ovl <= 1 ? [] : [`overlapThreshold: must be a number in [0, 1], got ${ovl}`]),
  ];
  if (thresholdProblems.length > 0) throw new InputError('INVALID_ARGUMENT', thresholdProblems);
  // An empty flagged set is contained in any other: growing from nothing is a threshold move.
  const overlapForClass = minSize === 0 ? 1 : inter / minSize;
  const classification: DriftClass =
    overlapForClass < ovl ? 'item-shift' : maxRateShift >= rateShift ? 'threshold-shift' : 'counts-stable';

  const bootstrap: BootstrapOptions = { ...DEFAULT_BOOTSTRAP, ...opts.bootstrap };
  const agreement = pairAgreement(oldList, newList, labels, bootstrap);

  return {
    itemCount: n,
    labels,
    transition: { labels, counts },
    perLabel,
    kappa: agreement.kappa,
    ac1: agreement.ac1,
    percentAgreement: agreement.percentAgreement,
    percentAgreementWilson: agreement.percentAgreementWilson,
    prevalence: agreement.prevalence,
    marginals: { old: agreement.marginals.a, new: agreement.marginals.b },
    kappaCI: agreement.kappaCI,
    ac1CI: agreement.ac1CI,
    bootstrap,
    maxRateShift,
    flagLabels: [...opts.flagLabels],
    flaggedOld: flaggedOldSet.length,
    flaggedNew: flaggedNewSet.length,
    flaggedJaccard,
    flaggedOverlap: minSize === 0 ? (flaggedOldSet.length === flaggedNewSet.length ? 1 : NA) : inter / minSize,
    classification,
    classificationBasis: DRIFT_BASIS,
    thresholds: { rateShift, overlap: ovl },
    rateShiftMinItems: rateShiftMinItems(n, rateShift),
    scope: DRIFT_SCOPE,
  };
}

export type JudgeControlledInput<T> = {
  /** Baseline outputs scored by the judge that produced the reported baseline number, keyed by case id. */
  baselineOldJudge: ReadonlyMap<string, T>;
  /** The same baseline outputs re-scored by the current judge. */
  baselineNewJudge: ReadonlyMap<string, T>;
  /** Candidate outputs scored by the current judge. */
  candidateNewJudge: ReadonlyMap<string, T>;
};

export type JudgeControlledDelta = {
  itemCount: number;
  /** Candidate (new judge) minus baseline (old judge): the number a naive comparison reports. */
  reportedDelta: BootstrapResult;
  /** Baseline re-judged minus baseline as first judged: the judge's movement on the baseline's outputs. */
  judgeEffect: BootstrapResult;
  /** Candidate minus the re-judged baseline: the system's movement, measured under the current judge. */
  systemEffect: BootstrapResult;
};

/**
 * Splits a reported score delta into the part the judge moved and the part the system moved.
 * Items are matched by case id and each row holds an item's three verdicts, so every interval is
 * paired. The three effects also share the seed over the same sorted rows, so they come from one
 * resample set. Point estimates add up to within floating-point rounding; percentile endpoints do not.
 */
export function judgeControlledDelta<T>(
  input: JudgeControlledInput<T>,
  scoreFn: (verdicts: readonly T[]) => number,
  bootstrap: BootstrapOptions,
): JudgeControlledDelta {
  const { baselineOldJudge, baselineNewJudge, candidateNewJudge } = input;
  const all = new Set([...baselineOldJudge.keys(), ...baselineNewJudge.keys(), ...candidateNewJudge.keys()]);
  const unmatched = [...all].filter((id) => !(baselineOldJudge.has(id) && baselineNewJudge.has(id) && candidateNewJudge.has(id))).sort();
  if (unmatched.length > 0) {
    throw new RefusalError('ITEM_SET_MISMATCH', unmatched, `case ids not present in all three runs: ${unmatched.join(', ')}`);
  }
  const rows = [...all].sort().map((id) => [baselineOldJudge.get(id), baselineNewJudge.get(id), candidateNewJudge.get(id)] as [T, T, T]);
  const score = (sample: readonly (readonly [T, T, T])[], k: 0 | 1 | 2): number => scoreFn(sample.map((r) => r[k]));
  return {
    itemCount: rows.length,
    reportedDelta: bootstrapCI(rows, (s) => score(s, 2) - score(s, 0), bootstrap),
    judgeEffect: bootstrapCI(rows, (s) => score(s, 1) - score(s, 0), bootstrap),
    systemEffect: bootstrapCI(rows, (s) => score(s, 2) - score(s, 1), bootstrap),
  };
}
