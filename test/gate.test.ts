import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GAP, hashOf } from '../src/identity.ts';
import { InputError } from '../src/errors.ts';
import { NA } from '../src/stats.ts';
import { barHash, evaluate, parseBarFile, splitBarFile } from '../src/gate.ts';
import type { Bar } from '../src/gate.ts';
import type { ClassSpec, FoldedCase } from '../src/scoring.ts';
import { gradedAttempt, slot } from './helpers.ts';

const fc = (caseId: string, klass: string, pass: boolean): FoldedCase => ({
  caseId,
  klass,
  pass,
  attributedDraw: slot(caseId, 0, gradedAttempt('x')),
  drawCount: 1,
  failingDraws: pass ? 0 : 1,
});

const classes: Record<string, ClassSpec> = { strict: { direction: 'floor', nonCompensable: true }, soft: { direction: 'ceiling' } };
/** Expected cases for evaluate: `r*` ids are soft, the rest strict. */
const ex = (...ids: string[]) => ids.map((id) => ({ id, klass: id.startsWith('r') || id.startsWith('x') ? 'soft' : 'strict' }));
const exOf = (folded: readonly FoldedCase[]) => folded.map((f) => ({ id: f.caseId, klass: f.klass }));

// The class rate is defined by this library (passed cases over folded cases of the class), so this is a hand-worked
// fixture and not a published reference value; none is claimed. The class "soft" holds four folded cases, r1 to r4;
// r1, r2 and r3 pass and r4 fails: passed 3, total 4, rate 3/4 = 0.75, which meets a bar of 0.75 exactly.
test('evaluate: per-class pass counts, rate and bar (a hand-worked fixture defined by this library: 3 of 4 = 0.75)', () => {
  const bar: Bar = { classes: { strict: { minPassRate: 1 }, soft: { minPassRate: 0.75 } } };
  const folded = [fc('s1', 'strict', true), fc('r1', 'soft', true), fc('r2', 'soft', true), fc('r3', 'soft', true), fc('r4', 'soft', false)];
  const g = evaluate(folded, bar, classes, ex('s1', 'r1', 'r2', 'r3', 'r4'));
  const soft = g.classes.find((c) => c.klass === 'soft');
  assert.equal(soft?.passed, 3);
  assert.equal(soft?.total, 4);
  assert.equal(soft?.rate, 0.75);
  assert.equal(soft?.meetsBar, true);
  assert.deepEqual(soft?.failedCaseIds, ['r4']);
  assert.equal(g.pass, true);
});

test('evaluate: a known failure is reported but never counted as a pass and never lowers the bar', () => {
  const bar: Bar = {
    classes: { strict: { minPassRate: 1 }, soft: { minPassRate: 0.8 } },
    knownFailures: [{ caseId: 'r4', since: '2026-01-10', note: 'tracked' }],
  };
  const folded = [fc('s1', 'strict', true), fc('r1', 'soft', true), fc('r2', 'soft', true), fc('r3', 'soft', true), fc('r4', 'soft', false)];
  const g = evaluate(folded, bar, classes, exOf(folded));
  const soft = g.classes.find((c) => c.klass === 'soft');
  assert.equal(soft?.passed, 3);
  assert.equal(soft?.rate, 0.75);
  assert.equal(soft?.minPassRate, 0.8);
  assert.equal(soft?.meetsBar, false);
  assert.deepEqual(soft?.knownFailureIds, ['r4']);
  assert.equal(g.pass, false);
});

test('evaluate: a known failure that now passes is annotated', () => {
  const bar: Bar = { classes: { strict: { minPassRate: 1 }, soft: { minPassRate: 0.5 } }, knownFailures: [{ caseId: 'r1', since: '2026-01-10', note: 'x' }] };
  const g = evaluate([fc('s1', 'strict', true), fc('r1', 'soft', true)], bar, classes, ex('s1', 'r1'));
  assert.deepEqual(g.classes.find((c) => c.klass === 'soft')?.knownFailuresNowPassing, ['r1']);
});

