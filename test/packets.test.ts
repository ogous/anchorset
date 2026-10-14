import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertSamePackets, caseSetHash, comparePackets, listed, LISTED_DRAWS, RUN_SCHEMA, samePacket } from '../src/artifact.ts';
import type { PacketBasis, RunArtifact } from '../src/artifact.ts';
import { InputError, RefusalError } from '../src/errors.ts';
import { barHash } from '../src/gate.ts';
import type { BarFile } from '../src/gate.ts';
import { GAP, NO_JUDGE, sha256Hex } from '../src/identity.ts';
import type { RunIdentity } from '../src/identity.ts';
import { JUDGE_CHANGE_PLAN_SCHEMA, judgeChangeRuns } from '../src/judgechange.ts';
import type { JudgeChangeInput, JudgeChangePlan, JudgeSide } from '../src/judgechange.ts';
import type { Attempt, Case, Draw } from '../src/scoring.ts';
import { callShapesFor, makeJudgedIdentity } from './helpers.ts';

// One rule: two raters are compared only on the same packet. The comparison of
// two runs' shown packets is comparePackets in src/artifact.ts, and its kernel is samePacket. The
// gate's judge-and-system split and the judge-change measurement both reach it, and differ only in
// the packet bases they admit.

const barFile: BarFile = { labels: ['lo', 'hi'], classes: { quality: { direction: 'floor', minPassRate: 0.5 } }, knownFailures: [] };
const cases: Case[] = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((id) => ({ id, klass: 'quality', input: { question: id }, expect: 'hi' }));
const newJudge: Partial<RunIdentity> = { judgeModelRequested: 'judge-next', judgeModelServed: 'judge-2026-06-01' };
const identity = (over: Partial<RunIdentity> = {}): RunIdentity => makeJudgedIdentity({ caseSetHash: caseSetHash(cases), barHash: barHash(barFile), drawsPerCase: 2, ...over });
const P = (caseId: string): string => sha256Hex(`packet ${caseId}`);
const OTHER = sha256Hex('another view of the same output');
const graded = (caseId: string, over: Record<string, unknown> = {}): Attempt =>
  ({ kind: 'graded', label: 'hi', outputHash: sha256Hex(`output ${caseId}`), systemStop: 'end', judgeStop: 'tool-use', packetHash: P(caseId), ...over }) as Attempt;
const judgeFailed = (caseId: string, over: Record<string, unknown> = {}): Attempt =>
  ({ kind: 'unmeasured', role: 'judge', reason: 'timeout', detail: 'timeout', outputHash: sha256Hex(`output ${caseId}`), systemStop: 'end', packetHash: P(caseId), ...over }) as Attempt;
const noResponse: Attempt = { kind: 'unmeasured', role: 'system', reason: 'timeout', detail: 'timeout' } as Attempt;
const systemFailed = { kind: 'failed', reason: 'system-error', detail: 'system-error', outputHash: sha256Hex('failure'), systemStop: 'NOT_SENT' } as unknown as Attempt;

type Edit = (draws: Draw[]) => Draw[];
const same: Edit = (d) => d;
const makeRun = (side: 'old' | 'new', edit: Edit = same, extra: Partial<RunArtifact> = {}): RunArtifact => {
  const id = identity(side === 'old' ? {} : newJudge);
  const draws = cases.flatMap((c) => [0, 1].map((drawIndex): Draw => ({ caseId: c.id, drawIndex, attempts: [graded(c.id)] })));
  return { schema: RUN_SCHEMA, identity: id, callShapes: callShapesFor(id), cases, draws: edit(draws), packetBasis: 'recorded', ...extra };
};
const key = (d: Draw): string => `${d.caseId}#${d.drawIndex}`;
/** The attempts of the named slots replaced. */
const onSlots = (keys: readonly string[], attempts: (d: Draw) => Attempt[]): Edit => (draws) => draws.map((d) => (keys.includes(key(d)) ? { ...d, attempts: attempts(d) } : d));
const withHash = (keys: readonly string[], packetHash: string): Edit => onSlots(keys, (d) => [graded(d.caseId, { packetHash })]);
const without = (keys: readonly string[]): Edit => (draws) => draws.filter((d) => !keys.includes(key(d)));
const basis = (packetBasis: PacketBasis): Partial<RunArtifact> => (packetBasis === 'declared' ? { packetBasis, packetSource: 'the judge harness documentation' } : { packetBasis });
const RECORDED = ['recorded'] as const;
const BOTH = ['recorded', 'declared'] as const;
const clean = { offBasis: [], draws: [] };

// --- The kernel -----------------------------------------------------------------------------------

test('samePacket: only two equal full sha256 hashes are the same packet; unknown is never equal', () => {
  assert.equal(samePacket(OTHER, OTHER), true);
  assert.equal(samePacket(OTHER, P('c1')), false);
  assert.equal(samePacket(GAP, GAP), false);
  assert.equal(samePacket(OTHER, GAP), false);
  assert.equal(samePacket(GAP, OTHER), false);
  assert.equal(samePacket(NO_JUDGE, NO_JUDGE), false);
  assert.equal(samePacket(undefined, undefined), false);
  assert.equal(samePacket(OTHER, undefined), false);
  assert.equal(samePacket(undefined, OTHER), false);
  // A shortened hash is not a hash, equal or not.
  assert.equal(samePacket(OTHER.slice(0, 12), OTHER.slice(0, 12)), false);
  assert.equal(samePacket(OTHER.toUpperCase(), OTHER.toUpperCase()), false);
});

