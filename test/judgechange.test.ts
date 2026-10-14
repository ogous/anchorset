import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { caseSetHash, RUN_SCHEMA } from '../src/artifact.ts';
import type { RunArtifact } from '../src/artifact.ts';
import { InputError, RefusalError } from '../src/errors.ts';
import type { RefusalCode } from '../src/errors.ts';
import { barHash } from '../src/gate.ts';
import type { BarFile } from '../src/gate.ts';
import { canonicalJson, GAP, hashOf, IDENTITY_FIELDS, INEXACT_INTEGER, JUDGE_FIELDS, sha256Hex } from '../src/identity.ts';
import type { RunIdentity } from '../src/identity.ts';
import { JUDGE_CHANGE_FILE_ROLES, JUDGE_CHANGE_PLAN_SCHEMA, judgeChangePlanProblems, judgeChangeRuns, parseJudgeChangePlan, PLAN_BOUND_FIELDS, REFERENCE_SCHEMA, referenceProblems, RESAMPLE_SCHEMA, resampleProblems, SYSTEM_SIDE_FIELDS, TIE_BREAK_SCHEMA, tieBreakProblems } from '../src/judgechange.ts';
import type { GateReport, JudgeChangeInput, JudgeChangePlan, JudgeChangeReport, JudgeSide, MapReport, ReferenceFile, SpreadReport } from '../src/judgechange.ts';
import { appendRecord, LEDGER_SCHEMA, makeGateRecord, makeJudgeChangeRecord, readLedger, validateRecord } from '../src/ledger.ts';
import type { JudgeChangeBinding, JudgeChangeLedgerRecord } from '../src/ledger.ts';
import { foldOfCase, tieBreakU } from '../src/cutmap.ts';
import { mulberry32 } from '../src/rng.ts';
import { nominalLevelCheck, nonInferiority, resampleIndices, spreadOf } from '../src/stats.ts';
import { gateRuns } from '../src/regression.ts';
import type { Attempt, Case, Draw } from '../src/scoring.ts';
import { extraKeys } from '../src/scoring.ts';
import { callShapesFor, failedAttempt, gateInputs, makeIdentity, makeJudgeCallShape, makeJudgedIdentity, unmeasured } from './helpers.ts';
import { callShapeHash } from '../src/callshape.ts';

// A scale of 1 to 5; an answer passes at 4 or above. "quality" is the measured class, "must" is
// non-compensable, and "other" is a second compensable class that one plan does not measure.
const barFile: BarFile = {
  labels: ['1', '2', '3', '4', '5'],
  classes: { quality: { direction: 'floor', minPassRate: 0.5 }, must: { direction: 'floor', nonCompensable: true, minPassRate: 1 }, other: { direction: 'floor', minPassRate: 0.5 } },
  knownFailures: [],
};
const cases: Case[] = [
  ...['c1', 'c2', 'c3', 'c4'].map((id) => ({ id, klass: 'quality', input: { question: id }, expect: '4' })),
  { id: 'm1', klass: 'must', input: { question: 'm1' }, expect: '4' },
  { id: 'o1', klass: 'other', input: { question: 'o1' }, expect: '4' },
];

/**
 * Six grades of one stored output per (system, case): draws 0-2 are the estimate set, 3-5 the re-ask set.
 *
 * Worked by hand, majority rule, on the 8 quality items:
 *   passing draws in the estimate set   old 3+2+0+3 + 3+0+2+1 = 14    new 3+0+2+2 + 0+0+3+1 = 11    of 8 × 3 = 24
 *   per-draw pass rate                  old 14/24                     new 11/24                     change −3/24 = −0.125
 *   majority label on the estimate set  old P P F P · P F P F = 5/8   new P F P P · F F P F = 4/8   change −1/8
 *   labels differing between judges     A/c2, A/c3, B/c1 = 3/8 = 0.375
 *   differing between a judge's sets    old: A/c2, B/c4 = 2/8         new: A/c4 = 1/8               mean 0.1875
 *   flips beyond re-asking              0.375 − 0.1875 = 0.1875
 */
const grades: Record<string, Record<string, { old: string; new: string }>> = {
  A: {
    c1: { old: '444444', new: '444444' },
    c2: { old: '434334', new: '333333' },
    c3: { old: '333333', new: '443444' },
    c4: { old: '555555', new: '542225' },
    m1: { old: '444444', new: '444424' },
    o1: { old: '444444', new: '444444' },
  },
  B: {
    c1: { old: '444444', new: '222222' },
    c2: { old: '111111', new: '111111' },
    c3: { old: '442444', new: '444444' },
    c4: { old: '343443', new: '334333' },
    m1: { old: '555555', new: '555555' },
    o1: { old: '444444', new: '444444' },
  },
};

const oldJudge: Partial<RunIdentity> = {};
const newJudge: Partial<RunIdentity> = { judgeModelRequested: 'judge-next', judgeModelServed: 'judge-2026-06-01' };
const identity = (over: Partial<RunIdentity> = {}): RunIdentity => makeJudgedIdentity({ caseSetHash: caseSetHash(cases), barHash: barHash(barFile), drawsPerCase: 6, ...over });
const sideOf = (id: RunIdentity): JudgeSide => ({
  judgeDefinitionHash: id.judgeDefinitionHash,
  judgeModelRequested: id.judgeModelRequested,
  judgeModelServed: id.judgeModelServed,
  judgeCallShapeHash: id.judgeCallShapeHash,
  judgeHarnessVersion: id.judgeHarnessVersion,
  rubricHash: id.rubricHash,
});

type Edit = (draws: Draw[]) => Draw[];
const graded = (system: string, caseId: string, label: string, over: Record<string, unknown> = {}): Attempt =>
  ({ kind: 'graded', label, outputHash: sha256Hex(`${system}:${caseId}`), systemStop: 'end', judgeStop: 'tool-use', packetHash: sha256Hex(`packet ${system}:${caseId}`), ...over }) as Attempt;

function makeRun(system: string, side: 'old' | 'new', over: Partial<RunIdentity> = {}, edit: Edit = (d) => d, extra: Partial<RunArtifact> = {}): RunArtifact {
  const id = identity({ ...(side === 'old' ? oldJudge : newJudge), systemModelServed: `system-${system}`, ...over });
  const draws = cases.flatMap((c) => [...(grades[system]?.[c.id]?.[side] ?? '')].map((label, drawIndex): Draw => ({ caseId: c.id, drawIndex, attempts: [graded(system, c.id, label)] })));
  return { schema: RUN_SCHEMA, identity: id, callShapes: callShapesFor(id), cases, draws: edit(draws), packetBasis: 'recorded', ...extra };
}

/** Every run file gets a fixed name and the bytes of its JSON text; the core hashes them itself. */
const file = (name: string, run: unknown): JudgeChangeInput => ({ name, bytes: new TextEncoder().encode(JSON.stringify(run)) });
const shaOf = (f: JudgeChangeInput): string => sha256Hex(f.bytes);
type Runs = Record<'Aold' | 'Anew' | 'Bold' | 'Bnew', RunArtifact>;
const baseRuns = (): Runs => ({ Aold: makeRun('A', 'old'), Anew: makeRun('A', 'new'), Bold: makeRun('B', 'old'), Bnew: makeRun('B', 'new') });

function setup(runsOver: Partial<Runs> = {}, planOver: Partial<JudgeChangePlan> = {}): { files: JudgeChangeInput[]; plan: JudgeChangePlan } {
  const runs = { ...baseRuns(), ...runsOver };
  const files = (Object.keys(runs) as (keyof Runs)[]).map((k) => file(`${k}.json`, runs[k]));
  const sha = (k: keyof Runs): string => shaOf(files.find((f) => f.name === `${k}.json`) as JudgeChangeInput);
  const plan: JudgeChangePlan = {
    schema: JUDGE_CHANGE_PLAN_SCHEMA,
    barHash: barHash(barFile),
    caseSetHash: caseSetHash(cases),
    drawsPerCase: 6,
    judges: { old: sideOf(identity(oldJudge)), new: sideOf(identity(newJudge)) },
    judgeMoves: ['judgeModelRequested', 'judgeModelServed'],
    systems: { A: { old: sha('Aold'), new: sha('Anew') }, B: { old: sha('Bold'), new: sha('Bnew') } },
    storedOutputs: 'system-side-compared',
    measuredClass: 'quality',
    cut: '4',
    drawSets: { estimate: [0, 1, 2], reask: [3, 4, 5] },
    labelRule: 'majority',
    pooling: 'items-equal',
    ...planOver,
  };
  return { files, plan };
}

const measure = (runsOver: Partial<Runs> = {}, planOver: Partial<JudgeChangePlan> = {}, bar: BarFile = barFile) => {
  const { files, plan } = setup(runsOver, planOver);
  return judgeChangeRuns(files, bar, plan);
};
const refused = (code: RefusalCode, field: string | RegExp, f: () => unknown): void => {
  assert.throws(f, (e: unknown) => {
    assert.ok(e instanceof RefusalError, String(e));
    assert.equal(e.code, code, e.message);
    assert.ok(e.fields.some((x) => (typeof field === 'string' ? x.includes(field) : field.test(x))), `${e.fields.join(', ')} · ${e.message}`);
    return true;
  });
};
const onSlot = (caseId: string, drawIndex: number, attempts: (a: Attempt) => Attempt[]): Edit => (draws) =>
  draws.map((d) => (d.caseId === caseId && d.drawIndex === drawIndex ? { ...d, attempts: attempts(d.attempts[0] as Attempt) } : d));
const onCase = (caseId: string, over: Record<string, unknown>): Edit => (draws) =>
  draws.map((d) => (d.caseId === caseId ? { ...d, attempts: d.attempts.map((a) => ({ ...a, ...over }) as Attempt) } : d));
const near = (got: number | string, want: number): void => assert.ok(typeof got === 'number' && Math.abs(got - want) < 1e-12, `${got} != ${want}`);

test('judge change: the hand-worked fixture, majority rule', () => {
  const r = measure();
  assert.equal(r.kind, 'measurement');
  assert.ok(!('pass' in r) && !('exitCode' in r));
  assert.deepEqual(r.counts, { systems: 2, cases: 4, fitOnlyCases: 0, items: 8, drawsPerSet: 3 });
  near(r.perDrawPassRate.old, 14 / 24);
  near(r.perDrawPassRate.new, 11 / 24);
  near(r.perDrawPassRate.change, -0.125);
  assert.deepEqual(r.labelPassRate, { rule: 'majority', old: 5 / 8, new: 4 / 8, change: -1 / 8 });
  near(r.flips.acrossJudges, 0.375);
  near(r.flips.withinJudge, 0.1875);
  near(r.flips.beyondReask, 0.1875);
  assert.deepEqual(r.flips.items, [
    { system: 'A', caseId: 'c2', old: true, new: false },
    { system: 'A', caseId: 'c3', old: false, new: true },
    { system: 'B', caseId: 'c1', old: true, new: false },
  ]);
  // Per system: A has 8 and 7 passing draws of 12, B has 6 and 4.
  assert.deepEqual(r.perSystem.map((s) => [s.system, s.items, s.perDrawPassRate.old, s.perDrawPassRate.new, s.flipsAcrossJudges]), [['A', 4, 8 / 12, 7 / 12, 0.5], ['B', 4, 6 / 12, 4 / 12, 0.25]]);
});

test('judge change: the same fixture under the worst rule; every number names its rule', () => {
  // Worst label on the estimate set: old P F F P · P F F F = 3/8; new P F F F · F F P F = 2/8.
  // Differing between judges: A/c4, B/c1, B/c3 = 3/8. Between a judge's sets: old B/c3 = 1/8; new A/c3 = 1/8.
  const r = measure({}, { labelRule: 'worst' });
  assert.deepEqual(r.labelPassRate, { rule: 'worst', old: 3 / 8, new: 2 / 8, change: -1 / 8 });
  assert.equal(r.flips.rule, 'worst');
  near(r.flips.acrossJudges, 0.375);
  near(r.flips.withinJudge, 0.125);
  near(r.flips.beyondReask, 0.25);
  assert.deepEqual(r.flips.items.map((x) => `${x.system}/${x.caseId}`), ['A/c4', 'B/c1', 'B/c3']);
  // The per-draw rate has no label rule in it, so it does not move.
  near(r.perDrawPassRate.change, -0.125);
});

test('judge change: without a re-ask set the within-judge flips are not declared, never guessed', () => {
  // One set of all six draws needs the worst rule, or an odd count: majority on six draws is an invalid plan.
  const r = measure({}, { drawSets: { estimate: [0, 1, 2, 3, 4, 5] }, labelRule: 'worst' });
  assert.equal(r.flips.withinJudge, 'not declared');
  assert.equal(r.flips.beyondReask, 'not declared');
  assert.equal(r.drawSets.reask, 'not declared');
  // Passing draws over all six: old 6+3+0+6 + 6+0+5+3 = 29, new 6+0+5+3 + 0+0+6+1 = 21, of 8 × 6 = 48.
  near(r.perDrawPassRate.old, 29 / 48);
  near(r.perDrawPassRate.new, 21 / 48);
});

test('judge change: a non-compensable class is listed case by case over every draw, with no rate', () => {
  const r = measure();
  assert.deepEqual(r.nonCompensableClasses, ['must']);
  assert.deepEqual(r.nonCompensable, [{ klass: 'must', system: 'A', caseId: 'm1', oldFailingDraws: [], newFailingDraws: [4], worstOfNDiffers: true }]);
  assert.deepEqual(r.notMeasuredClasses, ['other']);
  refused('UNSUPPORTED_DESIGN', 'measuredClass', () => measure({}, { measuredClass: 'must' }));
});

test('judge change: the report carries its provenance, and names what moved', () => {
  const { files, plan } = setup();
  const r = judgeChangeRuns(files, barFile, plan);
  assert.equal(r.planHash, hashOf(plan));
  assert.equal(r.barHash, barHash(barFile));
  assert.deepEqual(r.contracts, { run: 'anchorset.run/v3', plan: 'anchorset.judge-change-plan/v1' });
  assert.deepEqual(r.inputs.map((f) => [f.system, f.role, f.name]), [['A', 'old-judge', 'Aold.json'], ['A', 'new-judge', 'Anew.json'], ['B', 'old-judge', 'Bold.json'], ['B', 'new-judge', 'Bnew.json']]);
  assert.ok(r.inputs.every((f) => f.sha256 === shaOf(files.find((x) => x.name === f.name) as JudgeChangeInput) && f.packetBasis === 'recorded' && !('packetSource' in f)));
  assert.deepEqual(r.judges.moved, [
    { field: 'judgeModelRequested', old: 'judge-alias', new: 'judge-next' },
    { field: 'judgeModelServed', old: 'judge-2026-01-01', new: 'judge-2026-06-01' },
  ]);
  assert.deepEqual(r.notCompared, { fields: [], unknownStopDraws: 0, draws: 72 });
  assert.deepEqual(r.blocks, { gate: 'not declared', resampling: 'not declared', map: 'not declared', reference: 'not declared' });
  assert.ok(r.notes.some((n) => n.includes('nothing here shows the plan preceded the scores')));
  // The order of the input files does not matter: the roster binds them by hash.
  assert.deepEqual(judgeChangeRuns([...files].reverse(), barFile, plan), r);
});

test('judge change: a judge call-shape move names the keys that moved', () => {
  const shape = makeJudgeCallShape({ temperature: 0.5 });
  const moved = (system: string): RunArtifact => {
    const run = makeRun(system, 'new', { judgeCallShapeHash: callShapeHash(shape) });
    return { ...run, callShapes: { system: run.callShapes.system, judge: shape } };
  };
  const runs = { Anew: moved('A'), Bnew: moved('B') };
  const { files, plan } = setup(runs);
  const r = judgeChangeRuns(files, barFile, { ...plan, judges: { old: plan.judges.old, new: sideOf(runs.Anew.identity) }, judgeMoves: ['judgeModelRequested', 'judgeModelServed', 'judgeCallShapeHash'] });
  assert.ok(r.judges.callShapeMoved.some((k) => k.includes('temperature')), r.judges.callShapeMoved.join(', '));
});

test('judge change: supplied draws are bound by hash like every other input', () => {
  const { files, plan } = setup({}, { resampling: { suppliedSha256: hashOf('index matrices'), spreadFloor: 2 }, oneCasePerCluster: true });
  refused('HASH_MISMATCH', 'the supplied resample indices', () => judgeChangeRuns(files, barFile, plan));
  assert.equal(measure().blocks.resampling, 'not declared');
  assert.ok(measure().notes.includes('points only: no spread is computed'));
});

test('the gate cannot be handed a label rule: on these same runs it still folds worst-of-N', async () => {
  // A/c4 under the new judge passes by majority on draws 0-2 (5, 4, 2) and fails worst-of-6, so the gate calls it BROKE.
  // The gate takes no judge field in allowDiffer, so the candidate is a scratch copy of the new judge's draws that declares the
  // old judge's identity: one judge on both sides. What this test pins is the gate's fold, not the judge.
  const base = makeRun('A', 'old');
  const g = gateRuns(base, makeRun('A', 'new', { judgeModelRequested: base.identity.judgeModelRequested, judgeModelServed: base.identity.judgeModelServed }), barFile);
  assert.ok(g.kind === 'evaluated', g.kind === 'refused' ? g.refusal.message : '');
  assert.equal(g.diff.find((d) => d.caseId === 'c4')?.status, 'BROKE');
  assert.equal(measure().flips.items.some((x) => x.system === 'A' && x.caseId === 'c4'), false);
  // No export of the gate's modules takes or names a label rule, and the measurement exports no fold.
  for (const m of [await import('../src/regression.ts'), await import('../src/gate.ts'), await import('../src/scoring.ts')]) {
    assert.ok(!Object.keys(m).some((k) => /rule|majority/i.test(k)), Object.keys(m).join(', '));
  }
  assert.ok(!Object.keys(await import('../src/judgechange.ts')).some((k) => /fold/i.test(k)));
});

// ---- the stored-outputs exception ----

test('stored-outputs exception: without the opt-in, an unknown system-side field or system stop refuses', () => {
  const gap = { systemModelServed: GAP } as const;
  refused('IDENTITY_GAP', 'systemModelServed', () => measure({ Aold: makeRun('A', 'old', gap), Anew: makeRun('A', 'new', gap) }));
  refused('IDENTITY_MISMATCH', 'systemPromptHash', () => measure({ Anew: makeRun('A', 'new', { systemPromptHash: hashOf('another prompt') }) }));
  const stop = onCase('c1', { systemStop: GAP });
  refused('IDENTITY_GAP', 'systemStop[A/c1#0]', () => measure({ Aold: makeRun('A', 'old', {}, stop), Anew: makeRun('A', 'new', {}, stop) }));
});

test('stored-outputs exception: with the opt-in, the system side and a stop unknown on both sides are listed as not compared', () => {
  const stop = onCase('c1', { systemStop: GAP });
  const unknown = { systemModelRequested: GAP, systemModelServed: GAP, systemCallShapeHash: GAP, systemPromptHash: GAP, systemToolsHash: GAP, systemHarnessVersion: GAP, seed: GAP } as const;
  const stored = (system: string, side: 'old' | 'new'): RunArtifact => {
    const run = makeRun(system, side, unknown, system === 'A' ? stop : (d) => d);
    // An unknown call-shape hash is declared over a call shape with an unknown value.
    return { ...run, callShapes: { system: { ...run.callShapes.system, effort: GAP }, judge: run.callShapes.judge } } as RunArtifact;
  };
  const runs = { Aold: stored('A', 'old'), Anew: stored('A', 'new'), Bold: stored('B', 'old'), Bnew: stored('B', 'new') };
  const r = measure(runs, { storedOutputs: 'system-side-not-compared' });
  assert.deepEqual(r.notCompared, { fields: ['systemModelRequested', 'systemModelServed', 'systemCallShapeHash', 'systemPromptHash', 'systemToolsHash', 'systemHarnessVersion', 'seed', 'systemStop'], unknownStopDraws: 6, draws: 72 });
  near(r.perDrawPassRate.change, -0.125);
  // A stop known on one side only is not "not compared": it refuses.
  refused('HASH_MISMATCH', 'systemOutcome[c1#0]', () => measure({ ...runs, Anew: { ...runs.Anew, draws: makeRun('A', 'new').draws } }, { storedOutputs: 'system-side-not-compared' }));
  // The opt-in never exempts a judge field, the rubric, the bar, the case set or the draw count.
  const optIn = { storedOutputs: 'system-side-not-compared' } as const;
  const withId = (over: Partial<RunIdentity>): Partial<Runs> => ({ ...runs, Aold: { ...runs.Aold, identity: { ...runs.Aold.identity, ...over } } });
  refused('IDENTITY_GAP', 'judgeModelServed', () => measure(withId({ judgeModelServed: GAP }), optIn));
  refused('IDENTITY_MISMATCH', 'judgeHarnessVersion', () => measure(withId({ judgeHarnessVersion: 'another harness' }), optIn));
  refused('IDENTITY_GAP', 'rubricHash', () => measure(withId({ rubricHash: GAP }), optIn));
  refused('IDENTITY_MISMATCH', 'barHash', () => measure(withId({ barHash: hashOf('another bar') }), optIn));
  refused('IDENTITY_GAP', 'drawsPerCase', () => measure(withId({ drawsPerCase: GAP }), optIn));
  const fewer = cases.filter((c) => c.id !== 'o1');
  const cut = { ...runs.Aold, cases: fewer, draws: runs.Aold.draws.filter((d) => d.caseId !== 'o1'), identity: { ...runs.Aold.identity, caseSetHash: caseSetHash(fewer) } };
  refused('IDENTITY_MISMATCH', 'caseSetHash', () => measure({ ...runs, Aold: cut }, optIn));
});

// ---- one test per refusal ----

test('refusal IDENTITY_MISMATCH: a run that is not the plan\'s judge, bar, case set or draw count', () => {
  refused('IDENTITY_MISMATCH', 'judgeModelServed (A, old judge)', () => measure({ Aold: makeRun('A', 'old', { judgeModelServed: 'judge-other' }) }));
  refused('IDENTITY_MISMATCH', 'rubricHash', () => measure({ Bnew: makeRun('B', 'new', { rubricHash: hashOf('another rubric') }) }));
  refused('IDENTITY_MISMATCH', 'barHash', () => measure({ Aold: makeRun('A', 'old', { barHash: hashOf('another bar') }) }));
  refused('IDENTITY_MISMATCH', 'drawsPerCase', () => measure({}, { drawsPerCase: 3, drawSets: { estimate: [0, 1, 2] } }));
  refused('IDENTITY_GAP', 'barHash (A, old judge)', () => measure({ Aold: makeRun('A', 'old', { barHash: GAP }) }));
});

test('refusal IDENTITY_MISMATCH: judgeMoves must name exactly the fields that moved', () => {
  refused('IDENTITY_MISMATCH', 'judgeModelServed', () => measure({}, { judgeMoves: ['judgeModelRequested'] }));
  refused('IDENTITY_MISMATCH', 'judgeHarnessVersion', () => measure({}, { judgeMoves: ['judgeModelRequested', 'judgeModelServed', 'judgeHarnessVersion'] }));
});

test('refusal HASH_MISMATCH: the roster binds every file, and the bar file is the plan\'s', () => {
  const { files, plan } = setup();
  refused('HASH_MISMATCH', 'stray.json', () => judgeChangeRuns([...files, file('stray.json', { any: 'thing' })], barFile, plan));
  refused('HASH_MISMATCH', 'B (new judge)', () => judgeChangeRuns(files.filter((f) => f.name !== 'Bnew.json'), barFile, plan));
  // An edited run no longer has the hash the plan declares.
  const edited = file('Aold.json', makeRun('A', 'old', {}, onSlot('c1', 0, () => [graded('A', 'c1', '1')])));
  refused('HASH_MISMATCH', 'Aold.json', () => judgeChangeRuns([...files.filter((f) => f.name !== 'Aold.json'), edited], barFile, plan));
  refused('HASH_MISMATCH', 'barHash', () => judgeChangeRuns(files, { ...barFile, classes: { ...barFile.classes, quality: { direction: 'floor', minPassRate: 0.9 } } }, plan));
});

test('refusal HASH_MISMATCH: the message prints each input file\'s computed sha256 and points at the importer\'s "run file sha256" line', () => {
  const { files, plan } = setup();
  // A file outside the roster: its computed sha256 is printed in full, so it can be pasted into the plan.
  const stray = file('stray.json', { any: 'thing' });
  assert.throws(
    () => judgeChangeRuns([...files, stray], barFile, plan),
    (e: unknown) => {
      assert.ok(e instanceof RefusalError && e.code === 'HASH_MISMATCH');
      assert.deepEqual(e.fields, ['stray.json']);
      assert.ok(e.message.includes(`stray.json (sha256 ${shaOf(stray)})`), e.message);
      assert.ok(e.message.includes('run file sha256'), e.message);
      return true;
    },
  );
  // A roster entry no file matches: the declared hash is named, and every supplied file's computed sha256 is listed beside it.
  const missing = files.filter((f) => f.name !== 'Bnew.json');
  assert.throws(
    () => judgeChangeRuns(missing, barFile, plan),
    (e: unknown) => {
      assert.ok(e instanceof RefusalError && e.code === 'HASH_MISMATCH');
      assert.deepEqual(e.fields, ['B (new judge)']);
      assert.ok(e.message.includes(plan.systems['B']?.new as string), e.message);
      for (const f of missing) assert.ok(e.message.includes(`${f.name} (sha256 ${shaOf(f)})`), `${f.name} · ${e.message}`);
      assert.ok(e.message.includes('run file sha256'), e.message);
      // The hint names the plan field that holds the missing entry, and no other.
      assert.ok(e.message.includes('systems.B.new'), e.message);
      assert.ok(!e.message.includes('systems.<name>'), e.message);
      return true;
    },
  );
  // A roster entry that is not a run file (a reference file, the tie-break draws, the resample indices) is pointed at in its own field.
  const drawn = setup({}, { resampling: { suppliedSha256: hashOf('index matrices'), spreadFloor: 2 }, oneCasePerCluster: true });
  assert.throws(
    () => judgeChangeRuns(drawn.files, barFile, drawn.plan),
    (e: unknown) => {
      assert.ok(e instanceof RefusalError && e.code === 'HASH_MISMATCH');
      assert.deepEqual(e.fields, ['the supplied resample indices']);
      assert.ok(e.message.includes('resampling.suppliedSha256'), e.message);
      assert.ok(!e.message.includes('systems.<name>.old'), e.message);
      assert.ok(!e.message.includes('run file sha256'), e.message);
      return true;
    },
  );
});

test('refusal HASH_MISMATCH: the two judges must have graded the same stored outputs', () => {
  refused('HASH_MISMATCH', 'outputHash[c2#1]', () => measure({ Anew: makeRun('A', 'new', {}, onSlot('c2', 1, (a) => [{ ...a, outputHash: sha256Hex('another output') } as Attempt])) }));
  refused('HASH_MISMATCH', 'systemOutcome[c2#1]', () => measure({ Anew: makeRun('A', 'new', {}, onSlot('c2', 1, (a) => [{ ...a, systemStop: 'refusal' } as Attempt])) }));
  refused('ITEM_SET_MISMATCH', 'c2#1', () => measure({ Anew: makeRun('A', 'new', {}, (d) => d.filter((x) => !(x.caseId === 'c2' && x.drawIndex === 1))) }));
});

test('refusal HASH_MISMATCH: a case with two stored outputs is system variation, not repeated grades', () => {
  const second = onSlot('c2', 1, (a) => [{ ...a, outputHash: sha256Hex('a second output'), packetHash: sha256Hex('a second packet') } as Attempt]);
  refused('HASH_MISMATCH', 'A/c2', () => measure({ Aold: makeRun('A', 'old', {}, second), Anew: makeRun('A', 'new', {}, second) }));
  // The same output with two stops is two system outcomes.
  const stop = onSlot('c2', 1, (a) => [{ ...a, systemStop: 'refusal' } as Attempt]);
  refused('HASH_MISMATCH', 'A/c2', () => measure({ Aold: makeRun('A', 'old', {}, stop), Anew: makeRun('A', 'new', {}, stop) }));
});

test('one stop wherever the stop is known: a case with known and unknown stops is one output, listed', () => {
  // A/c1 draws 3-5 lost their stop in both runs. Blanking the known stops to get in would destroy evidence.
  const some: Edit = (draws) => draws.map((d) => (d.caseId === 'c1' && d.drawIndex >= 3 ? { ...d, attempts: d.attempts.map((a) => ({ ...a, systemStop: GAP }) as Attempt) } : d));
  const runs = { Aold: makeRun('A', 'old', {}, some), Anew: makeRun('A', 'new', {}, some) };
  refused('IDENTITY_GAP', 'systemStop[A/c1#3]', () => measure(runs));
  const r = measure(runs, { storedOutputs: 'system-side-not-compared' });
  assert.equal(r.notCompared.unknownStopDraws, 3);
  near(r.perDrawPassRate.change, -0.125);
});

test('stored-outputs exception: with the opt-in, a known but different system side is admitted and listed', () => {
  const r = measure({ Anew: makeRun('A', 'new', { systemPromptHash: hashOf('another prompt'), seed: 7 }) }, { storedOutputs: 'system-side-not-compared' });
  assert.deepEqual(r.notCompared.fields, [...SYSTEM_SIDE_FIELDS]);
  near(r.perDrawPassRate.change, -0.125);
});

test('every identity field is either bound to the plan or on the system side; none can go uncompared by omission', () => {
  assert.deepEqual([...PLAN_BOUND_FIELDS, ...SYSTEM_SIDE_FIELDS].sort(), [...IDENTITY_FIELDS].sort());
  assert.equal(new Set([...PLAN_BOUND_FIELDS, ...SYSTEM_SIDE_FIELDS]).size, IDENTITY_FIELDS.length);
  assert.ok(SYSTEM_SIDE_FIELDS.every((f) => f.startsWith('system') || f === 'seed'));
});

test('refusal PACKET_MISMATCH: the draws of one case must have been shown one packet', () => {
  // The same change in both runs: the judges still match each other, but the re-ask set saw another view.
  const view: Edit = (draws) => draws.map((d) => (d.caseId === 'c2' && d.drawIndex >= 3 ? { ...d, attempts: d.attempts.map((a) => ({ ...a, packetHash: sha256Hex('a cut view') }) as Attempt) } : d));
  refused('PACKET_MISMATCH', 'A/c2', () => measure({ Aold: makeRun('A', 'old', {}, view), Anew: makeRun('A', 'new', {}, view) }));
});

test('judge change: one system, one draw per case, and an empty measured class', () => {
  const { files, plan } = setup();
  const one = { ...plan, systems: { A: plan.systems['A'] as { old: string; new: string } } };
  const r = judgeChangeRuns(files.filter((f) => f.name.startsWith('A')), barFile, one);
  assert.deepEqual(r.counts, { systems: 1, cases: 4, fitOnlyCases: 0, items: 4, drawsPerSet: 3 });
  near(r.perDrawPassRate.old, 8 / 12);
  near(r.flips.acrossJudges, 0.5);
  // One draw per case: the first grade of each item. old 4,4,3,5 = 3 of 4; new 4,3,4,5 = 3 of 4; c2 and c3 flip.
  const first = (system: string, side: 'old' | 'new'): RunArtifact => {
    const run = makeRun(system, side, { drawsPerCase: 1 });
    return { ...run, draws: run.draws.filter((d) => d.drawIndex === 0) };
  };
  const single = measure({ Aold: first('A', 'old'), Anew: first('A', 'new'), Bold: first('B', 'old'), Bnew: first('B', 'new') }, { drawsPerCase: 1, drawSets: { estimate: [0] } });
  assert.deepEqual(single.perSystem[0]?.perDrawPassRate, { old: 0.75, new: 0.75, change: 0 });
  assert.equal(single.perSystem[0]?.flipsAcrossJudges, 0.5);
  // A bar class with no case cannot be measured.
  const more: BarFile = { ...barFile, classes: { ...barFile.classes, empty: { direction: 'floor', minPassRate: 0.5 } } };
  const rebar = (r: RunArtifact): RunArtifact => ({ ...r, identity: { ...r.identity, barHash: barHash(more) } });
  const b = baseRuns();
  refused('UNSUPPORTED_DESIGN', 'measuredClass', () => measure({ Aold: rebar(b.Aold), Anew: rebar(b.Anew), Bold: rebar(b.Bold), Bnew: rebar(b.Bnew) }, { barHash: barHash(more), measuredClass: 'empty' }, more));
});

test('refusal HASH_MISMATCH: one system listed twice would be pooled twice', () => {
  const asA = (side: 'old' | 'new'): RunArtifact => ({ ...makeRun('A', side), identity: makeRun('B', side).identity });
  refused('HASH_MISMATCH', /^B$/, () => measure({ Bold: asA('old'), Bnew: asA('new') }));
});

test('refusal PACKET_MISMATCH: unknown or differing packets between the two judges', () => {
  refused('PACKET_MISMATCH', 'packetHash[A/c3#0]', () => measure({ Anew: makeRun('A', 'new', {}, onSlot('c3', 0, (a) => [{ ...a, packetHash: sha256Hex('a cut view') } as Attempt])) }));
  refused('PACKET_MISMATCH', 'packetHash[A/c3#0]', () => measure({ Anew: makeRun('A', 'new', {}, onSlot('c3', 0, (a) => [{ ...a, packetHash: GAP } as Attempt])) }));
  const gapAll: Edit = (draws) => draws.map((d) => ({ ...d, attempts: d.attempts.map((a) => ({ ...a, packetHash: GAP }) as Attempt) }));
  refused('PACKET_MISMATCH', 'packetBasis (A, new judge)', () => measure({ Anew: makeRun('A', 'new', {}, gapAll, { packetBasis: GAP }) }));
});

