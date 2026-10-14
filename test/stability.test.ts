import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flipRate, groupDraws, repeatFlips, unknownOutputHashes } from '../src/stability.ts';
import type { Outcome } from '../src/stability.ts';
import { InputError, RefusalError } from '../src/errors.ts';
import { GAP, sha256Hex } from '../src/identity.ts';
import type { Draw, GradedAttempt } from '../src/scoring.ts';
import { forEachResample, quantileSorted } from '../src/stats.ts';
import { failedAttempt, gradedAttempt, slot, unmeasured } from './helpers.ts';
import { readFileSync } from 'node:fs';
import { measuredSlots } from '../src/scoring.ts';

const L = (label: string): Outcome => ({ kind: 'label', label });
const F: Outcome = { kind: 'failed' };

// The flip share is defined by this library, so the two flipRate tests below are hand-worked fixtures, not
// published reference values; no published reference is claimed. As src/stability.ts states it: a case's outputs
// are its labels, with every failed draw counted as one output; the mode is the most frequent output; a case is
// flipped when it has more than one distinct output; its disagreeing share is the share of draws off the mode;
// the flip share is flipped cases over cases.
//   case  draws                   distinct  mode    off the mode   flipped
//   a     x  x  x                 1         x       0 of 3 = 0     no
//   b     x  y  x  x              2         x (3)   1 of 4 = 0.25  yes
//   c     failed  failed  x       2         failed  (1 of 3; not asserted)  yes
// Flipped cases: b and c = 2. Flip share = 2 of 3 cases = 2/3.
test('flipRate reports distinct outputs, mode and disagreement per case (a hand-worked fixture: 2 of 3 cases flipped)', () => {
  const m = new Map<string, Outcome[]>([
    ['a', [L('x'), L('x'), L('x')]],
    ['b', [L('x'), L('y'), L('x'), L('x')]],
    ['c', [F, F, L('x')]],
  ]);
  const r = flipRate(m);
  const [a, b, c] = r.cases;
  assert.equal(a?.flipped, false);
  assert.equal(a?.disagreeShare, 0);
  assert.equal(b?.distinctOutputs, 2);
  assert.deepEqual(b?.mode, { kind: 'label', label: 'x' });
  assert.equal(b?.disagreeShare, 0.25);
  assert.equal(c?.distinctOutputs, 2);
  assert.deepEqual(c?.mode, { kind: 'failed' });
  assert.equal(r.flippedCases, 2);
  assert.equal(r.flipShare, 2 / 3);
});

// Defined by this library; a hand-worked fixture. One case with draws y, x, x, y: y twice, x twice. The tie goes
// to the output seen first in draw order, which is y. Draws off the mode: the two x of 4 = 0.5.
test('flipRate breaks mode ties by first appearance in draw order (a hand-worked fixture: mode y, 2 of 4 = 0.5 off it)', () => {
  const r = flipRate(new Map([['a', [L('y'), L('x'), L('x'), L('y')]]]));
  assert.deepEqual(r.cases[0]?.mode, { kind: 'label', label: 'y' });
  assert.equal(r.cases[0]?.disagreeShare, 0.5);
});

test('groupDraws orders by drawIndex and reads each slot from its final attempt', () => {
  const g = groupDraws([slot('a', 1, gradedAttempt('y')), slot('a', 0, gradedAttempt('x')), slot('a', 2, failedAttempt('system-error'))], 3, ['a']);
  assert.deepEqual(g.get('a'), [L('x'), L('y'), F]);
  assert.throws(() => flipRate(new Map()));
});

test('flipRate withholds a case with an unmeasured or missing slot, and the share that depends on it', () => {
  const g = groupDraws([slot('a', 0, gradedAttempt('x')), slot('a', 1, unmeasured('system', 'timeout')), slot('a', 2, gradedAttempt('x')), slot('b', 0, gradedAttempt('x')), slot('b', 2, gradedAttempt('y'))], 3, ['a', 'b']);
  const r = flipRate(g);
  const [a, b] = r.cases;
  assert.equal(a?.unmeasured, 1);
  assert.equal(a?.flipped, GAP);
  assert.equal(a?.disagreeShare, GAP);
  assert.equal(b?.unmeasured, 1);
  assert.equal(b?.flipped, GAP);
  assert.equal(r.flipShare, GAP);
  assert.equal(r.withheldCases, 2);
});

