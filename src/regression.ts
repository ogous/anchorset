import { assertSameOutputs, assertSamePackets, judgeRejected, runArtifactProblems, systemNoAnswer } from './artifact.ts';
import { callShapeDiff } from './callshape.ts';
import type { RunArtifact } from './artifact.ts';
import { InputError, RefusalError } from './errors.ts';
import { judgeControlledDelta } from './drift.ts';
import type { JudgeControlledDelta } from './drift.ts';
import { barHash, evaluate, parseBarFile, splitBarFile } from './gate.ts';
import type { BarFile, GateResult } from './gate.ts';
import { assertComparable, DRAW_COUNT_FIELD, GAP, gateNeverWaives, hashOf, JUDGE_FIELDS, NO_JUDGE } from './identity.ts';
import type { IdentityField } from './identity.ts';
import { assertStopsKnown, extraKeys, foldRun, incompleteCounts, incompleteDetail } from './scoring.ts';
import type { ClassSpec, FoldedCase, FoldRunResult } from './scoring.ts';
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
   * (assertSamePackets); otherwise `judgeControl` is `{ refused }` and the gate's verdict stands. The original
   * is held to the admission checks and to the input rules, though: one that fails them, or whose labels are
   * not the bar's, stops the gate.
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

function checkRejudgedBaseline(original: RunArtifact, rejudged: RunArtifact): void {
  for (const [name, run] of [['original baseline (--rejudge-of)', original], ['re-judged baseline', rejudged]] as const) {
    if (run.identity.judgeDefinitionHash === NO_JUDGE) {
      throw new RefusalError('IDENTITY_MISMATCH', ['judgeDefinitionHash'], `the ${name} has no judge, so there is nothing to re-judge`);
    }
  }
  // A rewritten rubric is judge movement too, so a judged re-run may differ on it here; a plain
  // gate refuses it whenever a judge graded the runs.
  assertComparable(original.identity, rejudged.identity, { allowDiffer: [...JUDGE_FIELDS, 'rubricHash'] });
  assertSameOutputs(original, rejudged);
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
      const moved = (from: ReadonlyMap<string, boolean>, to: ReadonlyMap<string, boolean>) => ({
        newlyFailing: ids.filter((id) => from.get(id) === true && to.get(id) !== true),
        newlyPassing: ids.filter((id) => from.get(id) !== true && to.get(id) === true),
      });
      return {
        klass,
        n: ids.length,
        failing: { originalBaseline: failing(a), rejudgedBaseline: failing(b), candidate: failing(c) },
        transitions: [
          { from: 'originalBaseline', to: 'rejudgedBaseline', ...moved(a, b) },
          { from: 'rejudgedBaseline', to: 'candidate', ...moved(b, c) },
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
function splitRefusal(original: RunArtifact, rejudged: RunArtifact): RefusalError | undefined {
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

/**
 * The baseline-vs-candidate gate: verifies declared hashes, checks the identities are comparable,
 * folds both runs, evaluates the candidate against the bar and diffs it against the baseline.
 * Refusals are returned, not thrown; malformed input still throws InputError.
 */
export function gateRuns(baseline: RunArtifact, candidate: RunArtifact, barFile: BarFile, opts: GateRunOptions = {}): GateRunResult {
  // The bar is validated here, not only where a file is read: a caller who hands over an object gets the same refusal as the CLI.
  parseBarFile(barFile);
  const { labels, classes, bar } = splitBarFile(barFile);
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
  if (original !== undefined) runs.push(['original baseline (--rejudge-of)', original]);
  // The parser's own checks, so a caller that skipped parsing gets the same verdict (exit 65, run named).
  const invalid = runs.flatMap(([name, run]) => runArtifactProblems(run).map((p) => `${name}: ${p}`));
  if (invalid.length > 0) throw new InputError('INVALID_ARTIFACT', invalid);
  assertNoForbiddenWaiver(allowDiffer, baseline, candidate, original);
  let drawsPerCase: { base: number; cand: number; orig?: number };
  try {
    const expectedBar = barHash(barFile);
    for (const [name, run] of runs) {
      const declared = run.identity.barHash;
      refuseUnless(declared === GAP || declared === expectedBar, 'HASH_MISMATCH', ['barHash'], `${name} declares barHash ${declared}, the bar file hashes to ${expectedBar}`);
    }
    // An unknown system stop is not completion: no gate folds such a run.
    for (const [name, run] of runs) assertStopsKnown(run.draws, name, run.packetSource);
    for (const [name, run] of [['baseline', baseline], ['candidate', candidate]] as const) {
      const rejected = judgeRejected(run);
      if (rejected.length > 0) throw notRunnable(name, rejected);
    }
    if (original !== undefined) checkRejudgedBaseline(original, baseline);
    try {
      assertComparable(baseline.identity, candidate.identity, { allowDiffer });
    } catch (e) {
      if (!(e instanceof RefusalError)) throw e;
      const bothJudged = baseline.identity.judgeDefinitionHash !== NO_JUDGE && candidate.identity.judgeDefinitionHash !== NO_JUDGE;
      const judgeMoved = JUDGE_FIELDS.some((f) => !allowDiffer.includes(f) && baseline.identity[f] !== GAP && candidate.identity[f] !== GAP && baseline.identity[f] !== candidate.identity[f]);
      const notes = [
        ...callShapeNotes(e.fields, baseline, candidate),
        ...(original === undefined && e.code === 'IDENTITY_MISMATCH' && bothJudged && judgeMoved ? [REJUDGE_HINT] : []),
      ];
      if (notes.length === 0) throw e;
      throw new RefusalError(e.code, e.fields, [e.message.slice(e.code.length + 2), ...notes].join('; '));
    }
    assertSharedCasesUnchanged(baseline, candidate);
    const base = baseline.identity.drawsPerCase;
    const cand = candidate.identity.drawsPerCase;
    const orig = original?.identity.drawsPerCase;
    if (base === GAP || cand === GAP || orig === GAP) {
      throw new RefusalError('IDENTITY_GAP', ['drawsPerCase'], 'drawsPerCase is unknown, so completeness cannot be checked');
    }
    drawsPerCase = orig === undefined ? { base, cand } : { base, cand, orig };
    // A rejected request or the system's own error in the baseline hides a case the candidate breaks: the baseline's fail
    // is no reference for that case, so it drops out of BROKE. Baseline only: in a candidate the slot fails its case.
    const noAnswer = systemNoAnswer(baseline);
    if (noAnswer.length > 0) {
      const name = original === undefined ? 'baseline' : 're-judged baseline';
      const slots = noAnswer.map((x) => `${x.key} (${x.reason})`).join(', ');
      throw new RefusalError('INCOMPLETE_RUN', noAnswer.map((x) => x.key), `${name}: the system gave no answer on ${slots}; a slot with no answer cannot show which cases the candidate broke; fix the request or the system and run the baseline again`);
    }
  } catch (e) {
    if (e instanceof RefusalError) return { kind: 'refused', refusal: e };
    throw e;
  }

  // Any error inside a run's fold names the run, as a parse error names the file.
  const fold = (name: string, run: RunArtifact, n: number) => {
    try {
      return foldRun(run.cases, run.draws, labels, classes, n);
    } catch (e) {
      if (e instanceof InputError) throw new InputError(e.code, e.problems.map((p) => `${name}: ${p}`));
      throw e;
    }
  };
  const b = fold(original === undefined ? 'baseline' : 're-judged baseline', baseline, drawsPerCase.base);
  // A case missing from the baseline would show up as NEW, and a real break on it would pass. The
  // original of a re-judged baseline is not checked here: its judge may have failed on an output the
  // re-judged baseline graded, and the gate stands on the re-judged baseline. The split then refuses
  // the cases the original lacks, naming them. Its packets are not checked here either: the gate reads
  // no packet, and packets that differ from the re-judged baseline's refuse the split alone.
  if (b.incomplete.length > 0) {
    const name = original === undefined ? 'baseline' : 're-judged baseline';
    const counts = incompleteCounts(name, baseline.cases.length, drawsPerCase.base, b.incomplete);
    const detail = b.incomplete.map((x) => `${x.caseId}: ${incompleteDetail(x)}`).join('; ');
    const slots = b.incomplete.flatMap((x) => [...x.unmeasured.map((u) => u.drawIndex), ...x.missing].sort((p, q) => p - q).map((i) => `${x.caseId}#${i}`));
    return {
      kind: 'refused',
      refusal: new RefusalError('INCOMPLETE_RUN', slots, `${counts}; ${detail}; an incomplete baseline cannot show which cases the candidate broke`),
    };
  }
  const c = fold('candidate', candidate, drawsPerCase.cand);
  // The candidate answers for the baseline's cases and for any case of its own it did not finish.
  const baseIds = new Set(baseline.cases.map((x) => x.id));
  const expected = [...baseline.cases, ...c.incomplete.filter((x) => !baseIds.has(x.caseId)).map((x) => ({ id: x.caseId, klass: x.klass }))];
  const orig = drawsPerCase.orig;
  const split = (o: RunArtifact, n: number): JudgeControl => {
    const refused = splitRefusal(o, baseline);
    if (refused !== undefined) return { refused };
    return judgeControl(fold(ORIGINAL, o, n).folded, b.folded, c.folded, classes, opts.bootstrap ?? REJUDGE_BOOTSTRAP_DEFAULTS);
  };
  const control = original === undefined || orig === undefined ? {} : { judgeControl: split(original, orig) };
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
