import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { InputError, RefusalError } from '../src/errors.ts';
import type { BarFile, GateResult } from '../src/gate.ts';
import type { FoldedCase } from '../src/scoring.ts';
import { assertSameOutputs, assertSamePackets, caseSetHash, RUN_SCHEMA } from '../src/artifact.ts';
import type { RunArtifact } from '../src/artifact.ts';
import { barHash, parseBarFile } from '../src/gate.ts';
import { GAP, hashOf, JUDGE_FIELDS, NO_JUDGE, NO_SEED, outputHashOf, sha256Hex } from '../src/identity.ts';
import type { RunIdentity } from '../src/identity.ts';
import { diffRuns, EXIT_CODES, gateExitCode, gateRuns } from '../src/regression.ts';
import type { CaseDiff, GateRunResult } from '../src/regression.ts';
import type { Attempt, Case, Draw } from '../src/scoring.ts';
import { callShapesFor, failedAttempt, gradedAttempt, makeCallShape, makeIdentity, makeJudgedIdentity, PACKET, packetBasisFor, slot, unmeasured } from './helpers.ts';
import { callShapeHash } from '../src/callshape.ts';
import type { CallShape } from '../src/callshape.ts';

const fc = (caseId: string, pass: boolean): FoldedCase => ({ caseId, klass: 'k', pass, attributedDraw: slot(caseId, 0, gradedAttempt('x')), drawCount: 1, failingDraws: pass ? 0 : 1 });
const okGate: GateResult = { pass: true, classes: [], missingCaseIds: [], extraCaseIds: [] };

test('diffRuns classifies every case', () => {
  const base = [fc('a', true), fc('b', false), fc('c', false), fc('d', true), fc('e', true)];
  const cand = [fc('a', false), fc('b', true), fc('c', false), fc('d', true), fc('f', true)];
  const byId = Object.fromEntries(diffRuns(base, cand, []).map((x) => [x.caseId, x.status]));
  assert.deepEqual(byId, { a: 'BROKE', b: 'FIXED', c: 'STILL_FAILING', d: 'STILL_PASSING', e: 'REMOVED', f: 'NEW' });
});

test('gateExitCode: 0 ok, 1 on a broken case or a failed gate, 2 on refusal', () => {
  assert.equal(EXIT_CODES.OK, 0);
  assert.equal(EXIT_CODES.REGRESSION, 1);
  assert.equal(EXIT_CODES.REFUSED, 2);
  // The exit code reads the gate and the diff; the other parts of a result are what makes it the result of gateRuns, and are empty here.
  const result = (gate: GateResult, diff: CaseDiff[]): GateRunResult => ({
    kind: 'evaluated',
    gate,
    baselineGate: gate,
    diff,
    folded: { baseline: [], candidate: [] },
    incomplete: { baseline: [], candidate: [] },
    allowedDifferences: [],
    newCases: [],
  });
  assert.equal(gateExitCode(result(okGate, [{ caseId: 'a', klass: 'k', status: 'FIXED' }])), 0);
  assert.equal(gateExitCode(result(okGate, [{ caseId: 'a', klass: 'k', status: 'BROKE' }])), 1);
  assert.equal(gateExitCode(result({ ...okGate, pass: false, missingCaseIds: ['z'] }, [])), 1);
  // A result that still holds an incomplete case fails the gate.
  assert.equal(gateExitCode(result(okGate, [{ caseId: 'a', klass: 'k', status: 'INCOMPLETE' }])), 1);
  assert.equal(gateExitCode({ kind: 'refused', refusal: new RefusalError('IDENTITY_GAP', ['seed'], 'x') }), 2);
});