test('groupDraws refuses a duplicate slot (a v1-style retry) and a retried measurement, and keeps a case with no draws', () => {
  assert.throws(() => groupDraws([slot('a', 0, gradedAttempt('x')), slot('a', 0, gradedAttempt('y')), slot('a', 1, gradedAttempt('y'))], 2, ['a']), (e: unknown) => e instanceof InputError && e.code === 'INVALID_DRAWS');
  assert.throws(() => groupDraws([slot('a', 0, gradedAttempt('x'), gradedAttempt('y'))], 1, ['a']), (e: unknown) => e instanceof InputError);
  assert.throws(() => groupDraws([slot('a', 5, gradedAttempt('x'))], 2, ['a']), (e: unknown) => e instanceof InputError);
  const g = groupDraws([slot('a', 0, gradedAttempt('x'))], 1, ['a', 'silent']);
  assert.deepEqual(g.get('silent'), [{ kind: 'absent' }]);
  assert.equal(flipRate(g).flipShare, GAP);
});

test('groupDraws refuses an unknown system stop, as the fold does', () => {
  const draws = [slot('a', 0, gradedAttempt('x')), slot('a', 1, { ...gradedAttempt('x'), systemStop: GAP })];
  assert.throws(() => groupDraws(draws, 2, ['a']), (e: unknown) => e instanceof RefusalError && e.code === 'IDENTITY_GAP' && e.fields.includes('systemStop[a#1]'));
});

// --- repeatFlips: label flips among repeat draws, split by whether the draws graded one stored output ---
const BOOT = { iterations: 400, seed: 3, alpha: 0.05 };
const out = (name: string): string => sha256Hex(`stored output ${name}`);
/** One judged draw: the judge was shown PACKET and graded the stored output `output`. */
const judged = (caseId: string, i: number, output: string, label: string, over: Partial<GradedAttempt> = {}) =>
  slot(caseId, i, gradedAttempt(label, { outputHash: out(output), judgeStop: 'tool-use', ...over }));
const three = (caseId: string, outputs: [string, string, string], labels: [string, string, string]) => outputs.map((o, i) => judged(caseId, i, o, labels[i] as string));

// A hand-worked fixture (no published worked example of this share is known): six cases, three draws each.
//   case  outputs        labels            basis               flipped   share of draws off the mode
//   c1    h1  h1  h1     pass pass fail    one output          yes       1/3
//   c2    h2  h2  h2     pass pass pass    one output          no        0
//   c3    h3  h3  h3     fail fail fail    one output          no        0
//   c4    h4a h4b h4a    pass fail pass    different outputs   yes       1/3
//   c5    h5a h5b h5c    pass pass pass    different outputs   no        0
//   c6    the system failed on every draw  ungraded            -         -
// One output:        1 flipped of 3 cases = 0.3333.  Different outputs: 1 of 2 = 0.5.  Ungraded: 1, in neither.
// Pooling the two would give 2 of 5 = 0.4, which is neither number; the report never forms it.
// Wilson 95% (z^2 = 3.8415) on 1 of 3:
//   centre (0.33333 + 3.8415/6) / (1 + 3.8415/3) = 0.97358 / 2.28049 = 0.42692
//   half   (1.95996 / 2.28049) · sqrt(0.33333·0.66667/3 + 3.8415/36) = 0.85945 · sqrt(0.074074 + 0.106707) = 0.85945 · 0.425184 = 0.36542
//   so [0.0615, 0.7923]
// Wilson on 1 of 2:
//   centre (0.5 + 3.8415/4) / (1 + 3.8415/2) = 1.460366 / 2.920729 = 0.5
//   half   (1.95996 / 2.920729) · sqrt(0.25/2 + 3.8415/16) = 0.671052 · sqrt(0.125 + 0.240091) = 0.671052 · 0.604228 = 0.40547
//   so [0.0945, 0.9055]
const fixture = (): Draw[] => [
  ...three('c1', ['h1', 'h1', 'h1'], ['pass', 'pass', 'fail']),
  ...three('c2', ['h2', 'h2', 'h2'], ['pass', 'pass', 'pass']),
  ...three('c3', ['h3', 'h3', 'h3'], ['fail', 'fail', 'fail']),
  ...three('c4', ['h4a', 'h4b', 'h4a'], ['pass', 'fail', 'pass']),
  ...three('c5', ['h5a', 'h5b', 'h5c'], ['pass', 'pass', 'pass']),
  ...[0, 1, 2].map((i) => slot('c6', i, failedAttempt('system-error'))),
];
const fixtureIds = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
const near = (x: unknown, want: number): void => assert.ok(typeof x === 'number' && Math.abs(x - want) < 5e-5, `${String(x)} != ${want}`);