// --- The primitive: each admitted and each refused case once ----------------------------------------

test('comparePackets admits: the same recorded packet on every draw', () => {
  assert.deepEqual(bare(comparePackets(makeRun('old'), makeRun('new'), RECORDED)), clean);
  assert.deepEqual(bare(comparePackets(makeRun('old'), makeRun('new'), BOTH)), clean);
});

test('comparePackets admits: a slot the judge could not grade, shown the same packet on both sides', () => {
  const failed = onSlots(['c2#1'], (d) => [judgeFailed(d.caseId)]);
  assert.deepEqual(bare(comparePackets(makeRun('old', failed), makeRun('new', failed), RECORDED)), clean);
  // One judge graded it and the other could not: both were shown the packet, and it is the same one.
  assert.deepEqual(bare(comparePackets(makeRun('old', failed), makeRun('new'), RECORDED)), clean);
});

test('comparePackets skips: a draw that reached no rater in either run has no packet to compare', () => {
  for (const attempt of [noResponse, systemFailed]) {
    const none = onSlots(['c1#0'], () => [attempt]);
    assert.deepEqual(bare(comparePackets(makeRun('old', none), makeRun('new', none), RECORDED)), clean);
  }
  // The two ways of reaching no rater are both no packet.
  assert.deepEqual(bare(comparePackets(makeRun('old', onSlots(['c1#0'], () => [noResponse])), makeRun('new', onSlots(['c1#0'], () => [systemFailed])), RECORDED)), clean);
});

test('comparePackets reads the final attempt: a retry that then graded carries the packet', () => {
  const retried = onSlots(['c1#1'], (d) => [noResponse, graded(d.caseId)]);
  assert.deepEqual(bare(comparePackets(makeRun('old', retried), makeRun('new'), RECORDED)), clean);
  const other = onSlots(['c1#1'], (d) => [noResponse, graded(d.caseId, { packetHash: OTHER })]);
  assert.deepEqual(bare(comparePackets(makeRun('old', other), makeRun('new'), RECORDED)), { offBasis: [], draws: ['c1#1'] });
});

test('comparePackets refuses: a draw shown different packets, on either side', () => {
  assert.deepEqual(bare(comparePackets(makeRun('old'), makeRun('new', withHash(['c1#1'], OTHER)), RECORDED)), { offBasis: [], draws: ['c1#1'] });
  assert.deepEqual(bare(comparePackets(makeRun('old', withHash(['c1#1'], OTHER)), makeRun('new'), RECORDED)), { offBasis: [], draws: ['c1#1'] });
});

test('comparePackets refuses: an unknown packet on one side, and on both (unknown is never equal)', () => {
  assert.deepEqual(bare(comparePackets(makeRun('old', withHash(['c2#0'], GAP)), makeRun('new'), RECORDED)), { offBasis: [], draws: ['c2#0'] });
  assert.deepEqual(bare(comparePackets(makeRun('old'), makeRun('new', withHash(['c2#0'], GAP)), RECORDED)), { offBasis: [], draws: ['c2#0'] });
  assert.deepEqual(bare(comparePackets(makeRun('old', withHash(['c2#0'], GAP)), makeRun('new', withHash(['c2#0'], GAP)), RECORDED)), { offBasis: [], draws: ['c2#0'] });
  // A judged attempt holds a full sha256 or the gap marker and nothing else: any other value is an
  // invalid draw, which the read of the final attempt throws on before anything is compared.
  for (const h of [NO_JUDGE, OTHER.slice(0, 12), '']) {
    assert.throws(() => comparePackets(makeRun('old', withHash(['c2#0'], h)), makeRun('new', withHash(['c2#0'], h)), RECORDED), (e: unknown) => e instanceof InputError && e.code === 'INVALID_DRAWS', h);
  }
});

test('comparePackets refuses: the packet of a slot the judge could not grade is compared too', () => {
  const failed = onSlots(['c2#1'], (d) => [judgeFailed(d.caseId, { packetHash: OTHER })]);
  assert.deepEqual(bare(comparePackets(makeRun('old', failed), makeRun('new'), RECORDED)), { offBasis: [], draws: ['c2#1'] });
});

test('comparePackets refuses: a packet on one side only', () => {
  const none = onSlots(['c1#0'], () => [noResponse]);
  assert.deepEqual(bare(comparePackets(makeRun('old', none), makeRun('new'), RECORDED)), { offBasis: [], draws: ['c1#0'] });
  assert.deepEqual(bare(comparePackets(makeRun('old'), makeRun('new', none), RECORDED)), { offBasis: [], draws: ['c1#0'] });
});

