// The gate's admission, listed whole (regression.ts:gateAdmission): every refusal the gate would raise before it
// evaluates, in the order it checks them, and each step that could not run. What this file pins: the order and the
// completeness of the list on hand-built synthetic runs, and that its first entry is the refusal gateRuns returns. The
// parity on every other gate fixture is pinned by test/helpers.ts:gateRunsWithAdmission, through which the gate tests
// call gateRuns. No statistic is computed here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { caseSetHash, RUN_SCHEMA } from '../src/artifact.ts';
import type { RunArtifact } from '../src/artifact.ts';
import { InputError } from '../src/errors.ts';
import { barHash, parseBarFile } from '../src/gate.ts';
import { GAP, hashOf } from '../src/identity.ts';
import { gateAdmission, gateRuns } from '../src/regression.ts';
import type { AdmissionItem } from '../src/regression.ts';
import type { Case, Draw } from '../src/scoring.ts';
import { callShapesFor, gradedAttempt, makeIdentity, packetBasisFor, slot } from './helpers.ts';

const bar = parseBarFile({ labels: ['lo', 'hi'], classes: { k: { direction: 'floor', minPassRate: 0.5 } }, knownFailures: [] });
const cases: Case[] = [
  { id: 'c1', klass: 'k', input: 'a', expect: 'hi' },
  { id: 'c2', klass: 'k', input: 'b', expect: 'hi' },
];
const draws = (over: (key: string) => Partial<Parameters<typeof gradedAttempt>[1]> = () => ({})): Draw[] =>
  ['c1', 'c2'].flatMap((id) => [0, 1].map((d) => slot(id, d, gradedAttempt('hi', over(`${id}#${d}`) ?? {}))));
const run = (ds: Draw[], over = {}): RunArtifact => {
  const identity = makeIdentity({ caseSetHash: caseSetHash(cases), barHash: barHash(bar), drawsPerCase: 2, ...over });
  return { schema: RUN_SCHEMA, identity, callShapes: callShapesFor(identity), cases, draws: ds, ...packetBasisFor(identity) };
};
const summary = (items: readonly AdmissionItem[]): string[] => items.map((x) => (x.kind === 'refused' ? `${x.refusal.code} ${x.refusal.fields.join(',')}` : `not checked: ${x.step}`));
const firstIsGate = (b: RunArtifact, c: RunArtifact): void => {
  const items = gateAdmission(b, c, bar);
  const g = gateRuns(b, c, bar);
  assert.equal(g.kind, 'refused');
  const first = items[0];
  assert.ok(first !== undefined && first.kind === 'refused', 'the first entry is always a refusal');
  if (g.kind === 'refused') assert.deepEqual([first.refusal.code, [...first.refusal.fields], first.refusal.message], [g.refusal.code, [...g.refusal.fields], g.refusal.message]);
};

test('gateAdmission: a pair the gate evaluates has an empty admission', () => {
  const r = run(draws());
  assert.deepEqual(gateAdmission(r, r, bar), []);
  assert.equal(gateRuns(r, r, bar).kind, 'evaluated');
});

test('gateAdmission: an unknown stop and an unknown identity field are listed together, in the gate\'s order, where the gate names only the stop', () => {
  // The case the validate command exists for: the gate stops at the stops and does not name the seed until they are fixed.
  const unknownStop = (k: string) => (k === 'c1#0' ? { systemStop: GAP } as const : {});
  const r = run(draws(unknownStop), { seed: GAP });
  assert.deepEqual(summary(gateAdmission(r, r, bar)), [
    'IDENTITY_GAP systemStop[c1#0]', // baseline stops
    'IDENTITY_GAP systemStop[c1#0]', // candidate stops
    'IDENTITY_GAP seed', // assertComparable
    'not checked: baseline completeness', // the fold reads no slot with an unknown stop
  ]);
  firstIsGate(r, r);
});

test('gateAdmission: every step that refuses is listed (bar hash per run, identity, missing slot), and a missing slot is still found behind the others', () => {
  const short = draws().slice(0, 3);
  const b = run(short, { seed: GAP, barHash: hashOf('another bar') });
  const c = run(draws(), { barHash: hashOf('another bar'), caseSetHash: caseSetHash(cases) });
  assert.deepEqual(summary(gateAdmission(b, c, bar)), ['HASH_MISMATCH barHash', 'HASH_MISMATCH barHash', 'IDENTITY_GAP seed', 'INCOMPLETE_RUN c2#1']);
  firstIsGate(b, c);
});

test('gateAdmission: an unknown draw count is refused by the identity check and by the count check, and completeness is then not checked', () => {
  const r = run(draws(), { drawsPerCase: GAP });
  const items = gateAdmission(r, r, bar);
  assert.deepEqual(summary(items), ['IDENTITY_GAP drawsPerCase', 'IDENTITY_GAP drawsPerCase', 'not checked: baseline completeness']);
  const last = items[2];
  assert.ok(last !== undefined && last.kind === 'not-checked' && /drawsPerCase is unknown/.test(last.why));
  firstIsGate(r, r);
});

test('gateAdmission: invalid input inside the fold is not the gate\'s answer when a refusal comes first (listed as not checked), and is thrown as the gate throws it when none does', () => {
  const badLabel = draws().map((d, i) => (i === 0 ? slot(d.caseId, d.drawIndex, gradedAttempt('zz')) : d));
  const gapped = run(badLabel, { seed: GAP });
  const items = gateAdmission(gapped, gapped, bar);
  assert.deepEqual(summary(items), ['IDENTITY_GAP seed', 'not checked: baseline completeness']);
  const last = items[1];
  assert.ok(last !== undefined && last.kind === 'not-checked' && /invalid input/.test(last.why), JSON.stringify(last));
  firstIsGate(gapped, gapped);
  const clean = run(badLabel);
  assert.throws(() => gateAdmission(clean, clean, bar), InputError);
  assert.throws(() => gateRuns(clean, clean, bar), InputError);
});

test('gateAdmission: arguments the gate never takes throw, before any step, as they do from gateRuns', () => {
  const r = run(draws());
  for (const opts of [{ allowDiffer: ['drawsPerCase' as const] }, { bootstrap: { iterations: 10, seed: 1, alpha: 0.05 } }, { nonsense: 1 } as never]) {
    assert.throws(() => gateAdmission(r, r, bar, opts), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT');
    assert.throws(() => gateRuns(r, r, bar, opts), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT');
  }
});

// Pinned to the gate's behaviour in 0.2.0, before gateAdmission existed: an allowDiffer name that is not an
// identity field, met after another check has already refused, leaves that refusal as the gate's answer; with nothing
// refused first, the invalid argument is thrown. A library call only: the CLI rejects unknown field names first.
test('gateRuns: an unknown allowDiffer field after a refusal returns that refusal, and throws only when nothing refused first', () => {
  const good = run(draws());
  const wrongBar = run(draws(), { barHash: 'f'.repeat(64) });
  const g = gateRuns(wrongBar, good, bar, { allowDiffer: ['bogusField' as never] });
  assert.equal(g.kind, 'refused');
  if (g.kind === 'refused') assert.deepEqual([g.refusal.code, [...g.refusal.fields]], ['HASH_MISMATCH', ['barHash']]);
  assert.throws(() => gateRuns(good, good, bar, { allowDiffer: ['bogusField' as never] }), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT');
});
