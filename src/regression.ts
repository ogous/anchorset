import { assertSameOutputs, assertSamePackets, judgeRejected, runArtifactProblems, systemFacts, systemNoAnswer } from './artifact.ts';
import { callShapeDiff } from './callshape.ts';
import type { RunArtifact } from './artifact.ts';
import { InputError, RefusalError } from './errors.ts';
import { judgeControlledDelta } from './drift.ts';
import type { JudgeControlledDelta } from './drift.ts';
import { barHash, evaluate, parseBarFile, splitBarFile } from './gate.ts';
import type { BarFile, GateResult } from './gate.ts';
import { assertComparable, DRAW_COUNT_FIELD, GAP, gateNeverWaives, hashOf, IDENTITY_FIELDS, JUDGE_FIELDS, NO_JUDGE } from './identity.ts';
import type { IdentityField } from './identity.ts';
import { FIXED_SENTENCES } from './judgechange.ts';
import { assertStopsKnown, extraKeys, finalAttempt, foldRun, incompleteCounts, incompleteDetail, judgeRetries, unknownStops } from './scoring.ts';
import type { Case, ClassSpec, Draw, FailReason, FoldedCase, FoldRunResult, IncompleteCase } from './scoring.ts';
import { storedAnswerCount } from './stability.ts';
import type { BootstrapOptions } from './stats.ts';

/** CLI and gate exit codes. Frozen. */
export const EXIT_CODES = Object.freeze({
  /** Comparison admitted, every bar met, nothing broke. */
  OK: 0,
  /** Regression: a case broke, a class is below its bar, a non-compensable class failed, or cases are missing. */
  REGRESSION: 1,
  /** Comparison refused: identities differ outside the declared axes, a must-match value is unknown, or the baseline is incomplete or holds a slot where the system gave no answer. */
  REFUSED: 2,
  /** Bad command-line usage. */
  USAGE: 64,
  /** An input file failed validation. */
  INVALID_INPUT: 65,
  /** An error the command did not foresee. Never 1: a caller's script reads 1 as the verdict "regression". It says nothing about the runs. */
  INTERNAL: 70,
} as const);

/** INCOMPLETE: the candidate declared the case but its draws fell short; it is never NEW or REMOVED. */
export type CaseStatus = 'BROKE' | 'FIXED' | 'STILL_FAILING' | 'STILL_PASSING' | 'NEW' | 'REMOVED' | 'INCOMPLETE';

export type CaseDiff = { caseId: string; klass: string; status: CaseStatus };

/** `incomplete` lists the candidate's cases whose draws fell short (FoldRunResult.incomplete). */
export function diffRuns(
  baseline: readonly FoldedCase[],
  candidate: readonly FoldedCase[],
  incomplete: readonly { caseId: string; klass: string }[],
): CaseDiff[] {
  const base = new Map(baseline.map((f) => [f.caseId, f]));
  const cand = new Map(candidate.map((f) => [f.caseId, f]));
  const short = new Map(incomplete.map((x) => [x.caseId, x.klass]));
  const ids = [...new Set([...base.keys(), ...cand.keys(), ...short.keys()])].sort();
  return ids.map((caseId) => {
    const b = base.get(caseId);
    const c = cand.get(caseId);
    const shortKlass = short.get(caseId);
    if (c === undefined && shortKlass !== undefined) return { caseId, klass: shortKlass, status: 'INCOMPLETE' };
    if (b === undefined) return { caseId, klass: (c as FoldedCase).klass, status: 'NEW' };
    if (c === undefined) return { caseId, klass: b.klass, status: 'REMOVED' };
    const status: CaseStatus = b.pass ? (c.pass ? 'STILL_PASSING' : 'BROKE') : c.pass ? 'FIXED' : 'STILL_FAILING';
    return { caseId, klass: c.klass, status };
  });
}

export type AllowedDifference = { field: IdentityField; baseline: string | number; candidate: string | number };

export type NewCases = { klass: string; count: number; caseIds: string[] };

export type GateRunResult =
  | { kind: 'refused'; refusal: RefusalError }
  | {
      kind: 'evaluated';
      gate: GateResult;
      baselineGate: GateResult;
      diff: CaseDiff[];
      folded: { baseline: FoldedCase[]; candidate: FoldedCase[] };
      incomplete: { baseline: FoldRunResult['incomplete']; candidate: FoldRunResult['incomplete'] };
      allowedDifferences: AllowedDifference[];
      /**
       * For each class of the bar, in the order of `gate.classes`: how many of the cases counted in the class's `total`
       * are new, that is, folded by the candidate and not held by the baseline, and their ids, sorted. A new case stays
       * in its class's rate, so a rate over more cases than the baseline's is always shown beside this count. A new case
       * the candidate did not finish is not in `total` and is not counted here (it is in `gate.missingCaseIds`).
       * A whole number, never a share.
       */
      newCases: NewCases[];
      /** Present when the gate ran against a re-judged baseline (`rejudgeOf`). */
      judgeControl?: JudgeControl;
      /** Present exactly when `judgeControl` is: the cases whose folded result moved between the two baselines (JudgeFlips). */
      judgeFlips?: JudgeFlips;
    };

/**
 * The reported move (candidate vs the baseline as first judged), the judge's movement and the system's
 * movement, overall and per class. `refused` when the split itself is not computed (splitRefusal): the gate's verdict
 * stands then. An original baseline that is invalid input, or that fails the admission checks, stops the gate instead.
 *
 * A non-compensable class is never given a pass share, a difference of shares or a bracket:
 * a net rate can hide a case that newly fails behind one that newly passes. It is in `nonCompensable`,
 * as counts and case ids, and not in `perClass`. `overall` stays over every case, those of the
 * non-compensable classes included, because it must equal the delta a naive comparison reports.
 */
export type JudgeControl =
  | {
      overall: JudgeControlledDelta;
      /** The compensable bar classes that have a case, each with its split. */
      perClass: Record<string, JudgeControlledDelta>;
      /**
       * The non-compensable bar classes that have a case, sorted by name. `n` is the number of the class's
       * cases, each complete in all three runs. `failing` holds the ids that fail in each run, and each of
       * the two transitions, named by its two runs, the ids that fail in `to` and not in `from`
       * (`newlyFailing`) and the reverse (`newlyPassing`). Every list is sorted. No number but `n`.
       */
      nonCompensable: {
        klass: string;
        n: number;
        failing: { originalBaseline: string[]; rejudgedBaseline: string[]; candidate: string[] };
        transitions: [
          { from: 'originalBaseline'; to: 'rejudgedBaseline'; newlyFailing: string[]; newlyPassing: string[] },
          { from: 'rejudgedBaseline'; to: 'candidate'; newlyFailing: string[]; newlyPassing: string[] },
        ];
      }[];
      /** Bar classes with no case complete in all three runs: listed, not split. */
      emptyClasses: string[];
    }
  | { refused: RefusalError };

