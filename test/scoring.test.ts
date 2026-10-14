import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOT_SENT } from '../src/callshape.ts';
import { GAP, NO_JUDGE } from '../src/identity.ts';
import { InputError, RefusalError } from '../src/errors.ts';
import { attemptsProblems, finalAttempt, foldDraws, foldRun, measuredSlots, rank, scoreAttempt, slotProblems, unknownStops, validateLabelSet } from '../src/scoring.ts';
import type { Attempt, Case, ClassSpec, Draw } from '../src/scoring.ts';
import { failedAttempt, gradedAttempt, slot, unmeasured } from './helpers.ts';

const labels = ['none', 'review', 'handoff'];
const floor: ClassSpec = { direction: 'floor' };
const ceiling: ClassSpec = { direction: 'ceiling' };
const up: Case = { id: 'c1', klass: 'k', input: { message: 'x' }, expect: 'review' };
const outcome = (x: string | Attempt): Attempt => (typeof x === 'string' ? gradedAttempt(x) : x);
const d = (x: string | Attempt, drawIndex = 0, caseId = 'c1'): Draw => slot(caseId, drawIndex, outcome(x));
const draws = (...outs: (string | Attempt)[]): Draw[] => outs.map((o, i) => d(o, i));
const label = (dr: Draw): string => {
  const a = finalAttempt(dr);
  return a.kind === 'graded' ? a.label : `failed:${a.reason}`;
};

test('rank orders labels and rejects unknown labels with a typed error', () => {
  assert.equal(rank(labels, 'none'), 0);
  assert.equal(rank(labels, 'handoff'), 2);
  assert.throws(() => rank(labels, 'maybe'), (e: unknown) => e instanceof InputError && e.code === 'UNKNOWN_LABEL');
});

test('scoreAttempt: floor passes at or above, ceiling at or below, a failed attempt never passes', () => {
  assert.equal(scoreAttempt(up, gradedAttempt('review'), labels, floor), true);
  assert.equal(scoreAttempt(up, gradedAttempt('handoff'), labels, floor), true);
  assert.equal(scoreAttempt(up, gradedAttempt('none'), labels, floor), false);
  assert.equal(scoreAttempt(up, gradedAttempt('none'), labels, ceiling), true);
  assert.equal(scoreAttempt(up, gradedAttempt('handoff'), labels, ceiling), false);
  for (const reason of ['truncated', 'client-error', 'system-error'] as const) {
    assert.equal(scoreAttempt(up, failedAttempt(reason), labels, floor), false);
    assert.equal(scoreAttempt(up, failedAttempt(reason), labels, ceiling), false);
  }
  assert.throws(() => scoreAttempt(up, gradedAttempt('maybe'), labels, floor), InputError);
});

test('foldDraws floor: worst-of-N attributes the lowest-ranked draw', () => {
  const f = foldDraws(up, draws('handoff', 'none', 'review'), labels, floor, 3);
  assert.equal(f.pass, false);
  assert.equal(f.attributedDraw.drawIndex, 1);
  assert.equal(label(f.attributedDraw), 'none');
  assert.equal(f.drawCount, 3);
  const ok = foldDraws(up, draws('handoff', 'review', 'handoff'), labels, floor, 3);
  assert.equal(ok.pass, true);
  assert.equal(label(ok.attributedDraw), 'review');
});

test('foldDraws ceiling: worst-of-N attributes the highest-ranked draw', () => {
  const f = foldDraws(up, draws('none', 'handoff', 'review'), labels, ceiling, 3);
  assert.equal(f.pass, false);
  assert.equal(label(f.attributedDraw), 'handoff');
  const ok = foldDraws(up, draws('none', 'review', 'none'), labels, ceiling, 3);
  assert.equal(ok.pass, true);
  assert.equal(ok.attributedDraw.drawIndex, 1);
});