test('evaluate: a single failure fails a non-compensable class even when the rate meets the bar', () => {
  const bar: Bar = { classes: { strict: { minPassRate: 0.5 }, soft: { minPassRate: 0 } } };
  const folded = [fc('s1', 'strict', true), fc('s2', 'strict', true), fc('s3', 'strict', true), fc('s4', 'strict', false), fc('r1', 'soft', true)];
  const g = evaluate(folded, bar, classes, exOf(folded));
  const strict = g.classes.find((c) => c.klass === 'strict');
  assert.equal(strict?.rate, 0.75);
  assert.equal(strict?.meetsBar, false);
  assert.equal(g.pass, false);
});

test('evaluate: missing expected case ids fail the gate; extras are reported', () => {
  const bar: Bar = { classes: { strict: { minPassRate: 0 }, soft: { minPassRate: 0 } } };
  const g = evaluate([fc('s1', 'strict', true), fc('r1', 'soft', true), fc('x9', 'soft', true)], bar, classes, ex('s1', 'r1', 'r2'));
  assert.deepEqual(g.missingCaseIds, ['r2']);
  assert.deepEqual(g.extraCaseIds, ['x9']);
  assert.equal(g.pass, false);
});

test('evaluate: a class with a missing case withholds its rate and fails, even when the measured cases all pass', () => {
  const bar: Bar = { classes: { strict: { minPassRate: 0 }, soft: { minPassRate: 0.5 } } };
  const g = evaluate([fc('s1', 'strict', true), fc('r1', 'soft', true)], bar, classes, ex('s1', 'r1', 'r2'));
  const soft = g.classes.find((c) => c.klass === 'soft');
  assert.equal(soft?.passed, 1);
  assert.equal(soft?.total, 1);
  assert.equal(soft?.rate, GAP);
  assert.deepEqual(soft?.missingCaseIds, ['r2']);
  assert.equal(soft?.meetsBar, false);
  const strict = g.classes.find((c) => c.klass === 'strict');
  assert.equal(strict?.rate, 1);
  assert.deepEqual(strict?.missingCaseIds, []);
  assert.equal(g.pass, false);
});

test('evaluate: an empty class fails and an unknown class throws', () => {
  const bar: Bar = { classes: { strict: { minPassRate: 0 }, soft: { minPassRate: 0 } } };
  const g = evaluate([fc('s1', 'strict', true)], bar, classes, ex('s1'));
  assert.equal(g.classes.find((c) => c.klass === 'soft')?.meetsBar, false);
  assert.equal(g.classes.find((c) => c.klass === 'soft')?.rate, NA);
  assert.throws(() => evaluate([fc('q', 'ghost', true)], bar, classes, [{ id: 'q', klass: 'ghost' }]), InputError);
});

test('parseBarFile validates and lists every problem', () => {
  const ok = parseBarFile({ labels: ['a', 'b'], classes: { k: { direction: 'floor', minPassRate: 0.9 } }, knownFailures: [] });
  assert.deepEqual(ok.knownFailures, []);
  assert.equal(barHash(ok).length, 64);
  const split = splitBarFile(ok);
  assert.deepEqual(split.classes, { k: { direction: 'floor' } });
  assert.deepEqual(split.bar.classes, { k: { minPassRate: 0.9 } });
  assert.throws(
    () =>
      parseBarFile({
        labels: ['a', 'a'],
        classes: { k: { direction: 'up', minPassRate: 2 } },
        knownFailures: [{ caseId: 'c', since: '2026-02-30', note: '' }],
      }),
    (e: unknown) => e instanceof InputError && e.code === 'INVALID_BAR' && e.problems.length === 5,
  );
});

const problemsOf = (json: unknown): readonly string[] => {
  try {
    parseBarFile(json);
  } catch (e) {
    if (e instanceof InputError) return e.problems;
    throw e;
  }
  return [];
};