/** Frozen: a caller that wants another resampling passes `bootstrap`. */
export const REJUDGE_BOOTSTRAP_DEFAULTS: BootstrapOptions = Object.freeze({ iterations: 2000, seed: 1, alpha: 0.05 });

export type GateRunOptions = {
  /** Identity fields expected to differ between baseline and candidate. Nothing is allowed by default. */
  allowDiffer?: readonly IdentityField[];
  /**
   * The baseline as it was first judged. When given, `baseline` must be the same system outputs
   * re-graded by the candidate's judge; the gate runs against it and reports the judge's share.
   * The share is computed only when both baselines recorded the same packet for every draw
   * (assertSamePackets); otherwise `judgeControl` and `judgeFlips` are `{ refused }` and the gate's verdict stands.
   * Where the old judge left a slot without a grade, the split is refused as INCOMPLETE_RUN naming the slots, and the
   * judge-flip list lists those cases apart. The original is held to the admission checks and to the input rules,
   * though: one that fails them, or whose labels are not the bar's, stops the gate.
   */
  rejudgeOf?: RunArtifact;
  /** Bootstrap for the judge-controlled intervals. Defaults to REJUDGE_BOOTSTRAP_DEFAULTS. */
  bootstrap?: BootstrapOptions;
};

/**
 * Refuses a case id that both runs share but whose class, input or expected label changed. With the
 * case set allowed to differ, such a case would otherwise be re-scored under another class or a lower
 * expectation, and a failure could vanish from the diff. A changed case needs a new id.
 */
function assertSharedCasesUnchanged(baseline: RunArtifact, candidate: RunArtifact): void {
  const base = new Map(baseline.cases.map((c) => [c.id, hashOf(c)]));
  const changed = candidate.cases.filter((c) => base.has(c.id) && base.get(c.id) !== hashOf(c)).map((c) => c.id).sort();
  if (changed.length > 0) {
    throw new RefusalError('ITEM_SET_MISMATCH', changed, `cases changed under the same id (class, input or expected label): ${changed.join(', ')}; give a changed case a new id`);
  }
}

const notRunnable = (name: string, keys: readonly string[]): RefusalError =>
  new RefusalError('MEASUREMENT_NOT_RUNNABLE', keys, `${name}: the provider rejected the judge's call (4xx) on ${keys.join(', ')}; the recorded judge call shape cannot run as stated`);

/**
 * The checks of a re-judged baseline against the original, each a step of its own so that the admission can list every
 * one that refuses: both runs have a judge, they differ in nothing but the judge and the rubric, and the re-judged
 * baseline graded exactly the original's outputs.
 */
function rejudgedBaselineChecks(original: RunArtifact, rejudged: RunArtifact): (() => void)[] {
  const hasJudge = (name: string, run: RunArtifact) => (): void => {
    if (run.identity.judgeDefinitionHash === NO_JUDGE) {
      throw new RefusalError('IDENTITY_MISMATCH', ['judgeDefinitionHash'], `the ${name} has no judge, so there is nothing to re-judge`);
    }
  };
  return [
    hasJudge('original baseline (--rejudge-of)', original),
    hasJudge('re-judged baseline', rejudged),
    // A rewritten rubric is judge movement too, so a judged re-run may differ on it here; a plain
    // gate refuses it whenever a judge graded the runs.
    () => assertComparable(original.identity, rejudged.identity, { allowDiffer: [...JUDGE_FIELDS, 'rubricHash'] }),
    () => assertSameOutputs(original, rejudged),
  ];
}

/**
 * Of the ids given, those that pass in `from` and not in `to` (`newlyFailing`) and the reverse (`newlyPassing`), each in
 * the order of `ids`. The one definition of "newly failing" behind the non-compensable listing of the split and the
 * judge-flip list. An id absent from a map does not pass there, so a caller passes only ids both maps hold.
 */
function transitions(from: ReadonlyMap<string, boolean>, to: ReadonlyMap<string, boolean>, ids: readonly string[]): { newlyFailing: string[]; newlyPassing: string[] } {
  return {
    newlyFailing: ids.filter((id) => from.get(id) === true && to.get(id) !== true),
    newlyPassing: ids.filter((id) => from.get(id) !== true && to.get(id) === true),
  };
}

function judgeControl(
  original: readonly FoldedCase[],
  rejudged: readonly FoldedCase[],
  candidate: readonly FoldedCase[],
  barClasses: Readonly<Record<string, ClassSpec>>,
  bootstrap: BootstrapOptions,
): JudgeControl {
  const passRate = (v: readonly boolean[]): number => v.filter(Boolean).length / v.length;
  const byId = (fs: readonly FoldedCase[], klass?: string) => new Map(fs.filter((f) => klass === undefined || f.klass === klass).map((f) => [f.caseId, f.pass]));
  const split = (klass?: string) =>
    judgeControlledDelta({ baselineOldJudge: byId(original, klass), baselineNewJudge: byId(rejudged, klass), candidateNewJudge: byId(candidate, klass) }, passRate, bootstrap);
  try {
    // The overall split refuses unless every case id is in all three runs, so each class below has one case set.
    const overall = split();
    const present = new Set(rejudged.map((f) => f.klass));
    const classes = Object.keys(barClasses).sort();
    const strict = (k: string): boolean => barClasses[k]?.nonCompensable === true;
    // Counts and ids only: nothing here is divided, differenced or resampled.
    const listing = (klass: string): Extract<JudgeControl, { overall: unknown }>['nonCompensable'][number] => {
      const [a, b, c] = [byId(original, klass), byId(rejudged, klass), byId(candidate, klass)];
      const ids = [...b.keys()].sort();
      const failing = (m: ReadonlyMap<string, boolean>): string[] => ids.filter((id) => m.get(id) !== true);
      return {
        klass,
        n: ids.length,
        failing: { originalBaseline: failing(a), rejudgedBaseline: failing(b), candidate: failing(c) },
        transitions: [
          { from: 'originalBaseline', to: 'rejudgedBaseline', ...transitions(a, b, ids) },
          { from: 'rejudgedBaseline', to: 'candidate', ...transitions(b, c, ids) },
        ],
      };
    };
    return {
      overall,
      perClass: Object.fromEntries(classes.filter((k) => present.has(k) && !strict(k)).map((k) => [k, split(k)])),
      nonCompensable: classes.filter((k) => present.has(k) && strict(k)).map(listing),
      emptyClasses: classes.filter((k) => !present.has(k)),
    };
  } catch (e) {
    if (e instanceof RefusalError) return { refused: e };
    throw e;
  }
}