test('repeatFlips, a hand-worked fixture: 1 of 3 one-output cases flipped (0.3333, Wilson [0.0615, 0.7923]); 1 of 2 different-output cases (0.5, Wilson [0.0945, 0.9055]); never pooled', () => {
  const r = repeatFlips(fixture(), 3, fixtureIds, BOOT);
  assert.equal(r.caseCount, 6);
  assert.equal(r.drawsPerCase, 3);
  assert.deepEqual(r.cases.map((c) => [c.caseId, c.basis, c.flipped, c.distinctOutputs]), [
    ['c1', 'one-output', true, 1],
    ['c2', 'one-output', false, 1],
    ['c3', 'one-output', false, 1],
    ['c4', 'different-outputs', true, 2],
    ['c5', 'different-outputs', false, 3],
    ['c6', 'ungraded', false, 1],
  ]);
  near(r.cases[0]?.disagreeShare, 1 / 3);
  assert.equal(r.cases[1]?.disagreeShare, 0);
  assert.deepEqual(r.cases[0]?.outcomes, [{ kind: 'label', label: 'pass' }, { kind: 'label', label: 'pass' }, { kind: 'label', label: 'fail' }]);
  assert.deepEqual([r.oneOutput.cases, r.oneOutput.flipped], [3, 1]);
  near(r.oneOutput.share, 1 / 3);
  assert.ok(r.oneOutput.wilson !== 'NA');
  near(r.oneOutput.wilson.lo, 0.0615);
  near(r.oneOutput.wilson.hi, 0.7923);
  assert.deepEqual([r.differentOutputs.cases, r.differentOutputs.flipped, r.differentOutputs.share], [2, 1, 0.5]);
  assert.ok(r.differentOutputs.wilson !== 'NA');
  near(r.differentOutputs.wilson.lo, 0.0945);
  near(r.differentOutputs.wilson.hi, 0.9055);
  assert.equal(r.ungradedCases, 1);
  // The pooled 2 of 5 is nowhere in the report: it has the two shares and no third.
  assert.deepEqual(Object.keys(r).sort(), ['bootstrap', 'caseCount', 'cases', 'differentOutputs', 'drawsPerCase', 'oneOutput', 'ungradedCases']);
});