test('a declared packet is admitted, and every report says it was declared, not observed', () => {
  const declared = (system: string, side: 'old' | 'new'): RunArtifact => makeRun(system, side, {}, (d) => d, { packetBasis: 'declared', packetSource: 'the dataset paper, section 3' });
  const r = measure({ Aold: declared('A', 'old'), Bold: declared('B', 'old') });
  assert.deepEqual(r.inputs.map((f) => [f.name, f.packetBasis, f.packetSource]), [
    ['Aold.json', 'declared', 'the dataset paper, section 3'],
    ['Anew.json', 'recorded', undefined],
    ['Bold.json', 'declared', 'the dataset paper, section 3'],
    ['Bnew.json', 'recorded', undefined],
  ]);
});

test('refusal INCOMPLETE_RUN: a label needs every draw of its set, in both judges', () => {
  const timeout = onSlot('c3', 4, (a) => [unmeasuredJudge(a, 'timeout')]);
  refused('INCOMPLETE_RUN', 'A/c3#4 (new judge: judge timeout)', () => measure({ Anew: makeRun('A', 'new', {}, timeout) }));
  const both: Edit = (d) => d.filter((x) => !(x.caseId === 'm1' && x.drawIndex === 5));
  refused('INCOMPLETE_RUN', 'A/m1#5', () => measure({ Aold: makeRun('A', 'old', {}, both), Anew: makeRun('A', 'new', {}, both) }));
  // A system that gave no response on both sides is the same outcome, and still an incomplete slot.
  const silent = onSlot('c1', 0, () => [unmeasured('system', 'timeout')]);
  refused('INCOMPLETE_RUN', 'A/c1#0', () => measure({ Aold: makeRun('A', 'old', {}, silent), Anew: makeRun('A', 'new', {}, silent) }));
});

test('a judge retry that then graded is a measured slot', () => {
  const retried = onSlot('c3', 4, (a) => [unmeasuredJudge(a, 'timeout'), a]);
  // Draw 4 is in the re-ask set: were it dropped, A/c3 would not be read as 4, 4, 4 there.
  const r = measure({ Anew: makeRun('A', 'new', {}, retried) });
  near(r.flips.withinJudge, 0.1875);
  near(r.perDrawPassRate.change, -0.125);
});

/**
 * Judge retries per run, pinned to a hand-worked fixture: the counts are defined by this library, and no
 * published worked example is claimed. Each run counts twice: over the slots of the scored cases of the measured class
 * (c1-c4, 4 cases x 6 draws = 24 slots), which every number of the report is computed on, and over every slot record
 * of the run file (6 cases x 6 draws = 36: m1 of the non-compensable class and o1 of an unmeasured class included).
 *   Aold  no edit                                                   scored 0 of 24 · file 0 of 36 · no earlier judge attempt
 *   Anew  c3#4: judge timeout, judge parse-failure, then graded      scored and file: a slot with a retry, 2 earlier attempts
 *         c1#0: judge timeout, then graded                           scored and file: a slot with a retry, 1 earlier attempt
 *         m1#2: system timeout, then graded                          a system retry: not a judge retry, in neither count
 *         o1#5: judge truncated, then graded                         file only: o1 is of a class the plan does not measure
 *                                                                   scored 2 of 24 · parse-failure 1, timeout 1 + 1 = 2
 *                                                                   file   3 of 36 · parse-failure 1, timeout 2, truncated 1
 *   Bold  c2#1: judge rate-limited, then graded                      scored 1 of 24 · file 1 of 36 · rate-limited 1
 *   Bnew  c4#2: system timeout, judge server-error, then graded      the role filter: the system timeout is not counted
 *                                                                   scored 1 of 24 · file 1 of 36 · server-error 1 (no timeout)
 * The reasons are listed sorted, only those that occur. No retry changes a number of the measurement.
 */
const retryRuns = (): Partial<Runs> => {
  const anew: Edit = (d) => [
    onSlot('c3', 4, (a) => [unmeasuredJudge(a, 'timeout'), unmeasuredJudge(a, 'parse-failure'), a]),
    onSlot('c1', 0, (a) => [unmeasuredJudge(a, 'timeout'), a]),
    onSlot('m1', 2, (a) => [unmeasured('system', 'timeout'), a]),
    onSlot('o1', 5, (a) => [unmeasuredJudge(a, 'truncated'), a]),
  ].reduce((x, f) => f(x), d);
  return {
    Anew: makeRun('A', 'new', {}, anew),
    Bold: makeRun('B', 'old', {}, onSlot('c2', 1, (a) => [unmeasuredJudge(a, 'rate-limited'), a])),
    Bnew: makeRun('B', 'new', {}, onSlot('c4', 2, (a) => [unmeasured('system', 'timeout'), unmeasuredJudge(a, 'server-error'), a])),
  };
};
const none = (slots: number) => ({ slotsWithRetry: 0, slots, earlierAttemptsByReason: [] });
/** [scored, run file] for Aold, Anew, Bold, Bnew, as worked above. */
const RETRIES_BY_HAND = [
  [none(24), none(36)],
  [
    { slotsWithRetry: 2, slots: 24, earlierAttemptsByReason: [{ reason: 'parse-failure', attempts: 1 }, { reason: 'timeout', attempts: 2 }] },
    { slotsWithRetry: 3, slots: 36, earlierAttemptsByReason: [{ reason: 'parse-failure', attempts: 1 }, { reason: 'timeout', attempts: 2 }, { reason: 'truncated', attempts: 1 }] },
  ],
  [{ slotsWithRetry: 1, slots: 24, earlierAttemptsByReason: [{ reason: 'rate-limited', attempts: 1 }] }, { slotsWithRetry: 1, slots: 36, earlierAttemptsByReason: [{ reason: 'rate-limited', attempts: 1 }] }],
  [{ slotsWithRetry: 1, slots: 24, earlierAttemptsByReason: [{ reason: 'server-error', attempts: 1 }] }, { slotsWithRetry: 1, slots: 36, earlierAttemptsByReason: [{ reason: 'server-error', attempts: 1 }] }],
];

test('judge retries: each run counts its slots that hold a judge retry and its earlier judge attempts by reason, over the scored cases and over the run file (hand-worked fixture)', () => {
  const r = measure(retryRuns());
  assert.deepEqual(r.inputs.map((f) => [f.system, f.role, [f.judgeRetriesScored, f.judgeRetries]]), [['A', 'old-judge', RETRIES_BY_HAND[0]], ['A', 'new-judge', RETRIES_BY_HAND[1]], ['B', 'old-judge', RETRIES_BY_HAND[2]], ['B', 'new-judge', RETRIES_BY_HAND[3]]]);
  // The scored slots are the slots behind the numbers: the 4 scored cases times 6 draws.
  assert.equal(r.inputs[0]?.judgeRetriesScored.slots, r.counts.cases * 6);
  // A run with no retry says 0, and the report is the base fixture's in every number.
  const base = measure();
  assert.deepEqual(base.inputs.map((f) => [f.judgeRetriesScored, f.judgeRetries]), [0, 1, 2, 3].map(() => [none(24), none(36)]));
  assert.deepEqual([r.perDrawPassRate, r.labelPassRate, r.flips, r.perSystem, r.nonCompensable], [base.perDrawPassRate, base.labelPassRate, base.flips, base.perSystem, base.nonCompensable]);
  // Counts, never a rate: these keys and no other.
  for (const f of r.inputs) {
    for (const x of [f.judgeRetriesScored, f.judgeRetries]) {
      assert.deepEqual(Object.keys(x), ['slotsWithRetry', 'slots', 'earlierAttemptsByReason']);
      for (const y of x.earlierAttemptsByReason) assert.ok(Number.isInteger(y.attempts) && y.attempts > 0);
    }
  }
});

test('refusal MEASUREMENT_NOT_RUNNABLE: a judge call the provider rejected, even when a retry then graded', () => {
  const rejected = onSlot('c3', 4, (a) => [unmeasuredJudge(a, 'client-error'), a]);
  refused('MEASUREMENT_NOT_RUNNABLE', 'c3#4', () => measure({ Anew: makeRun('A', 'new', {}, rejected) }));
});

test('refusal UNSUPPORTED_DESIGN: the class and the cut must be what the bar and the cases say', () => {
  refused('UNSUPPORTED_DESIGN', 'measuredClass', () => measure({}, { measuredClass: 'nope' }));
  refused('UNSUPPORTED_DESIGN', 'cut', () => measure({}, { cut: '6' }));
  // The command never overrides a stored expectation: a cut the cases do not carry is refused.
  refused('UNSUPPORTED_DESIGN', 'c1', () => measure({}, { cut: '3' }));
  const ceiling: BarFile = { ...barFile, classes: { ...barFile.classes, quality: { direction: 'ceiling', minPassRate: 0.5 } } };
  const rebar = (r: RunArtifact): RunArtifact => ({ ...r, identity: { ...r.identity, barHash: barHash(ceiling) } });
  const b = baseRuns();
  refused('UNSUPPORTED_DESIGN', 'measuredClass', () => measure({ Aold: rebar(b.Aold), Anew: rebar(b.Anew), Bold: rebar(b.Bold), Bnew: rebar(b.Bnew) }, { barHash: barHash(ceiling) }, ceiling));
});

test('a system failure is a failing draw for both judges; it is never dropped', () => {
  // The system failed on A/c1 (one failure record, every draw): 3 fewer passing draws on each side.
  const failed: Edit = (draws) => draws.map((d) => (d.caseId === 'c1' ? { ...d, attempts: [failedAttempt('system-error')] } : d));
  const r = measure({ Aold: makeRun('A', 'old', {}, failed), Anew: makeRun('A', 'new', {}, failed) });
  near(r.perDrawPassRate.old, 11 / 24);
  near(r.perDrawPassRate.new, 8 / 24);
});