const ORIGINAL = 'original baseline (--rejudge-of)';

/**
 * Why the judge-and-system split cannot be computed from these two baselines, if it cannot. The
 * split sets the old judge's verdicts against the current judge's on the same draws, so it needs
 * what any comparison of two raters needs: a judge call that could run as stated, and the same
 * recorded packet on every draw (assertSamePackets). Returned, not thrown: these refuse the
 * split only, and the gate stands on the re-judged baseline.
 */
export function splitRefusal(original: RunArtifact, rejudged: RunArtifact): RefusalError | undefined {
  const rejected = judgeRejected(original);
  if (rejected.length > 0) return notRunnable(ORIGINAL, rejected);
  try {
    assertSamePackets(original, rejudged, { original: ORIGINAL, rejudged: 're-judged baseline' });
  } catch (e) {
    if (e instanceof RefusalError) return e;
    throw e;
  }
  return undefined;
}

/** How the packets behind a judge-flip list were found equal: as both runs recorded them, or by a declaration on one side or both. */
export type FlipPackets = 'recorded' | 'by declaration, not observed';

/**
 * Why the judge-flip list cannot be computed from these two baselines, if it cannot, or on what packets it stands. Like
 * the split, it needs a judge call that could run as stated and the same packet on every draw; unlike the split, it
 * admits packets that a run declares as well as recorded ones, through the same check (assertSamePackets) and its one
 * packet comparison, which judge-change uses too. An unknown packet basis or hash is never equal. A recorded side beside a declared one stands on the
 * declaration. Returned, not thrown: these refuse the list only, and the gate stands on the re-judged baseline.
 */
export function judgeFlipsAdmission(original: RunArtifact, rejudged: RunArtifact): { refused: RefusalError } | { packets: FlipPackets } {
  const rejected = judgeRejected(original);
  if (rejected.length > 0) return { refused: notRunnable(ORIGINAL, rejected) };
  try {
    const basis = assertSamePackets(original, rejudged, { original: ORIGINAL, rejudged: 're-judged baseline' }, ['recorded', 'declared']);
    return { packets: basis === 'recorded' ? 'recorded' : 'by declaration, not observed' };
  } catch (e) {
    if (e instanceof RefusalError) return { refused: e };
    throw e;
  }
}

/** The slots of incomplete cases as `case#draw`, every unmeasured and every missing slot, in case order and then draw order. */
function incompleteSlots(short: readonly IncompleteCase[]): string[] {
  return short.flatMap((x) => [...x.unmeasured.map((u) => u.drawIndex), ...x.missing].sort((p, q) => p - q).map((i) => `${x.caseId}#${i}`));
}

/**
 * The split's refusal of an original baseline whose old judge left slots without a grade: the slots are not a changed
 * case set, so it is an incomplete run, naming the slots and opening with their counts by reason. The gate stands on
 * the re-judged baseline, and the judge-flip list lists such cases in their own column.
 */
function originalIncomplete(short: readonly IncompleteCase[], caseCount: number, drawsPerCase: number): RefusalError {
  const counts = incompleteCounts(ORIGINAL, caseCount, drawsPerCase, short);
  const detail = short.map((x) => `${x.caseId}: ${incompleteDetail(x)}`).join('; ');
  return new RefusalError('INCOMPLETE_RUN', incompleteSlots(short), `${counts}; ${detail}; a slot the old judge left without a grade is not split into judge and system movement; the verdict stands on the re-judged baseline`);
}

/**
 * The split's refusal of a candidate whose cases hold a slot with no grade or no record: the cases are present, so this
 * is an incomplete run naming the slots, not a changed case set. The verdict stands, and fails those cases.
 */
function candidateIncomplete(short: readonly IncompleteCase[], caseCount: number, drawsPerCase: number): RefusalError {
  const counts = incompleteCounts('candidate', caseCount, drawsPerCase, short);
  const detail = short.map((x) => `${x.caseId}: ${incompleteDetail(x)}`).join('; ');
  return new RefusalError('INCOMPLETE_RUN', incompleteSlots(short), `${counts}; ${detail}; a slot the candidate left without a grade, or with no record, is not split; the verdict stands and fails that case`);
}

/** One draw's outcome in the judge-flip list: its label, a system failure by reason, or UNKNOWN where the slot holds no grade or has no record. */
export type FlipLabel = string | { failed: FailReason };
/** A case as one judge's fold left it: pass or fail, with the count of draws that fail it on their own. */
export type FlipFolded = { pass: boolean; failingDraws: number; labels: FlipLabel[] };
/** A case the old judge left without a grade on some slot: never a pass, a fail or a flip. `reason` reads "judge parse-failure", "system timeout" or "no record". */
export type FlipNoGrade = { noGrade: { drawIndex: number; reason: string }[]; labels: FlipLabel[] };
/**
 * Cases whose draws split between pass and fail, as counts beside their denominators, with one-answer and
 * different-answer cases apart, overall and per class. The two are never pooled: `splitCases` and `of`, and `split` and
 * `of` of a class, are present only when no case of the baseline holds different answers across its draws, so that
 * every split is the judge's alone.
 */
export type OwnVariation = {
  splitCases?: number;
  of?: number;
  oneAnswer: { split: number; of: number };
  differentAnswers: { split: number; of: number };
  byClass: { klass: string; split?: number; of?: number; oneAnswer: { split: number; of: number }; differentAnswers: { split: number; of: number } }[];
  /** Cases left out of the counts because a slot holds no grade (the old judge only). */
  noGradeCases: number;
};
/** What the own-variation counts read on runs of one draw per case. */
export const ONE_DRAW_OWN_VARIATION = 'not measured (one draw per case)';

/**
 * The judge-flip list of `gate --rejudge-of`: the baseline's stored answers as the old judge graded them (the original)
 * against the same answers as the new judge graded them (the re-judged baseline), each folded worst-of-N by the gate's
 * one fold. Per class, non-compensable classes first and then the others by name: the ids that moved from pass to fail
 * and from fail to pass, counted apart and never netted, and the ids the old judge left without a grade, which are in
 * neither direction. `cases` holds every flipped case and every no-grade case, and no other. `ownVariation` sets each
 * judge's own split draws beside the flips. No rate, no difference of rates and no bracket. `refused` when its admission
 * refuses (judgeFlipsAdmission): two judges are compared only on the packet both runs state, and the verdict stands.
 */