test('comparePackets refuses: a draw that exists in one run only, with a packet or without', () => {
  assert.deepEqual(bare(comparePackets(makeRun('old'), makeRun('new', without(['c2#1'])), RECORDED)), { offBasis: [], draws: ['c2#1'] });
  assert.deepEqual(bare(comparePackets(makeRun('old', without(['c2#1'])), makeRun('new'), RECORDED)), { offBasis: [], draws: ['c2#1'] });
  const none = onSlots(['c2#1'], () => [noResponse]);
  assert.deepEqual(bare(comparePackets(makeRun('old', none), makeRun('new', without(['c2#1'])), RECORDED)), { offBasis: [], draws: ['c2#1'] });
  assert.deepEqual(bare(comparePackets(makeRun('old', without(['c2#1'])), makeRun('new', none), RECORDED)), { offBasis: [], draws: ['c2#1'] });
});

test('comparePackets names every failing draw once, sorted, whatever order the runs list their draws in', () => {
  const reversed: Edit = (d) => [...d].reverse();
  const bad = withHash(['c2#1', 'c1#0'], OTHER);
  const want = { offBasis: [], draws: ['c1#0', 'c2#1'] };
  assert.deepEqual(bare(comparePackets(makeRun('old'), makeRun('new', bad), RECORDED)), want);
  assert.deepEqual(bare(comparePackets(makeRun('old', reversed), makeRun('new', (d) => reversed(bad(d))), RECORDED)), want);
});

test('comparePackets, the one parameter: which packet bases are admitted', () => {
  const run = (side: 'old' | 'new', b: PacketBasis): RunArtifact => makeRun(side, same, basis(b));
  // Recorded is admitted by both callers.
  assert.deepEqual(comparePackets(run('old', 'recorded'), run('new', 'recorded'), RECORDED).offBasis, []);
  // Declared: admitted only where the caller admits it, on either side or both.
  assert.deepEqual(comparePackets(run('old', 'declared'), run('new', 'declared'), BOTH).offBasis, []);
  assert.deepEqual(comparePackets(run('old', 'declared'), run('new', 'recorded'), BOTH).offBasis, []);
  assert.deepEqual(comparePackets(run('old', 'declared'), run('new', 'recorded'), RECORDED).offBasis, ['first']);
  assert.deepEqual(comparePackets(run('old', 'recorded'), run('new', 'declared'), RECORDED).offBasis, ['second']);
  assert.deepEqual(comparePackets(run('old', 'declared'), run('new', 'declared'), RECORDED).offBasis, ['first', 'second']);
  // Unknown and no-judge are admitted by nobody.
  for (const admitted of [RECORDED, BOTH]) {
    for (const b of [GAP, NO_JUDGE] as const) {
      assert.deepEqual(comparePackets(run('old', b), run('new', 'recorded'), admitted).offBasis, ['first']);
      assert.deepEqual(comparePackets(run('old', 'recorded'), run('new', b), admitted).offBasis, ['second']);
      assert.deepEqual(comparePackets(run('old', b), run('new', b), admitted).offBasis, ['first', 'second']);
    }
  }
  // Nothing admitted admits nothing.
  assert.deepEqual(comparePackets(run('old', 'recorded'), run('new', 'recorded'), []).offBasis, ['first', 'second']);
  // The basis changes nothing about the draws: equal declared hashes are equal hashes, and the draws are compared whatever the basis.
  assert.deepEqual(comparePackets(run('old', 'declared'), run('new', 'declared'), RECORDED).draws, []);
  assert.deepEqual(bare(comparePackets(makeRun('old', same, basis('declared')), makeRun('new', withHash(['c1#0'], OTHER)), RECORDED)), { offBasis: ['first'], draws: ['c1#0'] });
});

test('comparePackets is pure: it changes neither run and refuses nothing itself', () => {
  const a = makeRun('old', withHash(['c1#0'], GAP), basis(GAP));
  const b = makeRun('new', without(['c2#1']));
  const before = JSON.stringify([a, b]);
  assert.doesNotThrow(() => comparePackets(a, b, RECORDED));
  assert.equal(JSON.stringify([a, b]), before);
});

// --- The two callers: one comparison, and the differences that remain ------------------------------

const file = (name: string, run: unknown): JudgeChangeInput => ({ name, bytes: new TextEncoder().encode(JSON.stringify(run)) });
const sideOf = (id: RunIdentity): JudgeSide => ({
  judgeDefinitionHash: id.judgeDefinitionHash,
  judgeModelRequested: id.judgeModelRequested,
  judgeModelServed: id.judgeModelServed,
  judgeCallShapeHash: id.judgeCallShapeHash,
  judgeHarnessVersion: id.judgeHarnessVersion,
  rubricHash: id.rubricHash,
});
/** The judge-change measurement of one system, "A", on these two runs. */
const measure = (old: RunArtifact, next: RunArtifact) => {
  const files = [file('old.json', old), file('new.json', next)];
  const plan: JudgeChangePlan = {
    schema: JUDGE_CHANGE_PLAN_SCHEMA,
    barHash: barHash(barFile),
    caseSetHash: caseSetHash(cases),
    drawsPerCase: 2,
    judges: { old: sideOf(identity()), new: sideOf(identity(newJudge)) },
    judgeMoves: ['judgeModelRequested', 'judgeModelServed'],
    systems: { A: { old: sha256Hex((files[0] as JudgeChangeInput).bytes), new: sha256Hex((files[1] as JudgeChangeInput).bytes) } },
    storedOutputs: 'system-side-compared',
    measuredClass: 'quality',
    cut: 'hi',
    drawSets: { estimate: [0, 1] },
    labelRule: 'worst',
    pooling: 'items-equal',
  };
  return judgeChangeRuns(files, barFile, plan);
};
const bare = (c: ReturnType<typeof comparePackets>) => ({ offBasis: c.offBasis, draws: c.draws });
const refusal = (f: () => unknown): RefusalError => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof RefusalError, String(e));
    return e;
  }
  throw new Error('nothing was refused');
};