// An independent recomputation, not a published reference value: the resamples are drawn again here from the one
// driver and the shares are recomputed in the test. It shares the author's reading of the definition, so it checks the
// arithmetic and not the definition.
test('repeatFlips: the interval is the one bootstrap over all cases of the run, with its seed; the share on a resample is flipped / cases of that basis in the resample', () => {
  const r = repeatFlips(fixture(), 3, fixtureIds, BOOT);
  // The same resamples, drawn here from the one driver, and the statistic worked from the table above.
  const basis = ['one', 'one', 'one', 'diff', 'diff', 'none'];
  const flipped = [true, false, false, true, false, false];
  const values: Record<'one' | 'diff', number[]> = { one: [], diff: [] };
  let undefinedOne = 0;
  forEachResample(BOOT.seed, [6], BOOT.iterations, ([idx]) => {
    for (const b of ['one', 'diff'] as const) {
      const of = (idx as number[]).filter((i) => basis[i] === b);
      if (of.length === 0) {
        if (b === 'one') undefinedOne++;
        continue;
      }
      values[b].push(of.filter((i) => flipped[i]).length / of.length);
    }
  });
  for (const b of ['one', 'diff'] as const) values[b].sort((x, y) => x - y);
  assert.ok(r.oneOutput.bootstrap !== 'NA' && r.differentOutputs.bootstrap !== 'NA');
  assert.deepEqual([r.oneOutput.bootstrap.lo, r.oneOutput.bootstrap.hi], [quantileSorted(values.one, 0.025), quantileSorted(values.one, 0.975)]);
  assert.deepEqual([r.differentOutputs.bootstrap.lo, r.differentOutputs.bootstrap.hi], [quantileSorted(values.diff, 0.025), quantileSorted(values.diff, 0.975)]);
  // A resample that holds no case of the basis has no share: counted, never dropped silently.
  assert.equal(r.oneOutput.bootstrap.undefinedResamples, undefinedOne);
  assert.deepEqual([r.oneOutput.bootstrap.seed, r.oneOutput.bootstrap.iterations, r.oneOutput.bootstrap.alpha], [3, 400, 0.05]);
  assert.deepEqual(r.bootstrap, BOOT);
  for (const s of [r.oneOutput.bootstrap, r.differentOutputs.bootstrap]) assert.ok(s.lo >= 0 && s.hi <= 1 && s.lo <= s.hi);
  // Deterministic per seed; the order of the draws in the file does not matter.
  assert.deepEqual(repeatFlips(fixture().reverse(), 3, fixtureIds, BOOT), r);
  assert.notDeepEqual(repeatFlips(fixture(), 3, fixtureIds, { ...BOOT, seed: 4 }).oneOutput.bootstrap, r.oneOutput.bootstrap);
});

// A hand-worked fixture, not a published reference value. 0 flipped of 18: no resample can hold a flip, so the
// bootstrap is [0, 0] and bounds nothing.
//   Wilson upper = z^2 / (n + z^2) = 3.8415 / 21.8415 = 0.1759
test('repeatFlips with no flip observed: the bootstrap collapses to [0, 0] and is marked degenerate, while Wilson on 0 of 18 still reaches 0.1759', () => {
  const ids = Array.from({ length: 18 }, (_, i) => `k${String(i).padStart(2, '0')}`);
  const r = repeatFlips(ids.flatMap((id) => three(id, [id, id, id], ['pass', 'pass', 'pass'])), 3, ids, BOOT);
  assert.deepEqual([r.oneOutput.cases, r.oneOutput.flipped, r.oneOutput.share], [18, 0, 0]);
  assert.ok(r.oneOutput.bootstrap !== 'NA' && r.oneOutput.bootstrap.lo === 0 && r.oneOutput.bootstrap.hi === 0);
  assert.equal(r.oneOutput.degenerate, true);
  assert.ok(r.oneOutput.wilson !== 'NA');
  near(r.oneOutput.wilson.lo, 0);
  near(r.oneOutput.wilson.hi, 0.1759);
  // No case of the other basis: no share, no interval, nothing invented.
  assert.deepEqual(r.differentOutputs, { cases: 0, flipped: 0, share: 'NA', wilson: 'NA', bootstrap: 'NA', degenerate: false });
});

test('repeatFlips: a case that mixes a graded draw with the system\'s own failure holds different outputs and is flipped; the same output under two stops is not one output', () => {
  const mixed = [judged('a', 0, 'x', 'pass'), slot('a', 1, failedAttempt('truncated')), ...['b', 'c'].flatMap((id) => [judged(id, 0, id, 'pass'), judged(id, 1, id, 'pass')])];
  const r = repeatFlips(mixed, 2, ['a', 'b', 'c'], BOOT);
  assert.deepEqual(r.cases.map((c) => [c.basis, c.flipped]), [['different-outputs', true], ['one-output', false], ['one-output', false]]);
  const stops = [judged('a', 0, 'x', 'pass', { systemStop: 'end' }), judged('a', 1, 'x', 'pass', { systemStop: 'tool-use' })];
  assert.equal(repeatFlips(stops, 2, ['a'], BOOT).cases[0]?.basis, 'different-outputs');
});