export type JudgeFlips =
  | {
      fold: 'worst-of-N';
      drawsPerCase: number;
      /** Whether the packets of the two baselines were found equal as both recorded them, or by a declaration. */
      packets: FlipPackets;
      judges: { old: { requested: string; served: string }; new: { requested: string; served: string } };
      classes: { klass: string; nonCompensable: boolean; n: number; passToFail: string[]; failToPass: string[]; noGradeOld: string[] }[];
      /** `answers`: how many distinct stored answers the case's draws hold; `answerHashes`: their output hashes, each once, in draw order. */
      cases: { caseId: string; klass: string; expect: string; answers: number; answerHashes: string[]; old: FlipFolded | FlipNoGrade; new: FlipFolded }[];
      ownVariation: { old: OwnVariation; new: OwnVariation } | typeof ONE_DRAW_OWN_VARIATION;
      statements: readonly string[];
    }
  | { refused: RefusalError };

function judgeFlips(originalFold: FoldRunResult, rejudgedFold: FoldRunResult, original: RunArtifact, rejudged: RunArtifact, barClasses: Readonly<Record<string, ClassSpec>>, drawsPerCase: number, packets: FlipPackets): JudgeFlips {
  const strict = (k: string): boolean => barClasses[k]?.nonCompensable === true;
  const byName = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  const present = [...new Set(rejudged.cases.map((c) => c.klass))];
  const classes = [...present.filter(strict).sort(byName), ...present.filter((k) => !strict(k)).sort(byName)];
  const oldById = new Map(originalFold.folded.map((f) => [f.caseId, f]));
  const newById = new Map(rejudgedFold.folded.map((f) => [f.caseId, f]));
  const shortById = new Map(originalFold.incomplete.map((x) => [x.caseId, x]));
  const draws = (run: RunArtifact): Map<string, Draw[]> => {
    const m = new Map<string, Draw[]>(run.cases.map((c) => [c.id, []]));
    for (const d of run.draws) m.get(d.caseId)?.push(d);
    return m;
  };
  const oldDraws = draws(original);
  const newDraws = draws(rejudged);
  const labelsOf = (ds: readonly Draw[]): FlipLabel[] =>
    Array.from({ length: drawsPerCase }, (_, i) => {
      const d = ds.find((x) => x.drawIndex === i);
      if (d === undefined) return GAP;
      const a = finalAttempt(d);
      return a.kind === 'graded' ? a.label : a.kind === 'failed' ? { failed: a.reason } : GAP;
    });
  const folded = (f: FoldedCase, ds: readonly Draw[]): FlipFolded => ({ pass: f.pass, failingDraws: f.failingDraws, labels: labelsOf(ds) });
  const answers = new Map(rejudged.cases.map((c) => [c.id, storedAnswerCount(newDraws.get(c.id) ?? [])]));
  const casesOf = (klass: string): Case[] => rejudged.cases.filter((c) => c.klass === klass).sort((x, y) => byName(x.id, y.id));
  const rows = classes.map((klass) => {
    const ids = casesOf(klass).map((c) => c.id);
    const graded = ids.filter((id) => oldById.has(id) && newById.has(id));
    const t = transitions(new Map(graded.map((id) => [id, (oldById.get(id) as FoldedCase).pass])), new Map(graded.map((id) => [id, (newById.get(id) as FoldedCase).pass])), graded);
    return { klass, nonCompensable: strict(klass), n: ids.length, passToFail: t.newlyFailing, failToPass: t.newlyPassing, noGradeOld: ids.filter((id) => shortById.has(id)) };
  });
  const listedIds = new Set(rows.flatMap((r) => [...r.passToFail, ...r.failToPass, ...r.noGradeOld]));
  const cases = classes.flatMap(casesOf).filter((c) => listedIds.has(c.id)).map((c) => {
    const nf = newById.get(c.id) as FoldedCase;
    const short = shortById.get(c.id);
    const old: FlipFolded | FlipNoGrade = short === undefined
      ? folded(oldById.get(c.id) as FoldedCase, oldDraws.get(c.id) ?? [])
      : {
          noGrade: [...short.unmeasured.map((u) => ({ drawIndex: u.drawIndex, reason: `${u.role} ${u.reason}` })), ...short.missing.map((i) => ({ drawIndex: i, reason: 'no record' }))].sort((p, q) => p.drawIndex - q.drawIndex),
          labels: labelsOf(oldDraws.get(c.id) ?? []),
        };
    const hashes = [...new Set([...(newDraws.get(c.id) ?? [])].sort((x, y) => x.drawIndex - y.drawIndex).map((d) => systemFacts(finalAttempt(d)).outputHash).filter((h) => h !== ''))];
    return { caseId: c.id, klass: c.klass, expect: c.expect, answers: answers.get(c.id) as number, answerHashes: hashes, old, new: folded(nf, newDraws.get(c.id) ?? []) };
  });
  // A split is 0 < failing draws < draws: the judge both passed and failed the case. Counted per judge and per class,
  // with one-answer and different-answer cases apart and never pooled.
  const mixed = rejudged.cases.some((c) => (answers.get(c.id) as number) > 1);
  const variation = (byId: ReadonlyMap<string, FoldedCase>): OwnVariation => {
    const all = classes.flatMap(casesOf).filter((c) => byId.has(c.id));
    const isSplit = (id: string): boolean => {
      const f = byId.get(id) as FoldedCase;
      return f.failingDraws > 0 && f.failingDraws < f.drawCount;
    };
    const parts = (cs: readonly Case[]): { oneAnswer: { split: number; of: number }; differentAnswers: { split: number; of: number } } => {
      const one = cs.filter((c) => answers.get(c.id) === 1);
      const many = cs.filter((c) => (answers.get(c.id) as number) > 1);
      return { oneAnswer: { split: one.filter((c) => isSplit(c.id)).length, of: one.length }, differentAnswers: { split: many.filter((c) => isSplit(c.id)).length, of: many.length } };
    };
    const pooled = (cs: readonly Case[]): { split: number; of: number } | Record<string, never> => (mixed ? {} : { split: cs.filter((c) => isSplit(c.id)).length, of: cs.length });
    const whole = pooled(all);
    return {
      ...('split' in whole ? { splitCases: whole.split, of: whole.of } : {}),
      ...parts(all),
      byClass: classes.map((klass) => {
        const cs = all.filter((c) => c.klass === klass);
        return { klass, ...pooled(cs), ...parts(cs) };
      }),
      noGradeCases: rejudged.cases.length - all.length,
    };
  };
  const judge = (run: RunArtifact): { requested: string; served: string } => ({ requested: String(run.identity.judgeModelRequested), served: String(run.identity.judgeModelServed) });
  return {
    fold: 'worst-of-N',
    drawsPerCase,
    packets,
    judges: { old: judge(original), new: judge(rejudged) },
    classes: rows,
    cases,
    ownVariation: drawsPerCase === 1 ? ONE_DRAW_OWN_VARIATION : { old: variation(oldById), new: variation(newById) },
    statements: FIXED_SENTENCES,
  };
}