test('parseBarFile: a known-failure entry is { caseId, since, note } and nothing else, and a case is listed once', () => {
  const bar = (knownFailures: unknown): unknown => ({ labels: ['a', 'b'], classes: { k: { direction: 'floor', minPassRate: 0.9 } }, knownFailures });
  const entry = { caseId: 'c1', since: '2026-01-10', note: 'tracked' };
  assert.deepEqual(problemsOf(bar([entry, { ...entry, caseId: 'c2' }])), []);
  // A key the library does not read would enter the bar's hash and could be taken for a waiver that nothing honours.
  assert.deepEqual(problemsOf(bar([{ ...entry, waive: true }])), ['bar.knownFailures[0].waive: unknown field']);
  assert.deepEqual(problemsOf(bar([entry, { ...entry, caseId: 'c2', 'a b': 1, until: '2027-01-01' }])), ['bar.knownFailures[1].a b: unknown field', 'bar.knownFailures[1].until: unknown field']);
  // Two entries for one case: which date and note stand is not stated, so neither does.
  assert.deepEqual(problemsOf(bar([entry, { ...entry, since: '2026-02-01', note: 'again' }])), ['bar.knownFailures[1].caseId: duplicate "c1" (also bar.knownFailures[0]); a case is listed once']);
  assert.deepEqual(problemsOf(bar([entry, { ...entry, caseId: 'c2' }, entry])), ['bar.knownFailures[2].caseId: duplicate "c1" (also bar.knownFailures[0]); a case is listed once']);
  // An entry that is not an object is named as one, not as three missing fields.
  assert.deepEqual(problemsOf(bar(['c1'])), ['bar.knownFailures[0]: must be an object { caseId, since, note }']);
  assert.deepEqual(problemsOf(bar([[entry]])), ['bar.knownFailures[0]: must be an object { caseId, since, note }']);
});

test('parseBarFile: a class is named in a message as any key is, a class spec is an object and not a list, and a class has a name', () => {
  const bar = (classes: unknown): unknown => ({ labels: ['a', 'b'], classes, knownFailures: [] });
  const spec = { direction: 'floor', minPassRate: 0.9 };
  assert.deepEqual(problemsOf(bar({ k: [] })), ['bar.classes.k: must be an object']);
  assert.deepEqual(problemsOf(bar({ k: [spec] })), ['bar.classes.k: must be an object']);
  assert.deepEqual(problemsOf(bar({ '': spec })), ['bar.classes."": the class name must be a non-empty string']);
  // A class name that is not text is escaped, so the message is text; a plain name is written as it always was.
  const ill = problemsOf(bar({ 'k\ud800': { ...spec, direction: 'up' } }));
  assert.ok(ill.includes('bar.classes."k\\ud800".direction: must be "floor" or "ceiling"'), ill.join(' | '));
  for (const p of ill) assert.ok(p.isWellFormed(), JSON.stringify(p));
  assert.deepEqual(problemsOf(bar({ 'two words': { ...spec, direction: 'up' } })), ['bar.classes.two words.direction: must be "floor" or "ceiling"']);
});

test('parseBarFile requires knownFailures: a bar without it is invalid, and null is not an empty list', () => {
  const base = { labels: ['a', 'b'], classes: { k: { direction: 'floor', minPassRate: 0.9 } } };
  assert.deepEqual(problemsOf(base), ['bar.knownFailures: required (write [] for none)']);
  assert.throws(() => parseBarFile(base), (e: unknown) => e instanceof InputError && e.code === 'INVALID_BAR');
  assert.deepEqual(problemsOf({ ...base, knownFailures: null }), ['bar.knownFailures: must be an array']);
  assert.deepEqual(problemsOf({ ...base, knownFailures: {} }), ['bar.knownFailures: must be an array']);
  assert.deepEqual(problemsOf({ ...base, knownFailures: [] }), []);
});

test('barHash is hashOf the bar file as written: the parsed value is the file, with nothing filled in', () => {
  const literal = { labels: ['a', 'b'], classes: { k: { direction: 'floor', minPassRate: 0.9 } }, knownFailures: [] };
  assert.equal(barHash(parseBarFile(literal)), hashOf(literal));
  const onDisk = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'examples', 'refund-bot', 'bar.json'), 'utf8')) as unknown;
  assert.equal(barHash(parseBarFile(onDisk)), hashOf(onDisk));
});