test('both callers admit the same recorded packets', () => {
  assert.doesNotThrow(() => assertSamePackets(makeRun('old'), makeRun('new')));
  assert.equal(measure(makeRun('old'), makeRun('new')).kind, 'measurement');
});

test('deliberate difference: a declared packet is admitted by judge-change and refused by the gate split', () => {
  const old = makeRun('old', same, basis('declared'));
  const next = makeRun('new', same, basis('declared'));
  assert.deepEqual(measure(old, next).packetEquality.judges, 'by declaration');
  const e = refusal(() => assertSamePackets(old, next));
  assert.equal(e.code, 'PACKET_MISMATCH');
  assert.deepEqual([...e.fields], ['packetBasis (original)', 'packetBasis (re-judged baseline)']);
});

const TODO_BASIS = 'the basis must be recorded or declared; a run with an unknown basis has to be produced again by a harness that records what the judge was shown (packetHashOf), or its packets declared from a documented view with packetBasis: "declared" and a packetSource';
const TODO_UNKNOWN = 'for the draws whose packet is unknown, the packet hash was not recorded: grade the stored outputs again with a harness that records each packet hash as it is shown, or declare it (the example importers declare it: docs/IMPORTERS.md)';
const TODO_DIFFERS = 'for the draws on which the judges differ, the two judges saw different packets, so their grades are not grades of the same thing: re-grade so that both judges are shown the same packet';

test('both callers refuse the same draws, each in its own words', () => {
  const old = makeRun('old');
  const next = makeRun('new', withHash(['c2#0'], OTHER));
  const gate = refusal(() => assertSamePackets(old, next));
  assert.deepEqual([gate.code, [...gate.fields]], ['PACKET_MISMATCH', ['packetHash[c2#0]']]);
  assert.ok(gate.message.startsWith('PACKET_MISMATCH: the two judges were not shown the same packet, or what one or both were shown is unknown, on packetHash[c2#0]; the original and the re-judged baseline are compared only where both recorded the same packet; '));
  const change = refusal(() => measure(old, next));
  assert.deepEqual([change.code, [...change.fields]], ['PACKET_MISMATCH', ['packetHash[A/c2#0]']]);
  assert.equal(change.message, `PACKET_MISMATCH: system "A": the two judges were not shown the same packet on 1 draw(s) (c2#0); ${TODO_DIFFERS}`);
  // Unknown on both sides refuses in both.
  const gap = withHash(['c1#1'], GAP);
  assert.deepEqual([...refusal(() => assertSamePackets(makeRun('old', gap), makeRun('new', gap))).fields], ['packetHash[c1#1]']);
  const bothGap = refusal(() => measure(makeRun('old', gap), makeRun('new', gap)));
  assert.deepEqual([...bothGap.fields], ['packetHash[A/c1#1]']);
  assert.equal(bothGap.message, `PACKET_MISMATCH: system "A": what one or both of the two judges were shown is unknown on 1 draw(s) (c1#1); ${TODO_UNKNOWN}`);
});

test('comparePackets says why each draw fails: unknown (not a sha256 on either side, or on one side only) or differs (both known, unequal)', () => {
  const why = comparePackets(makeRun('old', withHash(['c1#0'], GAP)), makeRun('new', (d) => without(['c2#1'])(withHash(['c3#0', 'c1#0'], OTHER)(d))), RECORDED).why;
  assert.deepEqual(why, { 'c1#0': 'unknown', 'c2#1': 'unknown', 'c3#0': 'differs' });
  assert.deepEqual(comparePackets(makeRun('old'), makeRun('new'), RECORDED).why, {});
});

test('judge-change, only unknown: one sentence, the draws sorted', () => {
  const change = refusal(() => measure(makeRun('old', withHash(['c3#1', 'c1#0'], GAP)), makeRun('new')));
  assert.deepEqual([...change.fields], ['packetHash[A/c1#0]', 'packetHash[A/c3#1]']);
  assert.equal(change.message, `PACKET_MISMATCH: system "A": what one or both of the two judges were shown is unknown on 2 draw(s) (c1#0, c3#1); ${TODO_UNKNOWN}`);
});

test('judge-change, only differs: one sentence, the draws sorted', () => {
  const change = refusal(() => measure(makeRun('old'), makeRun('new', withHash(['c2#1', 'c1#0'], OTHER))));
  assert.deepEqual([...change.fields], ['packetHash[A/c1#0]', 'packetHash[A/c2#1]']);
  assert.equal(change.message, `PACKET_MISMATCH: system "A": the two judges were not shown the same packet on 2 draw(s) (c1#0, c2#1); ${TODO_DIFFERS}`);
});