test('invalid input: a run that fails the parser names its file', () => {
  const { files, plan } = setup();
  const swap = (name: string, run: unknown): { files: JudgeChangeInput[]; plan: JudgeChangePlan } => {
    const f = typeof run === 'string' ? { name, bytes: new TextEncoder().encode(run) } : file(name, run);
    return { files: [...files.filter((x) => x.name !== name), f], plan: { ...plan, systems: { ...plan.systems, A: { old: shaOf(f), new: (plan.systems['A'] as { new: string }).new } } } };
  };
  const invalid = (s: { files: JudgeChangeInput[]; plan: JudgeChangePlan }, starts: string): void => {
    assert.throws(() => judgeChangeRuns(s.files, barFile, s.plan), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARTIFACT' && e.problems.some((p) => p.startsWith(starts)));
  };
  invalid(swap('Aold.json', { ...baseRuns().Aold, schema: 'anchorset.run/v2' }), 'Aold.json: artifact.schema');
  invalid(swap('Aold.json', '{ not json'), 'Aold.json: invalid JSON');
  // A run that gives a key twice: JSON.parse would read each of these texts as the valid run, and the plan binds their bytes.
  const good = JSON.stringify(baseRuns().Aold);
  const exactly = (text: string, problem: string): void => {
    assert.notEqual(text, good);
    assert.deepEqual(JSON.parse(text), JSON.parse(good));
    const s = swap('Aold.json', text);
    assert.throws(() => judgeChangeRuns(s.files, barFile, s.plan), (e: unknown) => {
      assert.ok(e instanceof InputError && e.code === 'INVALID_ARTIFACT', String(e));
      assert.deepEqual(e.problems, [problem]);
      return true;
    });
  };
  exactly(good.replace(/^\{/, '{"schema":"anchorset.run/v2",'), 'Aold.json: the key "schema" is given twice in the top-level object');
  exactly(good.replace('"identity":{', '"identity":{"judgeModelServed":"UNKNOWN",'), 'Aold.json: the key "judgeModelServed" is given twice in the object at /identity');
  exactly(good.replace('"draws":[{', '"draws":[{"\\u0063aseId":"c2",'), 'Aold.json: the key "caseId" is given twice in the object at /draws/0');
  // Not JSON and a key repeated: the parser's message stays.
  invalid(swap('Aold.json', '{"schema":1,"schema":'), 'Aold.json: invalid JSON: ');
});

test('the core hashes the bytes itself: a file whose content was swapped is not the file the plan names', () => {
  const { files, plan } = setup();
  const other = file('Anew.json', makeRun('A', 'new', {}, onCase('c1', { label: '1' })));
  refused('HASH_MISMATCH', 'Anew.json', () => judgeChangeRuns([...files.filter((f) => f.name !== 'Anew.json'), other], barFile, plan));
});

test('invalid input: a case whose class the bar does not know is never skipped', () => {
  // A typo of a non-compensable class would otherwise drop the case from every listing.
  const typo = cases.map((c) => (c.id === 'm1' ? { ...c, klass: 'mustt' } : c));
  const rehash = (r: RunArtifact): RunArtifact => ({ ...r, cases: typo, identity: { ...r.identity, caseSetHash: caseSetHash(typo) } });
  const b = baseRuns();
  assert.throws(
    () => measure({ Aold: rehash(b.Aold), Anew: rehash(b.Anew), Bold: rehash(b.Bold), Bnew: rehash(b.Bnew) }, { caseSetHash: caseSetHash(typo) }),
    (e: unknown) => e instanceof InputError && e.code === 'UNKNOWN_CLASS' && e.problems.some((p) => p.includes('m1') && p.includes('mustt')),
  );
});

// ---- the plan ----

const planProblems = (over: Record<string, unknown>): string[] => judgeChangePlanProblems({ ...setup().plan, ...over });

test('plan: a valid plan parses, and the schema is closed with no nulls', () => {
  const { plan } = setup();
  assert.equal(parseJudgeChangePlan(plan), plan);
  assert.ok(planProblems({ extra: 1 }).some((p) => p.includes('plan.extra: unknown field')));
  assert.ok(planProblems({ cut: null }).some((p) => p.includes('plan.cut: null is not allowed')));
  assert.ok(planProblems({ schema: 'anchorset.judge-change-plan/v0' }).some((p) => p.includes('plan.schema')));
  assert.throws(() => parseJudgeChangePlan({}), (e: unknown) => e instanceof InputError && e.code === 'INVALID_PLAN');
  for (const f of ['storedOutputs', 'labelRule', 'pooling', 'measuredClass', 'barHash', 'drawsPerCase', 'systems', 'judgeMoves']) {
    const { [f]: _dropped, ...rest } = plan as unknown as Record<string, unknown>;
    assert.ok(judgeChangePlanProblems(rest).some((p) => p.startsWith(`plan.${f}`)), `no default for ${f}`);
  }
});

test('plan: both judges are fully known', () => {
  const { plan } = setup();
  for (const bad of [GAP, 'NO_JUDGE', '', 'n/a']) {
    assert.ok(planProblems({ judges: { old: { ...plan.judges.old, judgeModelServed: bad }, new: plan.judges.new } }).some((p) => p.includes('plan.judges.old.judgeModelServed')), bad);
  }
  assert.ok(planProblems({ judges: { old: plan.judges.old, new: { ...plan.judges.new, rubricHash: GAP } } }).some((p) => p.includes('plan.judges.new.rubricHash')));
  assert.ok(planProblems({ judgeMoves: ['systemModelServed'] }).some((p) => p.includes('plan.judgeMoves')));
  // The plan fixes every judge field of the identity, and the rubric; a system field has no place in it.
  for (const f of [...JUDGE_FIELDS, 'rubricHash']) {
    const { [f]: _dropped, ...rest } = plan.judges.old as Record<string, string>;
    assert.ok(planProblems({ judges: { old: rest, new: plan.judges.new } }).some((p) => p.includes(`plan.judges.old.${f}`)), f);
  }
  assert.ok(planProblems({ judges: { old: { ...plan.judges.old, systemModelServed: 'x' }, new: plan.judges.new } }).some((p) => p.includes('plan.judges.old.systemModelServed: unknown field')));
});

test('plan: the draw sets are disjoint, equal, cover every draw, and are odd under majority', () => {
  const sets = (drawSets: unknown, more: Record<string, unknown> = {}): string => planProblems({ drawSets, ...more }).join(' | ');
  assert.equal(sets({ estimate: [0, 1, 2], reask: [3, 4, 5] }), '');
  assert.match(sets({ estimate: [0, 1, 2], reask: [2, 3, 4] }), /disjoint/);
  assert.match(sets({ estimate: [0, 1, 2] }), /cover every draw, 0\.\.5/);
  assert.match(sets({ estimate: [0, 1, 2, 3, 4], reask: [5] }), /equal size/);
  assert.match(sets({ estimate: [0, 1, 2, 3, 4, 5] }), /odd number of draws, got 6/);
  assert.equal(sets({ estimate: [0, 1, 2, 3, 4, 5] }, { labelRule: 'worst' }), '');
  assert.match(sets({ estimate: [0, 0, 1], reask: [3, 4, 5] }), /listed twice/);
  assert.match(sets({ estimate: [], reask: [3, 4, 5] }), /non-empty list/);
  assert.match(sets({ estimate: [0, 1, 2], reask: [3, 4, 6] }), /cover every draw/);
});

test('plan: each file enters the roster once', () => {
  const { plan } = setup();
  const a = plan.systems['A'] as { old: string; new: string };
  assert.ok(planProblems({ systems: { A: a, B: { old: a.old, new: hashOf('x') } } }).some((p) => p.includes('each file enters the roster once')));
  assert.ok(planProblems({ systems: { A: { old: 'abc', new: a.new } } }).some((p) => p.includes('plan.systems.A.old')));
  assert.ok(planProblems({ systems: {} }).some((p) => p.includes('plan.systems')));
});

test('plan: the optional blocks are closed; one case per cluster is required, and true, with a gate or resampling', () => {
  const gate = { statistic: 'tango-1998', margin: 0.1, alpha: 0.05 };
  assert.deepEqual(planProblems({ gate, oneCasePerCluster: true }), []);
  assert.ok(planProblems({ gate }).some((p) => p.includes('plan.oneCasePerCluster: required')));
  assert.ok(planProblems({ gate, oneCasePerCluster: false }).some((p) => p.includes('plan.oneCasePerCluster: must be true')));
  assert.ok(planProblems({ gate: { ...gate, margin: 0 }, oneCasePerCluster: true }).some((p) => p.includes('plan.gate.margin')));
  assert.ok(planProblems({ gate: { ...gate, statistic: 'mcnemar' }, oneCasePerCluster: true }).some((p) => p.includes('plan.gate.statistic')));
  assert.ok(planProblems({ gate: { ...gate, alpha: 0.5 }, oneCasePerCluster: true }).some((p) => p.includes('plan.gate.alpha')));
  assert.deepEqual(planProblems({ resampling: { suppliedSha256: hashOf('indices'), spreadFloor: 30 }, oneCasePerCluster: true }), []);
  assert.ok(planProblems({ resampling: { iterations: 40, seed: 1, spreadFloor: 30 }, oneCasePerCluster: true }).some((p) => p.includes('plan.resampling.iterations: must be an integer of at least 41')));
  assert.deepEqual(planProblems({ resampling: { iterations: 41, seed: 1, spreadFloor: 2 }, oneCasePerCluster: true }), []);
  assert.ok(planProblems({ resampling: { iterations: 100, seed: 1, spreadFloor: 1 }, oneCasePerCluster: true }).some((p) => p.includes('plan.resampling.spreadFloor')));
  assert.ok(planProblems({ resampling: { iterations: 100, seed: 1, spreadFloor: 30, extra: 1 }, oneCasePerCluster: true }).some((p) => p.includes('plan.resampling.extra')));
  assert.ok(planProblems({ map: { folds: 5 }, labelRule: 'worst', drawSets: { estimate: [0, 1, 2], reask: [3, 4, 5] } }).some((p) => p.includes('plan.map: requires labelRule "majority"')));
  assert.ok(planProblems({ map: { band: 1 } }).some((p) => p.includes('plan.map.band: unknown field')));
  const fullMap = { encoding: { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5 }, folds: 5, fitOnlyCaseIds: ['x'], tieBreak: { seeds: Array.from({ length: 20 }, (_, i) => i + 1) }, minSystems: 2, minFitItems: 10, maxTieShare: 0.2 };
  assert.deepEqual(planProblems({ map: fullMap, ...gateBlock }), []);
  assert.deepEqual(planProblems({ map: { ...fullMap, tieBreak: { ...fullMap.tieBreak, suppliedSha256: hashOf('u') } }, ...gateBlock }), []);
  // Supplied draws never replace the seeds: without them nothing would show what the tie-break alone moves.
  assert.ok(planProblems({ map: { ...fullMap, tieBreak: { suppliedSha256: hashOf('u') } }, ...gateBlock }).some((p) => p.includes('plan.map.tieBreak.seeds')));
  // A tieBreak that is not an object says what it may hold: the seeds are always required, the supplied draws optional.
  assert.ok(planProblems({ map: { ...fullMap, tieBreak: 5 }, ...gateBlock }).includes('plan.map.tieBreak: must be { seeds, suppliedSha256? }'));
  assert.ok(planProblems({ map: { ...fullMap, encoding: { ...fullMap.encoding, '5': 2 ** 53 } }, ...gateBlock }).some((p) => p.includes('plan.map.encoding')));
  // The map has no defaults, feeds the pair gates, and needs majority labels.
  for (const k of Object.keys(fullMap)) {
    const { [k]: _dropped, ...rest } = fullMap as Record<string, unknown>;
    assert.ok(planProblems({ map: rest, ...gateBlock }).some((p) => p.includes(`plan.map.${k}: required`)), k);
  }
  assert.ok(planProblems({ map: fullMap }).some((p) => p.includes('plan.map: requires a gate block')));
  for (const [bad, key] of [[{ encoding: 5 }, 'encoding'], [{ folds: 'x' }, 'folds'], [{ folds: 1 }, 'folds'], [{ fitOnlyCaseIds: [1] }, 'fitOnlyCaseIds'], [{ fitOnlyCaseIds: ['x', 'x'] }, 'fitOnlyCaseIds'], [{ tieBreak: 3 }, 'tieBreak'], [{ tieBreak: { seeds: [1, 2, 3] } }, 'tieBreak.seeds'], [{ tieBreak: { seeds: Array.from({ length: 20 }, () => 1) } }, 'tieBreak.seeds'], [{ minSystems: 0 }, 'minSystems'], [{ maxTieShare: 2 }, 'maxTieShare']] as const) {
    assert.ok(planProblems({ map: { ...fullMap, ...bad }, ...gateBlock }).some((p) => p.includes(`plan.map.${key}`)), key);
  }
  // Declared alone, nothing would read it.
  assert.ok(planProblems({ oneCasePerCluster: true }).some((p) => p.includes('plan.oneCasePerCluster: only with')));
});

/** The judge could not grade this output on one attempt. */
function unmeasuredJudge(a: Attempt, reason: string): Attempt {
  const g = a as Extract<Attempt, { kind: 'graded' }>;
  return { kind: 'unmeasured', role: 'judge', reason, detail: reason, outputHash: g.outputHash, systemStop: g.systemStop, packetHash: g.packetHash } as Attempt;
}

// ---- the command ----

const root = join(import.meta.dirname, '..');
const cli = (...args: string[]) => spawnSync(process.execPath, [join(root, 'src', 'cli.ts'), ...args], { encoding: 'utf8' });
const tmp = mkdtempSync(join(tmpdir(), 'anchorset-judge-change-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Writes the fixture as files, with the plan and the bar beside the runs, and returns the three flags. */
function onDisk(name: string, planOver: Partial<JudgeChangePlan> = {}, runsOver: Partial<Runs> = {}): string[] {
  const dir = mkdtempSync(join(tmp, `${name}-`));
  const runs = { ...baseRuns(), ...runsOver };
  const sha: Record<string, string> = {};
  for (const [k, run] of Object.entries(runs)) {
    writeFileSync(join(dir, `${k}.json`), `${JSON.stringify(run, null, 2)}\n`);
    sha[k] = sha256Hex(readFileSync(join(dir, `${k}.json`)));
  }
  const plan = { ...setup().plan, systems: { A: { old: sha['Aold'], new: sha['Anew'] }, B: { old: sha['Bold'], new: sha['Bnew'] } }, ...planOver };
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(dir, 'bar.json'), JSON.stringify(barFile));
  return ['--plan', join(dir, 'plan.json'), '--bar', join(dir, 'bar.json'), '--inputs', dir];
}

test('anchorset judge-change: reads the runs by their file sha256, prints the measurement and exits 0', () => {
  const flags = onDisk('ok');
  const r = cli('judge-change', ...flags);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /a measurement\. It has no verdict and never exits 1\./);
  assert.match(r.stdout, /packets of the two judges: equal as recorded/);
  assert.match(r.stdout, /judgeModelServed\s+judge-2026-01-01 -> judge-2026-06-01/);
  assert.match(r.stdout, /per-draw pass rate\s+0\.583\s+0\.458\s+-0\.125/);
  assert.match(r.stdout, /label pass rate \(majority\)\s+0\.625\s+0\.500\s+-0\.125/);
  assert.match(r.stdout, /labels that differ between two sets of one judge \(majority\)\s+0\.188/);
  assert.match(r.stdout, /the first share minus the second \(from the counts\)\s+0\.188/);
  assert.match(r.stdout, /A\/c2 {2}pass -> fail/);
  assert.match(r.stdout, /must\/A\/m1 {2}old judge fails draws \[\] · new judge fails draws \[4\] · worst-of-N differs between the judges/);
  assert.match(r.stdout, /not measured \(one class per plan\): other/);
  assert.match(r.stdout, /note: nothing here shows the plan preceded the scores/);
  assert.doesNotMatch(r.stdout, /verdict: |Verdict|\bPASS\b|REGRESSION|exit 1/);
  const j = cli('judge-change', ...flags, '--json');
  assert.equal(j.status, 0, j.stderr);
  const out = JSON.parse(j.stdout) as { kind: string; perDrawPassRate: { change: number }; inputs: { name: string }[] };
  assert.equal(out.kind, 'measurement');
  assert.equal(out.perDrawPassRate.change, -0.125);
  assert.deepEqual(out.inputs.map((f) => f.name), ['Aold.json', 'Anew.json', 'Bold.json', 'Bnew.json']);
});

test('anchorset judge-change: under each run, its judge retries as counts over the scored cases and over the run file, zero included (the hand-worked fixture above)', () => {
  const flags = onDisk('retries', {}, retryRuns());
  const r = cli('judge-change', ...flags);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  const under = (name: string): string[] => {
    const at = lines.findIndex((l) => l.includes(` ${name}  `));
    return [lines[at + 1] as string, lines[at + 2] as string];
  };
  const scored = 'judge retries, the 4 scored cases of class "quality":';
  const file = 'judge retries, the run file, every class included:';
  assert.deepEqual(under('Aold.json'), [`    ${scored} 0 of 24 slots hold one · earlier judge attempts: 0`, `    ${file} 0 of 36 slot records hold one · earlier judge attempts: 0`]);
  assert.deepEqual(under('Anew.json'), [`    ${scored} 2 of 24 slots hold one · earlier judge attempts by reason: parse-failure 1, timeout 2`, `    ${file} 3 of 36 slot records hold one · earlier judge attempts by reason: parse-failure 1, timeout 2, truncated 1`]);
  assert.deepEqual(under('Bold.json'), [`    ${scored} 1 of 24 slots hold one · earlier judge attempts by reason: rate-limited 1`, `    ${file} 1 of 36 slot records hold one · earlier judge attempts by reason: rate-limited 1`]);
  assert.deepEqual(under('Bnew.json'), [`    ${scored} 1 of 24 slots hold one · earlier judge attempts by reason: server-error 1`, `    ${file} 1 of 36 slot records hold one · earlier judge attempts by reason: server-error 1`]);
  const j = JSON.parse(cli('judge-change', ...flags, '--json').stdout) as { inputs: { judgeRetriesScored: unknown; judgeRetries: unknown }[] };
  assert.deepEqual(j.inputs.map((f) => [f.judgeRetriesScored, f.judgeRetries]), RETRIES_BY_HAND);
});

test('anchorset judge-change: refused is exit 2, an invalid plan is 65, bad usage is 64; it never exits 1', () => {
  const flags = onDisk('codes');
  writeFileSync(join(flags[5] as string, 'stray.json'), '{}');
  const stray = cli('judge-change', ...flags);
  assert.equal(stray.status, 2);
  assert.match(stray.stderr, /REFUSED HASH_MISMATCH\n {2}fields: stray\.json/);
  const bad = onDisk('bad-plan', { labelRule: 'median' as never });
  const invalid = cli('judge-change', ...bad);
  assert.equal(invalid.status, 65);
  assert.match(invalid.stderr, /INVALID_PLAN/);
  assert.match(invalid.stderr, /--plan .*plan\.json: plan\.labelRule/);
  assert.equal(cli('judge-change', '--plan', flags[1] as string).status, 64);
  assert.equal(cli('judge-change', ...flags.slice(0, 4), '--inputs', join(tmp, 'no-such-dir')).status, 65);
  // A file in the folder that cannot be read is invalid input, never an uncaught error (which would exit 1).
  const dangling = onDisk('dangling');
  symlinkSync(join(tmp, 'gone.json'), join(dangling[5] as string, 'x.json'));
  const d = cli('judge-change', ...dangling);
  assert.equal(d.status, 65, d.stderr);
  assert.match(d.stderr, /cannot read .*x\.json/);
});

test('the judge-change example runs as documented, and its plan still binds its run files', () => {
  const ex = (f: string): string => join(root, 'examples', 'judge-change', f);
  const r = cli('judge-change', '--plan', ex('plan.json'), '--bar', ex('bar.json'), '--inputs', ex('runs'), '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as {
    perDrawPassRate: { old: number; new: number };
    labelPassRate: { old: number; new: number };
    flips: { acrossJudges: number; withinJudge: number; beyondReask: number };
    counts: { systems: number; cases: number; fitOnlyCases: number; items: number };
    gate: { counts: { pairs: number; passDoNothingOnly: number; passRejudgedOnly: number; passBoth: number; net: number } };
    map: { counts: { pairs: number; passRecalibratedOnly: number; passRejudgedCutOnly: number; passBoth: number; net: number } };
  };
  // The expected numbers below are the ones the example's README prints, from the report of this version; the data
  // are synthetic (examples/judge-change/generate.ts). 5 systems x 24 scored cases = 120 items, and 8 fit-only cases.
  // Passing estimate draws, of 360: old 169, new 103. Majority labels, of 120: old 59, new 36.
  assert.deepEqual(out.counts, { systems: 5, cases: 24, fitOnlyCases: 8, items: 120, drawsPerSet: 3 } as never);
  near(out.perDrawPassRate.old, 169 / 360);
  near(out.perDrawPassRate.new, 103 / 360);
  assert.deepEqual(out.labelPassRate, { rule: 'majority', old: 59 / 120, new: 36 / 120, change: (36 - 59) / 120 });
  // Labels that differ between the judges: 33 of 120. Within one judge between its two draw sets: mean 0.167. Beyond re-asking: 0.275 - 0.167.
  near(out.flips.acrossJudges, 33 / 120);
  near(out.flips.withinJudge, 1 / 6);
  near(out.flips.beyondReask, 33 / 120 - 1 / 6);
  // Twenty ordered pairs. Doing nothing passes none that re-judging does not; re-judging passes five that doing nothing does not.
  assert.deepEqual(out.gate.counts, { pairs: 20, passDoNothingOnly: 0, passRejudgedOnly: 5, passBoth: 1, net: -5 });
  assert.deepEqual(out.map.counts, { pairs: 20, passRecalibratedOnly: 2, passRejudgedCutOnly: 1, passBoth: 6, net: 1 });
});

// ---- pair gates, the reference and the spread ----

// Six quality cases and nothing else. A label is given directly: 1 is six grades of 4, 0 is six grades of 2.
const gCases: Case[] = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'].map((id) => ({ id, klass: 'quality', input: { question: id }, expect: '4' }));
const gateBlock = { gate: { statistic: 'tango-1998', margin: 0.1, alpha: 0.05 }, oneCasePerCluster: true } as const;
type Bits = Record<string, { old: string; new: string; ref?: string }>;

function gateSetup(bits: Bits, planOver: Partial<JudgeChangePlan> = {}, refOver: (system: string, ref: ReferenceFile) => unknown = (_s, r) => r): { files: JudgeChangeInput[]; plan: JudgeChangePlan } {
  const files: JudgeChangeInput[] = [];
  const systems: JudgeChangePlan['systems'] = {};
  for (const [system, b] of Object.entries(bits)) {
    const run = (side: 'old' | 'new'): RunArtifact => {
      const id = makeJudgedIdentity({ caseSetHash: caseSetHash(gCases), barHash: barHash(barFile), drawsPerCase: 6, ...(side === 'old' ? oldJudge : newJudge), systemModelServed: `system-${system}` });
      const draws = gCases.flatMap((c, k) => Array.from({ length: 6 }, (_, drawIndex): Draw => ({ caseId: c.id, drawIndex, attempts: [graded(system, c.id, b[side][k] === '1' ? '4' : '2')] })));
      return { schema: RUN_SCHEMA, identity: id, callShapes: callShapesFor(id), cases: gCases, draws, packetBasis: 'recorded' };
    };
    const o = file(`${system}.old.json`, run('old'));
    const n = file(`${system}.new.json`, run('new'));
    files.push(o, n);
    systems[system] = { old: shaOf(o), new: shaOf(n) };
    if (b.ref !== undefined) {
      const ref: ReferenceFile = {
        schema: REFERENCE_SCHEMA,
        verdictRule: 'the fixture\'s own pass mark',
        verdicts: Object.fromEntries(gCases.map((c, k) => [c.id, b.ref?.[k] === '1' ? 'pass' : 'fail'])),
        packetHashes: Object.fromEntries(gCases.map((c) => [c.id, sha256Hex(`packet ${system}:${c.id}`)])),
        packetBasis: 'recorded',
      };
      const r = file(`${system}.ref.json`, refOver(system, ref));
      files.push(r);
      systems[system] = { old: shaOf(o), new: shaOf(n), reference: shaOf(r) };
    }
  }
  return { files, plan: { ...setup().plan, caseSetHash: caseSetHash(gCases), systems, ...gateBlock, ...planOver } };
}
const gateMeasure = (bits: Bits, planOver: Partial<JudgeChangePlan> = {}, refOver?: (system: string, ref: ReferenceFile) => unknown): JudgeChangeReport => {
  const { files, plan } = gateSetup(bits, planOver, refOver);
  return judgeChangeRuns(files, barFile, plan);
};
const gateOf = (r: JudgeChangeReport): GateReport => {
  assert.ok(r.gate !== 'not declared' && !('withheld' in r.gate), JSON.stringify(r.gate));
  return r.gate;
};
/** The agreement block of a report whose reference saw the judges' packets; it fails when the block is withheld. */
const agreementWith = (r: JudgeChangeReport) => {
  assert.ok(r.reference !== 'not declared' && !('withheld' in r.reference), JSON.stringify(r.reference));
  const a = r.reference.agreement;
  assert.ok(!('withheld' in a), JSON.stringify(a));
  return a;
};

// The old judge is strict and the new one lenient. The reference says X is half right, Y always, Z never.
const lenient: Bits = {
  X: { ref: '111000', old: '110000', new: '111111' },
  Y: { ref: '111111', old: '110000', new: '111111' },
  Z: { ref: '000000', old: '000000', new: '111100' },
};

test('pair gates: the three gates on every ordered pair, worked by hand', () => {
  const g = gateOf(gateMeasure(lenient));
  assert.deepEqual([g.n, g.margin, g.alpha, g.approximation, g.smallestConcordantPassN, g.oneCasePerCluster], [6, 0.1, 0.05, 'asymptotic', 25, 'declared, not checked']);
  // (worse, better) = (n10, n01): cases the baseline passes and the candidate fails, and the reverse.
  // At n = 6 a table passes with nobody worse and two or more better, and regresses with four or more worse and nobody better.
  const want: Record<string, [number[], number[], number[]]> = {
    // pair:  reference              do nothing: old(A), new(B)   re-judged: new(A), new(B)
    'X>Y': [[0, 3], /* 111000 → 111111 */ [0, 4], /* 110000 → 111111 */ [0, 0]],
    'X>Z': [[3, 0], /* 111000 → 000000 */ [0, 2], /* 110000 → 111100 */ [2, 0]] /* 111111 → 111100 */,
    'Y>X': [[3, 0], [0, 4], [0, 0]],
    'Y>Z': [[6, 0], [0, 2], [2, 0]],
    'Z>X': [[0, 3], [0, 6], [0, 2]],
    'Z>Y': [[0, 6], [0, 6], [0, 2]],
  };
  assert.deepEqual(g.pairs.map((p) => `${p.baseline}>${p.candidate}`), Object.keys(want));
  for (const p of g.pairs) {
    const [e, r, c] = want[`${p.baseline}>${p.candidate}`] as [number[], number[], number[]];
    for (const [name, got, counts] of [['reference', p.reference, e], ['doNothing', p.doNothing, r], ['rejudged', p.rejudged, c]] as const) {
      const expected = nonInferiority({ n: 6, n10: counts[0] as number, n01: counts[1] as number }, { margin: 0.1, alpha: 0.05 });
      assert.deepEqual(got, { n10: counts[0], n01: counts[1], z: expected.z, state: expected.state }, `${p.baseline}>${p.candidate} ${name}`);
    }
  }
  const states = (k: 'reference' | 'doNothing' | 'rejudged'): string => g.pairs.map((p) => (p[k]?.state ?? '?')[0]).join('');
  assert.equal(states('reference'), 'PIIRPP');
  assert.equal(states('doNothing'), 'PPPPPP');
  assert.equal(states('rejudged'), 'IIIIPP');
});

test('pair gates: the counts, worked by hand, and the critical pair listed', () => {
  const r = gateMeasure(lenient);
  const g = gateOf(r);
  // Doing nothing passes all six pairs; re-judging passes the last two. Four pass by doing nothing only.
  assert.deepEqual(g.counts, { pairs: 6, passDoNothingOnly: 4, passRejudgedOnly: 0, passBoth: 2, net: 4 });
  // The reference gate does not pass X>Z, Y>X (INCONCLUSIVE) and Y>Z (REGRESSION). Doing nothing passes all
  // three, re-judging none. Of the three it passes (X>Y, Z>X, Z>Y), doing nothing misses none and re-judging misses X>Y.
  assert.deepEqual(g.reference, {
    notPass: 3,
    regression: 1,
    inconclusive: 2,
    passDoNothing: 3,
    passRejudged: 0,
    net: 3,
    onlyDoNothing: 3,
    onlyRejudged: 0,
    notPassedNet: -1,
    referenceRegressionPassed: [{ baseline: 'Y', candidate: 'Z', passedBy: ['doNothing'] }],
  });
  assert.deepEqual(Object.keys(g.states), ['PASS', 'REGRESSION', 'INCONCLUSIVE']);
  assert.match(g.states.PASS, /above the nominal threshold.*no more than the margin worse.*may still be worse/);
  assert.match(g.states.INCONCLUSIVE, /neither threshold is crossed; this does not say why/);
  assert.ok(r.notes.some((n) => n.includes('its level is nominal')));
});

test('reference agreement is never a lone share: counts, kappa, AC1 and the pass shares, worked by hand', () => {
  // A resampling block is declared: without one kappa and AC1 are withheld (the test after this one).
  const r = gateMeasure(lenient, resampling(4, 200));
  const a = agreementWith(r);
  // 18 items. The reference passes 3 + 6 + 0 = 9. The old judge passes 2 + 2 + 0 = 4 and agrees on 5 + 2 + 6 = 13;
  // the new judge passes 6 + 6 + 4 = 16 and agrees on 3 + 6 + 2 = 11.
  assert.deepEqual([a.rule, a.items, a.referencePassShare], ['majority', 18, 0.5]);
  assert.deepEqual([a.old.agree, a.old.share, a.old.passShare], [13, 13 / 18, 4 / 18]);
  assert.deepEqual([a.new.agree, a.new.share, a.new.passShare], [11, 11 / 18, 16 / 18]);
  // Cohen's kappa: chance agreement is 0.5 for both, because the reference passes half. (13/18 − 0.5) / 0.5 and (11/18 − 0.5) / 0.5.
  near(a.old.kappa as number, 8 / 18);
  near(a.new.kappa as number, 4 / 18);
  // Gwet's AC1: the mean pass share is 13/36 (old) and 25/36 (new); chance is 2·π·(1 − π).
  near(a.old.ac1 as number, (13 / 18 - 2 * (13 / 36) * (23 / 36)) / (1 - 2 * (13 / 36) * (23 / 36)));
  near(a.new.ac1 as number, (11 / 18 - 2 * (25 / 36) * (11 / 36)) / (1 - 2 * (25 / 36) * (11 / 36)));
  // A judge that passes everything agrees with a reference that passes most, and kappa says so: 0.
  const all = gateMeasure({ X: { ref: '111110', old: '111111', new: '111111' }, Y: { ref: '111110', old: '111111', new: '111110' } }, resampling(4, 200));
  assert.deepEqual([agreementWith(all).old.share, agreementWith(all).old.kappa], [10 / 12, 0]);
});

// Kappa and AC1 are printed only where something says how uncertain they are. Without a resampling
// block, and where the block's spread is withheld because the cases are below its floor, nothing does: both are
// withheld with the reason, and never computed. The agreeing count, the number of items and both pass shares stay.
// A fixture, worked by hand: the counts are those of the test above (18 items; 13 and 11 agree; pass shares 4/18,
// 16/18 and 9/18).
test('without a resampling block kappa and AC1 are withheld with the reason, in the JSON and in the text; the count, n and both pass shares stay (hand-worked fixture)', () => {
  const NO_BLOCK = { withheld: 'NO_RESAMPLING', detail: 'plan.resampling is not declared, so nothing would say how uncertain kappa and AC1 are: neither is computed. Declare a resampling block to get both, each with its percentiles over resamples of cases' };
  const a = agreementWith(gateMeasure(lenient));
  assert.deepEqual([a.items, a.referencePassShare, a.spread], [18, 0.5, 'not declared']);
  assert.deepEqual(a.old, { agree: 13, share: 13 / 18, kappa: NO_BLOCK, ac1: NO_BLOCK, passShare: 4 / 18 });
  assert.deepEqual(a.new, { agree: 11, share: 11 / 18, kappa: NO_BLOCK, ac1: NO_BLOCK, passShare: 16 / 18 });
  // Never computed: a table on which kappa is undefined (both raters pass everything) gives the same marker, not "NA".
  const flat = agreementWith(gateMeasure({ X: { ref: '111111', old: '111111', new: '111111' }, Y: { ref: '111111', old: '111111', new: '111111' } }));
  assert.deepEqual([flat.old.kappa, flat.old.ac1, flat.new.kappa, flat.new.ac1], [NO_BLOCK, NO_BLOCK, NO_BLOCK, NO_BLOCK]);
  // A block whose spread is withheld leaves kappa and AC1 just as bare: withheld too, under the spread's own code.
  const below = gateMeasure(lenient, { resampling: { iterations: 200, seed: 4, spreadFloor: 7 }, oneCasePerCluster: true });
  assert.deepEqual(below.spread, { withheld: 'BELOW_SPREAD_FLOOR', detail: '6 cases, and the plan\'s spreadFloor is 7' });
  const BELOW = { withheld: 'BELOW_SPREAD_FLOOR', detail: '6 cases, and the plan\'s spreadFloor is 7: the spread is withheld, so nothing would say how uncertain kappa and AC1 are, and neither is computed' };
  const b = agreementWith(below);
  assert.deepEqual([b.old.agree, b.old.kappa, b.old.ac1, b.new.agree, b.new.kappa, b.new.ac1, b.spread], [13, BELOW, BELOW, 11, BELOW, BELOW, 'not declared']);
  // With a block that is computed, both are numbers, as before.
  const c = agreementWith(gateMeasure(lenient, resampling(4, 200)));
  assert.deepEqual([typeof c.old.kappa, typeof c.old.ac1, typeof c.new.kappa, typeof c.new.ac1], ['number', 'number', 'number', 'number']);

  const text = (name: string, planOver: Partial<JudgeChangePlan>): string[] => {
    const { files, plan } = gateSetup(lenient, planOver);
    const dir = mkdtempSync(join(tmp, `withheld-${name}-`));
    for (const f of files) writeFileSync(join(dir, f.name), f.bytes);
    writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
    writeFileSync(join(dir, 'bar.json'), JSON.stringify(barFile));
    const flags = ['--plan', join(dir, 'plan.json'), '--bar', join(dir, 'bar.json'), '--inputs', dir];
    const r = cli('judge-change', ...flags);
    assert.equal(r.status, 0, r.stderr);
    // The --json is the report itself: the marker is on all four fields there too.
    const j = JSON.parse(cli('judge-change', ...flags, '--json').stdout) as { reference: { agreement: { old: { kappa: unknown; ac1: unknown }; new: { kappa: unknown; ac1: unknown } } } };
    const expected = name === 'none' ? NO_BLOCK : BELOW;
    assert.deepEqual([j.reference.agreement.old.kappa, j.reference.agreement.old.ac1, j.reference.agreement.new.kappa, j.reference.agreement.new.ac1], [expected, expected, expected, expected]);
    return r.stdout.split('\n');
  };
  const none = text('none', {});
  assert.ok(none.includes('agreement with the reference · judge labels: majority · reference verdicts: the fixture\'s own pass mark · 18 items · the reference passes 0.500 · packets equal as recorded:'), none.join('\n'));
  assert.ok(none.includes('  old judge  agrees on 13 of 18 · passes 0.222'), none.join('\n'));
  assert.ok(none.includes('  new judge  agrees on 11 of 18 · passes 0.889'), none.join('\n'));
  assert.ok(none.includes(`  kappa and AC1: withheld (NO_RESAMPLING): ${NO_BLOCK.detail}`), none.join('\n'));
  // No coefficient, no agreeing share and no bracket line: nothing stands there bare.
  assert.doesNotMatch(none.join('\n'), /kappa -?\d|AC1 -?\d|agrees on \d+ \(|brackets:|no brackets|stand here/);
  const low = text('below', { resampling: { iterations: 200, seed: 4, spreadFloor: 7 }, oneCasePerCluster: true });
  assert.ok(low.includes('  old judge  agrees on 13 of 18 · passes 0.222'), low.join('\n'));
  assert.ok(low.includes(`  kappa and AC1: withheld (BELOW_SPREAD_FLOOR): ${BELOW.detail}`), low.join('\n'));
  assert.doesNotMatch(low.join('\n'), /kappa -?\d|AC1 -?\d|agrees on \d+ \(|brackets:|no brackets|stand here/);
});

test('pair gates: counts that the first fixture cannot tell apart', () => {
  const r = gateMeasure(lenient);
  assert.ok(r.reference !== 'not declared' && !('withheld' in r.reference));
  assert.deepEqual(r.reference.inputs.map((f) => [f.system, f.name, f.packetBasis]), [['X', 'X.ref.json', 'recorded'], ['Y', 'Y.ref.json', 'recorded'], ['Z', 'Z.ref.json', 'recorded']]);
  assert.deepEqual(r.blocks, { gate: 'computed', resampling: 'not declared', map: 'not declared', reference: 'computed' });
  assert.ok(r.notes.some((n) => n.includes('not thereby wrong')));
  // A pair both gates pass that the reference gate does not, and REGRESSION pairs that no gate passes.
  //   P>Q: reference (0,0) U · do nothing 110000 → 111111 (0,4) PASS · re-judged 111100 → 111111 (0,2) PASS
  //   P>W: reference (6,0) R · do nothing 110000 → 000000 (2,0) U    · re-judged 111100 → 000000 (4,0) R
  //   Q>P: reference (0,0) U · do nothing 111111 → 111100 (2,0) U    · re-judged (2,0) U
  //   Q>W: (6,0) R under all three.   W>P: (0,6), (0,4), (0,4) PASS.   W>Q: (0,6) PASS under all three.
  const g = gateOf(gateMeasure({ P: { ref: '111111', old: '110000', new: '111100' }, Q: { ref: '111111', old: '111111', new: '111111' }, W: { ref: '000000', old: '000000', new: '000000' } }));
  const st = (k: 'reference' | 'doNothing' | 'rejudged'): string => g.pairs.map((p) => (p[k]?.state ?? '?')[0]).join('');
  assert.deepEqual([st('reference'), st('doNothing'), st('rejudged')], ['IRIRPP', 'PIIRPP', 'PRIRPP']);
  assert.deepEqual(g.counts, { pairs: 6, passDoNothingOnly: 0, passRejudgedOnly: 0, passBoth: 3, net: 0 });
  // Not passed by the reference gate: four pairs. Each gate passes one of them, the same one, so neither does so alone.
  assert.deepEqual(g.reference, { notPass: 4, regression: 2, inconclusive: 2, passDoNothing: 1, passRejudged: 1, net: 0, onlyDoNothing: 0, onlyRejudged: 0, notPassedNet: 0, referenceRegressionPassed: [] });
  // The level enters the header: at alpha 0.01 the critical value is 2.3263 and the concordant bound is 49.
  const strict = gateOf(gateMeasure(lenient, { gate: { statistic: 'tango-1998', margin: 0.1, alpha: 0.01 } }));
  near(strict.critical, 2.3263478740408408);
  assert.equal(strict.smallestConcordantPassN, 49);
  assert.equal(strict.pairs[0]?.doNothing.state, 'INCONCLUSIVE');
});

test('pair gates: a pair only re-judging passes counts against doing nothing', () => {
  // P and Q are equal under the reference and under the old judge; the new judge is stricter on P.
  // P>Q: reference (0, 0) U; do nothing old(P) 111111 → new(Q) 111111 (0, 0) U; re-judged new(P) 111100 → 111111 (0, 2) PASS.
  // Q>P: reference (0, 0) U; do nothing 111111 → 111100 (2, 0) U; re-judged (2, 0) U.
  const g = gateOf(gateMeasure({ P: { ref: '111111', old: '111111', new: '111100' }, Q: { ref: '111111', old: '111111', new: '111111' } }));
  assert.deepEqual(g.counts, { pairs: 2, passDoNothingOnly: 0, passRejudgedOnly: 1, passBoth: 0, net: -1 });
  assert.deepEqual(g.reference, { notPass: 2, regression: 0, inconclusive: 2, passDoNothing: 0, passRejudged: 1, net: -1, onlyDoNothing: 0, onlyRejudged: 1, notPassedNet: 0, referenceRegressionPassed: [] });
});

test('pair gates without a reference: the reference-free counts, and nothing about which gate is right', () => {
  const noRef = Object.fromEntries(Object.entries(lenient).map(([k, v]) => [k, { old: v.old, new: v.new }]));
  const r = gateMeasure(noRef);
  const g = gateOf(r);
  assert.equal(g.reference, 'not declared');
  assert.equal(r.reference, 'not declared');
  assert.ok(g.pairs.every((p) => !('reference' in p)));
  assert.deepEqual(g.counts, { pairs: 6, passDoNothingOnly: 4, passRejudgedOnly: 0, passBoth: 2, net: 4 });
});

test('pair gates: one system has no pair; the gate block needs majority labels', () => {
  const r = gateMeasure({ X: { old: '110000', new: '111111' } });
  assert.deepEqual(r.gate, { withheld: 'NO_PAIRS', detail: 'a pair gate compares two systems, and the roster has one' });
  assert.equal(r.blocks.gate, 'withheld: NO_PAIRS');
  assert.ok(planProblems({ ...gateBlock, labelRule: 'worst' }).some((p) => p.includes('plan.gate: requires labelRule "majority"')));
});

test('reference: packets that are unknown or differ from the judges\' withhold every reference row, and nothing else', () => {
  const base = gateMeasure(lenient);
  const cases: [string, (s: string, r: ReferenceFile) => unknown][] = [
    ['another view', (s, r) => (s === 'Y' ? { ...r, packetHashes: { ...r.packetHashes, g3: sha256Hex('a cut view') } } : r)],
    ['unknown hash', (s, r) => (s === 'Y' ? { ...r, packetHashes: { ...r.packetHashes, g3: GAP } } : r)],
    ['unknown basis', (s, r) => (s === 'Y' ? { ...r, packetBasis: GAP, packetHashes: Object.fromEntries(Object.keys(r.packetHashes).map((k) => [k, GAP])) } : r)],
  ];
  for (const [name, over] of cases) {
    const r = gateMeasure(lenient, {}, over);
    assert.ok(r.reference !== 'not declared' && 'withheld' in r.reference && r.reference.withheld === 'PACKET_MISMATCH' && r.reference.detail.includes('Y'), name);
    const g = gateOf(r);
    assert.deepEqual(g.reference, r.reference, name);
    assert.ok(g.pairs.every((p) => !('reference' in p)), name);
    assert.equal(r.blocks.reference, 'withheld: PACKET_MISMATCH', name);
    // The reference-free rows stand.
    assert.deepEqual(g.counts, gateOf(base).counts, name);
    assert.deepEqual(r.perDrawPassRate, base.perDrawPassRate, name);
  }
});

test('reference: a declared packet is admitted and marked; the file is closed and bound like a run', () => {
  const declared = gateMeasure(lenient, {}, (_s, r) => ({ ...r, packetBasis: 'declared', packetSource: 'the dataset paper, section 3' }));
  assert.ok(declared.reference !== 'not declared' && !('withheld' in declared.reference));
  assert.deepEqual(declared.reference.inputs.map((f) => [f.packetBasis, f.packetSource]), Array.from({ length: 3 }, () => ['declared', 'the dataset paper, section 3']));
  // It must cover exactly the measured cases.
  refused('ITEM_SET_MISMATCH', 'g6', () => gateMeasure(lenient, {}, (s, r) => {
    if (s !== 'Z') return r;
    const { g6: _v, ...verdicts } = r.verdicts;
    const { g6: _p, ...packetHashes } = r.packetHashes;
    return { ...r, verdicts, packetHashes };
  }));
  refused('ITEM_SET_MISMATCH', 'g7', () => gateMeasure(lenient, {}, (s, r) => (s === 'Z' ? { ...r, verdicts: { ...r.verdicts, g7: 'pass' }, packetHashes: { ...r.packetHashes, g7: sha256Hex('p') } } : r)));
  // The roster binds it by hash, and a missing file refuses.
  const { files, plan } = gateSetup(lenient);
  refused('HASH_MISMATCH', 'Y (reference)', () => judgeChangeRuns(files.filter((f) => f.name !== 'Y.ref.json'), barFile, plan));
  assert.throws(() => gateMeasure(lenient, {}, (s, r) => (s === 'X' ? { ...r, verdicts: { ...r.verdicts, g1: 'maybe' } } : r)), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARTIFACT' && e.problems.some((p) => p.startsWith('X.ref.json: reference.verdicts')));
  // A reference for every system, or for none.
  const some = gateSetup({ ...lenient, Z: { old: '000000', new: '111100' } }).plan;
  assert.ok(judgeChangePlanProblems(some).some((p) => p.includes('a reference for every system, or for none')));
});

test('referenceProblems: the file is closed, with no nulls, and a hash needs a stated basis', () => {
  const ok: ReferenceFile = { schema: REFERENCE_SCHEMA, verdictRule: 'two of three raters', verdicts: { a: 'pass', b: 'fail' }, packetHashes: { a: sha256Hex('a'), b: sha256Hex('b') }, packetBasis: 'recorded' };
  assert.deepEqual(referenceProblems(ok), []);
  const has = (x: unknown, fragment: string): void => assert.ok(referenceProblems(x).some((p) => p.includes(fragment)), `${fragment}: ${referenceProblems(x).join(' | ')}`);
  has({ ...ok, schema: 'anchorset.reference/v0' }, 'reference.schema');
  has({ ...ok, extra: 1 }, 'reference.extra: unknown field');
  has({ ...ok, verdicts: { a: 'pass', b: null } }, 'null is not allowed');
  has({ ...ok, verdicts: {} }, 'reference.verdicts');
  has({ ...ok, packetHashes: { a: sha256Hex('a') } }, 'cover exactly');
  has({ ...ok, packetHashes: { a: 'abc', b: sha256Hex('b') } }, 'reference.packetHashes');
  has({ ...ok, packetBasis: 'NO_JUDGE' }, 'reference.packetBasis');
  has({ ...ok, packetBasis: 'declared' }, 'reference.packetSource');
  has({ ...ok, packetSource: 'x' }, 'reference.packetSource');
  has({ ...ok, packetBasis: GAP }, 'say whether the hashes were recorded or declared');
  has([], 'must be an object');
});

const BEYOND = 'labels that differ between the judges, minus between two sets of one judge';
const resampling = (seed: number, iterations = 400): Partial<JudgeChangePlan> => ({ resampling: { iterations, seed, spreadFloor: 4 }, oneCasePerCluster: true });
// The spread's label under the library's seeded generator. A level is named only from the one floor of stats.ts (1,000
// resamples at these two percentiles), and only on a row defined on that many; with fewer, no row carries one.
const FEW_LABEL = (iterations: number): string => `spread over resamples of cases, the judge draws held fixed; its 2.5th and 97.5th percentiles: on every row they are percentiles over ${iterations} resamples of cases, the judge draws held fixed, with no level: a level is named from 1000 resamples on which the statistic is defined`;
const LEVELLED_LABEL = 'spread over resamples of cases, the judge draws held fixed; its 2.5th and 97.5th percentiles: on a share, a difference of shares, kappa or AC1 that was defined on at least 1000 of the resamples they are a percentile bootstrap interval over cases, the judge draws held fixed: nominal 95%, coverage not checked; on such a row defined on fewer, on a count of pairs by gate state, and on every map row, they are percentiles of the resamples and carry no level';
const spreadOfReport = (r: JudgeChangeReport): SpreadReport => {
  assert.ok(typeof r.spread === 'object' && !('withheld' in r.spread), JSON.stringify(r.spread));
  return r.spread;
};

// Pinned to an independent recomputation, the third kind of pin (after a published worked example and a hand-worked
// fixture): a second implementation written in this test. It shares the author's reading of the definition, so it
// checks the arithmetic and not the definition.
test('spread: whole cases are resampled jointly; the per-draw change matches an independent recomputation', () => {
  const sp = spreadOfReport(measure({}, resampling(7)));
  assert.deepEqual([sp.iterations, sp.draws, sp.unit, sp.label], [400, { seed: 7 }, 'cases', FEW_LABEL(400)]);
  assert.deepEqual(Object.keys(sp.quantities), ['per-draw pass rate change', 'label pass rate change', 'labels that differ between the judges', 'labels that differ between two sets of one judge', BEYOND]);
  // Per case, new minus old passing estimate draws, summed over the two systems: c1 0 − 3, c2 −2 + 0, c3 2 + 1, c4 −1 + 0.
  const d = [-3, -2, 3, -1];
  const rng = mulberry32(7);
  const byHand = Array.from({ length: 400 }, () => resampleIndices(rng, 4).reduce((s, k) => s + (d[k] as number), 0) / 24);
  const got = sp.quantities['per-draw pass rate change'];
  assert.deepEqual(got, { point: -0.125, ...spreadOf(-0.125, byHand) });
  assert.equal(got?.replicates, 400);
  assert.ok((got?.sd as number) > 0);
  // The same seed gives the same report; another seed does not.
  assert.deepEqual(spreadOfReport(measure({}, resampling(7))), sp);
  assert.notDeepEqual(spreadOfReport(measure({}, resampling(8))).quantities, sp.quantities);
});

test('spread: identical cases have none; pair counts are resampled too; a floor and supplied draws withhold it', () => {
  // Every case is the same, so every resample is the point.
  const flat = spreadOfReport(gateMeasure({ X: { old: '111111', new: '000000' }, Y: { old: '111111', new: '111111' } }, resampling(3, 200)));
  for (const [name, q] of Object.entries(flat.quantities)) assert.deepEqual([q.sd, q.p025, q.p50, q.p975, q.meanMinusPoint], [0, q.point, q.point, q.point, 0], name);
  assert.equal(flat.quantities['pairs passed by doing nothing only, minus by re-judging only']?.point, 0 - 1);
  const withRef = spreadOfReport(gateMeasure(lenient, resampling(3, 200)));
  assert.deepEqual(Object.keys(withRef.quantities).slice(-4), [
    'pairs passed by doing nothing only, minus by re-judging only',
    'pairs the reference gate does not pass',
    'of those, passed by doing nothing minus by re-judging',
    'of the pairs it passes, not passed by doing nothing minus by re-judging',
  ]);
  assert.deepEqual([4, 3, 3, -1], Object.values(withRef.quantities).slice(-4).map((q) => q.point));
  assert.ok(Object.values(withRef.quantities).every((q) => q.replicates === 200 && q.undefinedReplicates === 0));
  const floor = measure({}, { resampling: { iterations: 100, seed: 1, spreadFloor: 5 }, oneCasePerCluster: true });
  assert.deepEqual(floor.spread, { withheld: 'BELOW_SPREAD_FLOOR', detail: '4 cases, and the plan\'s spreadFloor is 5' });
  assert.equal(floor.blocks.resampling, 'withheld: BELOW_SPREAD_FLOOR');
  near(floor.perDrawPassRate.change, -0.125);
});

test('anchorset judge-change prints the gates, the reference and the spread; still no verdict and exit 0', () => {
  const { files, plan } = gateSetup(lenient, resampling(5, 300));
  const dir = mkdtempSync(join(tmp, 'gates-'));
  for (const f of files) writeFileSync(join(dir, f.name), f.bytes);
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(dir, 'bar.json'), JSON.stringify(barFile));
  const r = cli('judge-change', '--plan', join(dir, 'plan.json'), '--bar', join(dir, 'bar.json'), '--inputs', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pair gates on majority labels: tango-1998, margin 0\.1, nominal alpha 0\.05, critical value 1\.645, asymptotic · 6 cases per pair/);
  assert.match(r.stdout, /PASS: the statistic is above the nominal threshold: taken as showing the candidate no more than the margin worse/);
  assert.match(r.stdout, /INCONCLUSIVE: neither threshold is crossed; this does not say why/);
  assert.match(r.stdout, /no discordant pair passes: 25/);
  assert.match(r.stdout, /Y\s+Z\s+0\/2 1\.700 PASS\s+2\/0 -1\.128 INCONCLUSIVE\s+6\/0 -2\.216 REGRESSION/);
  assert.match(r.stdout, /pairs 6 · passed by doing nothing only 4 · by re-judging only 0 · by both 2 · net 4/);
  assert.match(r.stdout, /does not pass 3 pair\(s\): REGRESSION 1, INCONCLUSIVE 2/);
  assert.match(r.stdout, /Y -> Z {2}passed by doing nothing/);
  assert.match(r.stdout, /agreement with the reference · judge labels: majority · reference verdicts: the fixture's own pass mark · 18 items · the reference passes 0\.500 · packets equal as recorded:/);
  assert.match(r.stdout, /old judge {2}agrees on 13 \(0\.722\) · kappa 0\.444 \[-?\d\.\d{3}, \d\.\d{3}\] · AC1 0\.484 \[-?\d\.\d{3}, \d\.\d{3}\] · passes 0\.222/);
  assert.match(r.stdout, /new judge {2}agrees on 11 \(0\.611\) · kappa 0\.222 \[/);
  // 300 resamples are below the floor: the two percentiles are printed with no level, here and in the spread header.
  assert.ok(r.stdout.split('\n').includes('  brackets: percentiles over 300 resamples of cases, the judge draws held fixed, with no level: a level is named from 1000 resamples on which the statistic is defined (the 2.5th and 97.5th percentiles of the resamples)'), r.stdout);
  assert.doesNotMatch(r.stdout, /bootstrap interval|nominal 95%/);
  assert.match(r.stdout, /largest error rates found on the null boundary at this n, margin and alpha \(nuisance share on a grid of 0\.001, each by exact enumeration of the tables\): false PASS 0\.069 · false REGRESSION 0\.\d{3} \(nominal 0\.05\)/);
  assert.match(r.stdout, /mean-point\s+share <0 \/ =0 \/ >0\s+undefined/);
  assert.ok(r.stdout.split('\n').includes('spread over 300 resamples of cases (seed 5); the 2.5% and 97.5% columns: on every row they are percentiles over 300 resamples of cases, the judge draws held fixed, with no level: a level is named from 1000 resamples on which the statistic is defined'), r.stdout);
  // The note under the spread says what each kind of row holds fixed and leaves out; the level is the header's, on the rows it is true of.
  assert.ok(r.stdout.split('\n').includes('note: the spread describes resamples of cases with the judge draws and the reference verdicts held fixed; a map row refits its cuts on each resample, so its labels are not held fixed, and resamples on which the map is undefined or a cut is unidentified are left out of its rows; each quantity stands alone'), 'spread note');
  assert.doesNotMatch(r.stdout, /verdict: |Verdict|exit 1|confidence interval/);
});

// "Beyond re-asking" is defined by this library; no published reference is claimed. A hand-worked fixture for the
// point (the shares are counted in the comments below), and an independent recomputation for the resamples.
test('flips beyond re-asking, a hand-worked fixture: an exact tie is exactly 0, at the point and in every resample', () => {
  // One system, five cases. Majority labels: estimate old / new, re-ask old / new.
  //   g1 1/0, 0/1 · g2 1/0, 0/1 · g3 1/0, 1/1 · g4 1/1, 1/0 · g5 1/1, 1/1
  // Between the judges: g1, g2, g3 = 3/5. Within the old judge: g1, g2 = 2/5; within the new: g1, g2, g3, g4 = 4/5; mean 3/5.
  const five = gCases.slice(0, 5);
  const grade: Record<'old' | 'new', string[]> = { old: ['444222', '444222', '444444', '444444', '444444'], new: ['222444', '222444', '222444', '444222', '444444'] };
  const run = (side: 'old' | 'new'): RunArtifact => {
    const id = makeJudgedIdentity({ caseSetHash: caseSetHash(five), barHash: barHash(barFile), drawsPerCase: 6, ...(side === 'old' ? oldJudge : newJudge) });
    const draws = five.flatMap((c, k) => [...(grade[side][k] as string)].map((label, drawIndex): Draw => ({ caseId: c.id, drawIndex, attempts: [graded('S', c.id, label)] })));
    return { schema: RUN_SCHEMA, identity: id, callShapes: callShapesFor(id), cases: five, draws, packetBasis: 'recorded' };
  };
  const o = file('S.old.json', run('old'));
  const n = file('S.new.json', run('new'));
  const plan = { ...setup().plan, caseSetHash: caseSetHash(five), systems: { S: { old: shaOf(o), new: shaOf(n) } }, resampling: { iterations: 2000, seed: 1, spreadFloor: 2 }, oneCasePerCluster: true as const };
  const r = judgeChangeRuns([o, n], barFile, plan);
  assert.deepEqual([r.flips.acrossJudges, r.flips.withinJudge, r.flips.beyondReask], [0.6, 0.6, 0]);
  // Per case, 2·(differs between judges) − (differs within old) − (differs within new): 0, 0, 1, −1, 0, over 2 × 5.
  const c = [0, 0, 1, -1, 0];
  const rng = mulberry32(1);
  const byHand = Array.from({ length: 2000 }, () => resampleIndices(rng, 5).reduce((s, k) => s + (c[k] as number), 0) / 10);
  const got = spreadOfReport(r).quantities[BEYOND];
  assert.deepEqual(got, { point: 0, ...spreadOf(0, byHand) });
  assert.equal(got?.shareAt0, byHand.filter((x) => x === 0).length / 2000);
  assert.ok((got?.shareAt0 as number) > 0.2);
});

// Pinned to an independent recomputation, the third kind of pin (after a published worked example and a hand-worked
// fixture): a second implementation written in this test. It shares the author's reading of the definition, so it
// checks the arithmetic and not the definition.
test('spread: every resampled quantity matches an independent recomputation from the drawn indices', () => {
  const B = 150;
  const sp = spreadOfReport(gateMeasure(lenient, resampling(11, B)));
  // An independent implementation: expand the drawn cases into plain label strings and recount everything from scratch.
  const names = Object.keys(lenient);
  const pick = (bits: string, idx: readonly number[]): boolean[] => idx.map((k) => bits[k] === '1');
  const recompute = (idx: readonly number[]): Record<string, number> => {
    const L = names.map((s) => { const b = lenient[s] as { old: string; new: string; ref: string }; return { old: pick(b.old, idx), new: pick(b.new, idx), ref: pick(b.ref, idx) }; });
    const items = idx.length * names.length;
    const diff = (f: (l: (typeof L)[number]) => [boolean[], boolean[]]): number => L.reduce((s, l) => { const [x, y] = f(l); return s + x.filter((v, i) => v !== y[i]).length; }, 0);
    const passes = (f: (l: (typeof L)[number]) => boolean[]): number => L.reduce((s, l) => s + f(l).filter(Boolean).length, 0);
    const state = (x: boolean[], y: boolean[]): string => nonInferiority({ n: idx.length, n10: x.filter((v, i) => v && !y[i]).length, n01: x.filter((v, i) => !v && y[i]).length }, { margin: 0.1, alpha: 0.05 }).state;
    // Kappa and AC1 from the 2 × 2 table of a judge's labels against the reference, written out from their definitions.
    const table = (f: (l: (typeof L)[number]) => boolean[]): [number, number, number] => {
      const both = L.reduce((s, l) => s + f(l).filter((v, i) => v && l.ref[i]).length, 0);
      return [passes(f) / items, passes((l) => l.ref) / items, (both + (items - passes(f) - passes((l) => l.ref) + both)) / items];
    };
    const kappa = (f: (l: (typeof L)[number]) => boolean[]): number => {
      const [pj, pr, po] = table(f);
      const pe = pj * pr + (1 - pj) * (1 - pr);
      return pe === 1 ? Number.NaN : (po - pe) / (1 - pe);
    };
    const ac1 = (f: (l: (typeof L)[number]) => boolean[]): number => {
      const [pj, pr, po] = table(f);
      const pi = (pj + pr) / 2;
      const pe = 2 * pi * (1 - pi);
      return (po - pe) / (1 - pe);
    };
    let rOnly = 0, cOnly = 0, notPass = 0, eNotR = 0, eNotC = 0, notPassR = 0, notPassC = 0;
    for (const a of L) for (const b of L) {
      if (a === b) continue;
      const R = state(a.old, b.new) === 'PASS';
      const C = state(a.new, b.new) === 'PASS';
      const E = state(a.ref, b.ref) === 'PASS';
      if (R && !C) rOnly++;
      if (C && !R) cOnly++;
      if (!E) { notPass++; if (R) notPassR++; if (C) notPassC++; } else { if (!R) eNotR++; if (!C) eNotC++; }
    }
    return {
      'per-draw pass rate change': (3 * passes((l) => l.new) - 3 * passes((l) => l.old)) / (3 * items),
      'label pass rate change': (passes((l) => l.new) - passes((l) => l.old)) / items,
      'labels that differ between the judges': diff((l) => [l.old, l.new]) / items,
      // In this fixture the re-ask labels equal the estimate labels, so nothing differs within a judge.
      'labels that differ between two sets of one judge': 0,
      [BEYOND]: diff((l) => [l.old, l.new]) / items,
      'agreement with the reference, old judge': 1 - diff((l) => [l.old, l.ref]) / items,
      'agreement with the reference, new judge': 1 - diff((l) => [l.new, l.ref]) / items,
      'agreement with the reference, new minus old': (diff((l) => [l.old, l.ref]) - diff((l) => [l.new, l.ref])) / items,
      'kappa with the reference, old judge': kappa((l) => l.old),
      'kappa with the reference, new judge': kappa((l) => l.new),
      'AC1 with the reference, old judge': ac1((l) => l.old),
      'AC1 with the reference, new judge': ac1((l) => l.new),
      'pairs passed by doing nothing only, minus by re-judging only': rOnly - cOnly,
      'pairs the reference gate does not pass': notPass,
      'of those, passed by doing nothing minus by re-judging': notPassR - notPassC,
      'of the pairs it passes, not passed by doing nothing minus by re-judging': eNotR - eNotC,
    };
  };
  const rng = mulberry32(11);
  const reps = Array.from({ length: B }, () => recompute(resampleIndices(rng, 6)));
  const point = recompute([0, 1, 2, 3, 4, 5]);
  assert.deepEqual(Object.keys(sp.quantities), Object.keys(point));
  for (const name of Object.keys(point)) {
    const want = spreadOf(point[name] as number, reps.map((x) => x[name] as number));
    const got = sp.quantities[name] as (typeof sp.quantities)[string];
    near(got.point, point[name] as number);
    // Kappa and AC1 are ratios of floating-point shares: a value that is 0 in exact arithmetic can come out as
    // ±1e-17 in one order of operations and 0 in another, so their shares below, at and above 0 are not compared.
    const ratio = name.startsWith('kappa') || name.startsWith('AC1');
    for (const k of ['sd', 'p025', 'p50', 'p975', 'meanMinusPoint', ...(ratio ? [] : (['shareBelow0', 'shareAt0', 'shareAbove0'] as const))] as const) near(got[k], want[k] as number);
  }
  // The pair counts do move across resamples here, so the comparison above is not vacuous.
  assert.ok((sp.quantities['pairs the reference gate does not pass']?.sd as number) > 0);
  assert.ok((sp.quantities['of those, passed by doing nothing minus by re-judging']?.sd as number) > 0);
});

// ---- the recalibration map ----

// Three scored cases in each of two folds. The ids are found, not chosen, since the fold is a hash of the id.
const idsInFold = (fold: number, n: number, folds = 2, prefix = 'k'): string[] => Array.from({ length: 200 }, (_, i) => `${prefix}${i}`).filter((id) => foldOfCase(id, folds) === fold).slice(0, n);
const [ka, kb, kc] = idsInFold(0, 3) as [string, string, string];
const [kd, ke, kf] = idsInFold(1, 3) as [string, string, string];
const seeds20 = Array.from({ length: 20 }, (_, i) => i + 1);
const mapBlock = (over: Record<string, unknown> = {}): NonNullable<JudgeChangePlan['map']> =>
  ({ encoding: { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5 }, folds: 2, fitOnlyCaseIds: [], tieBreak: { seeds: seeds20 }, minSystems: 2, minFitItems: 2, maxTieShare: 0.5, ...over }) as NonNullable<JudgeChangePlan['map']>;

type MapGrades = Record<string, Record<string, { old: string; new: string; ref?: string }>>;
/** Runs from six-character grade strings per (system, case): draws 0-2 estimate, 3-5 re-ask. */
function mapSetup(grades: MapGrades, planOver: Partial<JudgeChangePlan> = {}, edit: (system: string, side: 'old' | 'new', draws: Draw[]) => Draw[] = (_s, _d, x) => x): { files: JudgeChangeInput[]; plan: JudgeChangePlan } {
  const ids = Object.keys(Object.values(grades)[0] as object);
  const mCases: Case[] = ids.map((id) => ({ id, klass: 'quality', input: { question: id }, expect: '4' }));
  const files: JudgeChangeInput[] = [];
  const systems: JudgeChangePlan['systems'] = {};
  const fitOnly = (planOver.map?.fitOnlyCaseIds ?? []) as string[];
  for (const [system, g] of Object.entries(grades)) {
    const run = (side: 'old' | 'new'): RunArtifact => {
      const id = makeJudgedIdentity({ caseSetHash: caseSetHash(mCases), barHash: barHash(barFile), drawsPerCase: 6, ...(side === 'old' ? oldJudge : newJudge), systemModelServed: `system-${system}` });
      const draws = mCases.flatMap((c) => [...(g[c.id]?.[side] as string)].map((label, drawIndex): Draw => ({ caseId: c.id, drawIndex, attempts: [graded(system, c.id, label)] })));
      return { schema: RUN_SCHEMA, identity: id, callShapes: callShapesFor(id), cases: mCases, draws: edit(system, side, draws), packetBasis: 'recorded' };
    };
    const o = file(`${system}.old.json`, run('old'));
    const n = file(`${system}.new.json`, run('new'));
    files.push(o, n);
    systems[system] = { old: shaOf(o), new: shaOf(n) };
    const scored = ids.filter((id) => !fitOnly.includes(id));
    if (scored.length > 0 && scored.every((id) => g[id]?.ref !== undefined)) {
      const ref: ReferenceFile = {
        schema: REFERENCE_SCHEMA,
        verdictRule: 'the fixture\'s own pass mark',
        verdicts: Object.fromEntries(scored.map((id) => [id, g[id]?.ref === '1' ? 'pass' : 'fail'])),
        packetHashes: Object.fromEntries(scored.map((id) => [id, sha256Hex(`packet ${system}:${id}`)])),
        packetBasis: 'recorded',
      };
      const r = file(`${system}.ref.json`, ref);
      files.push(r);
      systems[system] = { old: shaOf(o), new: shaOf(n), reference: shaOf(r) };
    }
  }
  return { files, plan: { ...setup().plan, caseSetHash: caseSetHash(mCases), systems, ...gateBlock, map: mapBlock(), ...planOver } };
}
const mapMeasure = (grades: MapGrades, planOver: Partial<JudgeChangePlan> = {}, edit?: (system: string, side: 'old' | 'new', draws: Draw[]) => Draw[]): JudgeChangeReport => {
  const { files, plan } = mapSetup(grades, planOver, edit);
  return judgeChangeRuns(files, barFile, plan);
};
const mapOf = (r: JudgeChangeReport): MapReport => {
  assert.ok(typeof r.map === 'object' && !('withheld' in r.map), JSON.stringify(r.map));
  return r.map;
};
// Both draw sets carry the same three grades, so a judge's re-ask labels equal its estimate labels.
const g3 = (old: string, neu: string, ref: string): { old: string; new: string; ref: string } => ({ old: old + old, new: neu + neu, ref });

// The sums of the three estimate grades are all distinct within a judge, so no label depends on the tie-break.
//             old grades (sum, majority)   new grades (sum, majority)
const mapFixture: MapGrades = {
  A: {
    [ka]: g3('555', '555', '1'), // 15, pass                 15, pass
    [kb]: g3('443', '444', '1'), // 11, pass                 12, pass
    [kc]: g3('333', '443', '0'), //  9, fail                 11, pass
    [kd]: g3('444', '554', '0'), // 12, pass                 14, pass
    [ke]: g3('332', '333', '0'), //  8, fail                  9, fail
    [kf]: g3('222', '223', '0'), //  6, fail                  7, fail
  },
  B: {
    [ka]: g3('433', '442', '1'), // 10, fail                 10, pass
    [kb]: g3('221', '332', '1'), //  5, fail                  8, fail
    [kc]: g3('111', '222', '0'), //  3, fail                  6, fail
    [kd]: g3('322', '445', '0'), //  7, fail                 13, pass
    [ke]: g3('211', '112', '0'), //  4, fail                  4, fail
    [kf]: g3('544', '111', '0'), // 13, pass                  3, fail
  },
};

test('recalibration map: the cuts, the mapped labels and the cut gates, worked by hand', () => {
  const r = mapMeasure(mapFixture);
  const m = mapOf(r);
  assert.deepEqual([m.folds, m.scoredCases, m.fitOnlyCases, m.tieBreak], [2, 6, 0, { seed: 1 }]);
  // Fold 0 (a, b, c) is fitted on fold 1's six items, of which the new judge's majority passes two (A/d, B/d).
  //   Old sums there: 13, 12, 8, 7, 6, 4 → the cut is 12. New sums there: 14, 13, 9, 7, 4, 3 → the cut is 13.
  // Fold 1 (d, e, f) is fitted on fold 0's six items, of which it passes four (A/a, A/b, A/c, B/a).
  //   Old sums there: 15, 11, 10, 9, 5, 3 → the cut is 9. New sums there: 15, 12, 11, 10, 8, 6 → the cut is 10.
  const cut = (f: { cut: unknown }): unknown => (typeof f.cut === 'object' && f.cut !== null ? (f.cut as { sum: number }).sum : f.cut);
  assert.deepEqual(m.cuts.recalibrated.map((f) => [f.fold, f.labelled, f.fit, f.target, f.achieved, cut(f)]), [[0, 6, 6, 2, 2, 12], [1, 6, 6, 4, 4, 9]]);
  assert.deepEqual(m.cuts.rejudged.map((f) => [f.fold, f.target, f.achieved, cut(f)]), [[0, 2, 2, 13], [1, 4, 4, 10]]);
  assert.deepEqual(m.tieShare, { recalibrated: 0, rejudged: 0 });
  // Recalibrated labels (old sum at or above the fold's cut): A 1 0 0 | 1 0 0, B 0 0 0 | 0 0 1.
  // Re-judged with the cut (new sum at or above):            A 1 0 0 | 1 0 0, B 0 0 0 | 1 0 0.
  // The new judge's majority labels:                          A 1 1 1 | 1 0 0, B 1 0 0 | 1 0 0.
  assert.deepEqual(m.perSystem, [
    { system: 'A', newJudgePasses: 4, recalibratedPasses: 2, rejudgedCutPasses: 2 },
    { system: 'B', newJudgePasses: 2, recalibratedPasses: 1, rejudgedCutPasses: 1 },
  ]);
  // The candidate is always the new judge's majority label. (worse, better) per pair:
  //   A>B recalibrated 100100 → 100100 (0, 0); re-judged with the cut 100100 → 100100 (0, 0).
  //   B>A recalibrated 000001 → 111100 (1, 4); re-judged with the cut 000100 → 111100 (0, 3).
  const counts = (g: { n10: number; n01: number; state: string }): unknown[] => [g.n10, g.n01, g.state];
  assert.deepEqual(m.pairs.map((p) => [p.baseline, p.candidate, counts(p.recalibrated), counts(p.rejudgedCut)]), [
    ['A', 'B', [0, 0, 'INCONCLUSIVE'], [0, 0, 'INCONCLUSIVE']],
    ['B', 'A', [1, 4, nonInferiority({ n: 6, n10: 1, n01: 4 }, { margin: 0.1, alpha: 0.05 }).state], [0, 3, 'PASS']],
  ]);
  assert.equal(m.pairs[1]?.recalibrated.state, 'INCONCLUSIVE');
  assert.deepEqual(m.counts, { pairs: 2, passRecalibratedOnly: 0, passRejudgedCutOnly: 1, passBoth: 0, net: -1 });
});

test('recalibration map: the counts against the reference, worked by hand', () => {
  const r = mapMeasure(mapFixture);
  const m = mapOf(r);
  const g = gateOf(r);
  // The reference passes a and b for both systems: A>B and B>A are both (0, 0), INCONCLUSIVE. Neither pair is passed by it.
  // Doing nothing: A>B old 110100 → new 100100 (1, 0) U; B>A old 000001 → new 111100 (1, 4) U. It passes neither.
  // Re-judged on majority labels: A>B 111100 → 100100 (2, 0) U; B>A 100100 → 111100 (0, 2) PASS.
  assert.deepEqual(g.pairs.map((p) => [p.reference?.state, p.doNothing.state, p.rejudged.state]), [['INCONCLUSIVE', 'INCONCLUSIVE', 'INCONCLUSIVE'], ['INCONCLUSIVE', 'INCONCLUSIVE', 'PASS']]);
  assert.deepEqual(m.reference, {
    passRecalibrated: 0,
    passRejudgedCut: 1, // B>A
    net: -1,
    onlyRecalibrated: 0,
    onlyRejudgedCut: 1,
    notPassedNet: 0, // the reference gate passes no pair
    doNothingMinusRejudgedCut: -1, // 0 − 1
    doNothingMinusRecalibrated: 0, // 0 − 0
    doNothingNotPassedNet: 0,
    rejudgedMajorityMinusCut: 0, // both pass B>A
    referenceRegressionPassed: [],
  });
  // The placebo maps each judge's re-ask set onto its own estimate set. The sets are equal here, so nothing moves.
  assert.deepEqual(m.placebo, { old: { net: 0, onlyReask: 0, onlyEstimate: 0, referenceNet: 0 }, new: { net: 0, onlyReask: 0, onlyEstimate: 0, referenceNet: 0 } });
  // No label depends on the tie-break, so the 20 seeds agree.
  assert.deepEqual(m.overTieBreakSeeds.seeds, seeds20);
  assert.deepEqual(m.overTieBreakSeeds.quantities['of the pairs the reference gate does not pass, passed by recalibrating minus by re-judging with the cut'], { min: -1, median: -1, max: -1, reported: -1, below: 0, equal: 20, above: 0 });
  // One reference-free count, three against the reference, and two placebo counts for each judge.
  assert.deepEqual(Object.keys(m.overTieBreakSeeds.quantities).length, 8);
  assert.equal(r.blocks.map, 'computed');
  assert.ok(r.notes.some((n) => n.includes('not a correction')));
});

test('recalibration map: a judge mapped onto itself gives the same gate twice', () => {
  // The old and the new run carry the same grades: recalibrating and re-judging with the cut are one operation.
  const same: MapGrades = Object.fromEntries(Object.entries(mapFixture).map(([s, g]) => [s, Object.fromEntries(Object.entries(g).map(([id, x]) => [id, { old: x.new, new: x.new, ref: x.ref as string }]))]));
  const m = mapOf(mapMeasure(same));
  assert.deepEqual(m.pairs.map((p) => p.recalibrated), m.pairs.map((p) => p.rejudgedCut));
  assert.deepEqual(m.counts, { pairs: 2, passRecalibratedOnly: 0, passRejudgedCutOnly: 0, passBoth: 1, net: 0 });
});

test('recalibration map: a fit-only case fits every cut and enters no estimand', () => {
  // A seventh case, fit-only, with a high old score that the new judge fails. It joins both fit sets.
  const fitId = idsInFold(0, 1, 2, 'fit')[0] as string;
  const withFit: MapGrades = { A: { ...mapFixture['A'], [fitId]: g3('555', '111', '0') }, B: { ...mapFixture['B'], [fitId]: g3('554', '111', '0') } };
  const r = mapMeasure(withFit, { map: mapBlock({ fitOnlyCaseIds: [fitId] }) });
  const m = mapOf(r);
  assert.deepEqual([m.scoredCases, m.fitOnlyCases, r.counts.cases, r.counts.items], [6, 1, 6, 12]);
  // The points do not see it: the same per-draw rates as without it.
  assert.deepEqual(r.perDrawPassRate, mapMeasure(mapFixture).perDrawPassRate);
  // Each fold is now fitted on eight items, and the targets are unchanged (two and four), since the new judge fails both
  // fit-only items. Their old sums, 15 and 14, are among the highest, so both cuts rise:
  //   fold 0: 15, 14, 13, 12, … → the second highest is 14 (it was 12);
  //   fold 1: 15, 15, 14, 11, 10, … → the fourth highest is 11 (it was 9).
  assert.deepEqual(m.cuts.recalibrated.map((f) => [f.fit, f.target, (f.cut as { sum: number }).sum]), [[8, 2, 14], [8, 4, 11]]);
  // The reference covers the scored cases only.
  assert.equal(agreementWith(r).items, 12);
  // A fit-only id that is not a case of the class, and a plan that leaves nothing to measure, are refused.
  refused('UNSUPPORTED_DESIGN', 'nope', () => mapMeasure(mapFixture, { map: mapBlock({ fitOnlyCaseIds: ['nope'] }) }));
  const noRef: MapGrades = Object.fromEntries(Object.entries(mapFixture).map(([sy, g]) => [sy, Object.fromEntries(Object.entries(g).map(([id, x]) => [id, { old: x.old, new: x.new }]))]));
  refused('UNSUPPORTED_DESIGN', 'map.fitOnlyCaseIds', () => mapMeasure(noRef, { map: mapBlock({ fitOnlyCaseIds: [ka, kb, kc, kd, ke, kf] }) }));
  // Without a reference the map still reports its reference-free counts.
  assert.equal(mapOf(mapMeasure(noRef)).reference, 'not declared');
});

test('recalibration map: equal sums are split by the keyed tie-break, and too many ties withhold it', () => {
  // Every old sum is 9, so the old judge's labels under the cut are decided by the tie-break alone.
  const flat: MapGrades = Object.fromEntries(Object.entries(mapFixture).map(([s, g]) => [s, Object.fromEntries(Object.entries(g).map(([id, x]) => [id, { old: '333333', new: x.new, ref: x.ref as string }]))]));
  const withheld = mapMeasure(flat);
  assert.ok(typeof withheld.map === 'object' && 'withheld' in withheld.map && withheld.map.withheld === 'MAP_NOT_IDENTIFIED' && withheld.map.detail.includes('1 distinct value'), JSON.stringify(withheld.map));
  // Two distinct sums in fold... three distinct sums overall, with ties at the cut.
  const tied: MapGrades = { A: { ...flat['A'], [ka]: g3('555', '555', '1'), [kf]: g3('111', '223', '0') }, B: { ...flat['B'] } } as MapGrades;
  const r = mapMeasure(tied, { map: mapBlock({ maxTieShare: 1 }) });
  const m = mapOf(r);
  // Fold 0's cut is fitted on fold 1 (old sums 9, 9, 3, 9, 9, 9; target two): the cut has sum 9, and its
  // tie-break is the second highest among fold 1's five items of sum 9.
  const us = [['A', kd], ['A', ke], ['B', kd], ['B', ke], ['B', kf]].map(([s, id]) => tieBreakU(1, 'old', 'estimate', s as string, id as string)).sort((x, y) => y - x);
  assert.deepEqual(m.cuts.recalibrated[0]?.cut, { sum: 9, u: us[1] });
  // In fold 0, A/a (15) passes outright; the five items of sum 9 pass only with a tie-break at or above the cut's.
  const fold0 = [['A', kb], ['A', kc], ['B', ka], ['B', kb], ['B', kc]].filter(([s, id]) => tieBreakU(1, 'old', 'estimate', s as string, id as string) >= (us[1] as number)).length;
  assert.equal(m.cuts.recalibrated[0]?.decidedByTieBreak, 5);
  assert.ok(m.tieShare.recalibrated > 0.5);
  const passesFold0 = (m.perSystem[0]?.recalibratedPasses ?? 0) + (m.perSystem[1]?.recalibratedPasses ?? 0);
  assert.ok(passesFold0 >= 1 + fold0);
  // Above the plan's maxTieShare the map is withheld, and the rest of the report stands.
  const strict = mapMeasure(tied, { map: mapBlock({ maxTieShare: 0.1 }) });
  assert.ok(typeof strict.map === 'object' && 'withheld' in strict.map && strict.map.detail.includes('maxTieShare'));
  assert.equal(strict.blocks.map, 'withheld: MAP_NOT_IDENTIFIED');
  assert.equal(strict.blocks.gate, 'computed');
});

test('recalibration map: each reason it is not identified, and the design refusals', () => {
  const why = (r: JudgeChangeReport): string => {
    assert.ok(typeof r.map === 'object' && 'withheld' in r.map, JSON.stringify(r.map).slice(0, 200));
    return `${r.map.withheld}: ${r.map.detail}`;
  };
  assert.match(why(mapMeasure(mapFixture, { map: mapBlock({ minSystems: 3 }) })), /MAP_NOT_IDENTIFIED: 2 systems, and the plan's minSystems is 3/);
  assert.match(why(mapMeasure(mapFixture, { map: mapBlock({ minFitItems: 7 }) })), /fold 0: 6 fit items, and the plan's minFitItems is 7/);
  // The new judge passes nothing in fold 1, so fold 0's target is 0; and everything in fold 0, so fold 1's target is every item.
  const split: MapGrades = Object.fromEntries(Object.entries(mapFixture).map(([s, g]) => [s, Object.fromEntries(Object.entries(g).map(([id, x]) => [id, { old: x.old, new: [ka, kb, kc].includes(id) ? '555555' : '111111', ref: x.ref as string }]))]));
  assert.match(why(mapMeasure(split)), /fold 0: the target passes no fit item.*fold 1: the target passes every fit item/);
  // A failed attempt has no score to sum.
  const failed = mapMeasure(mapFixture, {}, (system, _side, draws) => (system === 'A' ? draws.map((d) => (d.caseId === kb ? { ...d, attempts: [failedAttempt('system-error')] } : d)) : draws));
  assert.match(why(failed), new RegExp(`a failed attempt has no score: A/${kb}`));
  // Two scored cases in one fold and none in the other: the first fold has nothing to fit on.
  const [p, q] = idsInFold(0, 2, 2, 'z') as [string, string];
  const oneFold: MapGrades = { A: { [p]: g3('555', '555', '1'), [q]: g3('222', '333', '0') }, B: { [p]: g3('443', '444', '1'), [q]: g3('111', '222', '0') } };
  assert.match(why(mapMeasure(oneFold)), /recalibrated, fold 0: nothing to fit on/);
  // One system has no pair for the map to feed; supplied tie-break draws are not built yet.
  const one = mapMeasure({ A: mapFixture['A'] as MapGrades[string] }, { map: mapBlock({ minSystems: 1 }) });
  assert.deepEqual(one.map, { withheld: 'NO_PAIRS', detail: 'the map feeds the pair gates, and the roster has one system' });
  refused('HASH_MISMATCH', 'the supplied tie-break draws', () => mapMeasure(mapFixture, { map: mapBlock({ tieBreak: { suppliedSha256: hashOf('u'), seeds: seeds20 } }) }));
  // The encoding must cover the bar's labels exactly, and rise with them.
  refused('UNSUPPORTED_DESIGN', 'map.encoding', () => mapMeasure(mapFixture, { map: mapBlock({ encoding: { '1': 1, '2': 2, '3': 3, '4': 4 } }) }));
  refused('UNSUPPORTED_DESIGN', 'map.encoding', () => mapMeasure(mapFixture, { map: mapBlock({ encoding: { '1': 1, '2': 2, '3': 3, '4': 3, '5': 5 } }) }));
  // Withheld map rows never take the points or the majority gates with them.
  near(mapMeasure(mapFixture, { map: mapBlock({ minSystems: 3 }) }).perDrawPassRate.change, mapMeasure(mapFixture).perDrawPassRate.change);
});

// Pinned to an independent recomputation, the third kind of pin (after a published worked example and a hand-worked
// fixture): a second implementation written in this test. It shares the author's reading of the definition, so it
// checks the arithmetic and not the definition.
test('recalibration map: every resampled count matches an independent brute-force recomputation', () => {
  const B = 120;
  const sp = spreadOfReport(mapMeasure(mapFixture, { ...resampling(21, B) }));
  // An independent implementation: expand the drawn cases, refit every cut by scanning candidate cuts, and recount.
  const ids = [ka, kb, kc, kd, ke, kf];
  const sys = ['A', 'B'];
  const enc = (s: string): number => [...s.slice(0, 3)].reduce((a, c) => a + Number(c), 0);
  const maj = (s: string): boolean => [...s.slice(0, 3)].filter((c) => Number(c) >= 4).length >= 2;
  type Item = { s: string; k: number; sum: Record<string, number>; u: Record<string, number>; maj: Record<string, boolean>; ref: boolean };
  const item = (s: string, k: number): Item => {
    const g = mapFixture[s]?.[ids[k] as string] as { old: string; new: string; ref: string };
    const sums: Record<string, number> = {};
    const us: Record<string, number> = {};
    for (const j of ['old', 'new'] as const) for (const set of ['estimate', 'reask'] as const) { sums[`${j}.${set}`] = enc(g[j]); us[`${j}.${set}`] = tieBreakU(1, j, set, s, ids[k] as string); }
    return { s, k, sum: sums, u: us, maj: { old: maj(g.old), new: maj(g.new) }, ref: g.ref === '1' };
  };
  const state = (x: boolean[], y: boolean[]): string => nonInferiority({ n: x.length, n10: x.filter((v, i) => v && !y[i]).length, n01: x.filter((v, i) => !v && y[i]).length }, { margin: 0.1, alpha: 0.05 }).state;
  const recompute = (idx: readonly number[]): Record<string, number> => {
    const drawn = idx.map((k) => ({ k, fold: foldOfCase(ids[k] as string, 2) }));
    // labels[source][system] over the drawn cases, in drawn order; undefined when a needed fold has nothing to fit on.
    const cutLabels = (source: string, target: 'old' | 'new'): Record<string, boolean[]> | undefined => {
      const out: Record<string, boolean[]> = { A: [], B: [] };
      for (const d of drawn) {
        const fitItems = drawn.filter((x) => x.fold !== d.fold).flatMap((x) => sys.map((s) => item(s, x.k)));
        if (fitItems.length === 0) return undefined;
        const want = fitItems.filter((x) => x.maj[target]).length;
        // A cut whose target passes no fit item, or every one, is not identified: the resample is excluded, as at the point.
        if (want === 0 || want === fitItems.length) return undefined;
        const ge = (a: Item, b: Item): boolean => (a.sum[source] as number) > (b.sum[source] as number) || (a.sum[source] === b.sum[source] && (a.u[source] as number) >= (b.u[source] as number));
        const candidates = fitItems.filter((c) => fitItems.filter((x) => ge(x, c)).length >= want);
        const cut = want === 0 ? undefined : candidates.reduce((best, c) => (ge(c, best) ? c : best));
        for (const s of sys) (out[s] as boolean[]).push(cut === undefined ? false : ge(item(s, d.k), cut));
      }
      return out;
    };
    const lab = (f: (i: Item) => boolean): Record<string, boolean[]> => Object.fromEntries(sys.map((s) => [s, drawn.map((d) => f(item(s, d.k)))]));
    const [oldM, newM, ref] = [lab((i) => i.maj['old'] as boolean), lab((i) => i.maj['new'] as boolean), lab((i) => i.ref)];
    const pairs = [['A', 'B'], ['B', 'A']] as const;
    const net = (x: Record<string, boolean[]> | undefined, y: Record<string, boolean[]> | undefined, cand: Record<string, boolean[]>, among: 'all' | 'notPassedByReference'): number => {
      if (x === undefined || y === undefined) return Number.NaN;
      let n = 0;
      for (const [a, b] of pairs) {
        if (among === 'notPassedByReference' && state(ref[a] as boolean[], ref[b] as boolean[]) === 'PASS') continue;
        const X = state(x[a] as boolean[], cand[b] as boolean[]) === 'PASS';
        const Y = state(y[a] as boolean[], cand[b] as boolean[]) === 'PASS';
        n += Number(X && !Y) - Number(!X && Y);
      }
      return n;
    };
    const N = cutLabels('old.estimate', 'new');
    const C = cutLabels('new.estimate', 'new');
    const defined = N !== undefined && C !== undefined;
    return {
      'pairs passed by recalibrating only, minus by re-judging with the cut only': net(N, C, newM, 'all'),
      'of the pairs the reference gate does not pass, passed by recalibrating minus by re-judging with the cut': net(N, C, newM, 'notPassedByReference'),
      'of those, passed by doing nothing minus by re-judging with the cut': defined ? net(oldM, C, newM, 'notPassedByReference') : Number.NaN,
      'of those, passed by doing nothing minus by recalibrating': defined ? net(oldM, N, newM, 'notPassedByReference') : Number.NaN,
      'placebo, old judge: pairs passed from the re-ask set only, minus from the estimate set only': net(cutLabels('old.reask', 'old'), cutLabels('old.estimate', 'old'), oldM, 'all'),
      'placebo, old judge: the same among pairs the reference gate does not pass': net(cutLabels('old.reask', 'old'), cutLabels('old.estimate', 'old'), oldM, 'notPassedByReference'),
      'placebo, new judge: pairs passed from the re-ask set only, minus from the estimate set only': net(cutLabels('new.reask', 'new'), C, newM, 'all'),
      'placebo, new judge: the same among pairs the reference gate does not pass': net(cutLabels('new.reask', 'new'), C, newM, 'notPassedByReference'),
    };
  };
  const rng = mulberry32(21);
  const reps = Array.from({ length: B }, () => recompute(resampleIndices(rng, 6)));
  const point = recompute([0, 1, 2, 3, 4, 5].map((k) => ids.indexOf([...ids].sort()[k] as string)));
  for (const name of Object.keys(point)) {
    const got = sp.quantities[name];
    assert.ok(got !== undefined, `missing ${name}`);
    const want = spreadOf(point[name] as number, reps.map((x) => x[name] as number));
    assert.equal(got.point, point[name], name);
    assert.equal(got.undefinedReplicates, want.undefinedReplicates, name);
    for (const k of ['sd', 'p025', 'p50', 'p975', 'meanMinusPoint', 'shareBelow0', 'shareAt0', 'shareAbove0'] as const) near(got[k], want[k] as number);
  }
  // Some resamples leave a fold with nothing to fit on, or a cut that is not identified: they are excluded and counted, never dropped silently.
  assert.ok((sp.quantities['pairs passed by recalibrating only, minus by re-judging with the cut only']?.undefinedReplicates as number) > 0);
  assert.ok((sp.quantities['of those, passed by doing nothing minus by re-judging with the cut']?.sd as number) > 0);
});

test('anchorset judge-change prints the map: cuts, mapped passes, counts, placebo and the seeds', () => {
  const { files, plan } = mapSetup(mapFixture);
  const dir = mkdtempSync(join(tmp, 'map-'));
  for (const f of files) writeFileSync(join(dir, f.name), f.bytes);
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(dir, 'bar.json'), JSON.stringify(barFile));
  const r = cli('judge-change', '--plan', join(dir, 'plan.json'), '--bar', join(dir, 'bar.json'), '--inputs', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /recalibration map, a measured option and not a correction: 2 folds · 6 scored cases · 0 fit-only · tie-break seed 1/);
  assert.match(r.stdout, /fold 0: recalibrated \(sum, tie-break\) >= \(12, 0\.\d{4}\) \(target 2 of 6 fit items, at or above 2\) · re-judged \(sum, tie-break\) >= \(13, 0\.\d{4}\) \(target 2 of 6, at or above 2\)/);
  assert.match(r.stdout, /assumed, not checked: only the judge's severity moved/);
  assert.match(r.stdout, /A\s+passes: new judge, majority 4 · recalibrated 2 · re-judged with the cut 2/);
  assert.match(r.stdout, /pairs 2 · passed by recalibrating only 0 · by re-judging with the cut only 1 · by both 0 · net -1/);
  assert.match(r.stdout, /old judge: passed from the re-ask set only 0 · from the estimate set only 0 · net 0 · net among pairs the reference gate does not pass 0/);
  assert.match(r.stdout, /what the tie-break alone moves, across the 20 seeds 1, 2, 3, .*20 \(min \/ median \/ max; then the value reported above, and how many seeds gave less, the same and more\):/);
  // Every row says where the reported value sits, and its three counts cover the 20 seeds.
  const seedRows = [...r.stdout.matchAll(/ {2}reported (-?\d+): (\d+) below, (\d+) equal, (\d+) above/g)];
  assert.ok(seedRows.length >= 1);
  for (const row of seedRows) assert.equal(Number(row[2]) + Number(row[3]) + Number(row[4]), 20, row[0]);
  assert.doesNotMatch(r.stdout, /verdict: |Verdict|exit 1|corrected/);
});

// ---- supplied draws ----

test('supplied tie-break draws: the keyed values, supplied as a file, give the same map', () => {
  const seeded = mapMeasure(mapFixture, { ...resampling(9, 60) });
  const { files, plan } = mapSetup(mapFixture, { ...resampling(9, 60) });
  const ids = [ka, kb, kc, kd, ke, kf];
  const u = (judge: 'old' | 'new', set: 'estimate' | 'reask') => Object.fromEntries(['A', 'B'].map((s) => [s, Object.fromEntries(ids.map((id) => [id, tieBreakU(1, judge, set, s, id)]))]));
  const tie = file('tie.json', { schema: TIE_BREAK_SCHEMA, u: { old: { estimate: u('old', 'estimate'), reask: u('old', 'reask') }, new: { estimate: u('new', 'estimate'), reask: u('new', 'reask') } } });
  const withTie = (f: JudgeChangeInput): JudgeChangePlan => ({ ...plan, map: { ...mapBlock(), tieBreak: { suppliedSha256: shaOf(f), seeds: seeds20 } } });
  const r = judgeChangeRuns([...files, tie], barFile, withTie(tie));
  const [a, b] = [mapOf(seeded), mapOf(r)];
  assert.deepEqual(b.tieBreak, { suppliedSha256: shaOf(tie) });
  // The supplied stream gives the point; the plan's seeds still give the table of what the tie-break alone moves.
  assert.deepEqual(b.overTieBreakSeeds, a.overTieBreakSeeds);
  assert.deepEqual({ ...b, tieBreak: a.tieBreak }, a);
  assert.deepEqual(r.spread, seeded.spread);
  // The file must cover every item the map reads, and its values lie in [0, 1).
  const short = file('tie.json', { schema: TIE_BREAK_SCHEMA, u: { old: { estimate: u('old', 'estimate') }, new: { estimate: u('new', 'estimate') } } });
  refused('ITEM_SET_MISMATCH', `old.reask.A.${ka}`, () => judgeChangeRuns([...files, short], barFile, withTie(short)));
  const bad = file('tie.json', { schema: TIE_BREAK_SCHEMA, u: { old: { estimate: { A: { [ka]: 1 } } }, new: { estimate: {} } } });
  assert.throws(() => judgeChangeRuns([...files, bad], barFile, withTie(bad)), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARTIFACT' && e.problems.some((p) => p.startsWith('tie.json: tieBreak.u.old.estimate')));
  assert.ok(tieBreakProblems({ schema: 'x', u: {} }).length >= 3);
  // A file that gives a key twice is not read: here the draws of the old judge come twice, the file's own last.
  const text = new TextDecoder().decode(tie.bytes);
  const twice = { name: 'tie.json', bytes: new TextEncoder().encode(text.replace('"u":{', '"u":{"old":{},')) };
  assert.deepEqual(JSON.parse(new TextDecoder().decode(twice.bytes)), JSON.parse(text));
  assert.throws(() => judgeChangeRuns([...files, twice], barFile, withTie(twice)), (e: unknown) => {
    assert.ok(e instanceof InputError && e.code === 'INVALID_ARTIFACT', String(e));
    assert.deepEqual(e.problems, ['tie.json: the key "old" is given twice in the object at /u']);
    return true;
  });
});

test("supplied resample indices: the generator's own rows, supplied as a file, give the same spread", () => {
  // A fit-only case, so that both strata are drawn: scored first, then fit-only, in each resample.
  const fitId = idsInFold(0, 1, 2, 'fit')[0] as string;
  const withFit: MapGrades = { A: { ...mapFixture['A'], [fitId]: g3('555', '111', '0') }, B: { ...mapFixture['B'], [fitId]: g3('554', '111', '0') } };
  const block = { map: mapBlock({ fitOnlyCaseIds: [fitId] }) };
  const seeded = mapMeasure(withFit, { ...block, ...resampling(13, 80) });
  const rng = mulberry32(13);
  const scored: number[][] = [];
  const fitOnly: number[][] = [];
  for (let i = 0; i < 80; i++) {
    scored.push(resampleIndices(rng, 6));
    fitOnly.push(resampleIndices(rng, 1));
  }
  const rows = file('indices.json', { schema: RESAMPLE_SCHEMA, scored, fitOnly });
  const { files, plan } = mapSetup(withFit, block);
  const supplied = (f: JudgeChangeInput): JudgeChangePlan => ({ ...plan, resampling: { suppliedSha256: shaOf(f), spreadFloor: 4 }, oneCasePerCluster: true });
  const r = judgeChangeRuns([...files, rows], barFile, supplied(rows));
  const [a, b] = [spreadOfReport(seeded), spreadOfReport(r)];
  assert.deepEqual(b.draws, { suppliedSha256: shaOf(rows) });
  assert.deepEqual([b.iterations, b.quantities], [80, a.quantities]);
  // Rows that do not fit the cases are refused, never truncated or wrapped.
  const wrong = file('indices.json', { schema: RESAMPLE_SCHEMA, scored: scored.map((row) => row.slice(0, 5)), fitOnly });
  refused('ITEM_SET_MISMATCH', 'scored', () => judgeChangeRuns([...files, wrong], barFile, supplied(wrong)));
  const noFit = file('indices.json', { schema: RESAMPLE_SCHEMA, scored, fitOnly: [] });
  refused('ITEM_SET_MISMATCH', 'fitOnly', () => judgeChangeRuns([...files, noFit], barFile, supplied(noFit)));
  const high = file('indices.json', { schema: RESAMPLE_SCHEMA, scored: scored.map((row) => row.map(() => 6)), fitOnly });
  refused('ITEM_SET_MISMATCH', 'scored', () => judgeChangeRuns([...files, high], barFile, supplied(high)));
  assert.ok(resampleProblems({ schema: RESAMPLE_SCHEMA, scored: scored.slice(0, 40), fitOnly: [] }).some((p) => p.includes('at least 41')));
  assert.ok(resampleProblems({ schema: RESAMPLE_SCHEMA, scored: [[0.5]], fitOnly: [] }).some((p) => p.includes('resample.scored')));
  // A file that gives a key twice is not read: here "fitOnly" comes twice, the file's own rows last.
  const text = new TextDecoder().decode(rows.bytes);
  const twice = { name: 'indices.json', bytes: new TextEncoder().encode(text.replace(/^\{/, '{"fitOnly":[],')) };
  assert.deepEqual(JSON.parse(new TextDecoder().decode(twice.bytes)), JSON.parse(text));
  assert.throws(() => judgeChangeRuns([...files, twice], barFile, supplied(twice)), (e: unknown) => {
    assert.ok(e instanceof InputError && e.code === 'INVALID_ARTIFACT', String(e));
    assert.deepEqual(e.problems, ['indices.json: the key "fitOnly" is given twice in the top-level object']);
    return true;
  });
});

test('judge retries: a fit-only case is in the run-file count and not in the scored one, since it enters no number', () => {
  // Six scored cases and one fit-only case, six draws each: 36 scored slots, 42 slot records. One judge retry on the fit-only case.
  const fitId = idsInFold(0, 1, 2, 'fit')[0] as string;
  const withFit: MapGrades = { A: { ...mapFixture['A'], [fitId]: g3('555', '111', '0') }, B: { ...mapFixture['B'], [fitId]: g3('554', '111', '0') } };
  const edit = (system: string, side: 'old' | 'new', draws: Draw[]): Draw[] =>
    system === 'A' && side === 'new' ? onSlot(fitId, 0, (a) => [unmeasuredJudge(a, 'timeout'), a])(draws) : draws;
  const r = mapMeasure(withFit, { map: mapBlock({ fitOnlyCaseIds: [fitId] }) }, edit);
  assert.equal(r.counts.fitOnlyCases, 1);
  const anew = r.inputs.find((f) => f.system === 'A' && f.role === 'new-judge');
  assert.deepEqual([anew?.judgeRetriesScored, anew?.judgeRetries], [none(36), { slotsWithRetry: 1, slots: 42, earlierAttemptsByReason: [{ reason: 'timeout', attempts: 1 }] }]);
});

// ---- the whole map against an independent implementation, on a fixture where everything moves ----

/**
 * Four systems, twelve scored cases and three fit-only cases in three folds, with re-ask grades that differ from the
 * estimate grades. Three systems differ clearly in quality; the fourth is one the reference rates high and both judges
 * rate low, so that a gate can pass a pair the reference gate calls REGRESSION. Grades come from the seeded generator,
 * so each fixture is fixed.
 */
function richFixture(seed: number): { grades: MapGrades; scored: string[]; fit: string[] } {
  const rng = mulberry32(seed);
  const pick = (fold: number, n: number, prefix: string): string[] => idsInFold(fold, n, 3, prefix);
  const scored = [...pick(0, 4, 'r'), ...pick(1, 4, 'r'), ...pick(2, 4, 'r')].sort();
  const fit = idsInFold(0, 3, 3, 'w').sort();
  const clamp = (x: number): number => Math.max(1, Math.min(5, Math.round(x)));
  const six = (centre: number): string => Array.from({ length: 6 }, () => clamp(centre + (rng() - 0.5) * 2.2)).join('');
  const quality: Record<string, number> = { S1: 4.3, S2: 3.6, S3: 2.6, S4: 2.3 };
  const grades: MapGrades = {};
  for (const [system, q] of Object.entries(quality)) {
    grades[system] = {};
    for (const id of [...scored, ...fit]) {
      const item = q + (rng() - 0.5) * 1.6;
      // The new judge is more lenient by about half a point.
      (grades[system] as MapGrades[string])[id] = { old: six(item), new: six(item + 0.5), ref: (system === 'S4' ? item + 2.2 : item) + (rng() - 0.5) * 0.8 >= 3.5 ? '1' : '0' };
    }
  }
  return { grades, scored, fit };
}

/** Everything the map reports, recomputed by brute force from the grade strings, the drawn cases and a tie-break. */
function bruteMap(fx: ReturnType<typeof richFixture>, u: (judge: 'old' | 'new', set: 'estimate' | 'reask', system: string, id: string) => number, drawnScored: readonly string[], drawnFit: readonly string[]) {
  const sys = Object.keys(fx.grades);
  const g = (s: string, id: string) => fx.grades[s]?.[id] as { old: string; new: string; ref: string };
  const part = (str: string, set: 'estimate' | 'reask'): number[] => [...(set === 'estimate' ? str.slice(0, 3) : str.slice(3))].map(Number);
  const sum = (j: 'old' | 'new', set: 'estimate' | 'reask', s: string, id: string): number => part(g(s, id)[j], set).reduce((a, b) => a + b, 0);
  const maj = (j: 'old' | 'new', s: string, id: string): boolean => part(g(s, id)[j], 'estimate').filter((x) => x >= 4).length >= 2;
  const ge = (a: [number, number], b: [number, number]): boolean => a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1]);
  const fold = (id: string): number => foldOfCase(id, 3);
  type Cut = { labels: Record<string, boolean[]>; cutSums: Record<number, number | string>; tie: number; flat: boolean } | undefined;
  const cut = (j: 'old' | 'new', set: 'estimate' | 'reask', target: 'old' | 'new'): Cut => {
    const key = (s: string, id: string): [number, number] => [sum(j, set, s, id), u(j, set, s, id)];
    const labels: Record<string, boolean[]> = Object.fromEntries(sys.map((s) => [s, []]));
    const cutSums: Record<number, number | string> = {};
    let tied = 0;
    let flat = false;
    const cache = new Map<number, [number, number] | 'none'>();
    for (const id of drawnScored) {
      const f = fold(id);
      if (!cache.has(f)) {
        const fitItems = [...drawnScored.filter((x) => fold(x) !== f), ...drawnFit].flatMap((x) => sys.map((s) => ({ k: key(s, x), pass: maj(target, s, x) })));
        if (fitItems.length === 0) return undefined;
        const want = fitItems.filter((x) => x.pass).length;
        if (want === 0 || want === fitItems.length) flat = true;
        const ok = fitItems.filter((c) => fitItems.filter((x) => ge(x.k, c.k)).length >= want).map((c) => c.k);
        cache.set(f, want === 0 ? 'none' : ok.reduce((best, c) => (ge(c, best) ? c : best)));
        cutSums[f] = want === 0 ? 'ALL_FAIL' : (cache.get(f) as [number, number])[0];
      }
      const c = cache.get(f) as [number, number] | 'none';
      for (const s of sys) {
        (labels[s] as boolean[]).push(c === 'none' ? false : ge(key(s, id), c));
        if (c !== 'none' && key(s, id)[0] === c[0]) tied++;
      }
    }
    return { labels, cutSums, tie: tied / (drawnScored.length * sys.length), flat };
  };
  const lab = (f: (s: string, id: string) => boolean): Record<string, boolean[]> => Object.fromEntries(sys.map((s) => [s, drawnScored.map((id) => f(s, id))]));
  const [oldM, newM, ref] = [lab((s, id) => maj('old', s, id)), lab((s, id) => maj('new', s, id)), lab((s, id) => g(s, id).ref === '1')];
  const pairs = sys.flatMap((a) => sys.filter((b) => b !== a).map((b): [string, string] => [a, b]));
  const st = (x: boolean[], y: boolean[]): string => nonInferiority({ n: x.length, n10: x.filter((v, i) => v && !y[i]).length, n01: x.filter((v, i) => !v && y[i]).length }, { margin: 0.1, alpha: 0.05 }).state;
  const E = pairs.map(([a, b]) => st(ref[a] as boolean[], ref[b] as boolean[]));
  const gate = (x: Record<string, boolean[]>, cand: Record<string, boolean[]>): boolean[] => pairs.map(([a, b]) => st(x[a] as boolean[], cand[b] as boolean[]) === 'PASS');
  const n = (f: (i: number) => boolean): number => pairs.filter((_, i) => f(i)).length;
  const N = cut('old', 'estimate', 'new');
  const C = cut('new', 'estimate', 'new');
  if (N === undefined || C === undefined) return undefined;
  const [gN, gC, gR, gM] = [gate(N.labels, newM), gate(C.labels, newM), gate(oldM, newM), gate(newM, newM)];
  const notE = (i: number): boolean => E[i] !== 'PASS';
  const placeboFlat: Record<'old' | 'new', boolean> = { old: false, new: false };
  const placebo = (j: 'old' | 'new') => {
    const moved = cut(j, 'reask', j);
    const own = j === 'new' ? C : cut('old', 'estimate', 'old');
    if (moved === undefined || own === undefined) return undefined;
    placeboFlat[j] = moved.flat || own.flat;
    const cand = j === 'new' ? newM : oldM;
    const [x, y] = [gate(moved.labels, cand), gate(own.labels, cand)];
    const onlyReask = n((i) => (x[i] as boolean) && !y[i]);
    const onlyEstimate = n((i) => !x[i] && (y[i] as boolean));
    return { net: onlyReask - onlyEstimate, onlyReask, onlyEstimate, referenceNet: n((i) => notE(i) && (x[i] as boolean) && !y[i]) - n((i) => notE(i) && !x[i] && (y[i] as boolean)) };
  };
  return {
    flat: N.flat || C.flat,
    cuts: { recalibrated: N.cutSums, rejudged: C.cutSums },
    tieShare: { recalibrated: N.tie, rejudged: C.tie },
    passes: sys.map((s) => [newM[s]?.filter(Boolean).length, N.labels[s]?.filter(Boolean).length, C.labels[s]?.filter(Boolean).length]),
    counts: { pairs: pairs.length, passRecalibratedOnly: n((i) => (gN[i] as boolean) && !gC[i]), passRejudgedCutOnly: n((i) => !gN[i] && (gC[i] as boolean)), passBoth: n((i) => (gN[i] as boolean) && (gC[i] as boolean)) },
    reference: {
      passRecalibrated: n((i) => notE(i) && (gN[i] as boolean)),
      passRejudgedCut: n((i) => notE(i) && (gC[i] as boolean)),
      net: n((i) => notE(i) && (gN[i] as boolean)) - n((i) => notE(i) && (gC[i] as boolean)),
      onlyRecalibrated: n((i) => notE(i) && (gN[i] as boolean) && !gC[i]),
      onlyRejudgedCut: n((i) => notE(i) && !gN[i] && (gC[i] as boolean)),
      notPassedNet: n((i) => !notE(i) && !gN[i]) - n((i) => !notE(i) && !gC[i]),
      doNothingMinusRejudgedCut: n((i) => notE(i) && (gR[i] as boolean)) - n((i) => notE(i) && (gC[i] as boolean)),
      doNothingMinusRecalibrated: n((i) => notE(i) && (gR[i] as boolean)) - n((i) => notE(i) && (gN[i] as boolean)),
      doNothingNotPassedNet: n((i) => !notE(i) && !gR[i]) - n((i) => !notE(i) && !gC[i]),
      rejudgedMajorityMinusCut: n((i) => notE(i) && (gM[i] as boolean)) - n((i) => notE(i) && (gC[i] as boolean)),
      referenceRegressionPassed: pairs.flatMap(([a, b], i) => {
        const passedBy = [...(gN[i] ? ['recalibrated'] : []), ...(gC[i] ? ['rejudgedCut'] : [])];
        return E[i] === 'REGRESSION' && passedBy.length > 0 ? [{ baseline: a, candidate: b, passedBy }] : [];
      }),
    },
    E,
    placebo: { old: placebo('old'), new: placebo('new') },
    placeboFlat,
  };
}
const bruteNames = (b: NonNullable<ReturnType<typeof bruteMap>>): Record<string, number> => ({
  'pairs passed by recalibrating only, minus by re-judging with the cut only': b.counts.passRecalibratedOnly - b.counts.passRejudgedCutOnly,
  'of the pairs the reference gate does not pass, passed by recalibrating minus by re-judging with the cut': b.reference.net,
  'of those, passed by doing nothing minus by re-judging with the cut': b.reference.doNothingMinusRejudgedCut,
  'of those, passed by doing nothing minus by recalibrating': b.reference.doNothingMinusRecalibrated,
  'placebo, old judge: pairs passed from the re-ask set only, minus from the estimate set only': b.placebo.old?.net ?? Number.NaN,
  'placebo, old judge: the same among pairs the reference gate does not pass': b.placebo.old?.referenceNet ?? Number.NaN,
  'placebo, new judge: pairs passed from the re-ask set only, minus from the estimate set only': b.placebo.new?.net ?? Number.NaN,
  'placebo, new judge: the same among pairs the reference gate does not pass': b.placebo.new?.referenceNet ?? Number.NaN,
});
// Chosen by search so that every path is exercised; the first test below asserts that it still is.
const RICH_SEED = 104;

const richPlan = (fx: ReturnType<typeof richFixture>, more: Partial<JudgeChangePlan> = {}): Partial<JudgeChangePlan> => ({
  map: mapBlock({ folds: 3, fitOnlyCaseIds: fx.fit, minFitItems: 2, maxTieShare: 1, minSystems: 2 }),
  ...more,
});

// Pinned to an independent recomputation, the third kind of pin (after a published worked example and a hand-worked
// fixture): a second implementation written in this test. It shares the author's reading of the definition, so it
// checks the arithmetic and not the definition.
test('recalibration map: every reported field matches a brute-force implementation, on a fixture where everything moves', () => {
  const fx = richFixture(RICH_SEED);
  const r = mapMeasure(fx.grades, richPlan(fx));
  const m = mapOf(r);
  const b = bruteMap(fx, (j, set, s, id) => tieBreakU(1, j, set, s, id), fx.scored, fx.fit) as NonNullable<ReturnType<typeof bruteMap>>;
  // The fixture is rich enough to tell wrong implementations apart: the reference gate passes a pair and calls one
  // REGRESSION, a cut gate passes a REGRESSION pair, both placebos move, and the tie-break decides labels.
  const rich = {
    states: b.E.includes('PASS') && b.E.includes('REGRESSION') && b.E.includes('INCONCLUSIVE'),
    regressionPassed: b.reference.referenceRegressionPassed.length > 0,
    mirror: b.reference.notPassedNet !== 0 || b.reference.doNothingNotPassedNet !== 0,
    majorityMinusCut: b.reference.rejudgedMajorityMinusCut !== 0,
    net: b.reference.net !== 0 && b.reference.doNothingMinusRecalibrated !== 0,
    placeboOld: (b.placebo.old?.onlyReask ?? 0) + (b.placebo.old?.onlyEstimate ?? 0) > 0,
    placeboNew: (b.placebo.new?.onlyReask ?? 0) + (b.placebo.new?.onlyEstimate ?? 0) > 0,
    ties: b.tieShare.recalibrated > 0 && b.tieShare.rejudged > 0,
  };
  assert.deepEqual(rich, { states: true, regressionPassed: true, mirror: true, majorityMinusCut: true, net: true, placeboOld: true, placeboNew: true, ties: true });

  assert.deepEqual([m.scoredCases, m.fitOnlyCases, m.folds], [12, 3, 3]);
  const sums = (cuts: typeof m.cuts.recalibrated): Record<number, number | string> => Object.fromEntries(cuts.map((f) => [f.fold, typeof f.cut === 'string' ? f.cut : f.cut.sum]));
  assert.deepEqual({ recalibrated: sums(m.cuts.recalibrated), rejudged: sums(m.cuts.rejudged) }, b.cuts);
  assert.deepEqual(m.tieShare, b.tieShare);
  assert.deepEqual(m.perSystem.map((s) => [s.newJudgePasses, s.recalibratedPasses, s.rejudgedCutPasses]), b.passes);
  assert.deepEqual(m.counts, { ...b.counts, net: b.counts.passRecalibratedOnly - b.counts.passRejudgedCutOnly });
  assert.deepEqual(m.reference, b.reference);
  assert.deepEqual(m.placebo, b.placebo);
  assert.deepEqual(gateOf(r).pairs.map((p) => p.reference?.state), b.E);

  // Across the tie-break seeds: each seed recomputed from scratch, and they do not all agree.
  const perSeed = seeds20.map((seed) => bruteNames(bruteMap(fx, (j, set, s, id) => tieBreakU(seed, j, set, s, id), fx.scored, fx.fit) as NonNullable<ReturnType<typeof bruteMap>>));
  for (const [name, got] of Object.entries(m.overTieBreakSeeds.quantities)) {
    const xs = perSeed.map((q) => q[name] as number).sort((x, y) => x - y);
    // Where the reported value sits: the report prints the first seed's numbers, so each seed is counted against that one.
    // An independent recomputation: it checks the counting, and shares this reading of "the reported value".
    const reported = (perSeed[0] as Record<string, number>)[name] as number;
    const side = (f: (x: number) => boolean): number => xs.filter(f).length;
    assert.deepEqual(got, { min: xs[0], median: ((xs[9] as number) + (xs[10] as number)) / 2, max: xs[19], reported, below: side((x) => x < reported), equal: side((x) => x === reported), above: side((x) => x > reported) }, name);
    assert.equal(got.below + got.equal + got.above, 20, name);
    assert.ok(got.equal >= 1, name);
  }
  assert.equal(Object.keys(m.overTieBreakSeeds.quantities).length, 8);
  assert.ok(Object.values(m.overTieBreakSeeds.quantities).some((q) => q.min < q.max));
  assert.ok(Object.values(m.overTieBreakSeeds.quantities).some((q) => q.median !== q.max));
  // On this fixture the reported seed is not in the middle of every row: some seeds give less and some give more.
  assert.ok(Object.values(m.overTieBreakSeeds.quantities).some((q) => q.below > 0 || q.above > 0));
});

// Pinned to an independent recomputation, the third kind of pin (after a published worked example and a hand-worked
// fixture): a second implementation written in this test. It shares the author's reading of the definition, so it
// checks the arithmetic and not the definition.
test('recalibration map: resampling draws the scored cases, then the fit-only cases, and every count is recomputed (an independent recomputation)', () => {
  const fx = richFixture(RICH_SEED);
  const B = 150;
  const sp = spreadOfReport(mapMeasure(fx.grades, richPlan(fx, resampling(31, B))));
  const rng = mulberry32(31);
  const u = (j: 'old' | 'new', set: 'estimate' | 'reask', s: string, id: string): number => tieBreakU(1, j, set, s, id);
  const reps: Record<string, number>[] = [];
  let undefinedN = 0;
  let unidentified = 0;
  for (let i = 0; i < B; i++) {
    const drawnScored = resampleIndices(rng, 12).map((k) => fx.scored[k] as string);
    const drawnFit = resampleIndices(rng, 3).map((k) => fx.fit[k] as string);
    const b = bruteMap(fx, u, drawnScored, drawnFit);
    if (b === undefined) undefinedN++;
    else if (b.flat) unidentified++;
    const names = bruteNames(bruteMap(fx, u, fx.scored, fx.fit) as NonNullable<ReturnType<typeof bruteMap>>);
    const q = b === undefined ? Object.fromEntries(Object.keys(names).map((k) => [k, Number.NaN])) : bruteNames(b);
    // The map's own rows are excluded when one of its cuts is not identified; a placebo's rows when one of its own is not.
    if (b !== undefined) {
      for (const k of Object.keys(q)) {
        const judge = (['old', 'new'] as const).find((j) => k.startsWith(`placebo, ${j} judge`));
        if (judge === undefined ? b.flat : b.placeboFlat[judge]) q[k] = Number.NaN;
      }
    }
    reps.push(q);
  }
  const point = bruteNames(bruteMap(fx, u, fx.scored, fx.fit) as NonNullable<ReturnType<typeof bruteMap>>);
  for (const name of Object.keys(point)) {
    const got = sp.quantities[name];
    assert.ok(got !== undefined, `missing ${name}`);
    const want = spreadOf(point[name] as number, reps.map((x) => x[name] as number));
    assert.equal(got.point, point[name], name);
    assert.equal(got.undefinedReplicates, want.undefinedReplicates, name);
    for (const k of ['sd', 'p025', 'p50', 'p975', 'meanMinusPoint', 'shareBelow0', 'shareAt0', 'shareAbove0'] as const) near(got[k], want[k] as number);
  }
  assert.deepEqual(sp.map, { undefinedResamples: undefinedN, unidentifiedCutResamples: unidentified });
  // The fit-only stratum matters: with it left unresampled, at least one count would have another spread.
  assert.ok(Object.values(sp.quantities).filter((q) => (q.sd as number) > 0).length >= 8);
});

test('recalibration map: a placebo whose own cut is not identified is withheld alone, and leaves no row behind', () => {
  // The old judge passes everything, so its placebo's target passes every fit item; the map itself is fine.
  const allPass: MapGrades = Object.fromEntries(Object.entries(mapFixture).map(([s, g]) => [s, Object.fromEntries(Object.entries(g).map(([id, x], i) => [id, { old: ['555555', '554554', '545545', '455455', '445445', '544544'][i] as string, new: x.new, ref: x.ref as string }]))]));
  const r = mapMeasure(allPass, resampling(3, 60));
  const m = mapOf(r);
  assert.ok(typeof m.placebo === 'object' && 'withheld' in m.placebo.old && m.placebo.old.detail.includes('the target passes every fit item'), JSON.stringify(m.placebo));
  assert.ok(typeof m.placebo === 'object' && !('withheld' in m.placebo.new));
  const leaked = (names: string[]): string[] => names.filter((k) => k.startsWith('placebo, old judge'));
  assert.deepEqual(leaked(Object.keys(m.overTieBreakSeeds.quantities)), []);
  assert.deepEqual(leaked(Object.keys(spreadOfReport(r).quantities)), []);
  assert.equal(Object.keys(m.overTieBreakSeeds.quantities).filter((k) => k.startsWith('placebo, new judge')).length, 2);
});

// ---- later additions ----

test('the report says whether equal packets were recorded or declared, and how reference verdicts were derived', () => {
  const r = gateMeasure(lenient);
  assert.deepEqual(r.packetEquality, { judges: 'observed', reference: 'observed' });
  assert.equal(agreementWith(r).verdictRule, "the fixture's own pass mark");
  // A declared reference packet makes the equality one by declaration, on every row that rests on it.
  const declared = gateMeasure(lenient, {}, (_s, ref) => ({ ...ref, packetBasis: 'declared', packetSource: 'the dataset paper, section 3' }));
  assert.deepEqual(declared.packetEquality, { judges: 'observed', reference: 'by declaration' });
  assert.deepEqual(measure().packetEquality, { judges: 'observed', reference: 'not declared' });
  const declaredRun = (system: string, side: 'old' | 'new'): RunArtifact => makeRun(system, side, {}, (d) => d, { packetBasis: 'declared', packetSource: 'the harness documentation' });
  assert.equal(measure({ Aold: declaredRun('A', 'old') }).packetEquality.judges, 'by declaration');
  // References that derive their verdicts differently are not pooled; a reference with no rule is invalid.
  refused('UNSUPPORTED_DESIGN', 'verdictRule', () => gateMeasure(lenient, {}, (sys, ref) => (sys === 'Z' ? { ...ref, verdictRule: 'any one rater' } : ref)));
  assert.ok(referenceProblems({ schema: REFERENCE_SCHEMA, verdicts: { a: 'pass' }, packetHashes: { a: sha256Hex('a') }, packetBasis: 'recorded' }).some((p) => p.includes('reference.verdictRule')));
});

test('agreement gets the 2.5th and 97.5th percentiles over resamples with a resampling block, named as the spread table names them, and says so without one', () => {
  const without = gateMeasure(lenient);
  assert.equal(agreementWith(without).spread, 'not declared');
  const r = gateMeasure(lenient, resampling(4, 200));
  const iv = agreementWith(r).spread;
  assert.ok(iv !== 'not declared');
  const q = spreadOfReport(r).quantities;
  assert.deepEqual(iv.old.kappa, [q['kappa with the reference, old judge']?.p025, q['kappa with the reference, old judge']?.p975]);
  assert.deepEqual(iv.new.ac1, [q['AC1 with the reference, new judge']?.p025, q['AC1 with the reference, new judge']?.p975]);
  assert.ok((iv.old.kappa[0] as number) <= (agreementWith(r).old.kappa as number) && (agreementWith(r).old.kappa as number) <= (iv.old.kappa[1] as number));
  // The JSON says what the two numbers are, in the spread table's own words: percentiles, never a level.
  assert.deepEqual(Object.keys(iv), ['percentiles', 'label', 'old', 'new']);
  assert.deepEqual([iv.percentiles, iv.label], [[2.5, 97.5], spreadOfReport(r).label]);
  assert.equal(iv.label, FEW_LABEL(200));
  assert.doesNotMatch(JSON.stringify(r), /"level"|"interval"/);
});

// The floor is the one in stats.ts (a convention of this library: 1,000 resamples at these two percentiles). 999 is the
// last count with no level and 1,000 the first with one; the plan's own minimum of 41 only lets the spread be computed.
test('the spread and the agreement brackets are named "nominal 95%" only from 1,000 resamples; from 41 to 999 they are percentiles with no level, in the JSON and in the text', () => {
  for (const iterations of [41, 200, 999]) {
    const r = gateMeasure(lenient, resampling(4, iterations));
    assert.equal(spreadOfReport(r).label, FEW_LABEL(iterations));
    const iv = agreementWith(r).spread;
    assert.ok(iv !== 'not declared' && iv.label === FEW_LABEL(iterations));
    assert.doesNotMatch(JSON.stringify(r), /nominal 95%|bootstrap interval/, String(iterations));
  }
  for (const iterations of [1000, 2000]) {
    const r = gateMeasure(lenient, resampling(4, iterations));
    assert.equal(spreadOfReport(r).label, LEVELLED_LABEL);
    const iv = agreementWith(r).spread;
    assert.ok(iv !== 'not declared' && iv.label === LEVELLED_LABEL);
  }
  const text = (iterations: number): string => {
    const { files, plan } = gateSetup(lenient, resampling(5, iterations));
    const dir = mkdtempSync(join(tmp, `level-${iterations}-`));
    for (const f of files) writeFileSync(join(dir, f.name), f.bytes);
    writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
    writeFileSync(join(dir, 'bar.json'), JSON.stringify(barFile));
    const r = cli('judge-change', '--plan', join(dir, 'plan.json'), '--bar', join(dir, 'bar.json'), '--inputs', dir);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const few = text(999).split('\n');
  assert.ok(few.includes('  brackets: percentiles over 999 resamples of cases, the judge draws held fixed, with no level: a level is named from 1000 resamples on which the statistic is defined (the 2.5th and 97.5th percentiles of the resamples)'), few.join('\n'));
  assert.ok(few.includes('spread over 999 resamples of cases (seed 5); the 2.5% and 97.5% columns: on every row they are percentiles over 999 resamples of cases, the judge draws held fixed, with no level: a level is named from 1000 resamples on which the statistic is defined'), few.join('\n'));
  assert.doesNotMatch(few.join('\n'), /nominal 95%|bootstrap interval/);
  const enough = text(1000).split('\n');
  assert.ok(enough.includes('  brackets: a percentile bootstrap interval over cases, the judge draws held fixed: nominal 95%, coverage not checked (the 2.5th and 97.5th percentiles of the resamples)'), enough.join('\n'));
  assert.ok(enough.includes('spread over 1000 resamples of cases (seed 5); the 2.5% and 97.5% columns: on a share, a difference of shares, kappa or AC1 that was defined on at least 1000 of the resamples they are a percentile bootstrap interval over cases, the judge draws held fixed: nominal 95%, coverage not checked; on such a row defined on fewer, on a count of pairs by gate state, and on every map row, they are percentiles of the resamples and carry no level'), enough.join('\n'));
});

// The example plan is the one a reader copies: it asks for 2,000 resamples, so its brackets carry their level.
test('the judge-change example plan asks for 2,000 resamples, above the floor from which a level is named', () => {
  const plan = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'examples', 'judge-change', 'plan.json'), 'utf8')) as { resampling: { iterations: number } };
  assert.equal(plan.resampling.iterations, 2000);
});

// Supplied index rows are checked for length and range, not for how they were drawn: no row of the
// spread, and no bracket on kappa or AC1, is then called a bootstrap interval or given a level.
const SUPPLIED_LABEL = 'spread over the supplied resamples of cases, the judge draws held fixed; on every row its 2.5th and 97.5th percentiles are percentiles over the supplied resamples of cases, with no level: the resamples were checked for length and range, not for how they were drawn';
const suppliedIndices = (): { files: JudgeChangeInput[]; plan: JudgeChangePlan; seededPlan: JudgeChangePlan } => {
  const { files, plan } = gateSetup(lenient, resampling(4, 60));
  const rng = mulberry32(4);
  const rows = file('indices.json', { schema: RESAMPLE_SCHEMA, scored: Array.from({ length: 60 }, () => resampleIndices(rng, 6)), fitOnly: [] });
  return { files: [...files, rows], plan: { ...plan, resampling: { suppliedSha256: shaOf(rows), spreadFloor: 4 } }, seededPlan: plan };
};

test('supplied resample indices are not called a bootstrap: the spread and the agreement brackets say percentiles over the supplied resamples, with no level', () => {
  const { files, plan, seededPlan } = suppliedIndices();
  const r = judgeChangeRuns(files, barFile, plan);
  assert.equal(spreadOfReport(r).label, SUPPLIED_LABEL);
  const iv = agreementWith(r).spread;
  assert.ok(iv !== 'not declared');
  assert.equal(iv.label, SUPPLIED_LABEL);
  assert.doesNotMatch(SUPPLIED_LABEL, /bootstrap|nominal|95%/);
  // Under the library's own generator the label is the seeded one: with 60 resamples, percentiles with no level.
  const seeded = judgeChangeRuns(files.filter((f) => f.name !== 'indices.json'), barFile, seededPlan);
  assert.equal(spreadOfReport(seeded).label, FEW_LABEL(60));
});

test('anchorset judge-change: under supplied resample indices the spread header and the agreement brackets name no bootstrap and no level', () => {
  const { files, plan } = suppliedIndices();
  const dir = mkdtempSync(join(tmp, 'supplied-'));
  for (const f of files) writeFileSync(join(dir, f.name), f.bytes);
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(dir, 'bar.json'), JSON.stringify(barFile));
  const r = cli('judge-change', '--plan', join(dir, 'plan.json'), '--bar', join(dir, 'bar.json'), '--inputs', dir);
  assert.equal(r.status, 0, r.stderr);
  const sha = shaOf(files.find((f) => f.name === 'indices.json') as JudgeChangeInput);
  const lines = r.stdout.split('\n');
  assert.ok(lines.includes(`spread over 60 supplied resamples of cases (supplied indices ${sha.slice(0, 12)}…); on every row the 2.5% and 97.5% columns are percentiles over the supplied resamples of cases, with no level: the resamples were checked for length and range, not for how they were drawn`), r.stdout);
  assert.ok(lines.includes('  brackets: percentiles over the supplied resamples of cases, with no level: the resamples were checked for length and range, not for how they were drawn (the 2.5th and 97.5th percentiles of the resamples)'), r.stdout);
  assert.doesNotMatch(r.stdout, /bootstrap|nominal 95%/);
});

test('the gate header carries the largest error rates found on the null boundary at its own n, margin and alpha', () => {
  const g = gateOf(gateMeasure(lenient));
  // n = 6: the tables that pass are "nobody worse and two or more better", and "one worse and five better".
  assert.deepEqual(g.nominalCheck, nominalLevelCheck(6, { margin: 0.1, alpha: 0.05 }));
  assert.ok((g.nominalCheck.falsePass as number) > 0.05);
});

test('stored-outputs exception: under the opt-in, a stop known and different, or outputs that differ between the runs, still refuse', () => {
  const optIn = { storedOutputs: 'system-side-not-compared' } as const;
  refused('HASH_MISMATCH', 'systemOutcome[c2#1]', () => measure({ Anew: makeRun('A', 'new', {}, onSlot('c2', 1, (a) => [{ ...a, systemStop: 'refusal' } as Attempt])) }, optIn));
  refused('HASH_MISMATCH', 'outputHash[c2#1]', () => measure({ Anew: makeRun('A', 'new', {}, onSlot('c2', 1, (a) => [{ ...a, outputHash: sha256Hex('another output') } as Attempt])) }, optIn));
  // One stop per case holds for both runs, whichever run is read.
  const stop = onSlot('c2', 1, (a) => [{ ...a, systemStop: 'refusal' } as Attempt]);
  refused('HASH_MISMATCH', 'A/c2', () => measure({ Aold: makeRun('A', 'old', {}, stop), Anew: makeRun('A', 'new', {}, stop) }, optIn));
});

test('with a map, the counts say which cases are scored and which only fit', () => {
  const fitId = idsInFold(0, 1, 2, 'fit')[0] as string;
  const withFit: MapGrades = { A: { ...mapFixture['A'], [fitId]: g3('555', '111', '0') }, B: { ...mapFixture['B'], [fitId]: g3('554', '111', '0') } };
  const r = mapMeasure(withFit, { map: mapBlock({ fitOnlyCaseIds: [fitId] }) });
  assert.deepEqual(r.counts, { systems: 2, cases: 6, fitOnlyCases: 1, items: 12, drawsPerSet: 3 });
  assert.deepEqual(mapOf(r).limits, { minSystems: 2, minFitItems: 2, maxTieShare: 0.5 });
});

// ---- the ledger record of a report ----

/** A file's bytes, as a caller that read it from disk holds them. The record is built from bytes, never from a hash someone states. */
const bytesOf = (json: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(json, null, 2)}\n`);
const BAR_BYTES = bytesOf(barFile);
const BAR_FILE = sha256Hex(BAR_BYTES);
const AT = new Date('2026-01-02T03:04:05.000Z');
const ledgerRecord = (planOver: Partial<JudgeChangePlan> = {}): { record: JudgeChangeLedgerRecord; plan: JudgeChangePlan; report: JudgeChangeReport } => {
  const { files, plan } = setup({}, planOver);
  const report = judgeChangeRuns(files, barFile, plan);
  return { record: makeJudgeChangeRecord({ planFile: bytesOf(plan), barFile: BAR_BYTES, report, at: AT }), plan, report };
};
/** The canonical order of a record's files: by role, in the order of the one role list, then by sha256. */
const ROLE_ORDER = ['plan', 'bar', 'run', 'reference', 'tie-break', 'resample-indices'];
const inOrder = <T extends { role: string; sha256: string }>(files: readonly T[]): T[] => [...files].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || (a.sha256 < b.sha256 ? -1 : 1));
/** The record with its binding edited and the binding's hash recomputed, so that only the edit itself can be refused. */
const rebound = (r: JudgeChangeLedgerRecord, edit: (m: JudgeChangeBinding) => unknown): Record<string, unknown> => {
  const measurement = edit(structuredClone(r.measurement));
  return { ...r, measurement, inputsHash: hashOf(measurement) };
};
/** The record with its result edited and the result's hash recomputed. */
const reresult = (r: JudgeChangeLedgerRecord, over: Record<string, unknown>): Record<string, unknown> => {
  const result = { ...r.result, ...over };
  return { ...r, result, resultHash: hashOf(result) };
};
const problemsOf = (x: unknown, fragment: string): void => assert.ok(validateRecord(x).some((p) => p.includes(fragment)), `${fragment}: ${validateRecord(x).join(' | ') || 'no problem found'}`);

test('judgeChangeRuns validates the bar it is handed: a bar without knownFailures is invalid input before anything is measured', () => {
  const unparsed = { labels: barFile.labels, classes: barFile.classes } as unknown as BarFile;
  assert.throws(() => judgeChangeRuns([], unparsed, {} as JudgeChangePlan), (e: unknown) => e instanceof InputError && e.code === 'INVALID_BAR');
});

test('ledger: a judge-change record carries the plan hash, every input file by sha256, the seeds and the report, and reads back', () => {
  const { record, plan, report } = ledgerRecord(resampling(7, 60));
  assert.deepEqual(validateRecord(record), []);
  assert.equal(record.schema, 'anchorset.ledger/v3');
  assert.equal(record.kind, 'judge-change');
  assert.equal(record.at, '2026-01-02T03:04:05.000Z');
  assert.equal(record.measurement.planHash, hashOf(plan));
  assert.equal(record.measurement.planHash, report.planHash);
  // One plan, one bar, and the roster: four runs here. Sorted by role (plan, bar, run, ...), then by hash.
  // The plan and the bar are named by the sha256 of the bytes the builder was given.
  const runs = [plan.systems['A']?.old, plan.systems['A']?.new, plan.systems['B']?.old, plan.systems['B']?.new].sort();
  assert.deepEqual(record.measurement.files, [{ role: 'plan', sha256: sha256Hex(bytesOf(plan)) }, { role: 'bar', sha256: BAR_FILE }, ...runs.map((sha256) => ({ role: 'run', sha256 }))]);
  assert.deepEqual(record.measurement.seeds, { resampling: { seed: 7 }, tieBreak: 'not declared' });
  // The result is the report itself, so a reader holding the inputs recomputes the report and compares one hash.
  assert.deepEqual(record.result, report);
  assert.equal(record.resultHash, hashOf(report));
  assert.equal(record.inputsHash, hashOf(record.measurement));
  assert.deepEqual(record.tool, report.tool);
  assert.ok(!('identity' in record));
  const path = join(tmp, 'record', 'ledger.jsonl');
  const position = appendRecord(path, record);
  assert.deepEqual(position, { line: 1, recordHash: hashOf(record) });
  assert.equal(readFileSync(path, 'utf8'), `${canonicalJson(record)}\n`);
  assert.deepEqual(readLedger(path), [record]);
  // One ledger: a gate record and a judge-change record sit in the same file.
  const gate = makeGateRecord({ inputs: gateInputs(), result: { exitCode: 0 }, at: AT });
  assert.deepEqual(appendRecord(path, gate), { line: 2, recordHash: hashOf(gate) });
  assert.deepEqual(readLedger(path).map((r) => r.kind), ['judge-change', 'gate']);
  // Without a resampling block or a map, both seeds say so; neither is ever null or absent.
  assert.deepEqual(ledgerRecord().record.measurement.seeds, { resampling: 'not declared', tieBreak: 'not declared' });
});

test('ledger: a judge-change record with a missing or short hash is refused', () => {
  const { record } = ledgerRecord();
  const short = 'a1b2c3d4e5f6';
  problemsOf({ ...record, resultHash: short }, 'record.resultHash: must be a full sha256 hex');
  problemsOf({ ...record, inputsHash: short }, 'record.inputsHash: must be a full sha256 hex');
  problemsOf(rebound(record, (m) => ({ ...m, planHash: short })), 'record.measurement.planHash: must be a full sha256');
  problemsOf(rebound(record, (m) => ({ files: m.files, seeds: m.seeds })), 'record.measurement.planHash: must be a full sha256');
  problemsOf(rebound(record, (m) => ({ ...m, files: m.files.map((f, i) => (i === 2 ? { ...f, sha256: f.sha256.slice(0, 12) } : f)) })), 'record.measurement.files[2].sha256: must be the full sha256 of the file');
  problemsOf(rebound(record, (m) => ({ ...m, files: m.files.map((f, i) => (i === 2 ? { role: f.role } : f)) })), 'record.measurement.files[2].sha256: must be the full sha256 of the file');
  problemsOf(rebound(record, (m) => ({ ...m, files: m.files.map((f, i) => (i === 0 ? { ...f, sha256: GAP } : f)) })), 'record.measurement.files[0].sha256');
  const { measurement: _m, ...bare } = record;
  problemsOf(bare, 'record.measurement: must be { planHash, files, seeds }');
  const { resultHash: _r, ...unhashed } = record;
  problemsOf(unhashed, 'record.resultHash');
  assert.throws(() => appendRecord(join(tmp, 'short', 'ledger.jsonl'), { ...record, resultHash: short }), (e: unknown) => e instanceof InputError && e.code === 'INVALID_LEDGER');
  assert.throws(() => readFileSync(join(tmp, 'short', 'ledger.jsonl')), /ENOENT/);
});

test('ledger: a tampered result, binding or tool in a judge-change record is refused', () => {
  const { record } = ledgerRecord();
  // The result against its hash, and the binding against its hash.
  problemsOf({ ...record, result: { ...record.result, perDrawPassRate: { old: 0.9, new: 0.9, change: 0 } } }, 'record.resultHash: does not match hashOf(result)');
  problemsOf({ ...record, measurement: { ...record.measurement, planHash: sha256Hex('another plan') } }, 'record.inputsHash: does not match hashOf(measurement)');
  // With both hashes recomputed, the record must still agree with the report it carries.
  problemsOf(rebound(record, (m) => ({ ...m, planHash: sha256Hex('another plan') })), 'record.measurement.planHash: differs from result.planHash');
  problemsOf(reresult(record, { planHash: sha256Hex('another plan') }), 'record.measurement.planHash: differs from result.planHash');
  problemsOf(reresult(record, { tool: { name: 'anchorset', version: '9.9.9' } }), 'record.tool: differs from result.tool');
  problemsOf(reresult(record, { kind: 'verdict' }), 'record.result.kind: must be "measurement"');
  problemsOf(reresult(record, { inputs: (record.result['inputs'] as unknown[]).slice(1) }), 'record.measurement.files: the run files must be exactly the runs of result.inputs');
  problemsOf(reresult(record, { inputs: 'none' }), 'record.result.inputs');
  problemsOf(reresult(record, { notes: [null] }), 'null is not allowed');
});

test('ledger: the files of a judge-change record are a closed roster: one plan, one bar, two runs per system, each file once', () => {
  const { record } = ledgerRecord();
  const other = sha256Hex('another file');
  problemsOf(rebound(record, (m) => ({ ...m, files: m.files.filter((f) => f.role !== 'plan') })), 'exactly one file with role "plan", found 0');
  problemsOf(rebound(record, (m) => ({ ...m, files: inOrder([...m.files, { role: 'bar', sha256: other }]) })), 'exactly one file with role "bar", found 2');
  problemsOf(rebound(record, (m) => ({ ...m, files: m.files.slice(0, -1) })), 'an old-judge and a new-judge run for each system');
  problemsOf(rebound(record, (m) => ({ ...m, files: m.files.filter((f) => f.role !== 'run') })), 'an old-judge and a new-judge run for each system');
  // One reference file may serve several systems, so a binding of two systems holds up to two reference files: three are one too many.
  problemsOf(rebound(record, (m) => ({ ...m, files: inOrder([...m.files, ...['x', 'y', 'z'].map((n) => ({ role: 'reference', sha256: sha256Hex(`reference ${n}`) }))]) })), 'a reference for every system, or for none');
  problemsOf(rebound(record, (m) => ({ ...m, files: [...m.files, { role: 'converter', sha256: other }] })), 'role: must be one of plan, bar, run, reference, tie-break, resample-indices');
  problemsOf(rebound(record, (m) => ({ ...m, files: inOrder([...m.files, { role: 'reference', sha256: m.files[0]?.sha256 as string }]) })), 'listed twice');
  problemsOf(rebound(record, (m) => ({ ...m, files: m.files.map((f) => ({ ...f, name: 'x.json' })) })), 'record.measurement.files[0].name: unknown field');
  problemsOf(rebound(record, (m) => ({ ...m, files: [] })), 'record.measurement.files');
  problemsOf(rebound(record, (m) => ({ ...m, note: 'x' })), 'record.measurement.note: unknown field');
  // A record has the identity of a run or the binding of a measurement, by its kind, and never both or neither.
  problemsOf({ ...record, identity: makeIdentity() }, 'record.identity: unknown field');
  const gate = makeGateRecord({ inputs: gateInputs(), result: { exitCode: 0 }, at: AT });
  assert.deepEqual(validateRecord(gate), []);
  problemsOf({ ...gate, measurement: record.measurement }, 'record.measurement: unknown field');
  problemsOf({ ...gate, kind: 'judge-change' }, 'record.measurement: must be { planHash, files, seeds }');
  const { identity: _i, ...noIdentity } = gate;
  problemsOf(noIdentity, 'record.identity');
});

test('ledger: every seed is recorded, and a supplied-draw hash must name a file of the record', () => {
  const { record } = ledgerRecord(resampling(7, 60));
  const supplied = sha256Hex('supplied rows');
  problemsOf(rebound(record, (m) => ({ ...m, seeds: { ...m.seeds, resampling: { seed: -1 } } })), 'record.measurement.seeds.resampling');
  problemsOf(rebound(record, (m) => ({ ...m, seeds: { ...m.seeds, resampling: { seed: 7, iterations: 60 } } })), 'record.measurement.seeds.resampling');
  problemsOf(rebound(record, (m) => ({ ...m, seeds: { ...m.seeds, resampling: null } })), 'null is not allowed');
  problemsOf(rebound(record, (m) => ({ ...m, seeds: { tieBreak: m.seeds.tieBreak } })), 'record.measurement.seeds.resampling');
  problemsOf(rebound(record, (m) => ({ ...m, seeds: { ...m.seeds, tieBreak: { seeds: [] } } })), 'record.measurement.seeds.tieBreak');
  problemsOf(rebound(record, (m) => ({ ...m, seeds: { ...m.seeds, tieBreak: { seeds: [1, 1] } } })), 'record.measurement.seeds.tieBreak');
  problemsOf(rebound(record, (m) => ({ ...m, seeds: { ...m.seeds, tieBreak: { seeds: [1], suppliedSha256: 'abc' } } })), 'record.measurement.seeds.tieBreak');
  problemsOf(rebound(record, (m) => ({ ...m, seeds: { ...m.seeds, extra: 1 } })), 'record.measurement.seeds.extra: unknown field');
  // A hash of supplied draws with no such file, and a supplied-draw file that no seed entry names.
  problemsOf(rebound(record, (m) => ({ ...m, seeds: { ...m.seeds, resampling: { suppliedSha256: supplied } } })), 'record.measurement.seeds.resampling.suppliedSha256: no file with role "resample-indices" has this sha256');
  problemsOf(rebound(record, (m) => ({ ...m, files: inOrder([...m.files, { role: 'resample-indices', sha256: supplied }]) })), 'role "resample-indices" but seeds.resampling names no supplied draws');
  problemsOf(rebound(record, (m) => ({ ...m, files: inOrder([...m.files, { role: 'tie-break', sha256: supplied }]) })), 'role "tie-break" but seeds.tieBreak names no supplied draws');
  problemsOf(rebound(record, (m) => ({ ...m, seeds: { ...m.seeds, tieBreak: { seeds: [1], suppliedSha256: supplied } } })), 'record.measurement.seeds.tieBreak.suppliedSha256: no file with role "tie-break" has this sha256');
  // Supplied draws named by a seed entry and present as a file are a consistent binding, and the report must say the same:
  // with both hashes recomputed and the report's own draws record replaced, the record validates.
  const withSupplied = rebound(record, (m) => ({ ...m, files: inOrder([...m.files, { role: 'resample-indices', sha256: supplied }]), seeds: { ...m.seeds, resampling: { suppliedSha256: supplied } } })) as unknown as JudgeChangeLedgerRecord;
  problemsOf(withSupplied, 'record.measurement.seeds.resampling: differs from result.spread.draws');
  assert.deepEqual(validateRecord(reresult(withSupplied, { spread: { ...(record.result['spread'] as object), draws: { suppliedSha256: supplied } } })), []);
});

test('ledger: supplied draws and a reference enter the record from the plan, as files and in place of a seed', () => {
  // Supplied tie-break draws beside the plan's seeds, and a seeded spread.
  const { files, plan } = mapSetup(mapFixture, { ...resampling(9, 60) });
  const ids = [ka, kb, kc, kd, ke, kf];
  const u = (judge: 'old' | 'new', set: 'estimate' | 'reask') => Object.fromEntries(['A', 'B'].map((s) => [s, Object.fromEntries(ids.map((id) => [id, tieBreakU(1, judge, set, s, id)]))]));
  const tie = file('tie.json', { schema: TIE_BREAK_SCHEMA, u: { old: { estimate: u('old', 'estimate'), reask: u('old', 'reask') }, new: { estimate: u('new', 'estimate'), reask: u('new', 'reask') } } });
  const withTie: JudgeChangePlan = { ...plan, map: { ...mapBlock(), tieBreak: { suppliedSha256: shaOf(tie), seeds: seeds20 } } };
  const report = judgeChangeRuns([...files, tie], barFile, withTie);
  const record = makeJudgeChangeRecord({ planFile: bytesOf(withTie), barFile: BAR_BYTES, report, at: AT });
  assert.deepEqual(validateRecord(record), []);
  assert.deepEqual(record.measurement.seeds, { resampling: { seed: 9 }, tieBreak: { seeds: seeds20, suppliedSha256: shaOf(tie) } });
  assert.deepEqual(record.measurement.files.filter((f) => f.role === 'tie-break'), [{ role: 'tie-break', sha256: shaOf(tie) }]);
  // Every file the measurement read is in the record: the roster and the supplied draws, plus the plan and the bar.
  assert.deepEqual(record.measurement.files.map((f) => f.sha256).sort(), [sha256Hex(bytesOf(withTie)), BAR_FILE, ...[...files, tie].map(shaOf)].sort());
  assert.deepEqual(record.measurement.files, inOrder(record.measurement.files));
  assert.deepEqual([...new Set(record.measurement.files.map((f) => f.role))], ['plan', 'bar', 'run', 'reference', 'tie-break']);
  assert.deepEqual(ROLE_ORDER, [...JUDGE_CHANGE_FILE_ROLES]);
  assert.equal(record.measurement.files.filter((f) => f.role === 'reference').length, Object.values(withTie.systems).filter((f) => f.reference !== undefined).length);
});

test('ledger: makeJudgeChangeRecord reads the plan and the bar from their bytes, and refuses bytes that contradict the report', () => {
  const { plan, report } = ledgerRecord();
  const make = (over: Record<string, unknown>) => () => makeJudgeChangeRecord({ planFile: bytesOf(plan), barFile: BAR_BYTES, report, at: AT, ...over });
  const invalid = (f: () => unknown, fragment: string): void => {
    assert.throws(f, (e: unknown) => {
      assert.ok(e instanceof InputError && e.code === 'INVALID_LEDGER', String(e));
      assert.ok(e.problems.some((p) => p.includes(fragment)), e.problems.join(' | '));
      return true;
    });
  };
  // The plan file is another plan than the report's: its hash is not the report's planHash.
  invalid(make({ planFile: bytesOf({ ...plan, cut: '5' }) }), 'record.measurement.planHash: differs from result.planHash');
  // The bar file is not the bar the plan declares: the builder hashes the bar it was given, and takes no hash on trust.
  const otherBar: BarFile = { ...barFile, classes: { ...barFile.classes, quality: { direction: 'floor', minPassRate: 0.9 } } };
  invalid(make({ barFile: bytesOf(otherBar) }), `bar file: its barHash is ${barHash(otherBar)}, and the plan file declares ${plan.barHash}`);
  // A plan and a report that agree with each other on another bar than the file given: still refused.
  invalid(make({ report: { ...report, barHash: barHash(otherBar) } }), "record.result.barHash: differs from the plan file's barHash");
  // Bytes that are not a plan, not a bar, or not JSON at all.
  invalid(make({ planFile: BAR_BYTES }), 'plan file: plan.schema');
  invalid(make({ barFile: bytesOf(plan) }), 'bar file: ');
  invalid(make({ planFile: new TextEncoder().encode('{"schema": ') }), 'plan file: invalid JSON');
  invalid(make({ barFile: new Uint8Array([0xff, 0xfe]) }), 'bar file: invalid JSON');
  // Bytes that give a key twice: JSON.parse would read each as the very plan and the very bar of the report.
  const twice = (bytes: Uint8Array, after: RegExp, insert: string): Uint8Array => {
    const text = new TextDecoder().decode(bytes);
    const changed = text.replace(after, (m) => `${m}${insert}`);
    assert.notEqual(changed, text);
    assert.deepEqual(JSON.parse(changed), JSON.parse(text));
    return new TextEncoder().encode(changed);
  };
  const exactly = (f: () => unknown, problems: string[]): void => {
    assert.throws(f, (e: unknown) => {
      assert.ok(e instanceof InputError && e.code === 'INVALID_LEDGER', String(e));
      assert.deepEqual(e.problems, problems);
      return true;
    });
  };
  exactly(make({ planFile: twice(bytesOf(plan), /"judges": \{/, '"old": {},') }), ['plan file: the key "old" is given twice in the object at /judges']);
  exactly(make({ barFile: twice(BAR_BYTES, /^\{/, '"classes": {},') }), ['bar file: the key "classes" is given twice in the top-level object']);
  exactly(make({ planFile: twice(bytesOf(plan), /^\{/, '"cut": "1",'), barFile: twice(BAR_BYTES, /"classes": \{/, '"quality": {},') }), ['plan file: the key "cut" is given twice in the top-level object', 'bar file: the key "quality" is given twice in the object at /classes']);
  // The same content in other bytes is another file: the record names the bytes it was given.
  const compact = makeJudgeChangeRecord({ planFile: new TextEncoder().encode(JSON.stringify(plan)), barFile: BAR_BYTES, report, at: AT });
  assert.notDeepEqual(compact.measurement.files, ledgerRecord().record.measurement.files);
  assert.equal(compact.measurement.planHash, ledgerRecord().record.measurement.planHash);
  // A non-finite number has no canonical JSON, so the report has no hash: invalid input, never an uncaught error.
  invalid(make({ report: { ...report, perDrawPassRate: { old: Number.NaN, new: 0, change: 0 } } }), 'the report cannot be hashed');
});

// Each change below validated before, once `inputsHash` was recomputed: the binding was checked against its own hash
// and, of the report, only against its plan hash, its tool and its run files.
test('ledger: a binding whose reference files, seeds or file order contradict the report is refused, with its hash recomputed', () => {
  const { files, plan } = gateSetup(lenient, resampling(7, 60));
  const report = judgeChangeRuns(files, barFile, plan);
  const record = makeJudgeChangeRecord({ planFile: bytesOf(plan), barFile: BAR_BYTES, report, at: AT });
  assert.deepEqual(validateRecord(record), []);
  assert.equal(record.measurement.files.filter((f) => f.role === 'reference').length, 3);
  const other = sha256Hex('another reference file');
  // A changed reference hash: the record no longer names the file the report read.
  const firstRef = record.measurement.files.find((f) => f.role === 'reference')?.sha256;
  problemsOf(rebound(record, (m) => ({ ...m, files: inOrder(m.files.map((f) => (f.sha256 === firstRef ? { ...f, sha256: other } : f))) })), 'record.measurement.files: the reference files must be exactly the references of result.reference.inputs');
  // Dropped references: the report lists three.
  problemsOf(rebound(record, (m) => ({ ...m, files: m.files.filter((f) => f.role !== 'reference') })), 'record.measurement.files: the reference files must be exactly the references of result.reference.inputs');
  // Replaced seeds: another seed, and no seed at all.
  problemsOf(rebound(record, (m) => ({ ...m, seeds: { ...m.seeds, resampling: { seed: 99 } } })), 'record.measurement.seeds.resampling: differs from result.spread.draws');
  problemsOf(rebound(record, (m) => ({ ...m, seeds: { ...m.seeds, resampling: 'not declared' } })), 'record.measurement.seeds.resampling: "not declared", but result.spread is declared');
  // An unsorted list: the same files in another order are another binding hash for the same inputs.
  const unsorted = 'record.measurement.files: must be sorted by role (plan, bar, run, reference, tie-break, resample-indices), then by sha256';
  problemsOf(rebound(record, (m) => ({ ...m, files: [...m.files].reverse() })), unsorted);
  // The bar before the plan; two runs swapped; the references before the runs.
  problemsOf(rebound(record, (m) => ({ ...m, files: [m.files[1], m.files[0], ...m.files.slice(2)] })), unsorted);
  problemsOf(rebound(record, (m) => ({ ...m, files: [m.files[0], m.files[1], m.files[3], m.files[2], ...m.files.slice(4)] })), unsorted);
  problemsOf(rebound(record, (m) => ({ ...m, files: [...m.files.filter((f) => f.role !== 'run'), ...m.files.filter((f) => f.role === 'run')] })), unsorted);
  // A report with no reference and no resampling block: the record may name neither.
  const bare = ledgerRecord().record;
  const [a, b] = [sha256Hex('ref a'), sha256Hex('ref b')];
  problemsOf(rebound(bare, (m) => ({ ...m, files: inOrder([...m.files, { role: 'reference', sha256: a }, { role: 'reference', sha256: b }]) })), 'file(s) with role "reference", but result.reference is "not declared"');
  problemsOf(rebound(bare, (m) => ({ ...m, seeds: { ...m.seeds, resampling: { seed: 7 } } })), 'record.measurement.seeds.resampling: result.spread is "not declared", so this must be "not declared" too');
  problemsOf(rebound(bare, (m) => ({ ...m, seeds: { ...m.seeds, tieBreak: { seeds: [1, 2] } } })), 'record.measurement.seeds.tieBreak: result.map is "not declared", so this must be "not declared" too');
  // A reference the report withholds (its packets are unknown, and no file states so): the report lists no reference
  // file, so only the presence of the references is checked, and dropping them is still refused.
  const hidden = gateSetup(lenient, {}, (s, r) => (s === 'Y' ? { ...r, packetHashes: { ...r.packetHashes, g3: GAP } } : r));
  const withheld = makeJudgeChangeRecord({ planFile: bytesOf(hidden.plan), barFile: BAR_BYTES, report: judgeChangeRuns(hidden.files, barFile, hidden.plan), at: AT });
  assert.deepEqual(validateRecord(withheld), []);
  problemsOf(rebound(withheld, (m) => ({ ...m, files: m.files.filter((f) => f.role !== 'reference') })), 'no file with role "reference", but result.reference is withheld');
});

test('ledger: the tie-break seeds of a record are the seeds of the map the report carries', () => {
  const { files, plan } = mapSetup(mapFixture, { ...resampling(9, 60) });
  const report = judgeChangeRuns(files, barFile, plan);
  const record = makeJudgeChangeRecord({ planFile: bytesOf(plan), barFile: BAR_BYTES, report, at: AT });
  assert.deepEqual(validateRecord(record), []);
  assert.deepEqual(record.measurement.seeds.tieBreak, { seeds: seeds20 });
  // Replaced seeds, a dropped seed, another first seed (the one behind the map's numbers), and no seeds at all.
  problemsOf(rebound(record, (m) => ({ ...m, seeds: { ...m.seeds, tieBreak: { seeds: [99] } } })), 'record.measurement.seeds.tieBreak.seeds: differs from result.map.overTieBreakSeeds.seeds');
  problemsOf(rebound(record, (m) => ({ ...m, seeds: { ...m.seeds, tieBreak: { seeds: seeds20.slice(1) } } })), 'record.measurement.seeds.tieBreak.seeds: differs from result.map.overTieBreakSeeds.seeds');
  problemsOf(rebound(record, (m) => ({ ...m, seeds: { ...m.seeds, tieBreak: { seeds: [...seeds20].reverse() } } })), "record.measurement.seeds.tieBreak: differs from result.map.tieBreak, the draws behind the map's numbers");
  problemsOf(rebound(record, (m) => ({ ...m, seeds: { ...m.seeds, tieBreak: 'not declared' } })), 'record.measurement.seeds.tieBreak: "not declared", but result.map is declared');
  // Supplied draws that the report does not say it used.
  const supplied = sha256Hex('supplied draws');
  problemsOf(
    rebound(record, (m) => ({ ...m, files: inOrder([...m.files, { role: 'tie-break', sha256: supplied }]), seeds: { ...m.seeds, tieBreak: { seeds: seeds20, suppliedSha256: supplied } } })),
    "record.measurement.seeds.tieBreak: differs from result.map.tieBreak, the draws behind the map's numbers",
  );
});

test('ledger: a file with another schema string is refused with the one plain message, and nothing is appended to it', () => {
  const { record } = ledgerRecord();
  const v2 = { ...makeGateRecord({ inputs: gateInputs(), result: { exitCode: 0 }, at: AT }), schema: 'anchorset.ledger/v2' };
  problemsOf(v2, 'record.schema: must be "anchorset.ledger/v3"');
  assert.equal(LEDGER_SCHEMA, 'anchorset.ledger/v3');
  const path = join(tmp, 'v2-ledger.jsonl');
  writeFileSync(path, `${canonicalJson(v2)}\n`);
  const before = readFileSync(path);
  assert.throws(() => appendRecord(path, record), (e: unknown) => e instanceof InputError && e.code === 'INVALID_LEDGER' && e.problems.some((p) => p.includes('line 1') && p.includes('record.schema: must be "anchorset.ledger/v3"') && !p.includes('retired')));
  assert.deepEqual(readFileSync(path), before);
  // The command refuses the same file before it measures anything.
  const r = cli('judge-change', ...onDisk('v2-ledger'), '--ledger', path);
  assert.equal(r.status, 65, r.stderr);
  assert.match(r.stderr, /v2-ledger\.jsonl: line 1: record\.schema: must be "anchorset\.ledger\/v3"/);
  assert.doesNotMatch(r.stderr, /retired|MIGRATIONS/);
  assert.equal(r.stdout, '');
  assert.deepEqual(readFileSync(path), before);
});

test('judge-change --ledger appends exactly one record, and leaves the report on stdout byte for byte', () => {
  const flags = onDisk('ledger');
  const ledger = join(tmp, 'cli', 'ledger.jsonl');
  const plain = cli('judge-change', ...flags);
  const plainJson = cli('judge-change', ...flags, '--json');
  const text = cli('judge-change', ...flags, '--ledger', ledger);
  assert.equal(text.status, 0, text.stderr);
  const lines = (): string[] => readFileSync(ledger, 'utf8').split('\n');
  assert.equal(lines().length, 2);
  assert.equal(lines()[1], '');
  const [first] = readLedger(ledger) as [JudgeChangeLedgerRecord];
  assert.equal(first.kind, 'judge-change');
  // The text report gains one last line and nothing else moves.
  const trace = `ledger: line 1 · record ${hashOf(first)} · result ${first.resultHash}\n`;
  assert.equal(text.stdout, `${plain.stdout}${trace}`);
  assert.equal(text.stderr, '');
  assert.equal(sha256Hex(lines()[0] as string), hashOf(first));
  // The JSON report is the result itself, so stdout does not change; the trace line goes to stderr.
  const json = cli('judge-change', ...flags, '--json', '--ledger', ledger);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(json.stdout, plainJson.stdout);
  assert.equal(lines().length, 3);
  const [, second] = readLedger(ledger) as [JudgeChangeLedgerRecord, JudgeChangeLedgerRecord];
  assert.equal(json.stderr, `ledger: line 2 · record ${hashOf(second)} · result ${second.resultHash}\n`);
  assert.equal(hashOf(JSON.parse(json.stdout)), second.resultHash);
  assert.deepEqual(second.result, JSON.parse(json.stdout));
  // Two runs on the same inputs: the records differ in the timestamp and in nothing else.
  const { at: at1, ...rest1 } = first;
  const { at: at2, ...rest2 } = second;
  assert.deepEqual(rest1, rest2);
  assert.match(at1, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(at2, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  // The files are the bytes on disk: the plan and the bar as read, and every run of the roster.
  const sha = (p: string): string => sha256Hex(readFileSync(p));
  const dir = flags[5] as string;
  assert.deepEqual(first.measurement.files.slice(0, 2), [{ role: 'plan', sha256: sha(flags[1] as string) }, { role: 'bar', sha256: sha(flags[3] as string) }]);
  assert.deepEqual(first.measurement.files.slice(2).map((f) => f.sha256), ['Aold', 'Anew', 'Bold', 'Bnew'].map((k) => sha(join(dir, `${k}.json`))).sort());
});

test('judge-change --inputs: a --ledger file kept in the folder is skipped as the plan and the bar are, by its real path; a copy of it under another name is not', () => {
  const flags = onDisk('ledger-in-dir');
  const dir = flags[5] as string;
  const outside = cli('judge-change', ...flags, '--json');
  assert.equal(outside.status, 0, outside.stderr);
  // The first run creates the ledger inside the folder; the second finds a `.json` ledger beside the runs.
  const inside = join(dir, 'history.json');
  const first = cli('judge-change', ...flags, '--json', '--ledger', inside);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, outside.stdout);
  const second = cli('judge-change', ...flags, '--json', '--ledger', inside);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, outside.stdout);
  assert.equal((readLedger(inside) as unknown[]).length, 2);
  // By real path: a symlink to the ledger, under any name, is the ledger and not an input.
  symlinkSync(inside, join(dir, 'link.json'));
  const linked = cli('judge-change', ...flags, '--json', '--ledger', inside);
  assert.equal(linked.status, 0, linked.stderr);
  assert.equal(linked.stdout, outside.stdout);
  rmSync(join(dir, 'link.json'));
  // Any other file in the folder is still an input of the roster, and refuses.
  writeFileSync(join(dir, 'copy.json'), readFileSync(inside));
  const copy = cli('judge-change', ...flags, '--ledger', inside);
  assert.equal(copy.status, 2, copy.stderr);
  assert.match(copy.stderr, /REFUSED HASH_MISMATCH\n {2}fields: copy\.json/);
});

test('judge-change --ledger checks the ledger file before the measurement, and a refused measurement appends nothing', () => {
  // A stray file refuses the measurement (exit 2). With a ledger that cannot take a record, the ledger speaks first (65).
  const flags = onDisk('ledger-first');
  writeFileSync(join(flags[5] as string, 'stray.json'), '{}');
  const garbled = join(tmp, 'garbled-ledger.jsonl');
  writeFileSync(garbled, '{"not": "a ledger');
  const r = cli('judge-change', ...flags, '--ledger', garbled);
  assert.equal(r.status, 65, r.stderr);
  assert.match(r.stderr, /INVALID_LEDGER/);
  assert.match(r.stderr, /garbled-ledger\.jsonl: line 1: not valid JSON/);
  assert.doesNotMatch(r.stderr, /REFUSED/);
  assert.equal(r.stdout, '');
  assert.equal(readFileSync(garbled, 'utf8'), '{"not": "a ledger');
  // Before the plan is read, too: a plan that does not exist is not reached.
  const noPlan = cli('judge-change', '--plan', join(tmp, 'no-such-plan.json'), '--bar', flags[3] as string, '--inputs', flags[5] as string, '--ledger', garbled);
  assert.equal(noPlan.status, 65);
  assert.match(noPlan.stderr, /garbled-ledger\.jsonl/);
  assert.doesNotMatch(noPlan.stderr, /no-such-plan/);
  // A directory, and a path under a file, cannot hold a ledger.
  assert.equal(cli('judge-change', ...flags, '--ledger', flags[5] as string).status, 65);
  assert.equal(cli('judge-change', ...flags, '--ledger', join(garbled, 'ledger.jsonl')).status, 65);
  // A ledger whose last line has no newline, and a device that keeps nothing: refused before the measurement too,
  // so the stray file is never reached, nothing is printed, and the record the file holds is left as it was.
  const { record } = ledgerRecord();
  const unterminated = join(tmp, 'unterminated-ledger.jsonl');
  writeFileSync(unterminated, canonicalJson(record));
  const u = cli('judge-change', ...flags, '--ledger', unterminated);
  assert.equal(u.status, 65, u.stderr);
  assert.match(u.stderr, /INVALID_LEDGER\)\n {2}- .*unterminated-ledger\.jsonl: line 1: the file does not end with a newline/);
  assert.doesNotMatch(u.stderr, /REFUSED/);
  assert.equal(u.stdout, '');
  assert.equal(readFileSync(unterminated, 'utf8'), canonicalJson(record));
  if (process.platform !== 'win32') {
    const n = cli('judge-change', ...onDisk('dev-null'), '--ledger', '/dev/null');
    assert.equal(n.status, 65, n.stderr);
    assert.match(n.stderr, /\/dev\/null: is not a regular file/);
    assert.equal(n.stdout, '');
  }
  // A ledger this user may not write to: the check finds it before the plan is read, not after the measurement.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const readOnly = join(tmp, 'read-only-ledger.jsonl');
    writeFileSync(readOnly, `${canonicalJson(record)}\n`);
    chmodSync(readOnly, 0o444);
    const ro = cli('judge-change', '--plan', join(tmp, 'no-such-plan.json'), '--bar', flags[3] as string, '--inputs', flags[5] as string, '--ledger', readOnly);
    assert.equal(ro.status, 65, ro.stderr);
    assert.match(ro.stderr, /read-only-ledger\.jsonl: EACCES/);
    assert.doesNotMatch(ro.stderr, /no-such-plan/);
    assert.equal(readFileSync(readOnly, 'utf8'), `${canonicalJson(record)}\n`);
  }
  // A good ledger and a refused measurement: exit 2, and the ledger gains no line and is not created.
  const fresh = join(tmp, 'refused', 'ledger.jsonl');
  const refusedRun = cli('judge-change', ...flags, '--ledger', fresh);
  assert.equal(refusedRun.status, 2, refusedRun.stderr);
  assert.throws(() => readFileSync(fresh), /ENOENT/);
  assert.equal(cli('judge-change', ...flags, '--ledger').status, 64);
});

test('judge-change --ledger on the example: the record names every file of the study manifest and every seed of the plan', () => {
  const ex = (f: string): string => join(root, 'examples', 'judge-change', f);
  const ledger = join(tmp, 'example', 'ledger.jsonl');
  const r = cli('judge-change', '--plan', ex('plan.json'), '--bar', ex('bar.json'), '--inputs', ex('runs'), '--json', '--ledger', ledger);
  assert.equal(r.status, 0, r.stderr);
  const [rec] = readLedger(ledger) as [JudgeChangeLedgerRecord];
  const manifest = JSON.parse(readFileSync(ex('manifest.json'), 'utf8')) as { inputs: { role: string; sha256: string }[] };
  const plan = parseJudgeChangePlan(JSON.parse(readFileSync(ex('plan.json'), 'utf8')));
  const key = (f: { role: string; sha256: string }): string => `${f.role} ${f.sha256}`;
  assert.deepEqual(rec.measurement.files.map(key).sort(), manifest.inputs.filter((f) => f.role !== 'converter').map(key).sort());
  assert.equal(rec.measurement.planHash, hashOf(plan));
  assert.deepEqual(rec.measurement.seeds, { resampling: { seed: 20261002 }, tieBreak: { seeds: plan.map?.tieBreak.seeds } });
  assert.equal(rec.resultHash, hashOf(JSON.parse(r.stdout)));
});

test('judge-change: a plan, a bar, a bound run or a reference file that gives a key twice is invalid input (65), with the key and its place named', () => {
  const ex = (f: string): string => join(root, 'examples', 'judge-change', f);
  const work = mkdtempSync(join(tmp, 'twice-'));
  let n = 0;
  /** A copy in which a key is given twice, the file's own value last: JSON.parse reads the copy as the original. */
  const twice = (path: string, after: RegExp, insert: string, out = join(work, `twice-${n++}.json`)): string => {
    const text = readFileSync(path, 'utf8');
    const changed = text.replace(after, (m) => `${m}${insert}`);
    assert.notEqual(changed, text);
    assert.deepEqual(JSON.parse(changed), JSON.parse(text));
    writeFileSync(out, changed);
    return out;
  };
  const invalid = (r: { status: number | null; stdout: string; stderr: string }, code: string, named: RegExp): void => {
    assert.equal(r.status, 65, r.stdout + r.stderr);
    assert.ok(r.stderr.startsWith(`anchorset: invalid input (${code})\n`), r.stderr);
    assert.match(r.stderr, named);
    assert.doesNotMatch(r.stderr, /\n\s+at .*\(|node:internal/);
    assert.equal(r.stdout, '');
  };
  // The plan: a judge of the plan given twice.
  const plan = twice(ex('plan.json'), /"judges": \{/, '"old": {},');
  invalid(cli('judge-change', '--plan', plan, '--bar', ex('bar.json'), '--inputs', ex('runs')), 'INVALID_ARGUMENT', /--plan \S+: \S+twice-\d+\.json: the key "old" is given twice in the object at \/judges\n/);
  // The bar: a class with two bars.
  const bar = twice(ex('bar.json'), /"classes": \{/, '"reply_quality": {"direction": "floor", "minPassRate": 0},');
  const ledger = join(work, 'ledger.jsonl');
  invalid(cli('judge-change', '--plan', ex('plan.json'), '--bar', bar, '--inputs', ex('runs'), '--json', '--ledger', ledger), 'INVALID_ARGUMENT', /twice-\d+\.json: the key "reply_quality" is given twice in the object at \/classes\n/);
  assert.throws(() => readFileSync(ledger), /ENOENT/);

  // A run and a reference file that the plan binds by sha256: the roster admits the new bytes, and the reader refuses them.
  const planText = readFileSync(ex('plan.json'), 'utf8');
  const bound = (name: string, after: RegExp, insert: string): string[] => {
    const inputs = mkdtempSync(join(work, 'runs-'));
    cpSync(ex('runs'), inputs, { recursive: true });
    const before = sha256Hex(readFileSync(join(inputs, name)));
    twice(join(inputs, name), after, insert, join(inputs, name));
    assert.ok(planText.includes(before));
    const rebound = join(work, `plan-${n++}.json`);
    writeFileSync(rebound, planText.replaceAll(before, sha256Hex(readFileSync(join(inputs, name)))));
    return ['--plan', rebound, '--bar', ex('bar.json'), '--inputs', inputs];
  };
  invalid(cli('judge-change', ...bound('bot-v1.old-judge.json', /"draws": \[\s*\{/, '"caseId": "q02",')), 'INVALID_ARTIFACT', /^ {2}- bot-v1\.old-judge\.json: the key "caseId" is given twice in the object at \/draws\/0\n/m);
  invalid(cli('judge-change', ...bound('bot-v2.new-judge.json', /^\{/, '"schema": "anchorset.run/v2",'), '--json'), 'INVALID_ARTIFACT', /^ {2}- bot-v2\.new-judge\.json: the key "schema" is given twice in the top-level object\n/m);
  invalid(cli('judge-change', ...bound('bot-v1.reference.json', /"verdicts": \{/, '"q01": "pass",'), '--ledger', ledger), 'INVALID_ARTIFACT', /^ {2}- bot-v1\.reference\.json: the key "q01" is given twice in the object at \/verdicts\n/m);
  assert.throws(() => readFileSync(ledger), /ENOENT/);

  // The ledger read back: a record that gives a key twice is unreadable, and the ledger speaks before the measurement.
  const flags = ['--plan', ex('plan.json'), '--bar', ex('bar.json'), '--inputs', ex('runs')];
  assert.equal(cli('judge-change', ...flags, '--ledger', ledger).status, 0);
  const line = readFileSync(ledger, 'utf8');
  const lineTwice = line.replace('"measurement":{', '"measurement":{"planHash":"UNKNOWN",');
  assert.notEqual(lineTwice, line);
  assert.deepEqual(JSON.parse(lineTwice), JSON.parse(line));
  writeFileSync(ledger, lineTwice);
  const r = cli('judge-change', ...flags, '--ledger', ledger);
  assert.equal(r.status, 65, r.stdout + r.stderr);
  assert.equal(r.stderr, `anchorset: invalid input (INVALID_LEDGER)\n  - ${ledger}: line 1: the key "planHash" is given twice in the object at /measurement\n`);
  assert.equal(r.stdout, '');
  assert.equal(readFileSync(ledger, 'utf8'), lineTwice);
});

// ---- a reference that saw a different packet, as the criterion of pair gates only (reference v2) ----

const DIFFERENT = 'reference saw a different packet';
const PACKET_UNKNOWN = 'reference packet unknown';
const difference = { packets: 'different', quote: 'Raters were shown each reply beside four other replies to the same message.', source: 'the rating protocol, section 2' } as const;
type RefEdit = (system: string, ref: ReferenceFile) => unknown;
/** The raters saw another view of every case, the hashes say so, and the file states it with its source. */
const groupedView: RefEdit = (system, ref) => ({ ...ref, packetHashes: Object.fromEntries(Object.keys(ref.packetHashes).map((id) => [id, sha256Hex(`grouped view ${system}:${id}`)])), packetDifference: difference });
/** Nobody kept what the raters were shown, and the file states that with its source. */
const unknownView: RefEdit = (_system, ref) => ({
  ...ref,
  packetBasis: GAP,
  packetHashes: Object.fromEntries(Object.keys(ref.packetHashes).map((id) => [id, GAP])),
  packetDifference: { packets: GAP, quote: 'The view each rater was given was not kept.', source: 'the rating protocol, section 2' },
});
/** Rewrites every reference file of a setup and binds the plan to the new bytes. */
function rebindReferences(s: { files: JudgeChangeInput[]; plan: JudgeChangePlan }, over: RefEdit): { files: JudgeChangeInput[]; plan: JudgeChangePlan } {
  const systems = { ...s.plan.systems };
  const files = s.files.map((f) => {
    const system = Object.keys(systems).find((k) => systems[k]?.reference === shaOf(f));
    if (system === undefined) return f;
    const next = file(f.name, over(system, JSON.parse(new TextDecoder().decode(f.bytes)) as ReferenceFile));
    systems[system] = { ...(systems[system] as { old: string; new: string }), reference: shaOf(next) };
    return next;
  });
  return { files, plan: { ...s.plan, systems } };
}
const REF_GATE_ROWS = ['pairs the reference gate does not pass', 'of those, passed by doing nothing minus by re-judging', 'of the pairs it passes, not passed by doing nothing minus by re-judging'];
/** Every agreement number a report could carry: the keys of the agreement block and the names of its spread rows. */
const AGREEMENT_NUMBERS = /"agree"|"share"|"kappa"|"ac1"|"passShare"|"referencePassShare"|"percentiles"|agreement with the reference,|kappa with the reference|AC1 with the reference/;

test('a reference file with another schema string gets the one plain message', () => {
  const v1 = { schema: 'anchorset.reference/v1', verdictRule: 'two of three raters', verdicts: { a: 'pass' }, packetHashes: { a: sha256Hex('a') }, packetBasis: 'recorded' };
  assert.equal(REFERENCE_SCHEMA, 'anchorset.reference/v2');
  assert.deepEqual(referenceProblems(v1), ['reference.schema: must be "anchorset.reference/v2"']);
  assert.deepEqual(referenceProblems({ ...v1, schema: REFERENCE_SCHEMA }), []);
  // In a measurement it is invalid input naming the file, never read in a compatibility mode: not even with equal packets.
  assert.throws(
    () => gateMeasure(lenient, {}, (s, r) => (s === 'Y' ? { ...r, schema: 'anchorset.reference/v1' } : r)),
    (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARTIFACT' && e.problems.length === 1 && e.problems[0] === 'Y.ref.json: reference.schema: must be "anchorset.reference/v2"',
  );
  // The command: invalid input, exit 65.
  const { files, plan } = gateSetup(lenient, {}, (_s, r) => ({ ...r, schema: 'anchorset.reference/v1' }));
  const dir = mkdtempSync(join(tmp, 'ref-v1-'));
  for (const f of files) writeFileSync(join(dir, f.name), f.bytes);
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(dir, 'bar.json'), JSON.stringify(barFile));
  const r = cli('judge-change', '--plan', join(dir, 'plan.json'), '--bar', join(dir, 'bar.json'), '--inputs', dir);
  assert.equal(r.status, 65, r.stderr);
  assert.match(r.stderr, /Y\.ref\.json: reference\.schema: must be "anchorset\.reference\/v2"/);
  assert.doesNotMatch(r.stderr, /retired|MIGRATIONS/);
});

test('referenceProblems: a stated packet difference is closed, names its source, and must fit the file\'s own packet evidence', () => {
  const ok: ReferenceFile = { schema: REFERENCE_SCHEMA, verdictRule: 'two of three raters', verdicts: { a: 'pass', b: 'fail' }, packetHashes: { a: sha256Hex('a'), b: sha256Hex('b') }, packetBasis: 'recorded' };
  const unknown = { ...ok, packetBasis: GAP, packetHashes: { a: GAP, b: GAP } };
  const has = (x: unknown, fragment: string): void => assert.ok(referenceProblems(x).some((p) => p.includes(fragment)), `${fragment}: ${referenceProblems(x).join(' | ') || 'no problem found'}`);
  assert.deepEqual(referenceProblems({ ...ok, packetDifference: difference }), []);
  assert.deepEqual(referenceProblems({ ...ok, packetBasis: 'declared', packetSource: 'the protocol', packetDifference: difference }), []);
  assert.deepEqual(referenceProblems({ ...unknown, packetDifference: { ...difference, packets: GAP } }), []);
  // Closed, with no nulls; the quotation and where it comes from are non-empty strings that say something.
  has({ ...ok, packetDifference: 'different' }, 'reference.packetDifference: must be { packets, quote, source }');
  has({ ...ok, packetDifference: { ...difference, note: 'x' } }, 'reference.packetDifference.note: unknown field');
  has({ ...ok, packetDifference: { ...difference, quote: null } }, 'null is not allowed');
  has({ ...ok, packetDifference: { ...difference, packets: 'equal' } }, 'reference.packetDifference.packets: must be "different" or "UNKNOWN"');
  for (const bad of ['', '   ', 'unknown', 'n/a', 7]) {
    has({ ...ok, packetDifference: { ...difference, quote: bad } }, 'reference.packetDifference.quote');
    has({ ...ok, packetDifference: { ...difference, source: bad } }, 'reference.packetDifference.source');
  }
  has({ ...ok, packetDifference: { packets: 'different', quote: 'q' } }, 'reference.packetDifference.source');
  // "different" is a known difference: every hash known, with a stated basis.
  has({ ...unknown, packetDifference: difference }, 'reference.packetDifference.packets: "different" needs every packet hash known');
  has({ ...ok, packetHashes: { a: sha256Hex('a'), b: GAP }, packetDifference: difference }, 'reference.packetDifference.packets: "different" needs every packet hash known');
  // "UNKNOWN" is said only of a file that records no packet at all.
  has({ ...ok, packetDifference: { ...difference, packets: GAP } }, 'reference.packetDifference.packets: "UNKNOWN" needs packetBasis "UNKNOWN"');
  has({ ...ok, packetHashes: { a: sha256Hex('a'), b: GAP }, packetDifference: { ...difference, packets: GAP } }, 'reference.packetDifference.packets: "UNKNOWN" needs packetBasis "UNKNOWN"');
});

test('refusal PACKET_MISMATCH: a stated difference when the hashes equal the judges\'; a declared difference must be a real one', () => {
  // Every hash equals the judges': recorded, and declared.
  refused('PACKET_MISMATCH', 'packetDifference[X/g1]', () => gateMeasure(lenient, {}, (_s, r) => ({ ...r, packetDifference: difference })));
  refused('PACKET_MISMATCH', 'packetDifference[Z/g6]', () => gateMeasure(lenient, {}, (_s, r) => ({ ...r, packetBasis: 'declared', packetSource: 'the protocol', packetDifference: difference })));
  // One case with the judges' own packet is enough: the statement is made of the whole file.
  const oneEqual: RefEdit = (s, r) => {
    const g = groupedView(s, r) as ReferenceFile;
    return s === 'Y' ? { ...g, packetHashes: { ...g.packetHashes, g4: r.packetHashes['g4'] as string } } : g;
  };
  assert.throws(() => gateMeasure(lenient, {}, oneEqual), (e: unknown) => e instanceof RefusalError && e.code === 'PACKET_MISMATCH' && e.fields.join() === 'packetDifference[Y/g4]' && /states that its packets differ.*equal.*Y\/g4/.test(e.message));
  // One code, two meanings, told apart by the words and by the fields. Here the statement is contradicted and the whole
  // report is refused; without a statement the same code withholds the reference rows and the report stands.
  assert.throws(
    () => gateMeasure(lenient, {}, oneEqual),
    (e: unknown) => e instanceof RefusalError && e.message.startsWith('PACKET_MISMATCH: the stated packet difference is contradicted: ') && e.message.endsWith('the report is refused, not withheld in part: remove the statement, or correct the packet hashes') && e.fields.every((f) => f.startsWith('packetDifference[')),
  );
  const withheld = gateMeasure(lenient, {}, (s, r) => (s === 'Y' ? { ...r, packetHashes: { ...r.packetHashes, g3: sha256Hex('a cut view') } } : r));
  assert.ok(withheld.reference !== 'not declared' && 'withheld' in withheld.reference && withheld.reference.withheld === 'PACKET_MISMATCH');
  assert.doesNotMatch(JSON.stringify(withheld), /contradicted|packetDifference/);
  // It is a refusal of the whole report, not a withholding.
  const { files, plan } = gateSetup(lenient, {}, (_s, r) => ({ ...r, packetDifference: difference }));
  const dir = mkdtempSync(join(tmp, 'equal-'));
  for (const f of files) writeFileSync(join(dir, f.name), f.bytes);
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(dir, 'bar.json'), JSON.stringify(barFile));
  const r = cli('judge-change', '--plan', join(dir, 'plan.json'), '--bar', join(dir, 'bar.json'), '--inputs', dir);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /REFUSED PACKET_MISMATCH/);
  assert.equal(r.stdout, '');
});

test('refusal UNSUPPORTED_DESIGN: a packet statement on some references of a roster and not on others, or two different statements', () => {
  // Only Y states it. X and Z are named.
  assert.throws(
    () => gateMeasure(lenient, {}, (s, r) => (s === 'Y' ? groupedView(s, r) : r)),
    (e: unknown) => e instanceof RefusalError && e.code === 'UNSUPPORTED_DESIGN' && e.fields.join() === 'packetDifference (X),packetDifference (Z)' && /stated by every reference of the roster, or by none/.test(e.message),
  );
  // Partial also when the other references' packets are unknown or differ: they are not withheld quietly beside a stated one.
  refused('UNSUPPORTED_DESIGN', 'packetDifference (Z)', () => gateMeasure(lenient, {}, (s, r) => (s === 'Z' ? { ...(groupedView(s, r) as object), packetDifference: undefined } : groupedView(s, r))));
  refused('UNSUPPORTED_DESIGN', 'packetDifference (X)', () => gateMeasure(lenient, {}, (s, r) => (s === 'X' ? r : unknownView(s, r))));
  // One roster, one statement: a different kind, quotation or source refuses.
  refused('UNSUPPORTED_DESIGN', 'packetDifference', () => gateMeasure(lenient, {}, (s, r) => (s === 'X' ? unknownView(s, r) : groupedView(s, r))));
  refused('UNSUPPORTED_DESIGN', 'packetDifference', () => gateMeasure(lenient, {}, (s, r) => (s === 'X' ? { ...(groupedView(s, r) as object), packetDifference: { ...difference, source: 'another document' } } : groupedView(s, r))));
});

test('refusal UNSUPPORTED_DESIGN: a stated packet difference with no gate block; the reference would be read and used for nothing', () => {
  for (const edit of [groupedView, unknownView]) {
    const stated = rebindReferences(gateSetup(lenient), edit);
    const { gate: _gate, oneCasePerCluster: _cluster, ...noGate } = stated.plan;
    assert.throws(
      () => judgeChangeRuns(stated.files, barFile, noGate),
      (e: unknown) => e instanceof RefusalError && e.code === 'UNSUPPORTED_DESIGN' && e.fields.join() === 'gate' && /a stated packet difference needs a gate block/.test(e.message),
    );
    // With a resampling block and still no gate: the same refusal, since no row of the spread could use the reference either.
    refused('UNSUPPORTED_DESIGN', 'gate', () => judgeChangeRuns(stated.files, barFile, { ...noGate, ...resampling(3, 60) }));
    // The same files under the same plan with its gate block are admitted.
    assert.equal(judgeChangeRuns(stated.files, barFile, stated.plan).blocks.reference, 'computed as the criterion of the pair gates; agreement withheld: PACKET_MISMATCH');
  }
  // No statement and no gate block: the reference saw the judges' packets, and agreement with it is computed. Not refused.
  const plain = gateSetup(lenient);
  const { gate: _gate, oneCasePerCluster: _cluster, ...noGate } = plain.plan;
  const r = judgeChangeRuns(plain.files, barFile, noGate);
  assert.deepEqual([r.blocks.gate, r.blocks.reference], ['not declared', 'computed']);
  assert.equal(agreementWith(r).old.agree, 13);
  // The command: a refusal, exit 2, and nothing on stdout.
  const stated = rebindReferences(gateSetup(lenient), groupedView);
  const { gate: _g, oneCasePerCluster: _c, ...planNoGate } = stated.plan;
  const dir = mkdtempSync(join(tmp, 'stated-no-gate-'));
  for (const f of stated.files) writeFileSync(join(dir, f.name), f.bytes);
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(planNoGate));
  writeFileSync(join(dir, 'bar.json'), JSON.stringify(barFile));
  const run = cli('judge-change', '--plan', join(dir, 'plan.json'), '--bar', join(dir, 'bar.json'), '--inputs', dir);
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /REFUSED UNSUPPORTED_DESIGN\n {2}fields: gate\n/);
  assert.equal(run.stdout, '');
});

test('a stated packet difference on a roster of one system: no pair, so blocks.reference says that nothing was computed with it', () => {
  for (const [edit, label] of [[groupedView, DIFFERENT], [unknownView, PACKET_UNKNOWN]] as const) {
    const r = gateMeasure({ X: lenient['X'] as Bits[string] }, resampling(3, 60), edit);
    assert.deepEqual(r.gate, { withheld: 'NO_PAIRS', detail: 'a pair gate compares two systems, and the roster has one' });
    assert.equal(r.blocks.reference, 'withheld: NO_PAIRS for the pair gates it is the criterion of, PACKET_MISMATCH for agreement; nothing was computed with it');
    assert.notEqual(r.blocks.reference, 'computed as the criterion of the pair gates; agreement withheld: PACKET_MISMATCH');
    // The block still names the files, the statement and its label; no number in the report rests on the reference.
    assert.ok(r.reference !== 'not declared' && !('withheld' in r.reference) && 'withheld' in r.reference.agreement);
    assert.equal(r.reference.criterion?.referencePackets, label);
    assert.doesNotMatch(JSON.stringify(r), AGREEMENT_NUMBERS);
    assert.deepEqual(Object.keys(spreadOfReport(r).quantities).filter((k) => /reference/.test(k)), []);
  }
  // Without a statement, a one-system roster with equal packets keeps its agreement block: "computed" is true there.
  assert.equal(gateMeasure({ X: lenient['X'] as Bits[string] }).blocks.reference, 'computed');
});

test('two systems with the same verdicts and unknown packets share one reference file: the plan names it twice, the folder holds it once, and every reference number equals the one computed from two copies with distinct bytes', () => {
  // X and Y get the same reference verdicts. With unknown packets a reference file holds nothing else of its system,
  // so the two files are byte-identical and one file serves both.
  const same: Bits = { X: { ref: '111000', old: '110000', new: '111111' }, Y: { ref: '111000', old: '111100', new: '110000' } };
  const twins = gateSetup(same, {}, unknownView);
  assert.equal(twins.plan.systems['X']?.reference, twins.plan.systems['Y']?.reference);
  assert.deepEqual(judgeChangePlanProblems(twins.plan), []);
  const shared = twins.files.filter((f) => f.name !== 'Y.ref.json');
  const r = judgeChangeRuns(shared, barFile, twins.plan);
  assert.equal(r.packetEquality.reference, PACKET_UNKNOWN);
  assert.equal(gateOf(r).pairs.length, 2);
  // The report names the one file for each system that uses it, once per system and never under two names.
  assert.ok(r.reference !== 'not declared' && !('withheld' in r.reference));
  assert.deepEqual(r.reference.inputs.map((i) => [i.system, i.name, i.sha256]), [['X', 'X.ref.json', shaOf(shared.find((f) => f.name === 'X.ref.json') as JudgeChangeInput)], ['Y', 'X.ref.json', shaOf(shared.find((f) => f.name === 'X.ref.json') as JudgeChangeInput)]]);
  // The same content in other bytes is another file: Y's copy, respaced and bound in the plan, gives the same numbers.
  const yRef = twins.files.find((f) => f.name === 'Y.ref.json') as JudgeChangeInput;
  const respaced: JudgeChangeInput = { name: yRef.name, bytes: new TextEncoder().encode(`${JSON.stringify(JSON.parse(new TextDecoder().decode(yRef.bytes)), null, 2)}\n`) };
  const files = twins.files.map((f) => (f === yRef ? respaced : f));
  const plan = { ...twins.plan, systems: { ...twins.plan.systems, Y: { ...(twins.plan.systems['Y'] as { old: string; new: string }), reference: shaOf(respaced) } } };
  const own = judgeChangeRuns(files, barFile, plan);
  assert.equal(own.packetEquality.reference, PACKET_UNKNOWN);
  assert.equal(gateOf(own).pairs.length, 2);
  // Everything but the names, hashes and plan hash of the files is equal.
  const bare = (x: JudgeChangeReport): unknown => {
    const { inputs: _i, planHash: _p, reference, ...rest } = x;
    const { inputs: _r, ...ref } = reference as { inputs: unknown };
    return { ...rest, reference: ref };
  };
  assert.deepEqual(bare(r), bare(own));
  // The reference's own checks still run per system: a shared file that does not cover the scored cases of one system refuses, naming it.
  const short = gateSetup(same, {}, (sys, ref) => ({ ...(unknownView(sys, ref) as ReferenceFile), verdicts: { g1: 'pass' }, packetHashes: { g1: GAP } }));
  assert.throws(
    () => judgeChangeRuns(short.files.filter((f) => f.name !== 'Y.ref.json'), barFile, short.plan),
    (e: unknown) => e instanceof RefusalError && e.code === 'ITEM_SET_MISMATCH' && /the reference of "X" \(X\.ref\.json\)/.test(e.message),
  );
  // A folder that holds the shared file twice, under two names, is refused: the plan binds each file once, and which name the report would carry is not for the order of a folder to say.
  assert.throws(
    () => judgeChangeRuns(twins.files, barFile, twins.plan),
    (e: unknown) => e instanceof RefusalError && e.code === 'HASH_MISMATCH' && e.fields.join() === 'X.ref.json,Y.ref.json' && /the same bytes under two names: X\.ref\.json, Y\.ref\.json/.test(e.message),
  );
  // A file the plan does not name still refuses, and so does a roster entry with no file.
  const stranger = { name: 'extra.json', bytes: new TextEncoder().encode('{}') };
  assert.throws(() => judgeChangeRuns([...shared, stranger], barFile, twins.plan), (e: unknown) => e instanceof RefusalError && e.code === 'HASH_MISMATCH' && /not in the plan's roster/.test(e.message));
  assert.throws(
    () => judgeChangeRuns(shared.filter((f) => f.name !== 'X.ref.json'), barFile, twins.plan),
    (e: unknown) => e instanceof RefusalError && e.code === 'HASH_MISMATCH' && e.fields.join() === 'X (reference), Y (reference)' && /no input file has the sha256 the plan declares for/.test(e.message),
  );
});

test('a run file is never shared: named for two systems, or as the old and the new run of one, the plan is refused with the short message; a reference file may not be a run file either', () => {
  const a = setup().plan.systems['A'] as { old: string; new: string; reference?: string };
  const runTwice = planProblems({ systems: { A: a, B: { old: a.old, new: hashOf('x') } } });
  assert.ok(runTwice.some((p) => p === 'plan.systems.B.old: the same file as plan.systems.A.old; each file enters the roster once'), runTwice.join(' | '));
  const oldAsNew = planProblems({ systems: { A: { old: a.old, new: a.old } } });
  assert.ok(oldAsNew.some((p) => p === 'plan.systems.A.new: the same file as plan.systems.A.old; each file enters the roster once'), oldAsNew.join(' | '));
  const [x, y, z] = [hashOf('x'), hashOf('y'), hashOf('z')];
  // Two systems may name one reference; a reference may not also be a run, whichever comes first.
  assert.deepEqual(planProblems({ systems: { A: { old: x, new: y, reference: z }, B: { old: hashOf('p'), new: hashOf('q'), reference: z } } }), []);
  const refAsRun = planProblems({ systems: { A: { old: x, new: y, reference: z }, B: { old: z, new: hashOf('q'), reference: hashOf('r') } } });
  assert.ok(refAsRun.some((p) => p === 'plan.systems.B.old: the same file as plan.systems.A.reference; each file enters the roster once'), refAsRun.join(' | '));
  const runAsRef = planProblems({ systems: { A: { old: x, new: y, reference: hashOf('r') }, B: { old: hashOf('p'), new: hashOf('q'), reference: x } } });
  assert.ok(runAsRef.some((p) => p === 'plan.systems.B.reference: the same file as plan.systems.A.old; each file enters the roster once'), runAsRef.join(' | '));
});

test('ledger: a judge-change record of a plan whose systems share one reference file validates, lists that file once, and the binding still refuses a reference that the report does not name', () => {
  const same: Bits = { X: { ref: '111000', old: '110000', new: '111111' }, Y: { ref: '111000', old: '111100', new: '110000' } };
  const twins = gateSetup(same, {}, unknownView);
  const files = twins.files.filter((f) => f.name !== 'Y.ref.json');
  const report = judgeChangeRuns(files, barFile, twins.plan);
  const record = makeJudgeChangeRecord({ planFile: bytesOf(twins.plan), barFile: BAR_BYTES, report, at: AT });
  assert.deepEqual(validateRecord(JSON.parse(JSON.stringify(record))), []);
  const refSha = twins.plan.systems['X']?.reference as string;
  assert.deepEqual(record.measurement.files.filter((f) => f.role === 'reference'), [{ role: 'reference', sha256: refSha }]);
  assert.equal(record.measurement.files.filter((f) => f.role === 'run').length, 4);
  // The one file listed twice is still refused, and so is a reference the report does not list.
  problemsOf(rebound(record, (m) => ({ ...m, files: inOrder([...m.files, { role: 'reference', sha256: refSha }]) })), 'listed twice');
  problemsOf(rebound(record, (m) => ({ ...m, files: inOrder([...m.files, { role: 'reference', sha256: sha256Hex('another reference') }]) })), 'the reference files must be exactly the references of result.reference.inputs');
  problemsOf(rebound(record, (m) => ({ ...m, files: m.files.filter((f) => f.role !== 'reference') })), 'the reference files must be exactly the references of result.reference.inputs');
});

test('a stated packet difference: the reference is the criterion of the pair gates, every row built on it is labelled, and agreement is withheld, the plain share included', () => {
  const base = gateMeasure(lenient, resampling(3, 200));
  const r = gateMeasure(lenient, resampling(3, 200), groupedView);
  const g = gateOf(r);
  const b = gateOf(base);
  // The gates against the reference are the ones worked by hand above; each row and the counts carry the label.
  assert.deepEqual(g.pairs, b.pairs.map((p) => ({ ...p, referencePackets: DIFFERENT })));
  assert.equal(g.pairs.map((p) => (p.reference?.state ?? '?')[0]).join(''), 'PIIRPP');
  assert.deepEqual(g.reference, {
    referencePackets: DIFFERENT,
    notPass: 3,
    regression: 1,
    inconclusive: 2,
    passDoNothing: 3,
    passRejudged: 0,
    net: 3,
    onlyDoNothing: 3,
    onlyRejudged: 0,
    notPassedNet: -1,
    referenceRegressionPassed: [{ baseline: 'Y', candidate: 'Z', passedBy: ['doNothing'] }],
  });
  // What does not depend on the reference is as it was, and carries no label.
  assert.deepEqual(g.counts, b.counts);
  assert.deepEqual([r.perDrawPassRate, r.labelPassRate, r.flips], [base.perDrawPassRate, base.labelPassRate, base.flips]);
  // The reference block: its files, the statement with its source, and no agreement statistic.
  assert.ok(r.reference !== 'not declared' && !('withheld' in r.reference));
  assert.deepEqual(Object.keys(r.reference).sort(), ['agreement', 'criterion', 'inputs']);
  assert.deepEqual(r.reference.criterion, { verdictRule: "the fixture's own pass mark", referencePackets: DIFFERENT, quote: difference.quote, source: difference.source });
  assert.deepEqual(r.reference.agreement, {
    withheld: 'PACKET_MISMATCH',
    detail: 'reference saw a different packet: no agreement statistic with it is computed; kappa, AC1, their intervals and the plain agreeing share and count are withheld',
  });
  assert.deepEqual(r.reference.inputs.map((f) => [f.system, f.name, f.packetBasis]), [['X', 'X.ref.json', 'recorded'], ['Y', 'Y.ref.json', 'recorded'], ['Z', 'Z.ref.json', 'recorded']]);
  // Nowhere in the report: not at the point, not in the spread, not as an interval.
  assert.doesNotMatch(JSON.stringify(r), AGREEMENT_NUMBERS);
  assert.match(JSON.stringify(base), AGREEMENT_NUMBERS);
  const q = spreadOfReport(r).quantities;
  const qb = spreadOfReport(base).quantities;
  assert.deepEqual(Object.keys(q), Object.keys(qb).filter((k) => !/agreement|kappa|AC1/.test(k)));
  assert.equal(Object.keys(qb).length - Object.keys(q).length, 7);
  for (const k of Object.keys(q)) assert.deepEqual(q[k], REF_GATE_ROWS.includes(k) ? { ...qb[k], referencePackets: DIFFERENT } : qb[k], k);
  assert.deepEqual(Object.keys(q).filter((k) => 'referencePackets' in (q[k] as object)), REF_GATE_ROWS);
  assert.deepEqual(r.packetEquality, { judges: 'observed', reference: DIFFERENT });
  assert.deepEqual(r.blocks, { gate: 'computed', resampling: 'computed', map: 'not declared', reference: 'computed as the criterion of the pair gates; agreement withheld: PACKET_MISMATCH' });
  assert.ok(r.notes.includes("reference saw a different packet: a count that sets a judge's gate against the reference's reflects the two views as well as the judge, and no agreement statistic with this reference is computed"));
  // Without a resampling block there is still no agreement, and nothing claims an interval was merely not declared.
  const plain = gateMeasure(lenient, {}, groupedView);
  assert.doesNotMatch(JSON.stringify(plain), AGREEMENT_NUMBERS);
  // The plan still binds the reference by the sha256 of its bytes: the statement cannot be added to a bound file.
  const bound = gateSetup(lenient);
  const edited = rebindReferences(bound, groupedView);
  refused('HASH_MISMATCH', 'X.ref.json', () => judgeChangeRuns(edited.files, barFile, bound.plan));
  // Declared hashes that differ are a stated difference too; the files say that the hashes were declared.
  const declared = gateMeasure(lenient, {}, (s, ref) => ({ ...(groupedView(s, ref) as object), packetBasis: 'declared', packetSource: 'the rating protocol' }));
  assert.deepEqual(gateOf(declared).reference, g.reference);
  assert.ok(declared.reference !== 'not declared' && !('withheld' in declared.reference) && declared.reference.inputs.every((f) => f.packetBasis === 'declared' && f.packetSource === 'the rating protocol'));
});

test('a reference whose packets are stated to be unknown carries its own label, "reference packet unknown", and no agreement', () => {
  const base = gateMeasure(lenient, resampling(3, 200));
  const r = gateMeasure(lenient, resampling(3, 200), unknownView);
  const g = gateOf(r);
  assert.deepEqual(g.pairs, gateOf(base).pairs.map((p) => ({ ...p, referencePackets: PACKET_UNKNOWN })));
  assert.deepEqual(g.reference, { ...(gateOf(base).reference as object), referencePackets: PACKET_UNKNOWN });
  assert.ok(r.reference !== 'not declared' && !('withheld' in r.reference));
  assert.deepEqual(r.reference.criterion, { verdictRule: "the fixture's own pass mark", referencePackets: PACKET_UNKNOWN, quote: 'The view each rater was given was not kept.', source: 'the rating protocol, section 2' });
  assert.deepEqual(r.reference.agreement, {
    withheld: 'PACKET_MISMATCH',
    detail: 'reference packet unknown: no agreement statistic with it is computed; kappa, AC1, their intervals and the plain agreeing share and count are withheld',
  });
  assert.deepEqual(r.reference.inputs.map((f) => f.packetBasis), [GAP, GAP, GAP]);
  assert.doesNotMatch(JSON.stringify(r), AGREEMENT_NUMBERS);
  assert.doesNotMatch(JSON.stringify(r), /saw a different packet/);
  const q = spreadOfReport(r).quantities;
  assert.deepEqual(Object.keys(q).filter((k) => (q[k] as { referencePackets?: string }).referencePackets === PACKET_UNKNOWN), REF_GATE_ROWS);
  assert.deepEqual(r.packetEquality, { judges: 'observed', reference: PACKET_UNKNOWN });
  assert.equal(r.blocks.reference, 'computed as the criterion of the pair gates; agreement withheld: PACKET_MISMATCH');
  assert.ok(r.notes.some((n) => n.startsWith('reference packet unknown: a count that sets a judge\'s gate against the reference\'s reflects the two views')));
});

test('no statement: unknown or differing reference packets withhold every reference row as PACKET_MISMATCH, exactly as before; equal packets carry no label', () => {
  const noStatement = (edit: RefEdit): RefEdit => (s, r) => {
    const { packetDifference: _d, ...rest } = edit(s, r) as ReferenceFile;
    return rest;
  };
  const base = gateMeasure(lenient, resampling(3, 200));
  for (const [name, edit, first] of [['differing', groupedView, 'X/g1'], ['unknown', unknownView, 'X: packetBasis is UNKNOWN, X/g1']] as const) {
    const r = gateMeasure(lenient, resampling(3, 200), noStatement(edit));
    const withheld = { withheld: 'PACKET_MISMATCH', detail: `the reference's packets are unknown or differ from the judges' on: ${first}` };
    assert.ok(r.reference !== 'not declared' && 'withheld' in r.reference && r.reference.detail.startsWith(withheld.detail), name);
    assert.equal(r.reference.withheld, 'PACKET_MISMATCH', name);
    const g = gateOf(r);
    assert.deepEqual(g.reference, r.reference, name);
    assert.ok(g.pairs.every((p) => !('reference' in p) && !('referencePackets' in p)), name);
    assert.deepEqual([r.blocks.reference, r.packetEquality.reference], ['withheld: PACKET_MISMATCH', 'withheld: PACKET_MISMATCH'], name);
    // A reference that was declared and withheld is not "not declared": the row says so as the blocks do.
    assert.notEqual(r.packetEquality.reference, 'not declared', name);
    const json = JSON.stringify(r);
    assert.doesNotMatch(json, AGREEMENT_NUMBERS, name);
    assert.doesNotMatch(json, /referencePackets|criterion|saw a different packet|reference packet unknown/, name);
    assert.deepEqual(g.counts, gateOf(base).counts, name);
  }
  // Equal packets and no statement: the report has no label, no criterion block, and its agreement block.
  assert.doesNotMatch(JSON.stringify(base), /referencePackets|criterion|saw a different packet|reference packet unknown/);
  assert.deepEqual(Object.keys(base.reference as object), ['inputs', 'agreement']);
  assert.equal(agreementWith(base).old.agree, 13);
});

test('a case no judge was shown (the system failed on every draw): an unknown reference packet for it still withholds the reference; a known one has nothing to be compared with and withholds nothing', () => {
  /** The gate fixture with the system's failure on every draw of X/g6, in both runs: no judge was shown that case. */
  const noJudgeShown = (refPacket: string): { files: JudgeChangeInput[]; plan: JudgeChangePlan } => {
    const { files, plan } = gateSetup(lenient);
    const moved = new Map<string, string>();
    const edited = files.map((f) => {
      if (!f.name.startsWith('X.')) return f;
      const json = JSON.parse(new TextDecoder().decode(f.bytes)) as Record<string, unknown>;
      if (f.name === 'X.ref.json') (json['packetHashes'] as Record<string, string>)['g6'] = refPacket;
      else json['draws'] = (json['draws'] as Draw[]).map((d) => (d.caseId === 'g6' ? { ...d, attempts: [failedAttempt('system-error')] } : d));
      const next = file(f.name, json);
      moved.set(shaOf(f), shaOf(next));
      return next;
    });
    const at = (h: string): string => moved.get(h) ?? h;
    const systems = Object.fromEntries(Object.entries(plan.systems).map(([name, s]) => [name, { old: at(s.old), new: at(s.new), ...(s.reference === undefined ? {} : { reference: at(s.reference) }) }]));
    return { files: edited, plan: { ...plan, systems } };
  };
  // Unknown is never compared, even where there is no judge packet to differ from: the reference is withheld, and the case is named.
  const unknown = noJudgeShown(GAP);
  const u = judgeChangeRuns(unknown.files, barFile, unknown.plan);
  assert.ok(u.reference !== 'not declared' && 'withheld' in u.reference, JSON.stringify(u.reference));
  assert.deepEqual([u.reference.withheld, u.reference.detail], ['PACKET_MISMATCH', "the reference's packets are unknown or differ from the judges' on: X/g6"]);
  assert.equal(u.blocks.reference, 'withheld: PACKET_MISMATCH');
  // A known reference packet for that case: no judge packet exists to compare it with, so it is no problem, and the reference is read.
  const known = noJudgeShown(sha256Hex('what the rater was shown for g6'));
  const k = judgeChangeRuns(known.files, barFile, known.plan);
  assert.ok(k.reference !== 'not declared' && !('withheld' in k.reference), JSON.stringify(k.reference));
  assert.equal(k.blocks.reference, 'computed');
  assert.equal(agreementWith(k).items, 18);
  // The fixture as it stands (every case shown to both judges) is read too, so the two reports above differ in that one case alone.
  assert.equal(gateMeasure(lenient).blocks.reference, 'computed');
});

test('supplied tie-break draws and resample indices with an unpaired surrogate are invalid: the place is named, and an unknown key is printed as an escape', () => {
  const u = { estimate: { A: { 'c\ud800': 0.5, c2: 0.25 } } };
  const tie = tieBreakProblems({ schema: TIE_BREAK_SCHEMA, u: { old: u, new: u } });
  // The shape is a good one (system → case id → number): only the walk for ill-formed text sees the key.
  assert.deepEqual(tie.map((p) => p.slice(0, p.indexOf(' holds'))), ['tieBreak.u.old.estimate.A: the object key "c\\ud800"', 'tieBreak.u.new.estimate.A: the object key "c\\ud800"']);
  assert.deepEqual(tieBreakProblems({ schema: TIE_BREAK_SCHEMA, u: { old: { estimate: { A: { c1: 0.5 } } }, new: { estimate: { A: { c1: 0.5 } } } } }), []);
  const scored = Array.from({ length: 41 }, () => [0, 1]);
  assert.deepEqual(resampleProblems({ schema: RESAMPLE_SCHEMA, scored, fitOnly: [] }), []);
  const res = resampleProblems({ schema: RESAMPLE_SCHEMA, scored, fitOnly: [], 'k\ud800': 1 });
  // The unknown key is named twice, and both names can be printed: as a field nobody knows, and as text that is not text.
  assert.deepEqual(res.map((p) => p.replace(/ holds an unpaired surrogate.*$/, ' holds')), ['resample."k\\ud800": unknown field', 'resample: the object key "k\\ud800" holds']);
  assert.ok(res.every((p) => p.isWellFormed()));
  const inRow = resampleProblems({ schema: RESAMPLE_SCHEMA, scored: [...scored, ['\udc00']], fitOnly: [] });
  assert.ok(inRow.some((p) => p.startsWith('resample.scored[41][0]: holds an unpaired surrogate')), inRow.join(' | '));
  // A key that is text is printed as it is, as before.
  assert.deepEqual(resampleProblems({ schema: RESAMPLE_SCHEMA, scored, fitOnly: [], extra: 1 }), ['resample.extra: unknown field']);
  assert.deepEqual(extraKeys({ a: 1, 'b c': 2, 'd\ud800': 3 }, ['a'], 'x'), ['x.b c: unknown field', 'x."d\\ud800": unknown field']);
});

// With unknown packets a reference file holds nothing of its system but the verdicts, and the roster takes a file
// once: the two systems get different verdicts here, so that their reference files stay two files.
const mapFixtureTwo: MapGrades = { ...mapFixture, B: { ...mapFixture['B'], [kf]: g3('544', '111', '1') } };

test('a stated packet difference in the map block: the rows against the reference, the placebo rows, the seeds table and the spread carry the label', () => {
  // The counts worked by hand in the map's own test, each under the label.
  const byHand = rebindReferences(mapSetup(mapFixture), groupedView);
  assert.deepEqual(mapOf(judgeChangeRuns(byHand.files, barFile, byHand.plan)).reference, {
    referencePackets: DIFFERENT,
    passRecalibrated: 0,
    passRejudgedCut: 1,
    net: -1,
    onlyRecalibrated: 0,
    onlyRejudgedCut: 1,
    notPassedNet: 0,
    doNothingMinusRejudgedCut: -1,
    doNothingMinusRecalibrated: 0,
    doNothingNotPassedNet: 0,
    rejudgedMajorityMinusCut: 0,
    referenceRegressionPassed: [],
  });
  const setupOf = mapSetup(mapFixtureTwo, resampling(3, 60));
  const base = judgeChangeRuns(setupOf.files, barFile, setupOf.plan);
  for (const [edit, label] of [[groupedView, DIFFERENT], [unknownView, PACKET_UNKNOWN]] as const) {
    const stated = rebindReferences(setupOf, edit);
    const r = judgeChangeRuns(stated.files, barFile, stated.plan);
    const m = mapOf(r);
    const mb = mapOf(base);
    // The same counts as with the judges' own packets, each under the label.
    assert.deepEqual(m.reference, { ...(mb.reference as object), referencePackets: label });
    assert.equal(typeof (m.reference as { net: unknown }).net, 'number');
    assert.deepEqual(gateOf(r).pairs, gateOf(base).pairs.map((p) => ({ ...p, referencePackets: label })));
    assert.deepEqual(m.placebo, { old: { net: 0, onlyReask: 0, onlyEstimate: 0, referenceNet: 0, referencePackets: label }, new: { net: 0, onlyReask: 0, onlyEstimate: 0, referenceNet: 0, referencePackets: label } });
    // The reference-free rows are untouched.
    assert.deepEqual([m.pairs, m.counts, m.cuts, m.perSystem], [mb.pairs, mb.counts, mb.cuts, mb.perSystem]);
    const mapRefRows = [
      'of the pairs the reference gate does not pass, passed by recalibrating minus by re-judging with the cut',
      'of those, passed by doing nothing minus by re-judging with the cut',
      'of those, passed by doing nothing minus by recalibrating',
      'placebo, old judge: the same among pairs the reference gate does not pass',
      'placebo, new judge: the same among pairs the reference gate does not pass',
    ];
    const seeds = m.overTieBreakSeeds.quantities;
    assert.deepEqual(Object.keys(seeds), Object.keys(mb.overTieBreakSeeds.quantities));
    for (const k of Object.keys(seeds)) assert.deepEqual(seeds[k], mapRefRows.includes(k) ? { ...mb.overTieBreakSeeds.quantities[k], referencePackets: label } : mb.overTieBreakSeeds.quantities[k], k);
    const q = spreadOfReport(r).quantities;
    const qb = spreadOfReport(base).quantities;
    assert.deepEqual(Object.keys(q), Object.keys(qb).filter((k) => !/agreement|kappa|AC1/.test(k)));
    for (const k of Object.keys(q)) assert.deepEqual(q[k], [...REF_GATE_ROWS, ...mapRefRows].includes(k) ? { ...qb[k], referencePackets: label } : qb[k], k);
    assert.equal(Object.keys(q).filter((k) => 'referencePackets' in (q[k] as object)).length, 8);
    assert.deepEqual(spreadOfReport(r).map, spreadOfReport(base).map);
    assert.doesNotMatch(JSON.stringify(r), AGREEMENT_NUMBERS);
    // A ledger record takes the report as it is.
    const record = makeJudgeChangeRecord({ planFile: bytesOf(stated.plan), barFile: BAR_BYTES, report: r });
    assert.deepEqual(validateRecord(JSON.parse(JSON.stringify(record))), []);
  }
  // Without a statement the same files withhold the map's reference rows, as before.
  const silent = rebindReferences(setupOf, (s, ref) => ({ ...(groupedView(s, ref) as object), packetDifference: undefined }));
  const w = mapOf(judgeChangeRuns(silent.files, barFile, silent.plan));
  assert.ok(typeof w.reference === 'object' && 'withheld' in w.reference && w.reference.withheld === 'PACKET_MISMATCH');
  assert.deepEqual(w.placebo, { old: { net: 0, onlyReask: 0, onlyEstimate: 0 }, new: { net: 0, onlyReask: 0, onlyEstimate: 0 } });
});

test('anchorset judge-change with a stated packet difference: every reference line says so, and one line says agreement is withheld', () => {
  for (const [name, edit, label] of [['different', groupedView, DIFFERENT], ['unknown', unknownView, PACKET_UNKNOWN]] as const) {
    const { files, plan } = rebindReferences(mapSetup(mapFixtureTwo, resampling(5, 60)), edit);
    const dir = mkdtempSync(join(tmp, `stated-${name}-`));
    for (const f of files) writeFileSync(join(dir, f.name), f.bytes);
    writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
    writeFileSync(join(dir, 'bar.json'), JSON.stringify(barFile));
    const flags = ['--plan', join(dir, 'plan.json'), '--bar', join(dir, 'bar.json'), '--inputs', dir];
    const r = cli('judge-change', ...flags);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.split('\n');
    const one = (re: RegExp): string => {
      const hit = lines.filter((l) => re.test(l));
      assert.equal(hit.length, 1, `${re}: ${hit.length} line(s)\n${r.stdout}`);
      return hit[0] as string;
    };
    assert.equal(one(/^reference: /), `reference: the criterion of the pair gates only · reference verdicts: the fixture's own pass mark · ${label}`);
    assert.equal(one(/stated in the reference files/), `  stated in the reference files: "${name === 'different' ? difference.quote : 'The view each rater was given was not kept.'}" (the rating protocol, section 2)`);
    assert.equal(one(/agreement with the reference/), `  agreement with the reference: withheld (PACKET_MISMATCH): ${label}: no agreement statistic with it is computed; kappa, AC1, their intervals and the plain agreeing share and count are withheld`);
    assert.doesNotMatch(r.stdout, /agrees on|kappa \d|AC1 \d|packets equal|brackets:|no brackets/);
    // The pair table, and every count built on the reference gate, in the main block and in the map block.
    const pairRows = lines.filter((l) => /^ {2}[AB] +[AB] +\d+\/\d+ .* \d+\/\d+ .* \d+\/\d+ /.test(l));
    assert.equal(pairRows.length, 2, r.stdout);
    for (const l of pairRows) assert.ok(l.endsWith(` INCONCLUSIVE · ${label}`), l);
    for (const re of [
      /the reference gate does not pass 2 pair\(s\): REGRESSION 0, INCONCLUSIVE 2/,
      /of those, passed by doing nothing 0 · by re-judging 1 · net -1/,
      /of the pairs it passes, not passed by doing nothing minus not passed by re-judging: 0/,
      /pairs it calls REGRESSION that a gate passes \(0\)/,
      /of the pairs the reference gate does not pass: passed by recalibrating 0 · by re-judging with the cut 1 · net -1/,
      /passed by doing nothing minus by re-judging with the cut: -1 · minus by recalibrating: 0/,
      /passed by re-judging on majority labels minus with the cut: 0/,
      /of the pairs it passes, not passed by recalibrating minus not passed by re-judging with the cut: 0/,
      /pairs it calls REGRESSION that a cut gate passes \(0\)/,
      /^ {4}old judge: passed from the re-ask set only 0 .* net among pairs the reference gate does not pass 0/,
      /^ {4}new judge: passed from the re-ask set only 0 .* net among pairs the reference gate does not pass 0/,
    ]) assert.ok(one(re).endsWith(` · ${label}`), one(re));
    // The seeds table and the spread table: the rows against the reference, and only those.
    const labelled = lines.filter((l) => l.endsWith(`  ${label}`));
    assert.equal(labelled.length, 5 + 8, r.stdout);
    assert.equal(labelled.filter((l) => l.includes('reference gate does not pass') || l.includes('of those, ') || l.includes('of the pairs it passes')).length, 13);
    assert.equal(lines.filter((l) => l.includes(label)).length, 1 + 1 + 2 + 11 + 13 + 1, r.stdout);
    assert.ok(lines.includes('  reference   computed as the criterion of the pair gates; agreement withheld: PACKET_MISMATCH'));
    assert.ok(lines.includes(`note: ${label}: a count that sets a judge's gate against the reference's reflects the two views as well as the judge, and no agreement statistic with this reference is computed`));
    assert.doesNotMatch(r.stdout, name === 'different' ? /reference packet unknown/ : /saw a different packet/);
    // The JSON on stdout is the same report.
    const j = cli('judge-change', ...flags, '--json');
    assert.equal(j.status, 0, j.stderr);
    const out = JSON.parse(j.stdout) as JudgeChangeReport;
    assert.equal(out.packetEquality.reference, label);
    assert.doesNotMatch(j.stdout, AGREEMENT_NUMBERS);
  }
});

// ---- names like a property of Object.prototype, and integers too large to be read exactly ----

test('refusal UNSUPPORTED_DESIGN: a measured class named like a property of Object.prototype is not a class of the bar', () => {
  for (const name of ['constructor', 'toString', '__proto__']) {
    assert.throws(() => measure({}, { measuredClass: name }), (e: unknown) => {
      assert.ok(e instanceof RefusalError && e.code === 'UNSUPPORTED_DESIGN', String(e));
      assert.match(e.message, new RegExp(`the bar has no class "${name}"`));
      return true;
    }, name);
  }
});

test('supplied tie-break draws: an item the file leaves out is lacking, also for a case named like a property of Object.prototype', () => {
  // The fixture of the map, with its last case renamed "constructor".
  const ids = [ka, kb, kc, kd, ke, 'constructor'];
  const grades: MapGrades = Object.fromEntries(Object.entries(mapFixture).map(([s, g]) => [s, Object.fromEntries(Object.values(g).map((v, i) => [ids[i] as string, v]))]));
  const { files, plan } = mapSetup(grades);
  const tieFile = (leaveOut: boolean): JudgeChangeInput => {
    const u = (judge: 'old' | 'new', set: 'estimate' | 'reask') =>
      Object.fromEntries(['A', 'B'].map((s) => [s, Object.fromEntries(ids.filter((id) => !(leaveOut && s === 'A' && judge === 'old' && set === 'estimate' && id === 'constructor')).map((id) => [id, tieBreakU(1, judge, set, s, id)]))]));
    return file('tie.json', { schema: TIE_BREAK_SCHEMA, u: { old: { estimate: u('old', 'estimate'), reask: u('old', 'reask') }, new: { estimate: u('new', 'estimate'), reask: u('new', 'reask') } } });
  };
  const withTie = (f: JudgeChangeInput): JudgeChangePlan => ({ ...plan, map: { ...mapBlock(), tieBreak: { suppliedSha256: shaOf(f), seeds: seeds20 } } });
  const whole = tieFile(false);
  assert.doesNotThrow(() => judgeChangeRuns([...files, whole], barFile, withTie(whole)));
  // An indexed read of the file would find Object.prototype.constructor, and the item would pass for covered.
  const short = tieFile(true);
  refused('ITEM_SET_MISMATCH', 'old.estimate.A.constructor', () => judgeChangeRuns([...files, short], barFile, withTie(short)));
});

test('plan and resample indices: an integer beyond 2^53 - 1 is invalid input in every integer field, with that reason', () => {
  const BIG = 2 ** 53; // what JSON.parse reads 9007199254740993 as
  const resampling = (over: Record<string, unknown>): string[] => planProblems({ resampling: { iterations: 100, seed: 1, spreadFloor: 30, ...over }, oneCasePerCluster: true });
  for (const k of ['iterations', 'seed', 'spreadFloor']) assert.deepEqual(resampling({ [k]: BIG }), [`plan.resampling.${k}: ${INEXACT_INTEGER}`], k);
  assert.deepEqual(resampling({ spreadFloor: Number.MAX_SAFE_INTEGER }), []);
  const fullMap = { encoding: { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5 }, folds: 5, fitOnlyCaseIds: ['x'], tieBreak: { seeds: Array.from({ length: 20 }, (_, i) => i + 1) }, minSystems: 2, minFitItems: 10, maxTieShare: 0.2 };
  for (const k of ['folds', 'minSystems', 'minFitItems']) {
    assert.deepEqual(planProblems({ map: { ...fullMap, [k]: Number.MAX_SAFE_INTEGER }, ...gateBlock }), [], k);
    assert.deepEqual(planProblems({ map: { ...fullMap, [k]: BIG }, ...gateBlock }), [`plan.map.${k}: ${INEXACT_INTEGER}`], k);
  }
  assert.ok(planProblems({ drawsPerCase: BIG }).includes(`plan.drawsPerCase: ${INEXACT_INTEGER}`));
  const rows = Array.from({ length: 41 }, () => [0, 1]);
  assert.deepEqual(resampleProblems({ schema: RESAMPLE_SCHEMA, scored: rows, fitOnly: [] }), []);
  assert.deepEqual(resampleProblems({ schema: RESAMPLE_SCHEMA, scored: [[0, BIG], ...rows.slice(1)], fitOnly: [] }), ['resample.scored: must be a list of rows of case indices']);
});

// A bracket is levelled on the resamples it was read from. Here kappa is undefined on every resample that misses
// the one case the reference fails (five of six cases each time: (5/6)^6 = 0.335 of resamples), so of 1,100
// resamples about 730 are left, below the floor of 1,000, while AC1 is defined on all of them.
test('judge-change: a kappa bracket whose kappa was undefined on enough resamples is marked "no level", and AC1 beside it keeps the level', () => {
  const bits: Bits = { X: { ref: '111110', old: '111111', new: '111110' }, Y: { ref: '111110', old: '111111', new: '111110' } };
  const { files, plan } = gateSetup(bits, resampling(5, 1100));
  const report = judgeChangeRuns(files, barFile, plan);
  const q = spreadOfReport(report).quantities;
  const kappaOld = q['kappa with the reference, old judge'];
  const ac1Old = q['AC1 with the reference, old judge'];
  assert.ok(kappaOld !== undefined && ac1Old !== undefined);
  assert.ok(kappaOld.replicates < 1000 && kappaOld.replicates + kappaOld.undefinedReplicates === 1100, JSON.stringify(kappaOld));
  assert.deepEqual([ac1Old.replicates, ac1Old.undefinedReplicates], [1100, 0]);
  assert.equal(spreadOfReport(report).label, LEVELLED_LABEL);
  const dir = mkdtempSync(join(tmp, 'row-level-'));
  for (const f of files) writeFileSync(join(dir, f.name), f.bytes);
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(dir, 'bar.json'), JSON.stringify(barFile));
  const r = cli('judge-change', '--plan', join(dir, 'plan.json'), '--bar', join(dir, 'bar.json'), '--inputs', dir);
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('  old judge'));
  assert.ok(line !== undefined);
  assert.ok(line.includes(`] (no level: read from ${kappaOld.replicates} resamples, and a level is named from 1000) · AC1 `), line);
  assert.doesNotMatch(line.slice(line.indexOf('· AC1')), /no level/);
});