/** The six judge rows of a refusal's judge diff, in the order they are printed. */
export const JUDGE_DIFF_FIELDS = ['judgeModelRequested', 'judgeModelServed', 'judgeDefinitionHash', 'rubricHash', 'judgeCallShapeHash', 'judgeHarnessVersion'] as const satisfies readonly IdentityField[];
export type JudgeDiffState = 'same' | 'differs' | 'unknown' | 'no-judge';
/**
 * The cost of re-grading the `from` run's stored answers, as counts: its slots (cases times the draw count) and how many
 * of them hold an answer to grade (a final attempt graded, or left without a grade by the judge). A slot the system
 * failed on, or gave no response on, or that has no record, needs no judge call, so the slot count would not be a lower
 * bound. Retries are extra; `baselineSlotsWithJudgeRetry` is how many slots the `from` run's own grading asked again on.
 * "UNKNOWN" when the run's draw count is unknown.
 */
export type RejudgeSize = { cases: number; drawsPerCase: number; slots: number; slotsWithAnswer: number; judgeCallsAtLeast: number; retriesExtra: true; baselineSlotsWithJudgeRetry: number };
/**
 * What a gate refusal on a judge field says about the two runs it is about: the six judge rows with each state, whether
 * the served model moved under one requested name, the call-shape keys that moved, the re-judge size, and the other
 * fields the refusal names, split into those that differ and those that are unknown. Internal: the reader of the CLI;
 * not re-exported from index.ts. The paths and the next commands are the CLI's, which knows them.
 */
export type JudgeDiff = {
  fields: { field: (typeof JUDGE_DIFF_FIELDS)[number]; from: string; to: string; state: JudgeDiffState }[];
  servedChangedUnderSameRequest: boolean;
  callShapeKeys: string[];
  /** Absent when no row differs (a refusal on unknown fields alone asks for the fields first), and toward a candidate graded by code. */
  rejudge?: RejudgeSize | typeof GAP;
  /** Fields the refusal names beside the judge rows, known on both sides and different. */
  alsoDiffer: IdentityField[];
  /** Every field the refusal names that is unknown, with the runs it is unknown in. */
  unknown: { field: IdentityField; in: ('from' | 'to')[] }[];
};

/**
 * The judge diff of a refusal, or undefined where none is printed. It is printed for an IDENTITY_MISMATCH or an
 * IDENTITY_GAP that names a judge field, or the rubric while either run has a judge, and only when the refusal is about
 * these two runs: every field it names must differ or be unknown between them. Any other refusal gets none. Pure.
 */
export function judgeDiff(from: RunArtifact, to: RunArtifact, refusal: RefusalError): JudgeDiff | undefined {
  if (refusal.code !== 'IDENTITY_MISMATCH' && refusal.code !== 'IDENTITY_GAP') return undefined;
  const a = from.identity;
  const b = to.identity;
  const judged = a.judgeDefinitionHash !== NO_JUDGE || b.judgeDefinitionHash !== NO_JUDGE;
  const diffField = (f: string): boolean => (JUDGE_FIELDS as readonly string[]).includes(f) || (f === 'rubricHash' && judged);
  if (!refusal.fields.some(diffField)) return undefined;
  const known = (f: string): f is IdentityField => (IDENTITY_FIELDS as readonly string[]).includes(f);
  // The refusal must be about these two runs, by its code: a gap is a gap here, and a mismatch differs here. Anything
  // else (an original's gap against its re-judged baseline) is about another pair and gets no diff.
  if (!refusal.fields.every(known)) return undefined;
  const fs = refusal.fields as readonly IdentityField[];
  const gapHere = (f: IdentityField): boolean => a[f] === GAP || b[f] === GAP;
  const differsHere = (f: IdentityField): boolean => !gapHere(f) && a[f] !== b[f];
  if (refusal.code === 'IDENTITY_GAP' && !fs.every(gapHere)) return undefined;
  if (refusal.code === 'IDENTITY_MISMATCH' && (!fs.every((f) => gapHere(f) || differsHere(f)) || !fs.some(differsHere))) return undefined;
  const stateOf = (f: (typeof JUDGE_DIFF_FIELDS)[number]): JudgeDiffState => {
    if (f !== 'rubricHash' && (a[f] === NO_JUDGE || b[f] === NO_JUDGE)) return a[f] === b[f] ? 'same' : 'no-judge';
    if (a[f] === GAP || b[f] === GAP) return 'unknown';
    return a[f] === b[f] ? 'same' : 'differs';
  };
  const fields = JUDGE_DIFF_FIELDS.map((field) => ({ field, from: String(a[field]), to: String(b[field]), state: stateOf(field) }));
  const req = fields[0] as { state: JudgeDiffState };
  const served = fields[1] as { state: JudgeDiffState };
  const sa = from.callShapes.judge;
  const sb = to.callShapes.judge;
  const moved = fields.some((x) => x.state === 'differs' || x.state === 'no-judge');
  const n = a.drawsPerCase;
  const answered = from.draws.filter((d) => {
    const x = finalAttempt(d);
    return x.kind === 'graded' || (x.kind === 'unmeasured' && x.role === 'judge');
  }).length;
  const size: RejudgeSize | typeof GAP = n === GAP
    ? GAP
    : { cases: from.cases.length, drawsPerCase: n, slots: from.cases.length * n, slotsWithAnswer: answered, judgeCallsAtLeast: answered, retriesExtra: true, baselineSlotsWithJudgeRetry: judgeRetries(from.draws).slotsWithRetry };
  const others = refusal.fields.filter((f): f is IdentityField => known(f) && !diffField(f));
  return {
    fields,
    servedChangedUnderSameRequest: req.state === 'same' && a.judgeModelRequested !== NO_JUDGE && served.state === 'differs',
    callShapeKeys: sa === NO_JUDGE || sb === NO_JUDGE ? [] : callShapeDiff(sa, sb),
    // Grading by code needs no judge call: no size is printed toward a candidate graded by code.
    ...(moved && b.judgeDefinitionHash !== NO_JUDGE ? { rejudge: size } : {}),
    alsoDiffer: others.filter((f) => a[f] !== GAP && b[f] !== GAP),
    unknown: refusal.fields.filter(known).flatMap((f) => {
      const where = [...(a[f] === GAP ? ['from' as const] : []), ...(b[f] === GAP ? ['to' as const] : [])];
      return where.length === 0 ? [] : [{ field: f, in: where }];
    }),
  };
}