test('judge-change, both causes at once: both clauses, both sentences, every draw in the fields', () => {
  const change = refusal(() => measure(makeRun('old', withHash(['c3#0'], GAP)), makeRun('new', withHash(['c2#1', 'c1#0'], OTHER))));
  assert.deepEqual([...change.fields], ['packetHash[A/c1#0]', 'packetHash[A/c2#1]', 'packetHash[A/c3#0]']);
  assert.equal(change.message, `PACKET_MISMATCH: system "A": the two judges were not shown the same packet on 2 draw(s) (c1#0, c2#1), and what one or both of them were shown is unknown on 1 draw(s) (c3#0); ${TODO_UNKNOWN}; ${TODO_DIFFERS}`);
});

test('judge-change lists the first ten draws of a cause and says how many more; the fields hold every draw', () => {
  const all = cases.flatMap((c) => [0, 1].map((i) => `${c.id}#${i}`));
  assert.equal(all.length, 12);
  const change = refusal(() => measure(makeRun('old'), makeRun('new', withHash(all, OTHER))));
  assert.equal(change.fields.length, 12);
  assert.deepEqual([...change.fields], [...all].sort().map((k) => `packetHash[A/${k}]`));
  assert.equal(change.message, `PACKET_MISMATCH: system "A": the two judges were not shown the same packet on 12 draw(s) (${[...all].sort().slice(0, 10).join(', ')}, and 2 more); ${TODO_DIFFERS}`);
});

test('the listing of a packet refusal: ten draws are listed whole, eleven are ten and "1 more"; the gate lists as judge-change does, and the fields hold every draw', () => {
  const all = cases.flatMap((c) => [0, 1].map((i) => `${c.id}#${i}`)).sort();
  assert.equal(LISTED_DRAWS, 10);
  assert.equal(listed(all.slice(0, 9)), all.slice(0, 9).join(', '));
  assert.equal(listed(all.slice(0, 10)), all.slice(0, 10).join(', '));
  assert.equal(listed(all.slice(0, 11)), `${all.slice(0, 10).join(', ')}, and 1 more`);
  assert.equal(listed(all), `${all.slice(0, 10).join(', ')}, and 2 more`);
  assert.equal(listed([]), '');
  for (const n of [9, 10, 11, 12]) {
    const bad = all.slice(0, n);
    const more = n > 10 ? `, and ${n - 10} more` : '';
    const change = refusal(() => measure(makeRun('old'), makeRun('new', withHash(bad, OTHER))));
    assert.deepEqual([...change.fields], bad.map((k) => `packetHash[A/${k}]`), String(n));
    assert.equal(change.message, `PACKET_MISMATCH: system "A": the two judges were not shown the same packet on ${n} draw(s) (${bad.slice(0, 10).join(', ')}${more}); ${TODO_DIFFERS}`, String(n));
    // Each cause has its own listing, and each stops at ten.
    const unknown = refusal(() => measure(makeRun('old', withHash(bad, GAP)), makeRun('new')));
    assert.equal(unknown.message, `PACKET_MISMATCH: system "A": what one or both of the two judges were shown is unknown on ${n} draw(s) (${bad.slice(0, 10).join(', ')}${more}); ${TODO_UNKNOWN}`, String(n));
    // The gate: the same cap in the message, and every draw in the fields.
    const gate = refusal(() => assertSamePackets(makeRun('old'), makeRun('new', withHash(bad, OTHER))));
    assert.deepEqual([...gate.fields], bad.map((k) => `packetHash[${k}]`), String(n));
    const shown = bad.slice(0, 10).map((k) => `packetHash[${k}]`).join(', ');
    assert.ok(gate.message.startsWith(`PACKET_MISMATCH: the two judges were not shown the same packet, or what one or both were shown is unknown, on ${shown}${more}; the original and the re-judged baseline are compared only where both recorded the same packet; `), `${n}: ${gate.message}`);
  }
});

// --- More than one system: every system is read before anything is refused -------------------------------------------

