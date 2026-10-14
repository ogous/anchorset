import { canonicalJson, sha256Hex } from './identity.ts';
import { mulberry32, seedFromString } from './rng.ts';

/**
 * The cross-fitted cut behind the recalibration map of the judge-change measurement
 * (docs/JUDGE_CHANGE.md). Internal: no function here is re-exported from index.ts (the type `FoldCut`
 * is, because the measurement's report holds it), and the map ships only inside that measurement. It is
 * never a general recalibrator.
 */

/** The fold of a case: the full sha256 of its id, read as an integer, modulo the number of folds. */
export function foldOfCase(caseId: string, folds: number): number {
  return Number(BigInt(`0x${sha256Hex(caseId)}`) % BigInt(folds));
}

/**
 * The tie-break of one item: uniform on [0, 1), a pure function of its key through the one PRNG.
 * Adding or removing a system or a case changes no other item's value.
 */
export function tieBreakU(seed: number, judge: 'old' | 'new', set: 'estimate' | 'reask', system: string, caseId: string): number {
  return mulberry32(seedFromString(canonicalJson([seed, judge, set, system, caseId])))();
}

/** The statistic of every item, [system][case]: the integer sum of its encoded grades, and its tie-break. Scored cases first, then fit-only cases. */
export type Scores = { sum: readonly (readonly number[])[]; u: readonly (readonly number[])[] };
export type Cut = { sum: number; u: number };

export type FoldCut = {
  fold: number;
  /** Weighted number of scored items this fold's cut labels. */
  labelled: number;
  /** Weighted number of items the cut is fitted on: the scored items outside the fold, and the fit-only items. */
  fit: number;
  /** Weighted number of fit items the target labels pass, and the number at or above the cut. */
  target: number;
  achieved: number;
  /** The cut; ALL_FAIL when the target is 0; NOTHING_TO_LABEL for a fold with no scored item; EMPTY_FIT_SET when there is nothing to fit on. */
  cut: Cut | 'ALL_FAIL' | 'NOTHING_TO_LABEL' | 'EMPTY_FIT_SET';
  /** Weighted labelled items whose integer sum equals the cut's, so that the tie-break decides their label. */
  decidedByTieBreak: number;
};

export type CutFit = {
  /** [system][scored case]: the item is at or above its fold's cut. */
  labels: boolean[][];
  folds: FoldCut[];
  /** False when a fold with scored items had an empty fit set: nothing that depends on the labels is computed. */
  defined: boolean;
};

/** Every item as [system, case], highest statistic first: the sum, then the tie-break. Computed once, since resampling changes only the weights. */
export function sortItems(src: Scores): [number, number][] {
  const items = src.sum.flatMap((row, s) => row.map((_, c): [number, number] => [s, c]));
  const key = (i: [number, number]): [number, number] => [(src.sum[i[0]] as readonly number[])[i[1]] as number, (src.u[i[0]] as readonly number[])[i[1]] as number];
  return items.sort((a, b) => {
    const [sa, ua] = key(a);
    const [sb, ub] = key(b);
    return sb - sa || ub - ua;
  });
}

/**
 * Fits one cut per fold and labels that fold's scored items with it. The cut is the largest
 * observed statistic in the fit set with at least as many (weighted) fit items at or above it as the
 * target labels pass there. It matches a count on the fit cases; the cases it then labels may pass a
 * different share. The statistic is compared as the pair (sum, tie-break), never rounded, and items
 * with an equal pair form one atom: two items share a tie-break with probability 2^-32 (about 2e-10), and when
 * such a pair sits at the cut, `achieved` exceeds `target` by its weight. A case drawn twice in a
 * resample has weight 2 and stays in its fold.
 */
export function fitCut(
  src: Scores,
  order: readonly (readonly [number, number])[],
  target: readonly (readonly boolean[])[],
  foldOf: readonly number[],
  folds: number,
  wScored: readonly number[],
  wFit: readonly number[],
): CutFit {
  const nScored = wScored.length;
  const sumOf = (s: number, c: number): number => (src.sum[s] as readonly number[])[c] as number;
  const uOf = (s: number, c: number): number => (src.u[s] as readonly number[])[c] as number;
  const labels = src.sum.map(() => new Array<boolean>(nScored).fill(false));
  const out: FoldCut[] = [];
  let defined = true;
  for (let f = 0; f < folds; f++) {
    const fitWeight = (c: number): number => (c < nScored ? (foldOf[c] === f ? 0 : (wScored[c] as number)) : (wFit[c - nScored] as number));
    const inFold = wScored.map((_, c) => c).filter((c) => foldOf[c] === f);
    const labelled = inFold.reduce((acc, c) => acc + (wScored[c] as number), 0) * src.sum.length;
    let fit = 0;
    let want = 0;
    for (const [s, c] of order) {
      const w = fitWeight(c);
      fit += w;
      if ((target[s] as readonly boolean[])[c] === true) want += w;
    }
    const row = { fold: f, labelled, fit, target: want };
    if (labelled === 0) {
      out.push({ ...row, achieved: 0, cut: 'NOTHING_TO_LABEL', decidedByTieBreak: 0 });
      continue;
    }
    if (fit === 0) {
      defined = false;
      out.push({ ...row, achieved: 0, cut: 'EMPTY_FIT_SET', decidedByTieBreak: 0 });
      continue;
    }
    if (want === 0) {
      out.push({ ...row, achieved: 0, cut: 'ALL_FAIL', decidedByTieBreak: 0 });
      continue;
    }
    let achieved = 0;
    let cut: Cut = { sum: Number.NEGATIVE_INFINITY, u: 0 };
    for (let i = 0; i < order.length; ) {
      const [s0, c0] = order[i] as readonly [number, number];
      const key = { sum: sumOf(s0, c0), u: uOf(s0, c0) };
      let atom = 0;
      let j = i;
      for (; j < order.length; j++) {
        const [s, c] = order[j] as readonly [number, number];
        if (sumOf(s, c) !== key.sum || uOf(s, c) !== key.u) break;
        atom += fitWeight(c);
      }
      achieved += atom;
      // The count first reaches the target at an atom of positive weight, so the cut is always an observed statistic.
      if (achieved >= want) {
        cut = key;
        break;
      }
      i = j;
    }
    let decidedByTieBreak = 0;
    for (const c of inFold) {
      src.sum.forEach((_, s) => {
        const sum = sumOf(s, c);
        (labels[s] as boolean[])[c] = sum > cut.sum || (sum === cut.sum && uOf(s, c) >= cut.u);
        if (sum === cut.sum) decidedByTieBreak += wScored[c] as number;
      });
    }
    out.push({ ...row, achieved, cut, decidedByTieBreak });
  }
  return { labels, folds: out, defined };
}