/** For a refusal on a call-shape hash, which keys of the stored shapes moved or are unknown. */
function callShapeNotes(fields: readonly string[], baseline: RunArtifact, candidate: RunArtifact): string[] {
  const notes: string[] = [];
  for (const [field, role] of [['systemCallShapeHash', 'system'], ['judgeCallShapeHash', 'judge']] as const) {
    const a = baseline.callShapes[role];
    const b = candidate.callShapes[role];
    if (!fields.includes(field) || a === NO_JUDGE || b === NO_JUDGE) continue;
    const diff = callShapeDiff(a, b);
    if (diff.length > 0) notes.push(`${role} call shape: ${diff.join(', ')}`);
  }
  return notes;
}

const REJUDGE_HINT = 'the judge differs between these runs; re-judge the baseline outputs with the current judge and pass --rejudge-of <original baseline>';

function refuseUnless(ok: boolean, code: RefusalError['code'], fields: string[], message: string): void {
  if (!ok) throw new RefusalError(code, fields, message);
}

/**
 * What `allowDiffer` may never name on a gate. A usage error (INVALID_ARGUMENT), thrown before any comparison, with one
 * problem for each reason.
 *
 * A judge field, with or without a re-judged baseline: a changed judge is measured by re-judging the baseline with
 * the new judge and passing it as `rejudgeOf`, or by `judge-change`. The rubric is judge movement too, so
 * `rubricHash` is refused the same way whenever either run has a judge; between two runs with no judge it is an ordinary
 * field.
 *
 * The draw count: the fold is worst-of-N, so a run of fewer draws is a more lenient instrument, and a case that fails on
 * a later draw of the baseline reads as fixed against a candidate that never took that draw.
 */
function assertNoForbiddenWaiver(allowDiffer: readonly IdentityField[], baseline: RunArtifact, candidate: RunArtifact, original: RunArtifact | undefined): void {
  const judged = [baseline, candidate, ...(original === undefined ? [] : [original])].some((r) => r.identity.judgeDefinitionHash !== NO_JUDGE);
  const never = gateNeverWaives(allowDiffer, judged);
  const judge = never.filter((f) => f !== DRAW_COUNT_FIELD);
  const problems: string[] = [];
  if (judge.length > 0) {
    // The hint follows what the caller did: one who already passed the original baseline is not told to pass it.
    const cure =
      original === undefined
        ? "Re-judge the baseline's outputs with the new judge and pass the original baseline as --rejudge-of, or measure the change with judge-change"
        : "--rejudge-of already admits the judge's change between the original baseline and the re-judged one; between the re-judged baseline and the candidate the judge must be the same. Remove the field from --allow-differ, or measure the change with judge-change";
    problems.push(`allowDiffer: ${judge.join(', ')} cannot be allowed to differ on a gate: a judge that changed moves the labels on its own. ${cure}`);
  }
  if (never.length > judge.length) {
    problems.push(`allowDiffer: ${DRAW_COUNT_FIELD} cannot be allowed to differ on a gate: the draw count changes the fold on its own; re-run the baseline at the new count`);
  }
  if (problems.length > 0) throw new InputError('INVALID_ARGUMENT', problems);
}

/** One entry of the gate's admission: a refusal, or a step that could not run because an earlier fact is missing. */
export type AdmissionItem = { kind: 'refused'; refusal: RefusalError } | { kind: 'not-checked'; step: string; why: string };

type Admission = {
  items: AdmissionItem[];
  /** Present only when nothing was listed. */
  drawsPerCase?: { base: number; cand: number; orig?: number };
  baselineFold?: FoldRunResult;
};

/** A run's fold, with any error inside it naming the run, as a parse error names the file. */
function foldNamed(name: string, run: RunArtifact, labels: readonly string[], classes: Readonly<Record<string, ClassSpec>>, n: number): FoldRunResult {
  try {
    return foldRun(run.cases, run.draws, labels, classes, n);
  } catch (e) {
    if (e instanceof InputError) throw new InputError(e.code, e.problems.map((p) => `${name}: ${p}`));
    throw e;
  }
}

/**
 * The gate's admission, whole: every check `gateRuns` makes before it evaluates, in the order it makes them. Input that
 * is not in its format, and arguments the gate never takes, throw InputError, as they do from `gateRuns`. Each refusal
 * is collected rather than returned at once; a step that cannot run because an earlier fact is missing is listed as not
 * checked. `gateRuns` returns the first entry, so the gate and `validate` read one admission check.
 */