/** The runs of another system: other outputs and other packets than system A's, the same on both sides. */
const other = (tag: string): Edit => (draws) => draws.map((d) => ({ ...d, attempts: [graded(d.caseId, { outputHash: sha256Hex(`output ${tag} ${d.caseId}`), packetHash: sha256Hex(`packet ${tag} ${d.caseId}`) })] }));
const then = (...edits: Edit[]): Edit => (draws) => edits.reduce((d, e) => e(d), draws);
type Sides = { old?: Edit; new?: Edit; oldExtra?: Partial<RunArtifact>; newExtra?: Partial<RunArtifact> };
/** The judge-change measurement of several systems; each system's runs hold their own outputs. */
const measureSystems = (systems: Record<string, Sides>) => {
  const files: JudgeChangeInput[] = [];
  const roster: Record<string, { old: string; new: string }> = {};
  for (const [name, s] of Object.entries(systems)) {
    const old = file(`${name}.old.json`, makeRun('old', then(other(name), s.old ?? same), s.oldExtra ?? {}));
    const next = file(`${name}.new.json`, makeRun('new', then(other(name), s.new ?? same), s.newExtra ?? {}));
    files.push(old, next);
    roster[name] = { old: sha256Hex(old.bytes), new: sha256Hex(next.bytes) };
  }
  const plan: JudgeChangePlan = {
    schema: JUDGE_CHANGE_PLAN_SCHEMA,
    barHash: barHash(barFile),
    caseSetHash: caseSetHash(cases),
    drawsPerCase: 2,
    judges: { old: sideOf(identity()), new: sideOf(identity(newJudge)) },
    judgeMoves: ['judgeModelRequested', 'judgeModelServed'],
    systems: roster,
    storedOutputs: 'system-side-compared',
    measuredClass: 'quality',
    cut: 'hi',
    drawSets: { estimate: [0, 1] },
    labelRule: 'worst',
    pooling: 'items-equal',
  };
  return judgeChangeRuns(files, barFile, plan);
};
const gapEvery: Edit = (draws) => draws.map((d) => ({ ...d, attempts: [graded(d.caseId, { packetHash: GAP, outputHash: (d.attempts[0] as { outputHash: string }).outputHash })] }));
/** The packet hash of the named slots replaced, and nothing else of them: the outputs stay the system's own. */
const packetOf = (keys: readonly string[], packetHash: string): Edit => onSlots(keys, (d) => d.attempts.map((a) => ({ ...a, packetHash }) as Attempt));

test('judge-change, several systems: clean systems are measured, and a system after a clean one is still read', () => {
  assert.equal(measureSystems({ A: {}, B: {}, C: {} }).kind, 'measurement');
  // A is clean, B fails: the refusal is B's, as it would be for B alone.
  const second = refusal(() => measureSystems({ A: {}, B: { new: packetOf(['c2#1', 'c1#0'], OTHER) } }));
  assert.deepEqual([second.code, [...second.fields]], ['PACKET_MISMATCH', ['packetHash[B/c1#0]', 'packetHash[B/c2#1]']]);
  assert.equal(second.message, `PACKET_MISMATCH: system "B": the two judges were not shown the same packet on 2 draw(s) (c1#0, c2#1); ${TODO_DIFFERS}`);
  // The last of three.
  const third = refusal(() => measureSystems({ A: {}, B: {}, C: { old: packetOf(['c4#0'], GAP) } }));
  assert.deepEqual([...third.fields], ['packetHash[C/c4#0]']);
  assert.equal(third.message, `PACKET_MISMATCH: system "C": what one or both of the two judges were shown is unknown on 1 draw(s) (c4#0); ${TODO_UNKNOWN}`);
  // A clean system first, then one off basis.
  const basisSecond = refusal(() => measureSystems({ A: {}, B: { new: gapEvery, newExtra: basis(GAP) } }));
  assert.deepEqual([...basisSecond.fields], ['packetBasis (B, new judge)']);
  assert.equal(basisSecond.message, `PACKET_MISMATCH: system "B": the new judge has packetBasis UNKNOWN; ${TODO_BASIS}`);
});

test('judge-change, several systems that fail: one refusal names every failing draw of every system, each system with its own listing, and says what to do once for each cause', () => {
  const both = refusal(() => measureSystems({ A: { new: packetOf(['c3#0'], OTHER) }, B: { old: packetOf(['c1#1'], GAP), new: packetOf(['c2#0'], OTHER) } }));
  assert.deepEqual([both.code, [...both.fields]], ['PACKET_MISMATCH', ['packetHash[A/c3#0]', 'packetHash[B/c1#1]', 'packetHash[B/c2#0]']]);
  assert.equal(
    both.message,
    `PACKET_MISMATCH: system "A": the two judges were not shown the same packet on 1 draw(s) (c3#0); system "B": the two judges were not shown the same packet on 1 draw(s) (c2#0), and what one or both of them were shown is unknown on 1 draw(s) (c1#1); ${TODO_UNKNOWN}; ${TODO_DIFFERS}`,
  );
  // The same cause in both systems: what to do is said once.
  const same2 = refusal(() => measureSystems({ A: { new: packetOf(['c3#0'], OTHER) }, B: { new: packetOf(['c2#0'], OTHER) } }));
  assert.deepEqual([...same2.fields], ['packetHash[A/c3#0]', 'packetHash[B/c2#0]']);
  assert.equal(same2.message, `PACKET_MISMATCH: system "A": the two judges were not shown the same packet on 1 draw(s) (c3#0); system "B": the two judges were not shown the same packet on 1 draw(s) (c2#0); ${TODO_DIFFERS}`);
  assert.equal(same2.message.split(TODO_DIFFERS).length, 2);
  // The systems are named in the order of their names, whatever the order of the roster.
  const reversed = refusal(() => measureSystems({ B: { new: packetOf(['c2#0'], OTHER) }, A: { new: packetOf(['c3#0'], OTHER) } }));
  assert.deepEqual([...reversed.fields], ['packetHash[A/c3#0]', 'packetHash[B/c2#0]']);
  // A cause that only an earlier system has is still told what to do about: unknown in A alone, a difference in B alone, and the reverse.
  const unknownFirst = refusal(() => measureSystems({ A: { old: packetOf(['c1#1'], GAP) }, B: { new: packetOf(['c2#0'], OTHER) }, C: {} }));
  assert.equal(unknownFirst.message, `PACKET_MISMATCH: system "A": what one or both of the two judges were shown is unknown on 1 draw(s) (c1#1); system "B": the two judges were not shown the same packet on 1 draw(s) (c2#0); ${TODO_UNKNOWN}; ${TODO_DIFFERS}`);
  const differsFirst = refusal(() => measureSystems({ A: { new: packetOf(['c2#0'], OTHER) }, B: { old: packetOf(['c1#1'], GAP) }, C: {} }));
  assert.equal(differsFirst.message, `PACKET_MISMATCH: system "A": the two judges were not shown the same packet on 1 draw(s) (c2#0); system "B": what one or both of the two judges were shown is unknown on 1 draw(s) (c1#1); ${TODO_UNKNOWN}; ${TODO_DIFFERS}`);
  // The cap of ten is each system's own: twelve draws in A, one in B.
  const all = cases.flatMap((c) => [0, 1].map((i) => `${c.id}#${i}`)).sort();
  const many = refusal(() => measureSystems({ A: { new: packetOf(all, OTHER) }, B: { new: packetOf(['c2#0'], OTHER) } }));
  assert.equal(many.fields.length, 13);
  assert.equal(many.message, `PACKET_MISMATCH: system "A": the two judges were not shown the same packet on 12 draw(s) (${all.slice(0, 10).join(', ')}, and 2 more); system "B": the two judges were not shown the same packet on 1 draw(s) (c2#0); ${TODO_DIFFERS}`);
});