test('gateExitCode: the gate passed only when pass is exactly true; a result read back from text with pass "false", 0, or no pass at all is a regression (1), never 0', () => {
  const evaluated = gateRuns(artifact(full('hi', 'hi')), artifact(full('hi', 'hi')), barFile);
  assert.equal(evaluated.kind, 'evaluated');
  if (evaluated.kind !== 'evaluated') return;
  assert.equal(gateExitCode(evaluated), 0);
  // An evaluated result survives JSON and is still read.
  assert.equal(gateExitCode(JSON.parse(JSON.stringify(evaluated)) as GateRunResult), 0);
  for (const pass of ['false', 'true', 0, 1, undefined, {}, []]) {
    const edited = { ...evaluated, gate: { ...evaluated.gate, pass } } as unknown as GateRunResult;
    assert.equal(gateExitCode(edited), 1, `pass: ${JSON.stringify(pass)}`);
  }
  // A refused result does not survive JSON (its RefusalError becomes a plain object), and is refused as an argument.
  const refused = gateRuns(artifact(full('hi', 'hi')), artifact(full('hi', 'hi'), { drawsPerCase: GAP }), barFile);
  assert.equal(gateExitCode(refused), 2);
  assert.throws(() => gateExitCode(JSON.parse(JSON.stringify(refused)) as GateRunResult), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT');
});

test('gateExitCode takes the result of gateRuns only: a verdict put together by hand from the folds does not type-check', () => {
  const byHand = { kind: 'evaluated', gate: okGate, diff: [] } as const;
  // @ts-expect-error a gate and a diff without the two folds, the allowed differences, the incomplete lists and the new-case counts are not what gateRuns returned
  const typed = (): number => gateExitCode(byHand);
  // Nor does it run for a JavaScript caller, which the type cannot stop: the exit code is refused, not 0.
  assert.throws(typed, (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && /put together by hand/.test(e.problems.join()));
  assert.throws(() => gateExitCode({ kind: 'refused' } as unknown as GateRunResult), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT');
  assert.throws(() => gateExitCode(null as unknown as GateRunResult), InputError);
});

test('gateExitCode: a part that is null, or of another type, is INVALID_ARGUMENT like a part that is absent, never a bare TypeError', () => {
  const evaluated = gateRuns(artifact(full('hi', 'hi')), artifact(full('hi', 'hi')), barFile);
  assert.equal(evaluated.kind, 'evaluated');
  const invalid = (e: unknown): boolean => e instanceof InputError && e.code === 'INVALID_ARGUMENT';
  for (const part of ['gate', 'baselineGate', 'folded', 'incomplete', 'diff', 'allowedDifferences', 'newCases']) {
    for (const bad of [null, undefined, 'x', 1, true]) {
      assert.throws(() => gateExitCode({ ...evaluated, [part]: bad } as unknown as GateRunResult), invalid, `${part}: ${String(bad)}`);
    }
  }
  for (const bad of [null, undefined, 'BROKE', 1]) {
    assert.throws(() => gateExitCode({ ...evaluated, diff: [bad] } as unknown as GateRunResult), invalid, `diff: [${String(bad)}]`);
  }
  // An array is not a part: `gate: []` has no `pass` and would otherwise read as a regression (exit 1), which is a verdict.
  for (const part of ['gate', 'baselineGate', 'folded', 'incomplete']) {
    for (const bad of [[], [{ pass: true }]]) {
      assert.throws(() => gateExitCode({ ...evaluated, [part]: bad } as unknown as GateRunResult), invalid, `${part}: ${JSON.stringify(bad)}`);
    }
  }
  assert.throws(() => gateExitCode({ ...evaluated, diff: [[]] } as unknown as GateRunResult), invalid, 'diff: [[]]');
});

test('gateRuns: allowDiffer is an array of identity fields; a string, a Set or an object is INVALID_ARGUMENT, and the refusal of a field that can never be waived does not rest on the array\'s own methods', () => {
  const run = artifact(full('hi', 'hi'));
  const invalid = (e: unknown): boolean => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && /allowDiffer: must be an array of identity fields/.test(e.problems.join());
  for (const bad of ['drawsPerCase', new Set(['drawsPerCase']), { 0: 'drawsPerCase', length: 1 }, 1, null]) {
    assert.throws(() => gateRuns(run, run, barFile, { allowDiffer: bad as unknown as ['drawsPerCase'] }), invalid, String(bad));
  }
  // An array subclass whose filter hides every field: the fields are read from a plain copy, so the draw count is still refused.
  class Hiding extends Array<string> {
    override filter(): string[] { return []; }
  }
  const hiding = Hiding.from(['drawsPerCase']);
  // An option the gate does not know is refused, not ignored: a caller who passes one expects it to do something.
  assert.throws(() => gateRuns(run, run, barFile, { labels: ['x'] } as unknown as Record<string, never>), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && /options\.labels: unknown field/.test(e.message));
  assert.throws(() => gateRuns(run, run, barFile, { allowDiffer: hiding as unknown as ['drawsPerCase'] }), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && /drawsPerCase cannot/.test(e.problems.join()));
});

test('gateRuns refuses a judge field in allowDiffer, with or without a re-judged baseline: INVALID_ARGUMENT naming each field and --rejudge-of', () => {
  const judged = (over = {}): RunArtifact => {
    const identity = makeJudgedIdentity({ caseSetHash: caseSetHash(cases), barHash: barHash(barFile), drawsPerCase: 2, ...over });
    const draws = full('hi', 'hi').map((d) => slot(d.caseId, d.drawIndex, gradedAttempt('hi', { judgeStop: 'tool-use' })));
    return { schema: RUN_SCHEMA, identity, callShapes: callShapesFor(identity), cases, draws, ...packetBasisFor(identity) };
  };
  const a = judged();
  const b = judged();
  assert.equal(gateRuns(a, b, barFile).kind, 'evaluated', 'control: with no judge field waived the same pair is gated');
  for (const f of JUDGE_FIELDS) {
    for (const opts of [{ allowDiffer: [f] }, { allowDiffer: ['systemModelServed', f] }, { allowDiffer: [f], rejudgeOf: a }] as const) {
      assert.throws(
        () => gateRuns(a, b, barFile, opts),
        (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && e.problems.join().includes(f) && e.problems.join().includes('--rejudge-of'),
        `${f} ${JSON.stringify(Object.keys(opts))}`,
      );
    }
  }
  // Every field is named in the one refusal.
  assert.throws(() => gateRuns(a, b, barFile, { allowDiffer: ['judgeModelRequested', 'judgeModelServed'] }), (e: unknown) => e instanceof InputError && /judgeModelRequested, judgeModelServed/.test(e.problems.join()));
  // The hint follows what the caller already did. Without a re-judged baseline it says to pass one, byte for byte as before;
  // with one, it does not send the caller to the option already given.
  const problemOf = (opts: Parameters<typeof gateRuns>[3]): string => {
    try {
      gateRuns(a, b, barFile, opts);
    } catch (e) {
      if (e instanceof InputError && e.problems.length === 1) return e.problems[0] as string;
      throw e;
    }
    throw new Error('not refused');
  };
  assert.equal(
    problemOf({ allowDiffer: ['judgeModelServed'] }),
    "allowDiffer: judgeModelServed cannot be allowed to differ on a gate: a judge that changed moves the labels on its own. Re-judge the baseline's outputs with the new judge and pass the original baseline as --rejudge-of, or measure the change with judge-change",
  );
  const withOriginal = problemOf({ allowDiffer: ['judgeModelServed'], rejudgeOf: a });
  assert.doesNotMatch(withOriginal, /pass the original baseline as --rejudge-of/);
  assert.equal(
    withOriginal,
    'allowDiffer: judgeModelServed cannot be allowed to differ on a gate: a judge that changed moves the labels on its own. --rejudge-of already admits the judge\'s change between the original baseline and the re-judged one; between the re-judged baseline and the candidate the judge must be the same. Remove the field from --allow-differ, or measure the change with judge-change',
  );
});

test('gateRuns refuses rubricHash in allowDiffer when either run has a judge; between two runs with no judge it stays allowed', () => {
  const judgedRun = (): RunArtifact => {
    const identity = makeJudgedIdentity({ caseSetHash: caseSetHash(cases), barHash: barHash(barFile), drawsPerCase: 2 });
    const draws = full('hi', 'hi').map((d) => slot(d.caseId, d.drawIndex, gradedAttempt('hi', { judgeStop: 'tool-use' })));
    return { schema: RUN_SCHEMA, identity, callShapes: callShapesFor(identity), cases, draws, ...packetBasisFor(identity) };
  };
  const code = artifact(full('hi', 'hi'));
  const judged = judgedRun();
  assert.equal(code.identity.judgeDefinitionHash, NO_JUDGE);
  assert.equal(gateRuns(code, artifact(full('hi', 'hi')), barFile, { allowDiffer: ['rubricHash'] }).kind, 'evaluated', 'no judge on either side: the rubric is an ordinary field');
  for (const [x, y] of [[judged, judged], [judged, code], [code, judged]] as const) {
    assert.throws(() => gateRuns(x, y, barFile, { allowDiffer: ['rubricHash'] }), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && e.problems.join().includes('rubricHash'));
  }
});

const barFile = parseBarFile({ labels: ['lo', 'hi'], classes: { k: { direction: 'floor', minPassRate: 0.5 } }, knownFailures: [] });
const cases: Case[] = [
  { id: 'c1', klass: 'k', input: 'a', expect: 'hi' },
  { id: 'c2', klass: 'k', input: 'b', expect: 'hi' },
];
const artifact = (draws: Draw[], over = {}): RunArtifact => {
  const identity = makeIdentity({ caseSetHash: caseSetHash(cases), barHash: barHash(barFile), drawsPerCase: 2, ...over });
  return { schema: RUN_SCHEMA, identity, callShapes: callShapesFor(identity), cases, draws, ...packetBasisFor(identity) };
};
const full = (c1: string, c2: string): Draw[] => [
  slot('c1', 0, gradedAttempt(c1)),
  slot('c1', 1, gradedAttempt('hi')),
  slot('c2', 0, gradedAttempt(c2)),
  slot('c2', 1, gradedAttempt('hi')),
];

test('gateRuns validates the bar it is handed: a bar without knownFailures is invalid input, not a verdict', () => {
  const unparsed = { labels: ['lo', 'hi'], classes: { k: { direction: 'floor', minPassRate: 0.5 } } } as unknown as BarFile;
  assert.throws(() => gateRuns(artifact(full('hi', 'hi')), artifact(full('hi', 'hi')), unparsed), (e: unknown) => e instanceof InputError && e.code === 'INVALID_BAR');
});

test('gateRuns: a case with missing candidate draws fails the gate as missing', () => {
  const r = gateRuns(artifact(full('hi', 'hi')), artifact(full('hi', 'hi').slice(0, 3)), barFile);
  assert.equal(r.kind, 'evaluated');
  if (r.kind !== 'evaluated') return;
  assert.deepEqual(r.incomplete.candidate, [{ caseId: 'c2', klass: 'k', expected: 2, got: 1, missing: [1], unmeasured: [], measuredFailure: false }]);
  assert.deepEqual(r.gate.missingCaseIds, ['c2']);
  assert.equal(gateExitCode(r), 1);
});

test('gateRuns: a broken case fails even when the class still meets its bar', () => {
  const r = gateRuns(artifact(full('hi', 'hi')), artifact(full('lo', 'hi')), barFile);
  assert.equal(r.kind === 'evaluated' && r.gate.pass, true);
  assert.equal(gateExitCode(r), 1);
  assert.equal(gateExitCode(gateRuns(artifact(full('lo', 'hi')), artifact(full('hi', 'hi')), barFile)), 0);
});

test('gateRuns: an unknown drawsPerCase is refused (IDENTITY_GAP); naming it in allowDiffer is a refusal of the arguments, known or not', () => {
  const r = gateRuns(artifact(full('hi', 'hi')), artifact(full('hi', 'hi'), { drawsPerCase: GAP }), barFile);
  assert.equal(r.kind, 'refused');
  assert.equal(r.kind === 'refused' && r.refusal.code, 'IDENTITY_GAP');
  assert.equal(r.kind === 'refused' && r.refusal.fields.join(), 'drawsPerCase');
  assert.equal(gateExitCode(r), 2);
  assert.throws(
    () => gateRuns(artifact(full('hi', 'hi')), artifact(full('hi', 'hi'), { drawsPerCase: GAP }), barFile, { allowDiffer: ['drawsPerCase'] }),
    (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && /drawsPerCase/.test(e.problems.join()),
  );
});

// The fold is worst-of-N, so a smaller N is a more lenient instrument: the draw count moves the verdict on its own.
// The refund-bot baseline, cut to its first draw of each case, is the same system and the same outputs. Case r07 fails
// in the baseline on a later draw only, so against the cut run it would read FIXED with every bar met (exit 0).
test('gateRuns: drawsPerCase cannot be allowed to differ on a gate (INVALID_ARGUMENT naming it, before any comparison); without the waiver two known, different counts are IDENTITY_MISMATCH', () => {
  const committed = (name: string): unknown => JSON.parse(readFileSync(new URL(`../examples/refund-bot/${name}`, import.meta.url), 'utf8'));
  const baseline = committed('baseline.json') as RunArtifact;
  const bar = parseBarFile(committed('bar.json'));
  assert.equal(baseline.identity.drawsPerCase, 3);
  const cut: RunArtifact = { ...baseline, identity: { ...baseline.identity, drawsPerCase: 1 }, draws: baseline.draws.filter((d) => d.drawIndex === 0) };
  // The premise: the cut run folds r07 as a pass, and the whole run folds it as a failure.
  const whole = gateRuns(baseline, baseline, bar);
  const alone = gateRuns(cut, cut, bar);
  assert.equal(whole.kind === 'evaluated' && whole.folded.candidate.find((f) => f.caseId === 'r07')?.pass, false);
  assert.equal(alone.kind === 'evaluated' && alone.folded.candidate.find((f) => f.caseId === 'r07')?.pass, true);
  for (const [b, c] of [[baseline, cut], [cut, baseline]] as const) {
    assert.throws(
      () => gateRuns(b, c, bar, { allowDiffer: ['drawsPerCase'] }),
      (e: unknown) =>
        e instanceof InputError && e.code === 'INVALID_ARGUMENT' && e.problems.length === 1 &&
        /^allowDiffer: drawsPerCase cannot be allowed to differ on a gate: the draw count changes the fold on its own; re-run the baseline at the new count$/.test(e.problems[0] as string),
    );
    refusedWith(gateRuns(b, c, bar), 'IDENTITY_MISMATCH', 'drawsPerCase');
  }
  // Named beside another field, and beside a judge field: each refused field is named, each with its own reason.
  assert.throws(
    () => gateRuns(baseline, cut, bar, { allowDiffer: ['systemModelServed', 'drawsPerCase', 'judgeModelServed'] }),
    (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && e.problems.length === 2 && /judgeModelServed cannot/.test(e.problems.join('\n')) && /drawsPerCase cannot/.test(e.problems.join('\n')) && !/systemModelServed/.test(e.problems.join('\n')),
  );
  // Two runs of the same count are refused too: the rule is on the argument, not on what the runs hold.
  assert.throws(() => gateRuns(baseline, baseline, bar, { allowDiffer: ['drawsPerCase'] }), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT');
  // With a re-judged baseline as well.
  assert.throws(() => gateRuns(B, C, barFile, { rejudgeOf: A, allowDiffer: ['systemModelServed', 'drawsPerCase'], bootstrap: boot }), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && /drawsPerCase/.test(e.problems.join()));
});

// --- New cases in a class's rate ---------------------------------------------------------------------
// The count of new cases is defined by this library, so this is a hand-worked fixture and no published value is claimed.
// A new case is a case the candidate folded that the baseline does not hold. It stays in its class's rate, so the
// class row has to say how many of its cases are new.
//   baseline:  k01..k10, one class k under a floor with a bar of 0.9. k01..k08 pass, k09 and k10 fail: 8/10 = 0.8,
//              below the bar. Gated against itself: no new case, exit 1.
//   candidate: the same ten with the same grades, and n01..n10, all passing: 8 + 10 = 18 of 10 + 10 = 20 = 0.9,
//              which meets the bar. Ten of the twenty are new. With the case set allowed to differ: exit 0.
//   candidate with an unfinished new case: n10 has no draw. It is INCOMPLETE and not in the class's total, so the
//              count of new cases among the folded ones is 9 (17 of 19 folded), and the gate fails on the missing case.
const newCaseBar = parseBarFile({ labels: ['lo', 'hi'], classes: { k: { direction: 'floor', minPassRate: 0.9 }, empty: { direction: 'floor', minPassRate: 0 } }, knownFailures: [] });
const newCaseRun = (ids: readonly string[], failing: readonly string[], without: readonly string[] = []): RunArtifact => {
  const cs: Case[] = ids.map((id) => ({ id, klass: 'k', input: `input ${id}`, expect: 'hi' }));
  const identity = makeIdentity({ caseSetHash: caseSetHash(cs), barHash: barHash(newCaseBar), drawsPerCase: 1 });
  const draws = ids.filter((id) => !without.includes(id)).map((id) => slot(id, 0, gradedAttempt(failing.includes(id) ? 'lo' : 'hi')));
  return { schema: RUN_SCHEMA, identity, callShapes: callShapesFor(identity), cases: cs, draws, ...packetBasisFor(identity) };
};
const ten = (prefix: string): string[] => Array.from({ length: 10 }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`);

test('gateRuns: new cases stay in a class\'s rate and the result states how many of the class\'s folded cases are new, with their ids (a hand-worked fixture: 18 of 20, 10 new)', () => {
  const baseline = newCaseRun(ten('k'), ['k09', 'k10']);
  const same = gateRuns(baseline, baseline, newCaseBar);
  assert.equal(same.kind, 'evaluated');
  if (same.kind !== 'evaluated') return;
  assert.deepEqual(same.gate.classes.map((c) => [c.klass, c.passed, c.total, c.rate, c.meetsBar]), [['k', 8, 10, 0.8, false], ['empty', 0, 0, 'NA', false]]);
  assert.deepEqual(same.newCases, [{ klass: 'k', count: 0, caseIds: [] }, { klass: 'empty', count: 0, caseIds: [] }]);
  assert.equal(gateExitCode(same), 1);

  const grown = newCaseRun([...ten('k'), ...ten('n')], ['k09', 'k10']);
  refusedWith(gateRuns(baseline, grown, newCaseBar), 'IDENTITY_MISMATCH', 'caseSetHash');
  const r = gateRuns(baseline, grown, newCaseBar, { allowDiffer: ['caseSetHash'] });
  assert.equal(r.kind, 'evaluated');
  if (r.kind !== 'evaluated') return;
  const k = r.gate.classes.find((c) => c.klass === 'k');
  assert.deepEqual([k?.passed, k?.total, k?.rate, k?.meetsBar], [18, 20, 0.9, true]);
  assert.deepEqual(r.newCases, [{ klass: 'k', count: 10, caseIds: ten('n') }, { klass: 'empty', count: 0, caseIds: [] }]);
  // One entry for each class of the bar, in the order of the class rows, and the count is the NEW rows of the diff.
  assert.deepEqual(r.newCases.map((x) => x.klass), r.gate.classes.map((c) => c.klass));
  assert.equal(r.diff.filter((d) => d.status === 'NEW').length, 10);
  // The baseline's own failures are still failing: nothing broke, and nothing was fixed.
  assert.deepEqual(r.diff.filter((d) => d.status === 'BROKE' || d.status === 'FIXED'), []);

  // A new case that is not finished is not in the class's total, so it is not counted among its new cases.
  const unfinished = gateRuns(baseline, newCaseRun([...ten('k'), ...ten('n')], ['k09', 'k10'], ['n10']), newCaseBar, { allowDiffer: ['caseSetHash'] });
  assert.equal(unfinished.kind, 'evaluated');
  if (unfinished.kind !== 'evaluated') return;
  const u = unfinished.gate.classes.find((c) => c.klass === 'k');
  assert.deepEqual([u?.passed, u?.total, u?.missingCaseIds], [17, 19, ['n10']]);
  assert.deepEqual(unfinished.newCases[0], { klass: 'k', count: 9, caseIds: ten('n').slice(0, 9) });
  assert.equal(gateExitCode(unfinished), 1);

  // A result without the counts is not the result of gateRuns.
  const { newCases: _dropped, ...rest } = r;
  assert.throws(() => gateExitCode(rest as unknown as GateRunResult), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT');
});

// --- Re-judged baseline (gate --rejudge-of) -------------------------------------------------------
// A: the baseline as first graded by the old judge. B: the same outputs re-graded by the current
// judge. C: the candidate graded by the current judge. The new judge is stricter on c1.
const judged = (over = {}) => makeJudgedIdentity({ caseSetHash: caseSetHash(cases), barHash: barHash(barFile), drawsPerCase: 2, ...over });
const newJudge = { judgeDefinitionHash: hashOf('judge prompt v2'), judgeModelServed: 'judge-2026-06-01' };
const graded = (c1: string, c2: string, hashes: Record<string, string> = {}): Draw[] =>
  (['c1#0', 'c1#1', 'c2#0', 'c2#1'] as const).map((key) => {
    const [caseId, i] = key.split('#') as [string, string];
    return slot(caseId, Number(i), gradedAttempt(caseId === 'c1' ? c1 : c2, { judgeStop: 'tool-use', outputHash: hashes[key] ?? sha256Hex(`system output ${key}`) }));
  });
const run = (draws: Draw[], identity: RunIdentity): RunArtifact => ({ schema: RUN_SCHEMA, identity, callShapes: callShapesFor(identity), cases, draws, ...packetBasisFor(identity) });
/** The same draws, graded by code: judgeStop NO_JUDGE, for a code-graded identity. */
const byCode = (draws: Draw[]): Draw[] => draws.map((d) => ({ ...d, attempts: d.attempts.map((a) => (a.kind === 'graded' ? { ...a, judgeStop: NO_JUDGE, packetHash: NO_JUDGE } : a)) }));
const A = run(graded('hi', 'hi'), judged());
const B = run(graded('lo', 'hi'), judged(newJudge));
const C = run(graded('lo', 'hi', { 'c1#0': sha256Hex('new c1 a'), 'c1#1': sha256Hex('new c1 b'), 'c2#0': sha256Hex('new c2 a'), 'c2#1': sha256Hex('new c2 b') }), judged({ ...newJudge, systemModelServed: 'model-x-2026-06-01' }));
const boot = { iterations: 200, seed: 3, alpha: 0.05 };
const refusedWith = (r: ReturnType<typeof gateRuns>, code: string, fields: string): void => {
  assert.equal(r.kind, 'refused');
  if (r.kind !== 'refused') return;
  assert.equal(r.refusal.code, code, r.refusal.message);
  assert.equal(r.refusal.fields.join(), fields);
};

test('rejudge: a case that only broke because the judge got stricter is not reported BROKE', () => {
  const naive = diffRuns(
    (gateRuns(A, A, barFile) as Extract<ReturnType<typeof gateRuns>, { kind: 'evaluated' }>).folded.baseline,
    (gateRuns(C, C, barFile) as Extract<ReturnType<typeof gateRuns>, { kind: 'evaluated' }>).folded.baseline,
    [],
  );
  assert.equal(naive.find((d) => d.caseId === 'c1')?.status, 'BROKE');
  const r = gateRuns(B, C, barFile, { rejudgeOf: A, allowDiffer: ['systemModelServed'], bootstrap: boot });
  assert.equal(r.kind, 'evaluated');
  if (r.kind !== 'evaluated') return;
  assert.equal(r.diff.find((d) => d.caseId === 'c1')?.status, 'STILL_FAILING');
  assert.equal(gateExitCode(r), 0);
  const jc = r.judgeControl;
  assert.ok(jc !== undefined && !('refused' in jc));
  if (jc === undefined || 'refused' in jc) return;
  // A hand-worked fixture, not a published reference value. The judge effect is defined by this library and its
  // definition is pinned in test/drift.test.ts (the judge and system split, from line 195): score(baseline, new judge)
  // − score(baseline, old judge). Here c1 is graded 'hi' by the old judge and 'lo' by the new one, c2 'hi' by both, so
  // the pass rate over the 2 items goes from 2/2 to 1/2: 0.5 − 1.0 = −0.5; the outputs are the same, so the system effect is 0.
  assert.equal(jc.overall.itemCount, 2);
  assert.equal(jc.overall.judgeEffect.estimate, -0.5);
  assert.equal(jc.overall.systemEffect.estimate, 0);
  assert.equal(jc.overall.reportedDelta.estimate, -0.5);
  assert.equal(jc.overall.judgeEffect.seed, 3);
  assert.deepEqual(Object.keys(jc.perClass), ['k']);
  assert.equal(jc.perClass['k']?.judgeEffect.estimate, -0.5);
});

test('rejudge: both baseline runs must have a judge', () => {
  refusedWith(gateRuns(B, C, barFile, { rejudgeOf: run(byCode(graded('hi', 'hi')), makeIdentity({ caseSetHash: caseSetHash(cases), barHash: barHash(barFile), drawsPerCase: 2 })), allowDiffer: ['systemModelServed'] }), 'IDENTITY_MISMATCH', 'judgeDefinitionHash');
});

test('rejudge: the re-judged baseline must be the same system run; only judge fields may differ', () => {
  refusedWith(gateRuns(run(B.draws, judged({ ...newJudge, systemModelServed: 'model-x-other' })), C, barFile, { rejudgeOf: A, allowDiffer: ['systemModelServed'] }), 'IDENTITY_MISMATCH', 'systemModelServed');
});

test('rejudge: the re-judged baseline must have graded the same outputs, draw by draw', () => {
  refusedWith(gateRuns(run(B.draws.slice(0, 3), B.identity), C, barFile, { rejudgeOf: A, allowDiffer: ['systemModelServed'] }), 'ITEM_SET_MISMATCH', 'c2#1');
  // An unknown output hash is no longer a valid run at all, so it cannot reach the comparison.
  assert.throws(
    () => gateRuns(run(graded('lo', 'hi', { 'c1#0': GAP }), B.identity), C, barFile, { rejudgeOf: A, allowDiffer: ['systemModelServed'] }),
    (e: unknown) => e instanceof InputError && e.problems.some((p) => p.includes('outputHash')),
  );
  refusedWith(gateRuns(run(graded('lo', 'hi', { 'c2#1': sha256Hex('something else') }), B.identity), C, barFile, { rejudgeOf: A, allowDiffer: ['systemModelServed'] }), 'HASH_MISMATCH', 'outputHash[c2#1]');
});

test('rejudge: the candidate must use the same judge as the re-judged baseline; judge fields cannot be allowed to differ', () => {
  refusedWith(gateRuns(B, run(C.draws, judged({ ...newJudge, systemModelServed: 'model-x-2026-06-01', judgeModelServed: 'judge-2026-09-01' })), barFile, { rejudgeOf: A, allowDiffer: ['systemModelServed'] }), 'IDENTITY_MISMATCH', 'judgeModelServed');
  assert.throws(
    () => gateRuns(B, C, barFile, { rejudgeOf: A, allowDiffer: ['systemModelServed', 'judgeModelServed'] }),
    (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && e.problems.some((p) => p.includes('judgeModelServed')),
  );
});

test('rejudge: the original baseline is held to the same case-set and bar hashes', () => {
  refusedWith(gateRuns(B, C, barFile, { rejudgeOf: run(A.draws, judged({ barHash: hashOf('other bar') })), allowDiffer: ['systemModelServed'] }), 'HASH_MISMATCH', 'barHash');
});

test('rejudge: an original baseline that is invalid input stops the gate (InputError naming it), and one that fails an admission check refuses it; only a refusal of the split itself leaves the verdict standing', () => {
  // A label outside the bar's labels in the original baseline: invalid input, thrown out of gateRuns (exit 65), with no verdict.
  const outside = run(graded('zz', 'hi'), judged());
  assert.throws(
    () => gateRuns(B, C, barFile, { rejudgeOf: outside, allowDiffer: ['systemModelServed'], bootstrap: boot }),
    (e: unknown) => e instanceof InputError && e.code === 'UNKNOWN_LABEL' && e.problems.some((p) => p.startsWith('original baseline (--rejudge-of): ') && p.includes('"zz"')),
  );
  // The same original with a known label gates, so it is that label that stops the run.
  assert.equal(gateRuns(B, C, barFile, { rejudgeOf: A, allowDiffer: ['systemModelServed'], bootstrap: boot }).kind, 'evaluated');
  // An admission check on it (its bar hash) refuses the whole gate; the original's packets differing from the re-judged baseline's refuse the split alone.
  assert.equal(gateRuns(B, C, barFile, { rejudgeOf: run(A.draws, judged({ barHash: hashOf('other bar') })), allowDiffer: ['systemModelServed'] }).kind, 'refused');
  const otherPacket = gateRuns(B, C, barFile, { rejudgeOf: run(A.draws.map((d) => ({ ...d, attempts: d.attempts.map((a) => (a.kind === 'graded' ? { ...a, packetHash: hashOf('another packet') } : a)) })), judged()), allowDiffer: ['systemModelServed'], bootstrap: boot });
  assert.equal(otherPacket.kind, 'evaluated');
  assert.ok(otherPacket.kind === 'evaluated' && otherPacket.judgeControl !== undefined && 'refused' in otherPacket.judgeControl);
});

test('rejudge: a candidate with missing cases fails the gate and the decomposition is refused, not guessed', () => {
  const r = gateRuns(B, run(C.draws.slice(0, 2), C.identity), barFile, { rejudgeOf: A, allowDiffer: ['systemModelServed'], bootstrap: boot });
  assert.equal(r.kind, 'evaluated');
  if (r.kind !== 'evaluated') return;
  assert.equal(gateExitCode(r), 1);
  assert.ok(r.judgeControl !== undefined && 'refused' in r.judgeControl && r.judgeControl.refused.code === 'ITEM_SET_MISMATCH');
});

test('a plain gate refused on a judge field points at --rejudge-of', () => {
  const r = gateRuns(A, C, barFile, { allowDiffer: ['systemModelServed'] });
  assert.equal(r.kind, 'refused');
  assert.ok(r.kind === 'refused' && r.refusal.message.includes('--rejudge-of'), r.kind === 'refused' ? r.refusal.message : '');
  const other = gateRuns(A, run(A.draws, judged({ seed: 9 })), barFile);
  assert.ok(other.kind === 'refused' && !other.refusal.message.includes('--rejudge-of'));
});

// --- Further cases ---------------------------------------------------------------------------------
test('outputHashOf: UTF-8 text for a string output, canonical JSON otherwise', () => {
  assert.equal(outputHashOf('Refund approved.'), sha256Hex('Refund approved.'));
  assert.equal(outputHashOf({ b: 1, a: 'x' }), hashOf({ a: 'x', b: 1 }));
  assert.equal(outputHashOf({ systemError: 'timeout' }), hashOf({ systemError: 'timeout' }));
});

test('rejudge: a system-error draw carried over with its hash does not block the split', () => {
  const errHash = outputHashOf({ systemError: 'timeout' });
  const withError = (c1: string, identity: RunIdentity): RunArtifact => {
    const draws = graded(c1, 'hi');
    draws[2] = slot('c2', 0, failedAttempt('system-error', { detail: 'the application threw', outputHash: errHash }));
    return run(draws, identity);
  };
  const r = gateRuns(withError('lo', judged(newJudge)), C, barFile, { rejudgeOf: withError('hi', judged()), allowDiffer: ['systemModelServed'], bootstrap: boot });
  assert.equal(r.kind, 'evaluated');
  assert.ok(r.kind === 'evaluated' && r.judgeControl !== undefined && !('refused' in r.judgeControl));
});

test('the rejudge hint appears only for a real judge mismatch between two judged runs', () => {
  // System mismatched, judge model merely unknown: no hint.
  const gapOnly = gateRuns(run(A.draws, judged({ judgeModelServed: GAP })), run(A.draws, judged({ systemModelServed: 'model-x-other' })), barFile);
  assert.ok(gapOnly.kind === 'refused' && !gapOnly.refusal.message.includes('--rejudge-of'), gapOnly.kind === 'refused' ? gapOnly.refusal.message : '');
  // A code-graded baseline against a judged candidate: re-judging cannot help.
  const codeGraded = run(byCode(A.draws), makeIdentity({ caseSetHash: caseSetHash(cases), barHash: barHash(barFile), drawsPerCase: 2 }));
  const r = gateRuns(codeGraded, A, barFile);
  assert.ok(r.kind === 'refused' && !r.refusal.message.includes('--rejudge-of'));
});

test('rejudge: no complete case anywhere is refused as an incomplete baseline instead of throwing', () => {
  const empty = (identity: RunIdentity): RunArtifact => run(graded('hi', 'hi').filter((d) => d.drawIndex === 0), identity);
  const r = gateRuns(empty(judged(newJudge)), empty(judged({ ...newJudge, systemModelServed: 'model-x-2026-06-01' })), barFile, { rejudgeOf: empty(judged()), allowDiffer: ['systemModelServed'], bootstrap: boot });
  refusedWith(r, 'INCOMPLETE_RUN', 'c1,c2');
  assert.equal(gateExitCode(r), 2);
});

test('rejudge: classes with no complete case are listed, not silently dropped', () => {
  const twoClassBar = parseBarFile({ labels: ['lo', 'hi'], classes: { k: { direction: 'floor', minPassRate: 0.5 }, z: { direction: 'floor', minPassRate: 0 } }, knownFailures: [] });
  const r = gateRuns(B, C, twoClassBar, { rejudgeOf: A, allowDiffer: ['systemModelServed'], bootstrap: boot });
  // The runs declare the one-class bar's hash, so this refuses; rebuild the runs with the two-class bar.
  assert.equal(r.kind, 'refused');
  const re = (a: RunArtifact): RunArtifact => ({ ...a, identity: { ...a.identity, barHash: barHash(twoClassBar) } });
  const ok = gateRuns(re(B), re(C), twoClassBar, { rejudgeOf: re(A), allowDiffer: ['systemModelServed'], bootstrap: boot });
  assert.ok(ok.kind === 'evaluated' && ok.judgeControl !== undefined && !('refused' in ok.judgeControl));
  if (ok.kind !== 'evaluated' || ok.judgeControl === undefined || 'refused' in ok.judgeControl) return;
  assert.deepEqual(Object.keys(ok.judgeControl.perClass), ['k']);
  assert.deepEqual(ok.judgeControl.emptyClasses, ['z']);
});

test('gateRuns: a self-inconsistent run is invalid input naming the run, even when it skipped the parser', () => {
  const edited: RunArtifact = { ...A, cases: [...cases, { id: 'c3', klass: 'k', input: 'c', expect: 'hi' }] };
  assert.throws(
    () => gateRuns(B, C, barFile, { rejudgeOf: edited, allowDiffer: ['systemModelServed'] }),
    (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARTIFACT' && e.problems.some((p) => p.startsWith('original baseline (--rejudge-of): artifact.identity.caseSetHash')),
  );
  const noShapes = { ...A } as Record<string, unknown>;
  delete noShapes['callShapes'];
  assert.throws(() => gateRuns(noShapes as RunArtifact, A, barFile), (e: unknown) => e instanceof InputError && e.problems.some((p) => p.startsWith('baseline: artifact.callShapes')));
});

test('gateRuns rejects bootstrap options without rejudgeOf', () => {
  assert.throws(() => gateRuns(A, A, barFile, { bootstrap: boot }), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT');
});

// --- Incomplete runs ------------------------------------------------------------------------------
test('gateRuns: an incomplete baseline is refused, so a real break cannot hide as NEW', () => {
  // c2 lost a baseline draw; the candidate really breaks c2, and the class still meets its 0.5 bar.
  const r = gateRuns(artifact(full('hi', 'hi').slice(0, 3)), artifact(full('hi', 'lo')), barFile);
  refusedWith(r, 'INCOMPLETE_RUN', 'c2');
  assert.equal(gateExitCode(r), 2);
});

test('rejudge: an incomplete re-judged baseline is refused before the gate or the split', () => {
  const dropC2 = (a: RunArtifact): RunArtifact => run(a.draws.filter((d) => !(d.caseId === 'c2' && d.drawIndex === 1)), a.identity);
  const r = gateRuns(dropC2(B), C, barFile, { rejudgeOf: dropC2(A), allowDiffer: ['systemModelServed'], bootstrap: boot });
  refusedWith(r, 'INCOMPLETE_RUN', 'c2');
  assert.ok(r.kind === 'refused' && r.refusal.message.includes('re-judged baseline'), r.kind === 'refused' ? r.refusal.message : '');
});

test('gateRuns: a candidate case with missing draws is INCOMPLETE in the diff, never REMOVED', () => {
  const r = gateRuns(artifact(full('hi', 'hi')), artifact(full('hi', 'hi').slice(0, 3)), barFile);
  assert.equal(r.kind, 'evaluated');
  if (r.kind !== 'evaluated') return;
  assert.equal(r.diff.find((d) => d.caseId === 'c2')?.status, 'INCOMPLETE');
  assert.equal(gateExitCode(r), 1);
});

test('gateRuns: an incomplete candidate case outside the baseline case set still fails the gate', () => {
  const more: Case[] = [...cases, { id: 'c3', klass: 'k', input: 'c', expect: 'hi' }];
  const draws: Draw[] = [...full('hi', 'hi'), slot('c3', 0, gradedAttempt('hi'))];
  const candId = makeIdentity({ caseSetHash: caseSetHash(more), barHash: barHash(barFile), drawsPerCase: 2 });
  const cand: RunArtifact = { schema: RUN_SCHEMA, identity: candId, callShapes: callShapesFor(candId), cases: more, draws, ...packetBasisFor(candId) };
  const r = gateRuns(artifact(full('hi', 'hi')), cand, barFile, { allowDiffer: ['caseSetHash'] });
  assert.equal(r.kind, 'evaluated');
  if (r.kind !== 'evaluated') return;
  assert.deepEqual(r.gate.missingCaseIds, ['c3']);
  assert.deepEqual(r.baselineGate.missingCaseIds, []);
  assert.equal(r.diff.find((d) => d.caseId === 'c3')?.status, 'INCOMPLETE');
  assert.equal(gateExitCode(r), 1);
});

test('gateRuns: a shared case id whose class, input or expected label changed is refused, even with caseSetHash allowed', () => {
  const twoClass = parseBarFile({ labels: ['lo', 'hi'], classes: { k: { direction: 'floor', minPassRate: 0.5 }, strict: { direction: 'floor', minPassRate: 1, nonCompensable: true } }, knownFailures: [] });
  const art = (cs: Case[], draws: Draw[]): RunArtifact => {
    const identity = makeIdentity({ caseSetHash: caseSetHash(cs), barHash: barHash(twoClass), drawsPerCase: 2 });
    return { schema: RUN_SCHEMA, identity, callShapes: callShapesFor(identity), cases: cs, draws, ...packetBasisFor(identity) };
  };
  const base = art([cases[0] as Case, { id: 'c2', klass: 'strict', input: 'b', expect: 'hi' }], full('hi', 'hi'));
  // c2 breaks; moving it out of the non-compensable class, or lowering its expected label, would hide that.
  for (const c2 of [
    { id: 'c2', klass: 'k', input: 'b', expect: 'hi' },
    { id: 'c2', klass: 'strict', input: 'b', expect: 'lo' },
    { id: 'c2', klass: 'strict', input: 'easier', expect: 'hi' },
  ]) {
    refusedWith(gateRuns(base, art([cases[0] as Case, c2], full('hi', 'lo')), twoClass, { allowDiffer: ['caseSetHash'] }), 'ITEM_SET_MISMATCH', 'c2');
  }
  // Adding a case under a new id is still allowed.
  const added = art([cases[0] as Case, { id: 'c2', klass: 'strict', input: 'b', expect: 'hi' }, { id: 'c3', klass: 'k', input: 'c', expect: 'hi' }], [...full('hi', 'hi'), slot('c3', 0, gradedAttempt('hi')), slot('c3', 1, gradedAttempt('hi'))]);
  assert.equal(gateRuns(base, added, twoClass, { allowDiffer: ['caseSetHash'] }).kind, 'evaluated');
});

test('rejudge: a rewritten rubric is judge movement, so the re-judged baseline may differ on it; a plain gate still refuses', () => {
  const newRubric = { ...newJudge, rubricHash: hashOf('rubric v2') };
  const B2 = run(B.draws, judged(newRubric));
  const C2 = run(C.draws, judged({ ...newRubric, systemModelServed: 'model-x-2026-06-01' }));
  assert.equal(gateRuns(B2, C2, barFile, { rejudgeOf: A, allowDiffer: ['systemModelServed'], bootstrap: boot }).kind, 'evaluated');
  const plain = gateRuns(A, C2, barFile, { allowDiffer: ['systemModelServed'] });
  assert.ok(plain.kind === 'refused' && plain.refusal.fields.includes('rubricHash'));
});

test('gateRuns: one unmeasured baseline slot refuses the gate, even beside a measured failure', () => {
  const base = artifact([...full('hi', 'lo').slice(0, 3), slot('c2', 1, unmeasured('system', 'timeout'))]);
  refusedWith(gateRuns(base, artifact(full('hi', 'hi')), barFile), 'INCOMPLETE_RUN', 'c2');
});

test('gateRuns: a candidate slot that timed out leaves its case INCOMPLETE, withholds the class rate and keeps the measured failure', () => {
  const cand = artifact([...full('hi', 'lo').slice(0, 3), slot('c2', 1, unmeasured('system', 'rate-limited'))]);
  const r = gateRuns(artifact(full('hi', 'hi')), cand, barFile);
  assert.equal(r.kind, 'evaluated');
  if (r.kind !== 'evaluated') return;
  assert.equal(r.diff.find((d) => d.caseId === 'c2')?.status, 'INCOMPLETE');
  assert.equal(r.gate.classes[0]?.rate, GAP);
  assert.equal(r.incomplete.candidate[0]?.measuredFailure, true);
  assert.equal(gateExitCode(r), 1);
});

// --- Judge 4xx (every attempt) and the re-judge original ------------------------------------------
/** Replaces one slot of a judged run with the given attempts, keeping the system's output hash. */
const withSlot = (r: RunArtifact, key: string, attempts: (hash: string) => Attempt[]): RunArtifact =>
  run(r.draws.map((d) => {
    if (`${d.caseId}#${d.drawIndex}` !== key) return d;
    const last = d.attempts[d.attempts.length - 1] as Extract<Attempt, { outputHash: string }>;
    return { ...d, attempts: attempts(last.outputHash) };
  }), r.identity);
const judgeFail = (reason: string, hash: string): Attempt => ({ kind: 'unmeasured', role: 'judge', reason, detail: reason, outputHash: hash, systemStop: 'tool-use', packetHash: PACKET }) as Attempt;
const regrade = (label: string, hash: string): Attempt => gradedAttempt(label, { judgeStop: 'tool-use', outputHash: hash });

test('gateRuns: a judge 4xx on any attempt refuses the run, even when a retry then graded', () => {
  const c1 = withSlot(C, 'c2#1', (h) => [judgeFail('client-error', h), regrade('hi', h)]);
  refusedWith(gateRuns(B, c1, barFile, { rejudgeOf: A, allowDiffer: ['systemModelServed'] }), 'MEASUREMENT_NOT_RUNNABLE', 'c2#1');
  const c2 = withSlot(C, 'c2#1', (h) => [judgeFail('client-error', h), judgeFail('timeout', h)]);
  refusedWith(gateRuns(B, c2, barFile, { rejudgeOf: A, allowDiffer: ['systemModelServed'] }), 'MEASUREMENT_NOT_RUNNABLE', 'c2#1');
  const b1 = withSlot(B, 'c1#0', (h) => [judgeFail('client-error', h), regrade('lo', h)]);
  refusedWith(gateRuns(b1, C, barFile, { rejudgeOf: A, allowDiffer: ['systemModelServed'] }), 'MEASUREMENT_NOT_RUNNABLE', 'c1#0');
});

test('rejudge: a 4xx from the old judge in the original refuses only the split; the gate stands on the re-judged baseline', () => {
  const a = withSlot(A, 'c2#1', (h) => [judgeFail('client-error', h), regrade('hi', h)]);
  const r = gateRuns(B, C, barFile, { rejudgeOf: a, allowDiffer: ['systemModelServed'], bootstrap: boot });
  assert.equal(r.kind, 'evaluated');
  assert.ok(r.kind === 'evaluated' && r.judgeControl !== undefined && 'refused' in r.judgeControl && r.judgeControl.refused.code === 'MEASUREMENT_NOT_RUNNABLE');
  assert.equal(gateExitCode(r), 0);
});

test('rejudge: an original whose judge could not grade one slot refuses only the split, naming the case', () => {
  const a = withSlot(A, 'c2#1', (h) => [judgeFail('timeout', h)]);
  const r = gateRuns(B, C, barFile, { rejudgeOf: a, allowDiffer: ['systemModelServed'], bootstrap: boot });
  assert.equal(r.kind, 'evaluated');
  assert.ok(r.kind === 'evaluated' && r.judgeControl !== undefined && 'refused' in r.judgeControl && r.judgeControl.refused.fields.includes('c2'));
});

test('rejudge: a slot the system never answered, on both sides, is an incomplete baseline, not a hash gap', () => {
  const noAnswer = (x: RunArtifact) => run(x.draws.map((d) => (d.caseId === 'c2' && d.drawIndex === 1 ? slot('c2', 1, unmeasured('system', 'timeout')) : d)), x.identity);
  refusedWith(gateRuns(noAnswer(B), C, barFile, { rejudgeOf: noAnswer(A), allowDiffer: ['systemModelServed'] }), 'INCOMPLETE_RUN', 'c2');
});

test('rejudge: a system 4xx carried over with its record does not block the split', () => {
  const err = (x: RunArtifact) => run(x.draws.map((d) => (d.caseId === 'c2' && d.drawIndex === 0 ? slot('c2', 0, failedAttempt('client-error', { detail: 'rejected' })) : d)), x.identity);
  const r = gateRuns(err(B), C, barFile, { rejudgeOf: err(A), allowDiffer: ['systemModelServed'], bootstrap: boot });
  assert.ok(r.kind === 'evaluated' && r.judgeControl !== undefined && !('refused' in r.judgeControl));
});

test('rejudge: the same output recorded with a different stop is refused', () => {
  const b = withSlot(B, 'c1#0', (h) => [gradedAttempt('lo', { judgeStop: 'tool-use', outputHash: h, systemStop: 'end' })]);
  refusedWith(gateRuns(b, C, barFile, { rejudgeOf: A, allowDiffer: ['systemModelServed'] }), 'HASH_MISMATCH', 'systemOutcome[c1#0]');
});

test('gateRuns: a refused call shape names the keys that moved or are unknown', () => {
  const shaped = (shape: CallShape): RunArtifact => {
    const identity = makeIdentity({ caseSetHash: caseSetHash(cases), barHash: barHash(barFile), drawsPerCase: 2, systemCallShapeHash: callShapeHash(shape) });
    return { schema: RUN_SCHEMA, identity, callShapes: { system: shape, judge: NO_JUDGE }, cases, draws: full('hi', 'hi'), packetBasis: NO_JUDGE };
  };
  const moved = gateRuns(shaped(makeCallShape()), shaped(makeCallShape({ temperature: 0.3, maxOutputTokens: 256 })), barFile);
  assert.ok(moved.kind === 'refused' && moved.refusal.message.includes('temperature 0 -> 0.3') && moved.refusal.message.includes('maxOutputTokens 512 -> 256'), moved.kind === 'refused' ? moved.refusal.message : '');
  const unknown = gateRuns(shaped(makeCallShape({ effort: GAP })), shaped(makeCallShape({ effort: GAP })), barFile);
  assert.ok(unknown.kind === 'refused' && unknown.refusal.code === 'IDENTITY_GAP' && unknown.refusal.message.includes('effort unknown'), unknown.kind === 'refused' ? unknown.refusal.message : '');
});

test('gateRuns: an error inside a run names the run', () => {
  assert.throws(
    () => gateRuns(artifact(full('hi', 'hi')), artifact(full('maybe', 'hi')), barFile),
    (e: unknown) => e instanceof InputError && e.code === 'UNKNOWN_LABEL' && e.problems.every((p) => p.startsWith('candidate: ')),
  );
});

test('rejudge: no response on both sides is an incomplete baseline even when the transport reasons differ', () => {
  const noAnswer = (x: RunArtifact, reason: string) => run(x.draws.map((d) => (d.caseId === 'c2' && d.drawIndex === 1 ? slot('c2', 1, unmeasured('system', reason)) : d)), x.identity);
  refusedWith(gateRuns(noAnswer(B, 'rate-limited'), C, barFile, { rejudgeOf: noAnswer(A, 'timeout'), allowDiffer: ['systemModelServed'] }), 'INCOMPLETE_RUN', 'c2');
});

test('gateRuns: an unknown system stop in any run is refused before folding, naming the draws', () => {
  const stopUnknown = (r: RunArtifact, key: string): RunArtifact => withSlot(r, key, (h) => [gradedAttempt('hi', { judgeStop: 'tool-use', outputHash: h, systemStop: GAP })]);
  for (const [b, c, opts] of [
    [stopUnknown(B, 'c1#0'), C, {}],
    [B, stopUnknown(C, 'c2#1'), {}],
    [B, C, { rejudgeOf: stopUnknown(A, 'c1#1') }],
  ] as const) {
    const r = gateRuns(b, c, barFile, { allowDiffer: ['systemModelServed'], ...opts });
    assert.ok(r.kind === 'refused' && r.refusal.code === 'IDENTITY_GAP' && r.refusal.fields.some((f) => f.startsWith('systemStop[')), r.kind === 'refused' ? r.refusal.message : 'evaluated');
    assert.equal(gateExitCode(r), 2);
  }
});

test('gateRuns: an imported run with an unknown system stop is refused with the hint to use judge-change; a run that is not imported gets no hint', () => {
  const stopUnknown = (r: RunArtifact): RunArtifact => withSlot(r, 'c1#0', (h) => [gradedAttempt('hi', { judgeStop: 'tool-use', outputHash: h, systemStop: GAP })]);
  const imported = (r: RunArtifact): RunArtifact => ({ ...r, packetBasis: 'declared', packetSource: 'computed at import from promptfoo 0.0.0 result file sha256:abc: the output slot' });
  const hint = 'imported run: use judge-change (docs/IMPORTERS.md)';
  const refusal = (b: RunArtifact, c: RunArtifact): RefusalError => {
    const r = gateRuns(b, c, barFile, { allowDiffer: ['systemModelServed'] });
    assert.ok(r.kind === 'refused', 'a refusal');
    return r.refusal;
  };
  // Baseline and candidate each carry the hint when it is the imported one that holds the gap; the refusal still names the slot.
  for (const [b, c] of [[imported(stopUnknown(B)), C], [B, imported(stopUnknown(C))]] as const) {
    const e = refusal(b, c);
    assert.equal(e.code, 'IDENTITY_GAP');
    assert.ok(e.fields.includes('systemStop[c1#0]'), e.fields.join(', '));
    assert.ok(e.message.includes(hint), e.message);
  }
  // A declared source that is not an importer's gets no hint, and neither does a run with no source.
  const other = refusal({ ...stopUnknown(B), packetBasis: 'declared', packetSource: 'the vendor documentation, section 4' }, C);
  assert.equal(other.code, 'IDENTITY_GAP');
  assert.ok(!other.message.includes('judge-change'), other.message);
  const plain = refusal(stopUnknown(B), C);
  assert.ok(!plain.message.includes('judge-change'), plain.message);
});

test('the same-outputs check lives beside the artifact and is the one the re-judge gate uses', () => {
  assert.doesNotThrow(() => assertSameOutputs(A, B));
  assert.throws(() => assertSameOutputs(A, withSlot(B, 'c1#0', () => [gradedAttempt('lo', { judgeStop: 'tool-use', outputHash: hashOf('another output') })])), (e: unknown) => e instanceof RefusalError && e.code === 'HASH_MISMATCH');
});

// --- The split and the packets the two judges saw -------------------------------------------------
type Evaluated = Extract<ReturnType<typeof gateRuns>, { kind: 'evaluated' }>;
const rejudgeOpts = { allowDiffer: ['systemModelServed'] as const, bootstrap: boot };
/** One draw's packet hash replaced on every attempt that carries one. */
const withPacket = (r: RunArtifact, key: string, packetHash: string): RunArtifact =>
  ({ ...r, draws: r.draws.map((d) => (`${d.caseId}#${d.drawIndex}` !== key ? d : { ...d, attempts: d.attempts.map((a) => ('packetHash' in a ? { ...a, packetHash } : a)) as Attempt[] })) });
const split = (r: ReturnType<typeof gateRuns>): NonNullable<Evaluated['judgeControl']> => {
  assert.equal(r.kind, 'evaluated');
  const jc = (r as Evaluated).judgeControl;
  assert.ok(jc !== undefined);
  return jc;
};
const passes = (r: Evaluated): unknown => ({ baseline: r.folded.baseline.map((f) => [f.caseId, f.pass]), candidate: r.folded.candidate });
/** The split is refused with PACKET_MISMATCH and these fields, and nothing else about the gate moved. */
const splitRefused = (original: RunArtifact, rejudged: RunArtifact, fields: string[]): RefusalError => {
  const r = gateRuns(rejudged, C, barFile, { ...rejudgeOpts, rejudgeOf: original });
  const jc = split(r);
  assert.ok('refused' in jc, 'the split was computed');
  if (!('refused' in jc)) throw new Error('unreachable');
  assert.equal(jc.refused.code, 'PACKET_MISMATCH', jc.refused.message);
  assert.deepEqual([...jc.refused.fields], fields);
  // The gate stands on the re-judged baseline: verdict, diff and exit code are those of the gate whose split was computed.
  const computed = gateRuns(B, C, barFile, { ...rejudgeOpts, rejudgeOf: A }) as Evaluated;
  const got = r as Evaluated;
  assert.deepEqual(got.gate, computed.gate);
  assert.deepEqual(got.baselineGate, computed.baselineGate);
  assert.deepEqual(got.diff, computed.diff);
  assert.deepEqual(got.incomplete, computed.incomplete);
  assert.deepEqual(got.allowedDifferences, computed.allowedDifferences);
  assert.deepEqual(passes(got), passes(computed));
  assert.equal(gateExitCode(r), gateExitCode(computed));
  assert.equal(gateExitCode(r), 0);
  return jc.refused;
};
const OTHER_PACKET = sha256Hex('another view of the same output');

test('rejudge split: a draw whose two judges were shown different packets refuses the split only, naming the draw', () => {
  const e = splitRefused(A, withPacket(B, 'c1#1', OTHER_PACKET), ['packetHash[c1#1]']);
  assert.match(e.message, /packetHash\[c1#1\]/);
  assert.match(e.message, /re-judge the baseline's stored outputs/);
});

test('rejudge split: an unknown packet on the original baseline refuses the split only', () => {
  splitRefused(withPacket(A, 'c2#0', GAP), B, ['packetHash[c2#0]']);
});

test('rejudge split: an unknown packet on the re-judged baseline refuses the split only', () => {
  splitRefused(A, withPacket(B, 'c2#0', GAP), ['packetHash[c2#0]']);
  // Unknown on both sides is not equality.
  splitRefused(withPacket(A, 'c1#0', GAP), withPacket(B, 'c1#0', GAP), ['packetHash[c1#0]']);
});

test('rejudge split: only recorded packets are admitted; a declared or unknown basis on either baseline refuses the split', () => {
  const declared = (r: RunArtifact): RunArtifact => ({ ...r, packetBasis: 'declared', packetSource: 'the judge harness documentation' });
  const unknown = (r: RunArtifact): RunArtifact => ({ ...r.draws.reduce((x, d) => withPacket(x, `${d.caseId}#${d.drawIndex}`, GAP), r), packetBasis: GAP });
  const O = 'packetBasis (original baseline (--rejudge-of))';
  const R = 'packetBasis (re-judged baseline)';
  splitRefused(declared(A), B, [O]);
  splitRefused(A, declared(B), [R]);
  // Equal declared hashes show that two declarations agree, not what either judge was shown.
  const e = splitRefused(declared(A), declared(B), [O, R]);
  assert.match(e.message, /declared/);
  splitRefused(unknown(A), B, [O]);
  splitRefused(A, unknown(B), [R]);
});

test('rejudge split: the packet of a slot the old judge could not grade is compared too', () => {
  const a = withSlot(A, 'c2#1', (h) => [{ ...judgeFail('timeout', h), packetHash: OTHER_PACKET } as Attempt]);
  splitRefused(a, B, ['packetHash[c2#1]']);
});

test('rejudge split: with equal recorded packets, one per draw, the split is computed and its numbers do not move', () => {
  const perDraw = (r: RunArtifact): RunArtifact => r.draws.reduce((x, d) => withPacket(x, `${d.caseId}#${d.drawIndex}`, sha256Hex(`packet ${d.caseId}#${d.drawIndex}`)), r);
  const before = split(gateRuns(B, C, barFile, { ...rejudgeOpts, rejudgeOf: A }));
  const after = split(gateRuns(perDraw(B), C, barFile, { ...rejudgeOpts, rejudgeOf: perDraw(A) }));
  assert.ok(!('refused' in before) && !('refused' in after));
  if ('refused' in before || 'refused' in after) return;
  assert.deepEqual(after, before);
  assert.deepEqual([after.overall.itemCount, after.overall.reportedDelta.estimate, after.overall.judgeEffect.estimate, after.overall.systemEffect.estimate], [2, -0.5, -0.5, 0]);
});

test('rejudge split: the candidate packets are not compared; it graded other outputs, so its packets differ by construction', () => {
  const c = C.draws.reduce((x, d) => withPacket(x, `${d.caseId}#${d.drawIndex}`, sha256Hex(`candidate packet ${d.caseId}#${d.drawIndex}`)), C);
  assert.ok(!('refused' in split(gateRuns(B, c, barFile, { ...rejudgeOpts, rejudgeOf: A }))));
});

test('the same-packets check lives beside the same-outputs check', () => {
  assert.doesNotThrow(() => assertSamePackets(A, B));
  assert.throws(() => assertSamePackets(A, withPacket(B, 'c1#0', OTHER_PACKET)), (e: unknown) => e instanceof RefusalError && e.code === 'PACKET_MISMATCH' && e.fields.join() === 'packetHash[c1#0]');
  // A draw the system failed on reached no rater on either side and carries no packet.
  const err = (x: RunArtifact) => run(x.draws.map((d) => (d.caseId === 'c2' && d.drawIndex === 0 ? slot('c2', 0, failedAttempt('client-error', { detail: 'rejected' })) : d)), x.identity);
  assert.doesNotThrow(() => assertSamePackets(err(A), err(B)));
  // A packet on one side only: one judge was shown something and the other was not.
  assert.throws(() => assertSamePackets(err(A), B), (e: unknown) => e instanceof RefusalError && e.code === 'PACKET_MISMATCH' && e.fields.join() === 'packetHash[c2#0]');
});

const near = (got: number, want: number): void => assert.ok(Math.abs(got - want) < 1e-12, `${got} vs ${want}`);

// --- A non-compensable class under --rejudge-of: counts, case ids and n; never a rate ----------
// A hand-worked fixture, labelled as one. Bar: class k is compensable (c1, c2), class s is non-compensable (s1, s2,
// s3); every case expects "hi" on a floor, one draw per case.
//                       c1  c2 | s1  s2  s3
//   A  baseline, old    hi  hi | hi  hi  lo     s fails on {s3}
//   B  baseline, new    lo  hi | lo  hi  hi     s fails on {s1}   A -> B: s1 newly fails, s3 newly passes
//   C  candidate, new   lo  hi | hi  lo  hi     s fails on {s2}   B -> C: s2 newly fails, s1 newly passes
// In class s one case fails in each run, so every pass share is 2/3 and every difference of shares is 0: a rate row
// would print "no movement" over three cases of which every one changed. The list shows each.
// Overall, over the 5 cases: A passes 4, B passes 3, C passes 3, so reported = judge = 3/5 − 4/5 = −0.2, system = 0.
const mixedCases: Case[] = [
  { id: 'c1', klass: 'k', input: 'a', expect: 'hi' },
  { id: 'c2', klass: 'k', input: 'b', expect: 'hi' },
  { id: 's1', klass: 's', input: 'c', expect: 'hi' },
  { id: 's2', klass: 's', input: 'd', expect: 'hi' },
  { id: 's3', klass: 's', input: 'e', expect: 'hi' },
];
const mixedBar = parseBarFile({ labels: ['lo', 'hi'], classes: { k: { direction: 'floor', minPassRate: 0 }, s: { direction: 'floor', nonCompensable: true, minPassRate: 0 } }, knownFailures: [] });
const mixedRun = (labels: string, outputs: string, over: Partial<RunIdentity> = {}): RunArtifact => {
  const identity = makeJudgedIdentity({ caseSetHash: caseSetHash(mixedCases), barHash: barHash(mixedBar), drawsPerCase: 1, ...over });
  const draws = mixedCases.map((c, i) => slot(c.id, 0, gradedAttempt(labels.split(' ')[i] as string, { judgeStop: 'tool-use', outputHash: sha256Hex(`${outputs} ${c.id}`) })));
  return { schema: RUN_SCHEMA, identity, callShapes: callShapesFor(identity), cases: mixedCases, draws, ...packetBasisFor(identity) };
};
const mixedA = mixedRun('hi hi hi hi lo', 'baseline');
const mixedB = mixedRun('lo hi lo hi hi', 'baseline', newJudge);
const mixedC = mixedRun('lo hi hi lo hi', 'candidate', { ...newJudge, systemModelServed: 'model-x-2026-06-01' });

test('rejudge: a non-compensable class gets n, the failing case ids of each run and the ids that changed in each transition; no share, no difference of shares, no bracket (hand-worked fixture)', () => {
  const r = gateRuns(mixedB, mixedC, mixedBar, { rejudgeOf: mixedA, allowDiffer: ['systemModelServed'], bootstrap: boot });
  const jc = split(r);
  assert.ok(!('refused' in jc), JSON.stringify(jc));
  if ('refused' in jc) return;
  // The compensable class keeps its split; the non-compensable class is not in it.
  assert.deepEqual(Object.keys(jc.perClass), ['k']);
  assert.equal(jc.perClass['k']?.itemCount, 2);
  assert.equal(jc.perClass['k']?.judgeEffect.estimate, -0.5);
  assert.deepEqual(jc.nonCompensable, [
    {
      klass: 's',
      n: 3,
      failing: { originalBaseline: ['s3'], rejudgedBaseline: ['s1'], candidate: ['s2'] },
      transitions: [
        { from: 'originalBaseline', to: 'rejudgedBaseline', newlyFailing: ['s1'], newlyPassing: ['s3'] },
        { from: 'rejudgedBaseline', to: 'candidate', newlyFailing: ['s2'], newlyPassing: ['s1'] },
      ],
    },
  ]);
  // Nothing in the class's entry is a number other than n: no rate and no interval can hide there.
  const numbersIn = (x: unknown): number[] => (typeof x === 'number' ? [x] : typeof x === 'object' && x !== null ? Object.values(x).flatMap(numbersIn) : []);
  assert.deepEqual(numbersIn(jc.nonCompensable), [3]);
  assert.doesNotMatch(JSON.stringify(jc.nonCompensable), /estimate|"lo"|"hi"|alpha|iterations|rate|share|delta|effect/i);
  // The overall row stays, over all five cases, and equals the reported delta.
  assert.equal(jc.overall.itemCount, 5);
  near(jc.overall.reportedDelta.estimate, -0.2);
  near(jc.overall.judgeEffect.estimate, -0.2);
  near(jc.overall.systemEffect.estimate, 0);
  assert.deepEqual(jc.emptyClasses, []);
  // The gate itself is untouched by the listing: the candidate fails s2 in a non-compensable class.
  assert.equal(gateExitCode(r), 1);
});

test('rejudge: with no non-compensable class the list is empty and every class keeps its split; a non-compensable class with no case is listed as empty, not as a row', () => {
  const plain = split(gateRuns(B, C, barFile, { rejudgeOf: A, allowDiffer: ['systemModelServed'], bootstrap: boot }));
  assert.ok(!('refused' in plain));
  if ('refused' in plain) return;
  assert.deepEqual(plain.nonCompensable, []);
  assert.deepEqual(Object.keys(plain.perClass), ['k']);
  const strictBar = parseBarFile({ labels: ['lo', 'hi'], classes: { k: { direction: 'floor', minPassRate: 0.5 }, z: { direction: 'floor', nonCompensable: true, minPassRate: 1 } }, knownFailures: [] });
  const re = (a: RunArtifact): RunArtifact => ({ ...a, identity: { ...a.identity, barHash: barHash(strictBar) } });
  const jc = split(gateRuns(re(B), re(C), strictBar, { rejudgeOf: re(A), allowDiffer: ['systemModelServed'], bootstrap: boot }));
  assert.ok(!('refused' in jc));
  if ('refused' in jc) return;
  assert.deepEqual([jc.nonCompensable, jc.emptyClasses, Object.keys(jc.perClass)], [[], ['z'], ['k']]);
});

// --- The no-seed sentinel on a gate ----------------------------------------------------------------
test('gateRuns: two runs that both declare NO_SEED gate; NO_SEED beside a uint32 is refused naming seed, with and without seed in allowDiffer; beside a gap it is IDENTITY_GAP', () => {
  const none = artifact(full('hi', 'hi'), { seed: NO_SEED });
  const ok = gateRuns(none, artifact(full('hi', 'hi'), { seed: NO_SEED }), barFile);
  assert.equal(ok.kind, 'evaluated', ok.kind === 'refused' ? ok.refusal.message : '');
  assert.equal(gateExitCode(ok), 0);
  assert.equal(ok.kind === 'evaluated' && ok.allowedDifferences.length, 0);
  const seeded = artifact(full('hi', 'hi'));
  assert.equal(typeof seeded.identity.seed, 'number');
  for (const [b, c] of [[none, seeded], [seeded, none]] as const) {
    refusedWith(gateRuns(b, c, barFile), 'IDENTITY_MISMATCH', 'seed');
    refusedWith(gateRuns(b, c, barFile, { allowDiffer: ['seed'] }), 'IDENTITY_MISMATCH', 'seed');
    assert.equal(gateExitCode(gateRuns(b, c, barFile, { allowDiffer: ['seed'] })), 2);
  }
  refusedWith(gateRuns(none, artifact(full('hi', 'hi'), { seed: GAP }), barFile, { allowDiffer: ['seed'] }), 'IDENTITY_GAP', 'seed');
  // A re-judged baseline and its original are compared by the same check.
  const a = run(A.draws, { ...A.identity, seed: NO_SEED });
  refusedWith(gateRuns(B, C, barFile, { rejudgeOf: a, allowDiffer: ['systemModelServed'] }), 'IDENTITY_MISMATCH', 'seed');
  const all = (r: RunArtifact): RunArtifact => run(r.draws, { ...r.identity, seed: NO_SEED });
  assert.equal(gateRuns(all(B), all(C), barFile, { rejudgeOf: all(A), allowDiffer: ['systemModelServed'], bootstrap: boot }).kind, 'evaluated');
});

// --- The bar file: versioned by the run schema, nothing added inside its hashed object -------------
/** hashOf of examples/refund-bot/bar.json as committed, which examples/refund-bot/baseline.json declares as its barHash. */
const REFUND_BAR_HASH = '83dbab4d7d27fa9a6e7fa3deae9b897dfdec8dbb39eee775a36605caca9ff7a4';
test('the bar file is the object { labels, classes, knownFailures } and nothing else: a schema key is refused, so no version string enters the hash, and the committed bars keep their hashes', () => {
  const plain = { labels: ['lo', 'hi'], classes: { k: { direction: 'floor', minPassRate: 0.5 } }, knownFailures: [] };
  assert.deepEqual(Object.keys(parseBarFile(plain)).sort(), ['classes', 'knownFailures', 'labels']);
  for (const key of ['schema', 'version', 'barSchema']) {
    assert.throws(
      () => parseBarFile({ ...plain, [key]: 'anchorset.bar/v1' }),
      (e: unknown) => e instanceof InputError && e.code === 'INVALID_BAR' && e.problems.join() === `bar.${key}: unknown field`,
      key,
    );
  }
  // The hash is over the parsed object, whose keys are those three: the value below was computed once and is kept
  // here, so a field added inside the hashed object, or a change of the canonical form, moves it.
  assert.equal(barHash(parseBarFile(plain)), hashOf(plain));
  // The committed bar files hash to what the committed runs gated against them declare.
  const committed = (name: string): unknown => JSON.parse(readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8'));
  for (const [bar, runFile] of [['refund-bot/bar.json', 'refund-bot/baseline.json'], ['refund-bot/bar.json', 'refund-bot/candidate.json'], ['run-format/bar.json', 'run-format/run.json'], ['judge-change/bar.json', 'judge-change/runs/bot-v1.old-judge.json']] as const) {
    const declared = (committed(runFile) as RunArtifact).identity.barHash;
    assert.equal(barHash(parseBarFile(committed(bar))), declared, `${bar} against ${runFile}`);
  }
  // Pinned as written, so that the test fails if every example were rewritten together.
  assert.equal(barHash(parseBarFile(committed('refund-bot/bar.json'))), REFUND_BAR_HASH);
});