function admit(baseline: RunArtifact, candidate: RunArtifact, barFile: BarFile, opts: GateRunOptions): Admission {
  // The bar is validated here, not only where a file is read: a caller who hands over an object gets the same refusal as the CLI.
  parseBarFile(barFile);
  const { labels, classes } = splitBarFile(barFile);
  // An option the gate does not know is refused, not ignored: a caller who passes one expects it to do something.
  const unknownOptions = extraKeys(opts as Record<string, unknown>, ['allowDiffer', 'rejudgeOf', 'bootstrap'], 'options');
  if (unknownOptions.length > 0) throw new InputError('INVALID_ARGUMENT', unknownOptions);
  // Read once, into a plain copy: a check and a use cannot see two lists.
  if (opts.allowDiffer !== undefined && !Array.isArray(opts.allowDiffer)) throw new InputError('INVALID_ARGUMENT', ['allowDiffer: must be an array of identity fields']);
  const allowDiffer: IdentityField[] = Array.from(opts.allowDiffer ?? []);
  const original = opts.rejudgeOf;
  if (original === undefined && opts.bootstrap !== undefined) {
    throw new InputError('INVALID_ARGUMENT', ['bootstrap: only applies with rejudgeOf']);
  }
  const runs: [string, RunArtifact][] = [['baseline', baseline], ['candidate', candidate]];
  if (original !== undefined) runs.push([ORIGINAL, original]);
  // The parser's own checks, so a caller that skipped parsing gets the same verdict (exit 65, run named).
  const invalid = runs.flatMap(([name, run]) => runArtifactProblems(run).map((p) => `${name}: ${p}`));
  if (invalid.length > 0) throw new InputError('INVALID_ARTIFACT', invalid);
  assertNoForbiddenWaiver(allowDiffer, baseline, candidate, original);

  const items: AdmissionItem[] = [];
  // An invalid argument met after a refusal is already listed stays a "not checked" entry, so the gate returns that
  // refusal as it always did; with nothing listed yet it is thrown, as before.
  const step = (check: () => void): void => {
    try {
      check();
    } catch (e) {
      if (e instanceof RefusalError) items.push({ kind: 'refused', refusal: e });
      else if (e instanceof InputError && items.length > 0) items.push({ kind: 'not-checked', step: 'a later admission check', why: `invalid input (${e.code}): ${e.problems.join('; ')}` });
      else throw e;
    }
  };
  const expectedBar = barHash(barFile);
  for (const [name, run] of runs) {
    step(() => {
      const declared = run.identity.barHash;
      refuseUnless(declared === GAP || declared === expectedBar, 'HASH_MISMATCH', ['barHash'], `${name} declares barHash ${declared}, the bar file hashes to ${expectedBar}`);
    });
  }
  // An unknown system stop is not completion: no gate folds such a run.
  for (const [name, run] of runs) step(() => assertStopsKnown(run.draws, name, run.packetSource));
  for (const [name, run] of [['baseline', baseline], ['candidate', candidate]] as const) {
    step(() => {
      const rejected = judgeRejected(run);
      if (rejected.length > 0) throw notRunnable(name, rejected);
    });
  }
  if (original !== undefined) for (const check of rejudgedBaselineChecks(original, baseline)) step(check);
  step(() => {
    try {
      assertComparable(baseline.identity, candidate.identity, { allowDiffer });
    } catch (e) {
      if (!(e instanceof RefusalError)) throw e;
      const bothJudged = baseline.identity.judgeDefinitionHash !== NO_JUDGE && candidate.identity.judgeDefinitionHash !== NO_JUDGE;
      // The rubric is part of the judge whenever a judge graded the runs: an edit of it alone is re-judged like any other judge change.
      const judgeMoved = [...JUDGE_FIELDS, 'rubricHash' as const].some((f) => !allowDiffer.includes(f) && baseline.identity[f] !== GAP && candidate.identity[f] !== GAP && baseline.identity[f] !== candidate.identity[f]);
      const notes = [
        ...callShapeNotes(e.fields, baseline, candidate),
        ...(original === undefined && e.code === 'IDENTITY_MISMATCH' && bothJudged && judgeMoved ? [REJUDGE_HINT] : []),
      ];
      if (notes.length === 0) throw e;
      throw new RefusalError(e.code, e.fields, [e.message.slice(e.code.length + 2), ...notes].join('; '));
    }
  });
  step(() => assertSharedCasesUnchanged(baseline, candidate));
  const base = baseline.identity.drawsPerCase;
  const cand = candidate.identity.drawsPerCase;
  const orig = original?.identity.drawsPerCase;
  step(() => {
    if (base === GAP || cand === GAP || orig === GAP) {
      throw new RefusalError('IDENTITY_GAP', ['drawsPerCase'], 'drawsPerCase is unknown, so completeness cannot be checked');
    }
  });
  const baselineName = original === undefined ? 'baseline' : 're-judged baseline';
  // A rejected request or the system's own error in the baseline hides a case the candidate breaks: the baseline's fail
  // is no reference for that case, so it drops out of BROKE. Baseline only: in a candidate the slot fails its case.
  step(() => {
    const noAnswer = systemNoAnswer(baseline);
    if (noAnswer.length > 0) {
      const slots = noAnswer.map((x) => `${x.key} (${x.reason})`).join(', ');
      throw new RefusalError('INCOMPLETE_RUN', noAnswer.map((x) => x.key), `${baselineName}: the system gave no answer on ${slots}; a slot with no answer cannot show which cases the candidate broke; fix the request or the system and run the baseline again`);
    }
  });

  // A case missing from the baseline would show up as NEW, and a real break on it would pass. The
  // original of a re-judged baseline is not checked here: its judge may have failed on an output the
  // re-judged baseline graded, and the gate stands on the re-judged baseline. The split then refuses
  // such an original as an incomplete run, naming its slots, and the judge-flip list lists those cases apart. Its packets are not checked here either: the gate reads
  // no packet, and packets that differ from the re-judged baseline's refuse the split alone.
  const completeness = `${baselineName} completeness`;
  if (base === GAP) {
    items.push({ kind: 'not-checked', step: completeness, why: `the ${baselineName}'s drawsPerCase is unknown` });
    return { items };
  }
  if (unknownStops(baseline.draws).length > 0) {
    items.push({ kind: 'not-checked', step: completeness, why: `the ${baselineName}'s system stop is unknown on some slots, and no fold reads such a slot` });
    return { items };
  }
  let b: FoldRunResult;
  try {
    b = foldNamed(baselineName, baseline, labels, classes, base);
  } catch (e) {
    // With a refusal already listed the gate never reaches the fold, so what stops the fold is not the gate's answer.
    if (e instanceof InputError && items.length > 0) {
      items.push({ kind: 'not-checked', step: completeness, why: `the fold stopped on invalid input (${e.code}): ${e.problems.join('; ')}` });
      return { items };
    }
    throw e;
  }
  if (b.incomplete.length > 0) {
    const counts = incompleteCounts(baselineName, baseline.cases.length, base, b.incomplete);
    const detail = b.incomplete.map((x) => `${x.caseId}: ${incompleteDetail(x)}`).join('; ');
    const slots = incompleteSlots(b.incomplete);
    items.push({ kind: 'refused', refusal: new RefusalError('INCOMPLETE_RUN', slots, `${counts}; ${detail}; an incomplete baseline cannot show which cases the candidate broke`) });
  }
  if (items.length > 0 || cand === GAP || orig === GAP) return { items };
  return { items, drawsPerCase: orig === undefined ? { base, cand } : { base, cand, orig }, baselineFold: b };
}

/**
 * Every refusal the gate would raise before it evaluates, in the order it checks them, with each step that could not run
 * listed as not checked. Empty when the gate would evaluate. Its first entry is always a refusal, and it is the one
 * `gateRuns` returns. Internal: the reader of the `validate` command; not re-exported from index.ts.
 */
export function gateAdmission(baseline: RunArtifact, candidate: RunArtifact, barFile: BarFile, opts: GateRunOptions = {}): AdmissionItem[] {
  return admit(baseline, candidate, barFile, opts).items;
}

/**
 * The baseline-vs-candidate gate: verifies declared hashes, checks the identities are comparable,
 * folds both runs, evaluates the candidate against the bar and diffs it against the baseline.
 * Refusals are returned, not thrown; malformed input still throws InputError. Every check before the evaluation is
 * the admission (gateAdmission), and a refusal is its first entry.
 */