// The count of failing draws is defined by this library (a draw fails when scoreAttempt says so; the fold counts
// them in its one pass). A hand-worked fixture, not a published reference value. Labels in order: none (rank 0),
// review (1), handoff (2); the case expects review.
//   floor (a draw passes at rank >= 1):
//     handoff, none, review     -> pass, FAIL, pass                 1 of 3
//     none, none, none          -> FAIL, FAIL, FAIL                 3 of 3
//     handoff, review, handoff  -> pass, pass, pass                 0 of 3, and the case passes
//     handoff, truncated, none  -> pass, FAIL (a failed attempt never passes), FAIL    2 of 3
//   ceiling (a draw passes at rank <= 1):
//     none, handoff, handoff    -> pass, FAIL, FAIL                 2 of 3
test('foldDraws: failingDraws is the number of draws that fail on their own, a hand-worked fixture: 1 of 3, 3 of 3, 0 of 3, 2 of 3, and 2 of 3 under a ceiling', () => {
  const count = (f: { failingDraws: number; drawCount: number }): [number, number] => [f.failingDraws, f.drawCount];
  assert.deepEqual(count(foldDraws(up, draws('handoff', 'none', 'review'), labels, floor, 3)), [1, 3]);
  assert.deepEqual(count(foldDraws(up, draws('none', 'none', 'none'), labels, floor, 3)), [3, 3]);
  assert.deepEqual(count(foldDraws(up, draws('handoff', 'review', 'handoff'), labels, floor, 3)), [0, 3]);
  assert.deepEqual(count(foldDraws(up, draws('handoff', failedAttempt('truncated'), 'none'), labels, floor, 3)), [2, 3]);
  assert.deepEqual(count(foldDraws(up, draws('none', 'handoff', 'handoff'), labels, ceiling, 3)), [2, 3]);
  // The attributed draw is one of the failing ones, so the count is at least 1 whenever the case fails.
  assert.equal(foldDraws(up, draws('handoff', 'none', 'review'), labels, floor, 3).pass, false);
  assert.equal(foldDraws(up, draws('handoff', 'review', 'handoff'), labels, floor, 3).pass, true);
});

// An independent recomputation, labelled as one: it shares this file's reading of "a draw fails" (the rank
// comparison written out below, without scoreAttempt), so it checks the fold's counting, not the definition.
// Every one of the 4^3 = 64 triples of outcomes (three labels and a system failure), under both directions.
test('foldDraws: failingDraws equals a count made in the test for all 64 outcome triples and both directions (an independent recomputation); the case passes exactly when it is 0; it is a whole number from 0 to the draw count', () => {
  const outcomes: (string | Attempt)[] = ['none', 'review', 'handoff', failedAttempt('system-error')];
  const want = labels.indexOf(up.expect);
  for (const spec of [floor, ceiling]) {
    const failsAlone = (o: string | Attempt): boolean => typeof o !== 'string' || (spec.direction === 'floor' ? labels.indexOf(o) < want : labels.indexOf(o) > want);
    for (const a of outcomes) for (const b of outcomes) for (const c of outcomes) {
      const f = foldDraws(up, draws(a, b, c), labels, spec, 3);
      const expected = [a, b, c].filter(failsAlone).length;
      const at = `${spec.direction}: ${[a, b, c].map((o) => (typeof o === 'string' ? o : 'failed')).join(', ')}`;
      assert.equal(f.failingDraws, expected, at);
      assert.equal(f.pass, expected === 0, at);
      assert.ok(Number.isInteger(f.failingDraws) && f.failingDraws >= 0 && f.failingDraws <= f.drawCount && f.drawCount === 3, at);
    }
  }
});

// A case with a slot that measured nothing is not folded, so it has no such count: N is always the declared draw count.
test('foldRun: an incomplete case carries no failing-draw count, and every folded case counts over all its declared draws', () => {
  const cases: Case[] = [up, { ...up, id: 'c2' }];
  const all = [...draws('handoff', 'none', 'none'), d('none', 0, 'c2'), d(unmeasured('system', 'timeout'), 1, 'c2'), d('none', 2, 'c2')];
  const r = foldRun(cases, all, labels, { k: floor }, 3);
  assert.deepEqual(r.folded.map((f) => [f.caseId, f.failingDraws, f.drawCount]), [['c1', 2, 3]]);
  assert.deepEqual(r.incomplete.map((x) => [x.caseId, 'failingDraws' in x, x.measuredFailure]), [['c2', false, true]]);
});

