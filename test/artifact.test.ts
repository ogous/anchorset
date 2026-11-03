import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callShapeHash } from '../src/callshape.ts';
import { caseSetHash, parseRunArtifact, RUN_SCHEMA } from '../src/artifact.ts';
import type { RunArtifact } from '../src/artifact.ts';
import { InputError } from '../src/errors.ts';
import { GAP, hashOf, NO_JUDGE, NO_SEED } from '../src/identity.ts';
import type { RunIdentity } from '../src/identity.ts';
import type { Attempt, Case } from '../src/scoring.ts';
import { callShapesFor, failedAttempt, gradedAttempt, makeCallShape, makeIdentity, makeJudgeCallShape, makeJudgedIdentity, PACKET, packetBasisFor, slot, unmeasured } from './helpers.ts';

const cases: Case[] = [
  { id: 'b', klass: 'k', input: { message: 'hi' }, expect: 'none' },
  { id: 'a', klass: 'k', input: 'plain', expect: 'review' },
];

/** A valid run over `cases` whose declared hashes all match their stored records. */
const valid = (identity: RunIdentity = makeIdentity({ caseSetHash: caseSetHash(cases) }), draws: unknown[] = []): RunArtifact =>
  ({ schema: RUN_SCHEMA, identity, callShapes: callShapesFor(identity), cases, draws, ...packetBasisFor(identity) }) as RunArtifact;
const problemsOf = (x: unknown): string[] => {
  try {
    parseRunArtifact(x);
    return [];
  } catch (e) {
    assert.ok(e instanceof InputError && e.code === 'INVALID_ARTIFACT');
    return [...e.problems];
  }
};

test('parseRunArtifact accepts a valid artifact', () => {
  const art = valid(undefined, [slot('a', 0, gradedAttempt('none', { outputHash: hashOf('reply a') })), slot('b', 0, failedAttempt('system-error'))]);
  assert.equal(parseRunArtifact(art), art);
});

test('parseRunArtifact lists every problem', () => {
  const bad = {
    schema: 'other/v1',
    identity: { ...makeIdentity(), systemModelServed: null },
    cases: [{ id: 'a', klass: '', input: 1, expect: 'none' }, { id: 'a', klass: 'k', expect: 3 }],
    draws: [{ caseId: 'zz', drawIndex: -1, attempts: [] }, slot('a', 0, gradedAttempt(''))],
    extra: true,
  };
  try {
    parseRunArtifact(bad);
    assert.fail('expected an InputError');
  } catch (e) {
    assert.ok(e instanceof InputError && e.code === 'INVALID_ARTIFACT');
    const want = ['artifact.extra', 'artifact.schema', 'identity.systemModelServed', 'artifact.callShapes', 'cases[0].klass', 'cases[1].id', 'cases[1].input', 'cases[1].expect', 'draws[0].caseId', 'draws[0].drawIndex', 'draws[0].attempts', 'draws[1].attempts[0].label', 'artifact.packetBasis'];
    for (const w of want) assert.ok(e.problems.some((p) => p.includes(w)), `missing problem for ${w}: ${e.problems.join(' | ')}`);
    assert.equal(e.problems.length, want.length);
  }
  assert.throws(() => parseRunArtifact([]), InputError);
});

test('parseRunArtifact verifies every declared hash against its stored record, a declared gap included', () => {
  assert.equal(caseSetHash(cases), caseSetHash([...cases].reverse()));
  const good = valid();
  assert.deepEqual(problemsOf(good), []);
  const has = (x: unknown, fragment: string): void => {
    const p = problemsOf(x);
    assert.ok(p.some((q) => q.includes(fragment)), `expected "${fragment}" in ${JSON.stringify(p)}`);
  };
  has({ ...good, cases: [...cases, { id: 'c', klass: 'k', input: 'new', expect: 'none' }] }, 'identity.caseSetHash');
  has({ ...good, identity: { ...good.identity, caseSetHash: GAP } }, 'identity.caseSetHash');
  has({ ...good, identity: { ...good.identity, systemCallShapeHash: hashOf('some other shape') } }, 'identity.systemCallShapeHash');
  // The stored shape has an unknown knob, so it hashes to UNKNOWN: a known declared hash is a lie.
  const gapShape = { ...good, callShapes: { system: makeCallShape({ effort: GAP }), judge: NO_JUDGE } };
  has(gapShape, 'identity.systemCallShapeHash');
  assert.deepEqual(problemsOf({ ...gapShape, identity: { ...good.identity, systemCallShapeHash: GAP } }), []);
});