test('judge-change: a spread row whose kappa is undefined at the point holds NA, the marker of an undefined statistic, for the point and for mean - point; never NaN, which JSON writes as null', () => {
  // The judge and the reference pass every case: one label on both sides, so kappa has no value at the point (AC1 does).
  const bits: Bits = { X: { ref: '111111', old: '111111', new: '111111' }, Y: { ref: '111111', old: '111111', new: '111111' } };
  const { files, plan } = gateSetup(bits, resampling(5, 200));
  const report = judgeChangeRuns(files, barFile, plan);
  const q = spreadOfReport(report).quantities;
  for (const judge of ['old', 'new']) {
    const kappa = q[`kappa with the reference, ${judge} judge`];
    const ac1 = q[`AC1 with the reference, ${judge} judge`];
    assert.ok(kappa !== undefined && ac1 !== undefined);
    assert.equal(kappa.point, 'NA');
    assert.equal(kappa.meanMinusPoint, 'NA');
    assert.equal(kappa.replicates, 0);
    assert.equal(kappa.undefinedReplicates, 200);
    // AC1 is defined there, so its row is numbers.
    assert.equal(typeof ac1.point, 'number');
    assert.equal(typeof ac1.meanMinusPoint, 'number');
  }
  // No row of the report holds a null: the JSON holds the marker.
  const json = JSON.stringify(report);
  assert.doesNotMatch(json, /null/);
  // The text report prints the marker in the row's cells.
  const dir = mkdtempSync(join(tmp, 'row-na-'));
  for (const f of files) writeFileSync(join(dir, f.name), f.bytes);
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(dir, 'bar.json'), JSON.stringify(barFile));
  const r = cli('judge-change', '--plan', join(dir, 'plan.json'), '--bar', join(dir, 'bar.json'), '--inputs', dir);
  assert.equal(r.status, 0, r.stderr);
  const row = r.stdout.split('\n').find((l) => l.startsWith('  kappa with the reference, old judge'));
  assert.ok(row !== undefined, r.stdout);
  assert.match(row, /^ {2}kappa with the reference, old judge\s+NA\s+NA\s+NA\s+NA\s+NA\s+NA\s+NA \/ NA \/ NA\s+200\b/);
});