test('judge-change, several systems: a run off basis in one system and failing draws in another are named together; every run off basis is named', () => {
  // A is off basis, B differs: both are named. A system off basis is named by its basis alone.
  const mixed = refusal(() => measureSystems({ A: { new: gapEvery, newExtra: basis(GAP) }, B: { new: packetOf(['c5#1'], OTHER) } }));
  assert.deepEqual([mixed.code, [...mixed.fields]], ['PACKET_MISMATCH', ['packetBasis (A, new judge)', 'packetHash[B/c5#1]']]);
  assert.equal(mixed.message, `PACKET_MISMATCH: system "A": the new judge has packetBasis UNKNOWN; system "B": the two judges were not shown the same packet on 1 draw(s) (c5#1); ${TODO_BASIS}; ${TODO_DIFFERS}`);
  // The other order: A differs, B is off basis.
  const mixed2 = refusal(() => measureSystems({ A: { old: packetOf(['c5#1'], GAP) }, B: { old: gapEvery, oldExtra: basis(GAP) } }));
  assert.deepEqual([...mixed2.fields], ['packetHash[A/c5#1]', 'packetBasis (B, old judge)']);
  assert.equal(mixed2.message, `PACKET_MISMATCH: system "A": what one or both of the two judges were shown is unknown on 1 draw(s) (c5#1); system "B": the old judge has packetBasis UNKNOWN; ${TODO_BASIS}; ${TODO_UNKNOWN}`);
  // Every run off basis, of every system, old judge first within a system.
  const off = refusal(() => measureSystems({ A: { old: gapEvery, oldExtra: basis(GAP), new: gapEvery, newExtra: basis(GAP) }, B: {}, C: { new: gapEvery, newExtra: basis(GAP) } }));
  assert.deepEqual([...off.fields], ['packetBasis (A, old judge)', 'packetBasis (A, new judge)', 'packetBasis (C, new judge)']);
  assert.equal(off.message, `PACKET_MISMATCH: system "A": the old judge has packetBasis UNKNOWN and the new judge has packetBasis UNKNOWN; system "C": the new judge has packetBasis UNKNOWN; ${TODO_BASIS}`);
  assert.equal(off.message.split(TODO_BASIS).length, 2);
});

// The two places once differed in two ways; they agree now: both sort the draws and both name every run off basis.

test('the two places agree on the order of the named draws: both sort them', () => {
  const reversed: Edit = (d) => [...d].reverse();
  const old = makeRun('old', reversed);
  const next = makeRun('new', packetOf(['c1#0', 'c2#1'], OTHER));
  assert.deepEqual([...refusal(() => assertSamePackets(old, next)).fields], ['packetHash[c1#0]', 'packetHash[c2#1]']);
  assert.deepEqual([...refusal(() => measure(old, next)).fields], ['packetHash[A/c1#0]', 'packetHash[A/c2#1]']);
});

test('the two places agree on naming every run off basis, old judge first', () => {
  const gapAll: Edit = (draws) => draws.map((d) => ({ ...d, attempts: [graded(d.caseId, { packetHash: GAP })] }));
  const old = makeRun('old', gapAll, basis(GAP));
  const next = makeRun('new', gapAll, basis(GAP));
  assert.deepEqual([...refusal(() => assertSamePackets(old, next)).fields], ['packetBasis (original)', 'packetBasis (re-judged baseline)']);
  const change = refusal(() => measure(old, next));
  assert.equal(change.code, 'PACKET_MISMATCH');
  assert.deepEqual([...change.fields], ['packetBasis (A, old judge)', 'packetBasis (A, new judge)']);
  assert.equal(change.message, `PACKET_MISMATCH: system "A": the old judge has packetBasis UNKNOWN and the new judge has packetBasis UNKNOWN; ${TODO_BASIS}`);
  // One run alone off basis is named as that judge.
  const one = refusal(() => measure(makeRun('old'), next));
  assert.deepEqual([...one.fields], ['packetBasis (A, new judge)']);
  assert.equal(one.message, `PACKET_MISMATCH: system "A": the new judge has packetBasis UNKNOWN; ${TODO_BASIS}`);
});