test('parseRunArtifact: the judge call shape is NO_JUDGE exactly when the run has no judge', () => {
  const coded = valid();
  const judged = valid(makeJudgedIdentity({ caseSetHash: caseSetHash(cases) }));
  assert.deepEqual(problemsOf(judged), []);
  assert.ok(problemsOf({ ...coded, callShapes: { system: makeCallShape(), judge: makeJudgeCallShape() } }).some((p) => p.includes('callShapes.judge')));
  assert.ok(problemsOf({ ...judged, callShapes: { system: makeCallShape(), judge: NO_JUDGE } }).some((p) => p.includes('callShapes.judge')));
});

test('parseRunArtifact names the role of a bad call shape', () => {
  const p = problemsOf({ ...valid(), callShapes: { system: { ...makeCallShape(), effort: 'turbo' }, judge: NO_JUDGE } });
  assert.ok(p.some((q) => q.startsWith('artifact.callShapes.system.effort')), JSON.stringify(p));
  assert.equal(callShapeHash(makeCallShape()), makeIdentity().systemCallShapeHash);
});

test('the retry rule: parseRunArtifact refuses an attempt after a final judge reason, with its path and reason; each one as the last attempt is a valid file', () => {
  const identity = makeJudgedIdentity({ caseSetHash: caseSetHash(cases) });
  const graded = gradedAttempt('none', { judgeStop: 'tool-use' });
  const draw = (...attempts: Attempt[]) => [slot('a', 0, ...attempts)];
  for (const reason of ['parse-failure', 'content-filter', 'client-error']) {
    const judge = unmeasured('judge', reason, graded.outputHash);
    const after = problemsOf(valid(identity, draw({ ...judge, packetHash: graded.packetHash } as Attempt, graded)));
    assert.ok(after.some((p) => p.startsWith('artifact.draws[0].attempts[0]: ') && p.includes(`the reason ${reason} is final`)), JSON.stringify(after));
    assert.deepEqual(problemsOf(valid(identity, draw({ ...judge, packetHash: graded.packetHash } as Attempt))), [], reason);
  }
  for (const reason of ['timeout', 'transport', 'server-error', 'rate-limited', 'truncated']) {
    const judge = unmeasured('judge', reason, graded.outputHash);
    assert.deepEqual(problemsOf(valid(identity, draw({ ...judge, systemStop: graded.systemStop, packetHash: graded.packetHash } as Attempt, graded))), [], reason);
  }
  for (const reason of ['timeout', 'transport', 'server-error', 'rate-limited']) assert.deepEqual(problemsOf(valid(identity, draw(unmeasured('system', reason), graded))), [], reason);
});

test('the run schema is v3; a file with any other schema string gets the one plain message', () => {
  assert.equal(RUN_SCHEMA, 'anchorset.run/v3');
  for (const other of ['anchorset.run/v0', 'anchorset.run/v1', 'anchorset.run/v2', 'anchorset.run/v4', 'run']) {
    const p = problemsOf({ ...valid(), schema: other }).filter((q) => q.startsWith('artifact.schema'));
    assert.deepEqual(p, ['artifact.schema: must be "anchorset.run/v3"'], other);
  }
});