test('repeatFlips on a run graded by code: one output is one packet-free grade each, and the shares are formed the same way', () => {
  const code = ['a', 'b'].flatMap((id) => [0, 1].map((i) => slot(id, i, gradedAttempt(id === 'a' && i === 1 ? 'y' : 'x', { outputHash: out(id) }))));
  const r = repeatFlips(code, 2, ['a', 'b'], BOOT);
  assert.deepEqual([r.oneOutput.cases, r.oneOutput.flipped, r.differentOutputs.cases], [2, 1, 0]);
});

test('repeatFlips refuses a run with one draw per case (UNSUPPORTED_DESIGN): one draw cannot flip', () => {
  assert.throws(() => repeatFlips([judged('a', 0, 'x', 'pass')], 1, ['a'], BOOT), (e: unknown) => e instanceof RefusalError && e.code === 'UNSUPPORTED_DESIGN' && e.fields.join() === 'drawsPerCase');
});

test('repeatFlips refuses an unknown output hash (IDENTITY_GAP), naming the draws: draws cannot be shown to share an output nobody hashed', () => {
  const draws = [judged('a', 0, 'x', 'pass'), judged('a', 1, 'x', 'pass', { outputHash: GAP })];
  assert.throws(() => repeatFlips(draws, 2, ['a'], BOOT), (e: unknown) => e instanceof RefusalError && e.code === 'IDENTITY_GAP' && e.fields.join() === 'outputHash[a#1]');
  // The same check on a file not yet parsed, for the command.
  assert.deepEqual(unknownOutputHashes([{ caseId: 'a', drawIndex: 1, attempts: [{ kind: 'graded', outputHash: GAP }] }, { caseId: 'b', drawIndex: 0, attempts: [{ kind: 'graded', outputHash: out('x') }] }, 'junk']), ['a#1']);
  assert.deepEqual(unknownOutputHashes('not draws'), []);
});

test('repeatFlips refuses a slot that measured nothing or has no record (INCOMPLETE_RUN), naming the slots: a missing grade could have been the flip', () => {
  const noGrade = [judged('a', 0, 'x', 'pass'), slot('a', 1, unmeasured('judge', 'parse-failure', out('x')))];
  assert.throws(() => repeatFlips(noGrade, 2, ['a'], BOOT), (e: unknown) => e instanceof RefusalError && e.code === 'INCOMPLETE_RUN' && e.fields.join() === 'a#1');
  const noRecord = [judged('a', 0, 'x', 'pass'), judged('b', 0, 'y', 'pass'), judged('b', 1, 'y', 'pass')];
  assert.throws(() => repeatFlips(noRecord, 2, ['a', 'b', 'silent'], BOOT), (e: unknown) => e instanceof RefusalError && e.code === 'INCOMPLETE_RUN' && e.fields.join() === 'a#1,silent#0,silent#1');
});

test('repeatFlips refuses one output shown in different packets (PACKET_MISMATCH) or in an unknown packet (IDENTITY_GAP): the judge\'s variation alone needs one packet', () => {
  const other = [judged('a', 0, 'x', 'pass'), judged('a', 1, 'x', 'fail', { packetHash: sha256Hex('another packet') })];
  assert.throws(() => repeatFlips(other, 2, ['a'], BOOT), (e: unknown) => e instanceof RefusalError && e.code === 'PACKET_MISMATCH' && e.fields.join() === 'a');
  const unknown = [judged('a', 0, 'x', 'pass', { packetHash: GAP }), judged('a', 1, 'x', 'pass', { packetHash: GAP })];
  assert.throws(() => repeatFlips(unknown, 2, ['a'], BOOT), (e: unknown) => e instanceof RefusalError && e.code === 'IDENTITY_GAP' && e.fields.join() === 'packetHash[a#0],packetHash[a#1]');
  // Where the outputs differ the packets differ with them, and that case is already reported as mixed.
  const mixed = [judged('a', 0, 'x', 'pass'), judged('a', 1, 'y', 'pass', { packetHash: sha256Hex('another packet') })];
  assert.equal(repeatFlips(mixed, 2, ['a'], BOOT).cases[0]?.basis, 'different-outputs');
});