test('judge-change never brings the comparison a draw of one run only, or a hash that is neither a sha256 nor the gap', () => {
  // Before the comparison was one function, judge-change walked the old-judge run's draws alone and
  // took only the gap marker for unknown. Both cases are refused before the packets are read, so the
  // one comparison's stricter reading of them changes no refusal.
  for (const [old, next] of [[makeRun('old'), makeRun('new', without(['c2#1']))], [makeRun('old', without(['c2#1'])), makeRun('new')]] as const) {
    const e = refusal(() => measure(old, next));
    assert.deepEqual([e.code, [...e.fields]], ['ITEM_SET_MISMATCH', ['c2#1']]);
  }
  for (const h of [NO_JUDGE, OTHER.slice(0, 12)]) {
    assert.throws(() => measure(makeRun('old', withHash(['c1#0'], h)), makeRun('new', withHash(['c1#0'], h))), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARTIFACT', h);
  }
});

// --- One implementation ---------------------------------------------------------------------------

const SRC = join(import.meta.dirname, '..', 'src');
/** A source file's code: block comments and whole-line or trailing line comments removed. */
const code = (name: string): string => readFileSync(join(SRC, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const sources = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts')).sort();
const count = (text: string, re: RegExp): number => [...text.matchAll(re)].length;
/** A read of an attempt's packet hash (`x.packetHash`); the text of a parser message (`.packetHash:`) is not one. */
const FIELD_READ = /\.packetHash\b(?!:)/g;
/** The files whose code matches, with how many times. */
const where = (re: RegExp): Record<string, number> => Object.fromEntries(sources.map((f) => [f, count(code(f), re)] as const).filter(([, n]) => n > 0));

test('one implementation: the comparison and its kernel are defined once, in artifact.ts', () => {
  assert.deepEqual(where(/\bfunction comparePackets\b|\bcomparePackets\s*=/g), { 'artifact.ts': 1 });
  assert.deepEqual(where(/\bfunction samePacket\b|\bsamePacket\s*=/g), { 'artifact.ts': 1 });
  assert.deepEqual(where(/\bfunction shownPacket\b|\bshownPacket\s*=/g), { 'artifact.ts': 1 });
});

test('one implementation: regression.ts and judgechange.ts reach the comparison only through it', () => {
  // The gate: assertSamePackets is the gate's refusal around comparePackets, and regression.ts reads no packet itself.
  const regression = code('regression.ts');
  assert.equal(count(regression, /\bassertSamePackets\(/g), 1);
  assert.equal(count(regression, /packetHash|packetBasis|isSha256Hex|comparePackets|samePacket/g), 0);
  const gate = code('artifact.ts');
  const body = gate.slice(gate.indexOf('export function assertSamePackets('));
  assert.equal(count(body, /\bcomparePackets\(/g), 1);
  assert.equal(count(body, /shownPacket|isSha256Hex|\.packetHash\b|===|!==/g), 0, 'assertSamePackets compares nothing itself');
  // Judge-change: one call for the two judges' runs, one call of the kernel for a reference's hash.
  const change = code('judgechange.ts');
  assert.equal(count(change, /\bcomparePackets\(/g), 1);
  assert.equal(count(change, /\bsamePacket\(/g), 1);
  // It reads an attempt's packet hash in one place only: the one packet of a case's draws, which is
  // handed to the kernel. It never sets two packet hashes against each other.
  assert.equal(count(change, FIELD_READ), 1);
  assert.equal(count(change, /packetHash\s*[!=]==|[!=]==\s*[\w.]*packetHash\b/g), 0);
  assert.equal(count(change, /shown\s*[!=]==\s*judged|judged\s*[!=]==\s*shown/g), 0);
});

test('one implementation: a new place that reads an attempt\'s packet hash, or refuses on packets, fails here', () => {
  // Reads of the field on an attempt. artifact.ts: shownPacket. judgechange.ts and stability.ts: the
  // draws of one case under one output must show one packet, which is a check inside a case and not
  // a comparison of two raters' runs.
  assert.deepEqual(where(FIELD_READ), { 'artifact.ts': 1, 'judgechange.ts': 1, 'stability.ts': 2 });
  // Code that names the refusal. flips.ts refuses a run whose packet basis is declared: the one lock that the draws of stability.ts rest on.
  // agreement.ts, drift.ts and cli.ts check rating files: one hash per
  // item and rater, no attempts, no basis, no draw that reached no rater. They are not this primitive.
  assert.deepEqual(Object.keys(where(/'PACKET_MISMATCH'/g)), ['agreement.ts', 'artifact.ts', 'cli.ts', 'drift.ts', 'errors.ts', 'flips.ts', 'judgechange.ts', 'stability.ts']);
});