test('every measured attempt carries the sha256 of the system output; UNKNOWN is refused', () => {
  const draw = (outputHash: unknown) => valid(undefined, [slot('a', 0, { ...gradedAttempt('none'), outputHash } as Attempt)]);
  assert.doesNotThrow(() => parseRunArtifact(draw(hashOf('reply'))));
  for (const bad of [undefined, null, 'abc123', hashOf('x').toUpperCase(), 7, GAP]) {
    const art = draw(bad) as unknown as { draws: { attempts: Record<string, unknown>[] }[] };
    if (bad === undefined) delete (art.draws[0]?.attempts[0] as Record<string, unknown>)['outputHash'];
    assert.ok(problemsOf(art).some((p) => p.includes('draws[0].attempts[0].outputHash')), String(bad));
  }
});

test('parseRunArtifact applies the attempt rules with the identity: judgeStop follows NO_JUDGE', () => {
  const coded = valid(undefined, [slot('a', 0, gradedAttempt('none', { judgeStop: 'end' }))]);
  assert.ok(problemsOf(coded).some((p) => p.includes('judgeStop')));
  const judgedId = makeJudgedIdentity({ caseSetHash: caseSetHash(cases) });
  assert.ok(problemsOf(valid(judgedId, [slot('a', 0, gradedAttempt('none'))])).some((p) => p.includes('judgeStop')));
  assert.deepEqual(problemsOf(valid(judgedId, [slot('a', 0, gradedAttempt('none', { judgeStop: 'tool-use' }))])), []);
  assert.ok(problemsOf(valid(undefined, [slot('a', 0, gradedAttempt('none'), gradedAttempt('review'))])).some((p) => p.includes('retried')));
});

test('parseRunArtifact refuses a duplicate slot and an out-of-range draw index, with the same check as the fold', () => {
  const id = makeIdentity({ caseSetHash: caseSetHash(cases), drawsPerCase: 1 });
  assert.ok(problemsOf(valid(id, [slot('a', 0, gradedAttempt('none')), slot('a', 0, gradedAttempt('review'))])).some((p) => p.includes('duplicate drawIndex 0')));
  assert.ok(problemsOf(valid(id, [slot('a', 1, gradedAttempt('none'))])).some((p) => p.includes('drawIndex 1 >= drawsPerCase 1')));
});

test('parseRunArtifact verifies and validates the judge call shape too, and callShapes is closed', () => {
  const judged = valid(makeJudgedIdentity({ caseSetHash: caseSetHash(cases) }));
  assert.ok(problemsOf({ ...judged, identity: { ...judged.identity, judgeCallShapeHash: hashOf('another judge shape') } }).some((p) => p.includes('identity.judgeCallShapeHash')));
  assert.ok(problemsOf({ ...judged, callShapes: { system: makeCallShape(), judge: { ...makeJudgeCallShape(), effort: 'turbo' } } }).some((p) => p.startsWith('artifact.callShapes.judge.effort')));
  assert.ok(problemsOf({ ...judged, callShapes: { ...judged.callShapes, observed: {} } }).some((p) => p.includes('artifact.callShapes.observed: unknown field')));
});

const judgedId = (): RunIdentity => makeJudgedIdentity({ caseSetHash: caseSetHash(cases) });
const judgedDraw = (over: Record<string, unknown> = {}) => slot('a', 0, { ...gradedAttempt('none', { judgeStop: 'tool-use' }), ...over } as Attempt);

test('run/v3: a stored output may record its system stop as UNKNOWN, on a graded and on a judge-unmeasured attempt', () => {
  assert.deepEqual(problemsOf(valid(judgedId(), [judgedDraw({ systemStop: GAP })])), []);
  const retried = slot('a', 0, { ...unmeasured('judge', 'timeout', gradedAttempt('none').outputHash), systemStop: GAP } as Attempt, { ...gradedAttempt('none', { judgeStop: 'tool-use' }), systemStop: GAP } as Attempt);
  assert.deepEqual(problemsOf(valid(judgedId(), [retried])), []);
  // A failed attempt still states its own stop, and a known stop must still complete.
  assert.ok(problemsOf(valid(undefined, [slot('a', 0, { ...failedAttempt('system-error'), systemStop: GAP } as unknown as Attempt)])).some((p) => p.includes('systemStop')));
  assert.ok(problemsOf(valid(judgedId(), [judgedDraw({ systemStop: 'other' })])).some((p) => p.includes('systemStop')));
});