export function gateRuns(baseline: RunArtifact, candidate: RunArtifact, barFile: BarFile, opts: GateRunOptions = {}): GateRunResult {
  const admission = admit(baseline, candidate, barFile, opts);
  const first = admission.items[0];
  if (first !== undefined) {
    if (first.kind !== 'refused') throw new Error('gateRuns: the admission listed a step it did not check before any refusal');
    return { kind: 'refused', refusal: first.refusal };
  }
  const { drawsPerCase, baselineFold: b } = admission;
  if (drawsPerCase === undefined || b === undefined) throw new Error('gateRuns: an empty admission carries the draw count and the baseline fold');
  const { labels, classes, bar } = splitBarFile(barFile);
  const allowDiffer: IdentityField[] = Array.from(opts.allowDiffer ?? []);
  const original = opts.rejudgeOf;

  const fold = (name: string, run: RunArtifact, n: number): FoldRunResult => foldNamed(name, run, labels, classes, n);
  const c = fold('candidate', candidate, drawsPerCase.cand);
  // The candidate answers for the baseline's cases and for any case of its own it did not finish.
  const baseIds = new Set(baseline.cases.map((x) => x.id));
  const expected = [...baseline.cases, ...c.incomplete.filter((x) => !baseIds.has(x.caseId)).map((x) => ({ id: x.caseId, klass: x.klass }))];
  const orig = drawsPerCase.orig;
  // The split and the judge-flip list read one fold of the original, made before either admission. Each has its admission: the split takes recorded
  // packets only (splitRefusal), the list declared ones too (judgeFlipsAdmission); both are the one same-packets check.
  const split = (o: RunArtifact, n: number): { judgeControl: JudgeControl; judgeFlips: JudgeFlips } => {
    // Folded first, whatever its packets or its judge's calls: an original that is invalid input stops the gate.
    const oFold = fold(ORIGINAL, o, n);
    const splitRefused = splitRefusal(o, baseline);
    const flipAdmission = judgeFlipsAdmission(o, baseline);
    const flips: JudgeFlips = 'refused' in flipAdmission ? flipAdmission : judgeFlips(oFold, b, o, baseline, classes, n, flipAdmission.packets);
    if (splitRefused !== undefined) return { judgeControl: { refused: splitRefused }, judgeFlips: flips };
    if (oFold.incomplete.length > 0) return { judgeControl: { refused: originalIncomplete(oFold.incomplete, o.cases.length, n) }, judgeFlips: flips };
    // A case one run does not hold is a changed case set, named before any slot of a case both hold.
    const baseCaseIds = new Set(baseline.cases.map((x) => x.id));
    const candCaseIds = new Set(candidate.cases.map((x) => x.id));
    const unmatched = [...new Set([...baseCaseIds, ...candCaseIds])].filter((id) => !(baseCaseIds.has(id) && candCaseIds.has(id))).sort();
    if (unmatched.length > 0) return { judgeControl: { refused: new RefusalError('ITEM_SET_MISMATCH', unmatched, `case ids not present in all three runs: ${unmatched.join(', ')}`) }, judgeFlips: flips };
    if (c.incomplete.length > 0) return { judgeControl: { refused: candidateIncomplete(c.incomplete, candidate.cases.length, drawsPerCase.cand) }, judgeFlips: flips };
    return { judgeControl: judgeControl(oFold.folded, b.folded, c.folded, classes, opts.bootstrap ?? REJUDGE_BOOTSTRAP_DEFAULTS), judgeFlips: flips };
  };
  const control = original === undefined || orig === undefined ? {} : split(original, orig);
  const gate = evaluate(c.folded, bar, classes, expected);
  const diff = diffRuns(b.folded, c.folded, c.incomplete);
  // Read off the diff, so that "new" has one definition: the baseline is complete here, so a NEW row is a case the
  // candidate folded and the baseline does not hold.
  const newCases = gate.classes.map(({ klass }): NewCases => {
    const caseIds = diff.filter((d) => d.status === 'NEW' && d.klass === klass).map((d) => d.caseId);
    return { klass, count: caseIds.length, caseIds };
  });
  return {
    kind: 'evaluated',
    gate,
    baselineGate: evaluate(b.folded, bar, classes, baseline.cases),
    diff,
    folded: { baseline: b.folded, candidate: c.folded },
    incomplete: { baseline: b.incomplete, candidate: c.incomplete },
    allowedDifferences: allowDiffer
      .filter((f) => baseline.identity[f] !== candidate.identity[f])
      .map((f) => ({ field: f, baseline: baseline.identity[f], candidate: candidate.identity[f] })),
    newCases,
    ...control,
  };
}

/**
 * The exit code of what `gateRuns` returned: 2 for a refusal, 1 for a failed bar or a case that broke or is incomplete,
 * else 0. It takes a `GateRunResult`: the type says so for a TypeScript caller, and a JavaScript caller that hands over
 * an object lacking a part of one (a verdict with no fold, a refusal with no RefusalError), or holding `null` or a value
 * of another type where a part or a row of the diff should be, gets an InputError. This is a
 * shape check, not a proof of origin: an object that has every part of an evaluated result is read as one, so an
 * evaluated result that went through JSON is still readable. A refused result is not: its RefusalError does not survive
 * JSON, and what comes back is refused as an argument. The gate passed only when `gate.pass` is exactly `true`: any
 * other value, the string "false" included, is a regression.
 */
export function gateExitCode(v: GateRunResult): number {
  if (typeof v !== 'object' || v === null) throw new InputError('INVALID_ARGUMENT', ['gateExitCode: takes the result of gateRuns']);
  if (v.kind === 'refused') {
    if (!(v.refusal instanceof RefusalError)) throw new InputError('INVALID_ARGUMENT', ['gateExitCode: a refused result must hold the RefusalError that gateRuns returned']);
    return EXIT_CODES.REFUSED;
  }
  const r = v as Partial<Extract<GateRunResult, { kind: 'evaluated' }>>;
  const part = (x: unknown): boolean => typeof x === 'object' && x !== null && !Array.isArray(x);
  if (r.kind !== 'evaluated' || !part(r.gate) || !part(r.baselineGate) || !Array.isArray(r.diff) || !r.diff.every(part) || !part(r.folded) || !part(r.incomplete) || !Array.isArray(r.allowedDifferences) || !Array.isArray(r.newCases)) {
    throw new InputError('INVALID_ARGUMENT', ['gateExitCode: takes the result of gateRuns, whole; a verdict put together by hand is not one']);
  }
  const broke = r.diff.some((d) => d.status === 'BROKE' || d.status === 'INCOMPLETE');
  return (r.gate as GateResult).pass !== true || broke ? EXIT_CODES.REGRESSION : EXIT_CODES.OK;
}