test('foldDraws: ties go to the lowest drawIndex', () => {
  const f = foldDraws(up, [d('review', 2), d('review', 0), d('handoff', 1)], labels, floor, 3);
  assert.equal(f.attributedDraw.drawIndex, 0);
});

test('foldDraws: a failed attempt (system truncation, a system 4xx, a system error) fails the fold and is attributed', () => {
  for (const reason of ['truncated', 'client-error', 'system-error'] as const) {
    const f = foldDraws(up, draws('handoff', failedAttempt(reason), 'handoff'), labels, floor, 3);
    assert.equal(f.pass, false);
    assert.equal(label(f.attributedDraw), `failed:${reason}`);
  }
});

test('foldDraws: missing draws are a completeness failure, not ignored', () => {
  assert.throws(
    () => foldDraws(up, draws('review', 'review'), labels, floor, 3),
    (e: unknown) => e instanceof InputError && e.code === 'INCOMPLETE_DRAWS',
  );
  assert.throws(() => foldDraws(up, [], labels, floor, 3), (e: unknown) => e instanceof InputError && e.code === 'INCOMPLETE_DRAWS');
});

// The draw count is the run's declaration and is never read off the draws that happen to be there: with a default of
// "as many as were handed in", one passing draw of a case that declares three would fold as a complete pass.
test('the fold and the measured-slots step take the declared draw count and have no default: one draw of three is incomplete, and a call without the count is refused, never folded', () => {
  const one = draws('handoff');
  assert.throws(() => foldDraws(up, one, labels, floor, 3), (e: unknown) => e instanceof InputError && e.code === 'INCOMPLETE_DRAWS' && /1 of 3 draws measured \(#1 missing; #2 missing\)/.test(e.problems.join()));
  const r = foldRun([up], one, labels, { k: floor }, 3);
  assert.deepEqual([r.folded.length, r.incomplete.map((x) => [x.caseId, x.expected, x.got, x.missing])], [0, [['c1', 3, 1, [1, 2]]]]);
  assert.deepEqual(measuredSlots(one, 3).missing, [1, 2]);
  const refused = (f: () => unknown, what: string): void =>
    assert.throws(f, (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && /drawsPerCase: must be a positive integer/.test(e.problems.join()), what);
  // @ts-expect-error the draw count is required
  refused(() => foldDraws(up, one, labels, floor), 'foldDraws without a count');
  // @ts-expect-error the draw count is required
  refused(() => measuredSlots(one), 'measuredSlots without a count');
  // @ts-expect-error the draw count is required, with a list of slots too
  refused(() => measuredSlots(one, undefined, [0]), 'measuredSlots with slots and no count');
  for (const bad of [0, -1, 1.5, '3', null]) {
    refused(() => foldDraws(up, one, labels, floor, bad as number), `foldDraws with ${String(bad)}`);
    refused(() => measuredSlots(one, bad as number), `measuredSlots with ${String(bad)}`);
    refused(() => foldRun([up], one, labels, { k: floor }, bad as number), `foldRun with ${String(bad)}`);
    refused(() => foldRun([], [], labels, { k: floor }, bad as number), `foldRun of no case with ${String(bad)}`);
  }
  // A count past the bound, or one that is no number, is refused by the one slot check, as it is everywhere (INVALID_DRAWS).
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 10_001]) {
    for (const f of [() => foldDraws(up, one, labels, floor, bad), () => measuredSlots(one, bad), () => foldRun([up], one, labels, { k: floor }, bad)]) {
      assert.throws(f, (e: unknown) => e instanceof InputError && e.code === 'INVALID_DRAWS' && /at most 10000 draws per case are read/.test(e.problems.join()), String(bad));
    }
  }
  // A slot list names slots of the declared count and no other.
  assert.throws(() => measuredSlots(one, 3, [0, 3]), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && /slots: 3 is not a slot of a case with 3 draws/.test(e.problems.join()));
  // A slot named twice would be expected twice and measured once: it is refused.
  assert.throws(() => measuredSlots(one, 3, [0, 0]), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && /slots: 0 is named twice/.test(e.problems.join()));
});

test('foldDraws: duplicate, out-of-range or foreign draws are invalid', () => {
  const dup = [d('review', 0), d('review', 0), d('review', 1)];
  assert.throws(() => foldDraws(up, dup, labels, floor, 3), (e: unknown) => e instanceof InputError && e.code === 'INVALID_DRAWS');
  assert.throws(() => foldDraws(up, [d('review', 0), d('review', 1), d('review', 5)], labels, floor, 3), InputError);
  assert.throws(() => foldDraws(up, [d('review', 0, 'c2')], labels, floor, 1), InputError);
  assert.throws(() => foldDraws(up, draws('maybe'), labels, floor, 1), (e: unknown) => e instanceof InputError && e.code === 'UNKNOWN_LABEL');
  assert.throws(() => foldDraws({ ...up, expect: 'maybe' }, draws('none'), labels, floor, 1), InputError);
});

test('foldRun folds every case and lists incomplete ones', () => {
  const cases: Case[] = [up, { id: 'c2', klass: 'k', input: 'y', expect: 'none' }];
  const all: Draw[] = [d('review', 0), d('handoff', 1), d('none', 0, 'c2')];
  const r = foldRun(cases, all, labels, { k: floor }, 2);
  assert.deepEqual(r.folded.map((f) => f.caseId), ['c1']);
  assert.deepEqual(r.incomplete, [{ caseId: 'c2', klass: 'k', expected: 2, got: 1, missing: [1], unmeasured: [], measuredFailure: false }]);
  assert.throws(() => foldRun(cases, [...all, d('none', 0, 'ghost')], labels, { k: floor }, 2), (e: unknown) => e instanceof InputError && e.code === 'UNKNOWN_CASE');
  assert.throws(() => foldRun(cases, all, labels, { other: floor }, 2), (e: unknown) => e instanceof InputError && e.code === 'UNKNOWN_CLASS');
});

// --- The one attempt-list check (used by the parser and by the fold) --------------------------------
const problemsFor = (attempts: unknown, judged?: boolean): string[] => attemptsProblems(attempts, 'draw', judged);

test('attempts: a measured attempt can never be followed by a retry, even when the fold is called directly', () => {
  assert.ok(problemsFor([gradedAttempt('none'), gradedAttempt('review')]).some((p) => p.includes('only an unmeasured attempt may be retried')));
  assert.ok(problemsFor([failedAttempt('truncated'), gradedAttempt('review')]).some((p) => p.includes('only an unmeasured attempt may be retried')));
  assert.throws(
    () => foldDraws(up, [slot('c1', 0, gradedAttempt('none'), gradedAttempt('review'))], labels, floor, 1),
    (e: unknown) => e instanceof InputError && e.code === 'INVALID_DRAWS',
  );
});

test('attempts: an empty list or an unknown kind is invalid input, not a crash', () => {
  assert.ok(problemsFor([]).length > 0);
  assert.ok(problemsFor([{ kind: 'oops', label: 'none' }]).some((p) => p.includes('kind')));
  assert.throws(() => foldDraws(up, [{ caseId: 'c1', drawIndex: 0, attempts: [] }], labels, floor, 1), (e: unknown) => e instanceof InputError && e.code === 'INVALID_DRAWS');
});

test('attempts: a graded answer needs a completing stop; a truncated one must be recorded as failed', () => {
  assert.deepEqual(problemsFor([gradedAttempt('none')]), []);
  assert.deepEqual(problemsFor([gradedAttempt('none', { systemStop: 'content-filter' })]), []);
  assert.ok(problemsFor([gradedAttempt('none', { systemStop: 'max-tokens' })]).some((p) => p.includes('failed') && p.includes('truncated')));
  assert.ok(problemsFor([gradedAttempt('none', { systemStop: 'other' })]).some((p) => p.includes('systemStop')));
  // run/v3 stores an unknown stop; the fold, not the parser, refuses it (see the unknown-system-stop test below).
  assert.deepEqual(problemsFor([{ ...gradedAttempt('none'), systemStop: GAP }]), []);
  assert.ok(problemsFor([failedAttempt('truncated', { systemStop: NOT_SENT })]).some((p) => p.includes('max-tokens')));
  assert.ok(problemsFor([failedAttempt('client-error', { systemStop: 'end' })]).some((p) => p.includes('systemStop')));
});

test('attempts: every measured attempt carries a known output hash', () => {
  assert.ok(problemsFor([gradedAttempt('none', { outputHash: GAP })]).some((p) => p.includes('outputHash')));
  assert.ok(problemsFor([failedAttempt('system-error', { outputHash: 'abc' })]).some((p) => p.includes('outputHash')));
});

test('attempts: judgeStop is NO_JUDGE exactly in a code-graded run, and a completing stop otherwise', () => {
  assert.deepEqual(problemsFor([gradedAttempt('none')], false), []);
  assert.ok(problemsFor([gradedAttempt('none', { judgeStop: 'end' })], false).some((p) => p.includes('judgeStop')));
  assert.ok(problemsFor([gradedAttempt('none')], true).some((p) => p.includes('judgeStop')));
  assert.deepEqual(problemsFor([gradedAttempt('none', { judgeStop: 'tool-use' })], true), []);
  assert.ok(problemsFor([gradedAttempt('none', { judgeStop: 'max-tokens' })], true).some((p) => p.includes('judgeStop')));
  // Without the identity (a direct fold) either kind of run is possible, but a judge that did not finish never is.
  assert.deepEqual(problemsFor([gradedAttempt('none', { judgeStop: NO_JUDGE })]), []);
  assert.deepEqual(problemsFor([gradedAttempt('none', { judgeStop: 'tool-use' })]), []);
  for (const stop of ['max-tokens', 'content-filter', 'refusal', 'other', 'stop-sequence'] as const) {
    assert.ok(problemsFor([gradedAttempt('none', { judgeStop: stop })]).some((p) => p.includes('judgeStop')), stop);
  }
  assert.throws(() => foldDraws(up, [slot('c1', 0, gradedAttempt('review', { judgeStop: 'max-tokens' }))], labels, floor, 1), (e: unknown) => e instanceof InputError && e.code === 'INVALID_DRAWS');
});

// --- Unmeasured slots and completeness (one fold) ----------------------------------------------------
const two = (a: Attempt, b: Attempt): Draw[] => [slot('c1', 0, a), slot('c1', 1, b)];

test('fold: an unmeasured slot leaves the case incomplete, with its reason, beside a passing draw', () => {
  const r = foldRun([up], two(gradedAttempt('review'), unmeasured('system', 'timeout')), labels, { k: floor }, 2);
  assert.deepEqual(r.folded, []);
  assert.deepEqual(r.incomplete, [{ caseId: 'c1', klass: 'k', expected: 2, got: 1, missing: [], unmeasured: [{ drawIndex: 1, role: 'system', reason: 'timeout' }], measuredFailure: false }]);
});

test('fold: completeness does not depend on the outcome; a measured failure beside an unmeasured slot is incomplete and keeps the failure', () => {
  const r = foldRun([up], two(gradedAttempt('none'), unmeasured('judge', 'server-error')), labels, { k: floor }, 2);
  assert.deepEqual(r.folded, []);
  assert.equal(r.incomplete[0]?.measuredFailure, true);
  assert.deepEqual(r.incomplete[0]?.unmeasured, [{ drawIndex: 1, role: 'judge', reason: 'server-error' }]);
});

test('fold: a retry after an unmeasured system attempt counts as the slot', () => {
  const f = foldDraws(up, [slot('c1', 0, unmeasured('system', 'timeout'), gradedAttempt('review'))], labels, floor, 1);
  assert.equal(f.pass, true);
});

test('attempts: a judge retry re-grades the same output; only a system retry may produce a new one', () => {
  const x = gradedAttempt('none').outputHash;
  assert.deepEqual(problemsFor([unmeasured('judge', 'timeout', x), gradedAttempt('none', { outputHash: x, judgeStop: 'tool-use' })]), []);
  assert.ok(problemsFor([unmeasured('judge', 'content-filter', x), gradedAttempt('review')]).some((p) => p.includes('same output')));
  assert.ok(problemsFor([unmeasured('judge', 'timeout', x), unmeasured('system', 'timeout'), gradedAttempt('review')]).some((p) => p.includes('same output')));
  assert.deepEqual(problemsFor([unmeasured('system', 'timeout'), gradedAttempt('review')]), []);
});

test('attempts: unmeasured reasons are closed, and a code-graded run has no judge attempt', () => {
  assert.ok(problemsFor([unmeasured('system', 'truncated'), gradedAttempt('none')]).some((p) => p.includes('reason')));
  assert.ok(problemsFor([unmeasured('judge', 'nap'), gradedAttempt('none')]).some((p) => p.includes('reason')));
  assert.ok(problemsFor([unmeasured('judge', 'timeout')], false).some((p) => p.includes('judge')));
  assert.deepEqual(problemsFor([unmeasured('judge', 'timeout')], true), []);
});

test('attempts: each kind has a closed shape; a content filter is never a fail reason', () => {
  assert.ok(problemsFor([{ ...failedAttempt('system-error'), reason: 'content-filtered' }]).some((p) => p.includes('reason')));
  assert.ok(problemsFor([{ ...unmeasured('system', 'timeout'), outputHash: gradedAttempt('none').outputHash }, gradedAttempt('none')]).some((p) => p.includes('unknown field')));
  const x = gradedAttempt('none').outputHash;
  assert.ok(problemsFor([{ ...unmeasured('judge', 'timeout', x), outputHash: 'abc' }], true).some((p) => p.includes('outputHash')));
  assert.ok(problemsFor([{ ...unmeasured('judge', 'timeout', x), systemStop: 'max-tokens' }], true).some((p) => p.includes('systemStop')));
});

test('attempts: a judge retry keeps the same stop too, and a system failure cannot follow a judge failure', () => {
  const x = gradedAttempt('none').outputHash;
  assert.ok(problemsFor([unmeasured('judge', 'timeout', x), gradedAttempt('none', { outputHash: x, systemStop: 'end' })]).some((p) => p.includes('same output')));
  assert.ok(problemsFor([unmeasured('judge', 'timeout', x), failedAttempt('system-error', { outputHash: x })]).some((p) => p.includes('same output')));
});

test('slots: one check for duplicate and out-of-range draw indices, shared by the parser, the fold and stability', () => {
  assert.deepEqual(slotProblems([slot('c1', 0, gradedAttempt('none')), slot('c1', 1, gradedAttempt('none'))], 2), []);
  assert.ok(slotProblems([slot('c1', 0, gradedAttempt('none')), slot('c1', 0, gradedAttempt('review'))], 2).some((p) => p.includes('duplicate drawIndex 0')));
  assert.ok(slotProblems([slot('c1', 2, gradedAttempt('none'))], 2).some((p) => p.includes('drawIndex 2 >= drawsPerCase 2')));
  assert.ok(slotProblems([slot('c1', -1, gradedAttempt('none'))], 2).some((p) => p.includes('drawIndex -1')));
  // Two cases may use the same index.
  assert.deepEqual(slotProblems([slot('c1', 0, gradedAttempt('none')), slot('c2', 0, gradedAttempt('none'))], 1), []);
});

test('validateLabelSet refuses the markers the library uses as labels', () => {
  for (const marker of ['UNKNOWN', 'NA', 'NO_JUDGE', 'NOT_SENT']) {
    assert.ok(validateLabelSet(['none', marker]).some((p) => p.includes(marker)), marker);
  }
});

test('an unknown system stop is not completion; the fold refuses it wherever it sits in the attempts', () => {
  const gap = (label: string): Attempt => ({ ...gradedAttempt(label), systemStop: GAP });
  const refused = (f: () => unknown): void => {
    assert.throws(f, (e: unknown) => e instanceof RefusalError && e.code === 'IDENTITY_GAP' && e.fields.includes('systemStop[c1#1]'));
  };
  const draws = [slot('c1', 0, gradedAttempt('review')), slot('c1', 1, gap('review'))];
  refused(() => foldDraws(up, draws, labels, floor, 2));
  refused(() => foldRun([up], draws, labels, { k: floor }, 2));
  // Even when another draw already fails the case, and when the unknown stop is on a judge attempt that was retried.
  refused(() => foldDraws(up, [slot('c1', 0, gradedAttempt('none')), slot('c1', 1, gap('review'))], labels, floor, 2));
  const x = gradedAttempt('review').outputHash;
  const retried = slot('c1', 1, { ...unmeasured('judge', 'timeout', x), systemStop: GAP } as Attempt, { ...gradedAttempt('review', { judgeStop: 'tool-use' }), systemStop: GAP } as Attempt);
  refused(() => foldDraws(up, [slot('c1', 0, gradedAttempt('review')), retried], labels, floor, 2));
  assert.deepEqual(unknownStops(draws), ['c1#1']);
});

test('measuredSlots counts each slot once and scores nothing; the fold is that step plus worst-of-N', () => {
  const draws = [slot('c1', 2, unmeasured('system', 'timeout')), slot('c1', 0, gradedAttempt('none')), slot('c1', 1, unmeasured('system', 'timeout'), gradedAttempt('handoff'))];
  const all = measuredSlots(draws, 4);
  assert.equal(all.expected, 4);
  assert.deepEqual(all.measured.map((m) => m.d.drawIndex), [0, 1]);
  assert.deepEqual(all.unmeasured, [{ drawIndex: 2, role: 'system', reason: 'timeout' }]);
  assert.deepEqual(all.missing, [3]);
  // A draw set is a list of slots; a slot outside it is not counted, and one inside it is never dropped.
  const set = measuredSlots(draws, 4, [0, 1]);
  assert.deepEqual([set.expected, set.measured.length, set.unmeasured.length, set.missing.length], [2, 2, 0, 0]);
  assert.deepEqual(measuredSlots(draws, 4, [1, 3]).missing, [3]);
  assert.deepEqual(measuredSlots(draws, 4, [2]).unmeasured.map((u) => u.drawIndex), [2]);
});

// The judge-change measurement labels a case with its own rule and never with the fold (it must also offer 'majority').
// Its 'worst' rule and the fold are two pieces of code that state one definition, so this ties them: over every one
// of the 4^3 = 64 triples of outcomes and both directions, on the slots measuredSlots returns and the per-draw score
// scoreAttempt gives (the two steps src/judgechange.ts takes), the 'worst' label is the fold's pass. It checks that the
// two agree, not that either is the right definition; the fold's own count is pinned in the tests above.
test('the judge-change "worst" label equals foldDraws(...).pass for all 64 outcome triples and both directions (a tie between two implementations)', async () => {
  const { labelOf } = await import('../src/judgechange.ts');
  const outcomes: (string | Attempt)[] = ['none', 'review', 'handoff', failedAttempt('system-error')];
  let compared = 0;
  for (const spec of [floor, ceiling]) {
    for (const a of outcomes) for (const b of outcomes) for (const c of outcomes) {
      const ds = draws(a, b, c);
      const passes = measuredSlots(ds, 3).measured.map((x) => scoreAttempt(up, x.a, labels, spec));
      assert.equal(passes.length, 3);
      const at = `${spec.direction}: ${[a, b, c].map((o) => (typeof o === 'string' ? o : 'failed')).join(', ')}`;
      assert.equal(labelOf('worst', passes, [0, 1, 2]), foldDraws(up, ds, labels, spec, 3).pass, at);
      compared++;
    }
  }
  assert.equal(compared, 128);
  // The two rules differ where they should: one failing draw of three fails 'worst' and passes 'majority'.
  assert.deepEqual([labelOf('worst', [true, false, true], [0, 1, 2]), labelOf('majority', [true, false, true], [0, 1, 2])], [false, true]);
});

test('the fold takes no label rule: no export of the scoring module accepts one', async () => {
  const mod = await import('../src/scoring.ts');
  assert.equal(mod.foldDraws.length, 5);
  assert.equal(mod.foldRun.length, 5);
  assert.ok(!Object.keys(mod).some((k) => /rule|majority/i.test(k)), Object.keys(mod).join(', '));
});