test('run/v3: every attempt that reached a rater carries a packet hash: a sha256 or UNKNOWN when judged, NO_JUDGE when graded by code', () => {
  assert.deepEqual(problemsOf(valid(judgedId(), [judgedDraw()])), []);
  assert.deepEqual(problemsOf({ ...valid(judgedId(), [judgedDraw({ packetHash: GAP })]), packetBasis: GAP }), []);
  for (const bad of [undefined, NO_JUDGE, 'abc', PACKET.toUpperCase(), 7]) {
    const d = judgedDraw({ packetHash: bad });
    if (bad === undefined) delete (d.attempts[0] as Record<string, unknown>)['packetHash'];
    assert.ok(problemsOf(valid(judgedId(), [d])).some((p) => p.includes('attempts[0].packetHash')), String(bad));
  }
  assert.deepEqual(problemsOf(valid(undefined, [slot('a', 0, gradedAttempt('none'))])), []);
  for (const bad of [PACKET, GAP]) {
    assert.ok(problemsOf(valid(undefined, [slot('a', 0, gradedAttempt('none', { packetHash: bad }))])).some((p) => p.includes('packetHash') && p.includes('NO_JUDGE')), bad);
  }
  // A judge retry re-grades the same packet.
  const moved = slot('a', 0, unmeasured('judge', 'timeout', gradedAttempt('none').outputHash), gradedAttempt('none', { judgeStop: 'tool-use', packetHash: hashOf('another packet') }));
  assert.ok(problemsOf(valid(judgedId(), [moved])).some((p) => p.includes('same output') && p.includes('packetHash')));
});

test('run/v3: packetBasis says where the packet hashes came from, and a declared basis names its source', () => {
  const judged = valid(judgedId(), [judgedDraw()]);
  assert.deepEqual(problemsOf({ ...judged, packetBasis: 'declared', packetSource: 'the dataset paper, section 3' }), []);
  assert.ok(problemsOf({ ...judged, packetBasis: 'declared' }).some((p) => p.includes('artifact.packetSource')));
  assert.ok(problemsOf({ ...judged, packetBasis: 'declared', packetSource: '' }).some((p) => p.includes('artifact.packetSource')));
  assert.ok(problemsOf({ ...judged, packetSource: 'x' }).some((p) => p.includes('artifact.packetSource')));
  assert.ok(problemsOf({ ...judged, packetBasis: NO_JUDGE }).some((p) => p.includes('artifact.packetBasis')));
  assert.ok(problemsOf({ ...judged, packetBasis: 'guessed' }).some((p) => p.includes('artifact.packetBasis')));
  assert.ok(problemsOf({ ...valid(), packetBasis: 'recorded' }).some((p) => p.includes('artifact.packetBasis')));
  // A hash with no stated basis is refused: UNKNOWN means nobody knows what was shown.
  assert.ok(problemsOf({ ...judged, packetBasis: GAP }).some((p) => p.includes('artifact.packetBasis')));
});

test('parseRunArtifact: a run whose seed is "NO_SEED" is a valid anchorset.run/v3 file, and the schema string does not move for it', () => {
  assert.equal(RUN_SCHEMA, 'anchorset.run/v3');
  const run = { ...valid(), identity: { ...valid().identity, seed: NO_SEED } };
  assert.deepEqual(problemsOf(run), []);
  assert.equal(parseRunArtifact(JSON.parse(JSON.stringify(run))).identity.seed, 'NO_SEED');
  assert.ok(problemsOf({ ...run, identity: { ...run.identity, seed: null } }).some((p) => p.includes('identity.seed: null is not allowed')));
  assert.ok(problemsOf({ ...run, identity: { ...run.identity, seed: 'no_seed' } }).some((p) => p.includes('identity.seed: must be a uint32 integer, "NO_SEED"')));
});