test('repeatFlips refuses an unknown system stop as the fold does, and invalid draws are invalid input', () => {
  const draws = [judged('a', 0, 'x', 'pass'), judged('a', 1, 'x', 'pass', { systemStop: GAP })];
  assert.throws(() => repeatFlips(draws, 2, ['a'], BOOT), (e: unknown) => e instanceof RefusalError && e.code === 'IDENTITY_GAP' && e.fields.includes('systemStop[a#1]'));
  assert.throws(() => repeatFlips([judged('a', 0, 'x', 'pass'), judged('a', 0, 'x', 'pass')], 2, ['a'], BOOT), (e: unknown) => e instanceof InputError && e.code === 'INVALID_DRAWS');
  assert.throws(() => repeatFlips([], 2, [], BOOT), (e: unknown) => e instanceof InputError && e.code === 'EMPTY_SAMPLE');
  assert.throws(() => repeatFlips(fixture(), 3, fixtureIds, { ...BOOT, seed: -1 }), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT');
});

// One measured-slots step in src/: the flip measurement reads a case's slots through the step the fold uses, so a slot
// cannot be measured for one and absent for the other.
test('groupDraws reads every case through measuredSlots: a slot is an outcome exactly where that step measured it, and absent where it lists it unmeasured or missing', () => {
  const draws = [
    slot('a', 2, gradedAttempt('y')), slot('a', 0, gradedAttempt('x')), slot('a', 1, unmeasured('system', 'timeout'), gradedAttempt('x')),
    slot('b', 0, failedAttempt('system-error')), slot('b', 2, unmeasured('system', 'timeout')),
    slot('c', 3, gradedAttempt('x')),
  ];
  const ids = ['a', 'b', 'c', 'silent'];
  const g = groupDraws(draws, 4, ids);
  assert.deepEqual([...g.keys()], ids);
  for (const id of ids) {
    const s = measuredSlots(draws.filter((d) => d.caseId === id), 4);
    const got = g.get(id) as Outcome[];
    assert.equal(got.length, 4, id);
    assert.deepEqual(got.flatMap((o, i) => (o.kind === 'absent' ? [] : [i])), s.measured.map((m) => m.d.drawIndex), id);
    assert.deepEqual(got.flatMap((o, i) => (o.kind === 'absent' ? [i] : [])), [...s.unmeasured.map((u) => u.drawIndex), ...s.missing].sort((x, y) => x - y), id);
    for (const m of s.measured) assert.deepEqual(got[m.d.drawIndex], m.a.kind === 'graded' ? { kind: 'label', label: m.a.label } : { kind: 'failed' }, id);
  }
  assert.deepEqual(g.get('a'), [L('x'), L('x'), L('y'), { kind: 'absent' }]);
  assert.deepEqual(g.get('b'), [F, { kind: 'absent' }, { kind: 'absent' }, { kind: 'absent' }]);
  // A draw count that is not one is refused as the step refuses it, never read as "no slots".
  for (const bad of [0, -1, 1.5]) {
    assert.throws(() => groupDraws([], bad, ['a']), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && /drawsPerCase/.test(e.problems.join()), String(bad));
  }
  // The source holds the one step: stability.ts calls it and classifies no attempt as measured or not on its own.
  const src = readFileSync(new URL('../src/stability.ts', import.meta.url), 'utf8');
  assert.match(src, /measuredSlots\(/);
  assert.doesNotMatch(src, /kind === 'unmeasured'/);
});
