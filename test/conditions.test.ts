// The recorded conditions of a run (run/v4 `calls` and `conditions`): the checks of each record, where calls may sit,
// the counts the `conditions` command prints, and that none of it moves a verdict. Synthetic data only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parseRunArtifact, RUN_SCHEMA, runArtifactProblems } from '../src/artifact.ts';
import type { RunArtifact } from '../src/artifact.ts';
import { cacheShare, conditionsProblems, conditionsReport, copiesRecord, drawSpreads, drawsTogether, percentText, requestHashPairs, resolvedCalls, tenthsOfPercent, timeNanos } from '../src/conditions.ts';
import type { CopiesRecord } from '../src/conditions.ts';
import { repeatFlips } from '../src/flips.ts';
import type { CallRecord, RunConditions } from '../src/conditions.ts';
import { GAP, hashOf, NOT_RETURNED, RETURNED_NULL } from '../src/identity.ts';
import { gateRuns } from '../src/regression.ts';
import { parseBarFile } from '../src/gate.ts';
import type { Attempt, Draw } from '../src/scoring.ts';
import { judgeRetry, REFUND_BAR, refundRun } from './helpers.ts';

const root = join(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'anchorset-conditions-'));
after(() => rmSync(work, { recursive: true, force: true }));
const cli = (...args: string[]) => spawnSync(process.execPath, [join(root, 'src', 'cli.ts'), ...args], { encoding: 'utf8', cwd: root });
let n = 0;
const put = (x: unknown): string => {
  const p = join(work, `run-${(n += 1)}.json`);
  writeFileSync(p, JSON.stringify(x));
  return p;
};

const JUDGE_SERVED = 'example-judge-2026-01-15';
const SYSTEM_SERVED = 'model-x-2026-01-01';
const T0 = '2026-11-08T10:00:00Z';
const usage = (total: number | string, read: number | string, write: number | string = 0, out: number | string = 10) => ({ inputTokensTotal: total, cacheReadTokens: read, cacheWriteTokens: write, outputTokens: out });
const judgeCall = (over: Partial<CallRecord> = {}): CallRecord => ({
  role: 'judge',
  requestHash: hashOf('request'),
  submission: 'batch-1',
  sentAt: T0,
  servedModel: JUDGE_SERVED,
  receivedAt: GAP,
  usage: usage(100, 80) as CallRecord['usage'] & object,
  serving: { 'provider.service_tier': 'standard' },
  ...over,
});
const systemCall = (over: Partial<CallRecord> = {}): CallRecord => ({
  role: 'system',
  requestHash: hashOf('system request'),
  sentAt: T0,
  servedModel: SYSTEM_SERVED,
  receivedAt: '2026-11-08T10:00:01Z',
  usage: usage(50, 0) as CallRecord['usage'] & object,
  serving: {},
  ...over,
});
const CONDITIONS: RunConditions = {
  judge: { concurrency: GAP, servingKeys: ['provider.service_tier'], submissions: [
    { id: 'batch-1', kind: 'provider-batch', size: 100, sharedWith: [], submittedAt: T0, endedAt: '2026-11-08T10:30:00Z', recordedAt: '2026-11-08T10:31:00Z' },
    { id: 'batch-2', kind: 'provider-batch', size: 100, sharedWith: [], submittedAt: '2026-11-08T11:00:00Z', endedAt: NOT_RETURNED, recordedAt: GAP },
  ] },
  system: { concurrency: 4, servingKeys: [], submissions: [] },
};

/** A run/v4 copy of `run` with `calls(draw, attemptIndex)` on every attempt and the conditions block. */
function v4(run: RunArtifact, calls: (d: Draw, i: number, a: Attempt) => CallRecord[], conditions: RunConditions | undefined = CONDITIONS): RunArtifact {
  return {
    ...run,
    schema: RUN_SCHEMA,
    draws: run.draws.map((d) => ({ ...d, attempts: d.attempts.map((a, i) => ({ ...a, calls: calls(d, i, a) })) })),
    ...(conditions === undefined ? {} : { conditions }),
  } as RunArtifact;
}
const base = (): RunArtifact => refundRun({ grades: { r1: ['4', '4'], r2: ['4', '3'] } });
/** Every attempt: one system call then the judge call, both answered. */
const plain = (): RunArtifact => v4(base(), () => [systemCall(), judgeCall()]);
const problems = (x: unknown): string[] => runArtifactProblems(JSON.parse(JSON.stringify(x)));

// ---- the records on their own ----------------------------------------------------------------------------------------

test('a v4 run with calls and conditions is valid, and v3 runs still read', () => {
  assert.equal(RUN_SCHEMA, 'anchorset.run/v4');
  assert.deepEqual(problems(plain()), []);
  assert.deepEqual(problems(base()), []);
  assert.equal(parseRunArtifact(JSON.parse(JSON.stringify(base()))).schema, 'anchorset.run/v3');
});

test('a v3 file holds no v4 key: calls or conditions in it is invalid, named by key', () => {
  const r = { ...plain(), schema: 'anchorset.run/v3' };
  const p = problems(r);
  assert.ok(p.some((x) => x === 'artifact.conditions: not a key of "anchorset.run/v3"; write schema "anchorset.run/v4"'), p.join('\n'));
  assert.ok(p.some((x) => x.startsWith('artifact.draws[0].attempts[0].calls: not a key of "anchorset.run/v3"')), p.join('\n'));
  for (const other of ['anchorset.run/v2', 'anchorset.run/v5', 'run']) {
    assert.deepEqual(problems({ ...base(), schema: other }).filter((x) => x.startsWith('artifact.schema')), ['artifact.schema: must be "anchorset.run/v4" (or "anchorset.run/v3", which is still read)'], other);
  }
});

test('each field of a call record: invalid input names the path', () => {
  const at = (over: Partial<CallRecord> | Record<string, unknown>, role: 'judge' | 'system' = 'judge') =>
    problems(v4(base(), () => [systemCall(role === 'system' ? (over as Partial<CallRecord>) : {}), judgeCall(role === 'judge' ? (over as Partial<CallRecord>) : {})])).join('\n');
  assert.match(at({ requestHash: 'abc' }), /calls\[1\]\.requestHash: must be the full sha256/);
  assert.match(at({ requestHash: null } as never), /calls\[1\]\.requestHash/);
  assert.match(at({ sentAt: '2026-11-08T10:00:00+01:00' }), /calls\[1\]\.sentAt: must be a UTC time/);
  assert.match(at({ sentAt: '2026-02-30T10:00:00Z' }), /calls\[1\]\.sentAt: must be a UTC time/);
  assert.match(at({ sentAt: '2026-11-08T10:00Z' }), /calls\[1\]\.sentAt: must be a UTC time/);
  assert.match(at({ sentAt: '2026-11-08T10:00:02Z', receivedAt: '2026-11-08T10:00:01Z' }), /calls\[1\]\.receivedAt: is before sentAt/);
  assert.match(at({ usage: usage(100, 80, 30) as never }), /cacheReadTokens \+ cacheWriteTokens \(110\) is more than inputTokensTotal \(100\)/);
  assert.match(at({ usage: usage(100, 120, GAP) as never }), /usage\.cacheReadTokens: 120 is more than inputTokensTotal \(100\)/);
  assert.match(at({ usage: usage(100, -1) as never }), /usage\.cacheReadTokens: must be a non-negative integer/);
  assert.match(at({ usage: usage(2 ** 53, 0) as never }), /usage\.inputTokensTotal/);
  assert.match(at({ usage: { inputTokensTotal: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } as never }), /usage\.outputTokens: required/);
  assert.match(at({ servedModel: 'unknown' }), /calls\[1\]\.servedModel: "unknown" reads as a gap/);
  assert.match(at({ servedModel: 'NO_JUDGE' }), /calls\[1\]\.servedModel: "NO_JUDGE" is a marker/);
  assert.match(at({ serving: { 'provider.service_tier': null } } as never), /serving\.provider\.service_tier: must be a non-empty string/);
  assert.match(at({ submission: 'none' }), /calls\[1\]\.submission: "none" reads as a gap/);
  assert.match(at({ color: 'x' } as never), /calls\[1\]\.color: unknown field/);
  // The reply side is whole or absent.
  const half = { role: 'judge', requestHash: GAP, sentAt: GAP, servedModel: JUDGE_SERVED };
  assert.match(problems(v4(base(), () => [systemCall(), half as never])).join('\n'), /a call that got a reply carries all of servedModel, receivedAt, usage, serving/);
  // A serving value is kept verbatim: a provider's own "none" is a value.
  assert.deepEqual(problems(v4(base(), () => [systemCall(), judgeCall({ serving: { 'provider.service_tier': 'none' } })])), []);
});

test('the markers: NOT_RETURNED and RETURNED_NULL are allowed in a call record, and refused as a label or an identity value', () => {
  const marked = v4(base(), () => [systemCall(), judgeCall({ serving: { 'provider.service_tier': RETURNED_NULL }, usage: usage(100, 80, NOT_RETURNED) as never })]);
  assert.deepEqual(problems(marked), []);
  const id = refundRun({ grades: { r1: ['4'] }, identity: { systemModelServed: NOT_RETURNED } });
  assert.ok(problems(id).some((x) => x.startsWith('artifact.identity.systemModelServed: must be a non-empty string')), problems(id).join('\n'));
  assert.throws(() => parseBarFile({ ...REFUND_BAR, labels: ['1', '2', '3', RETURNED_NULL] }), /reserved/);
});

test('the conditions block: keys, kinds, ids, times and the judge on a run graded by code', () => {
  const at = (c: unknown) => problems({ ...plain(), conditions: c }).join('\n');
  assert.match(at({ judge: { ...CONDITIONS.judge, servingKeys: ['b.x', 'a.x'] } }), /servingKeys: must be sorted and unique/);
  assert.match(at({ judge: { ...CONDITIONS.judge, servingKeys: ['tier'] } }), /servingKeys: must be a list of "namespace.key" names/);
  assert.match(at({ judge: { concurrency: 0, servingKeys: ['provider.service_tier'], submissions: [] } }), /concurrency: must be a positive integer/);
  assert.match(at({ judge: { servingKeys: ['provider.service_tier'], submissions: [] } }), /judge\.concurrency: required/);
  const sub = CONDITIONS.judge?.submissions[0];
  assert.match(at({ judge: { ...CONDITIONS.judge, submissions: [sub, sub] } }), /"batch-1" is listed twice/);
  assert.match(at({ judge: { ...CONDITIONS.judge, submissions: [{ ...sub, kind: 'batch' }] } }), /kind: must be one of provider-batch, client-group/);
  assert.match(at({ judge: { ...CONDITIONS.judge, submissions: [{ ...sub, submittedAt: 'yesterday' }] } }), /submittedAt: must be a UTC time/);
  assert.match(at({ judge: { ...CONDITIONS.judge, submissions: [{ ...sub, sharedWith: ['b', 'a'] }] } }), /sharedWith: must be sorted and unique/);
  assert.match(at({ referee: {} }), /artifact\.conditions\.referee: unknown field/);
  // A call names a submission the role does not list; a size below the calls that name it.
  assert.match(problems(v4(base(), () => [systemCall(), judgeCall({ submission: 'batch-9' })])).join('\n'), /submission: "batch-9" is not in conditions\.judge\.submissions/);
  const small = { ...CONDITIONS, judge: { ...CONDITIONS.judge, submissions: [{ ...sub, size: 2 }, CONDITIONS.judge?.submissions[1]] } } as RunConditions;
  assert.match(problems(v4(base(), () => [systemCall(), judgeCall()], small)).join('\n'), /submissions\[0\]\.size: 2, but 4 calls of this run name it/);
  // The serving keys a call carries are exactly the role's list.
  assert.match(problems(v4(base(), () => [systemCall(), judgeCall({ serving: {} })])).join('\n'), /serving: holds no key, but conditions\.judge\.servingKeys lists provider\.service_tier/);
});

// ---- where calls may sit ---------------------------------------------------------------------------------------------

test('placement: a graded attempt carries one judge call, last, with a reply; system calls before it', () => {
  const at = (calls: CallRecord[]) => problems(v4(base(), () => calls)).join('\n');
  assert.match(at([systemCall()]), /carries exactly one judge call, the last call/);
  assert.match(at([judgeCall(), systemCall()]), /carries exactly one judge call, the last call/);
  assert.match(at([systemCall(), judgeCall(), judgeCall()]), /carries exactly one judge call, the last call/);
  const { servedModel: _s, receivedAt: _r, usage: _u, serving: _v, ...noReply } = judgeCall();
  assert.match(at([systemCall(), noReply as CallRecord]), /the judge call of a graded attempt got a reply/);
  // [] on a graded attempt of a judged run: the judge call is missing.
  assert.match(at([]), /carries exactly one judge call/);
});

test('placement: a judge retry calls no system; a slot records calls on every attempt or on none', () => {
  const retried = refundRun({ grades: { r1: ['4'] }, retries: { 'r1#0': [judgeRetry('r1', 'timeout')] } });
  const { servedModel: _s, receivedAt: _r, usage: _u, serving: _v, ...noReply } = judgeCall();
  const ok = v4(retried, (_d, i) => (i === 0 ? [systemCall(), noReply as CallRecord] : [judgeCall()]));
  assert.deepEqual(problems(ok), []);
  assert.deepEqual(resolvedCalls(ok.draws[0] as Draw).system.length, 1);
  const bad = v4(retried, (_d, i) => (i === 0 ? [systemCall(), noReply as CallRecord] : [systemCall(), judgeCall()]));
  assert.match(problems(bad).join('\n'), /a judge retry re-grades the output the system already gave; it carries no system call/);
  // The timed-out judge call carries no reply.
  const replied = v4(retried, (_d, i) => (i === 0 ? [systemCall(), judgeCall()] : [judgeCall()]));
  assert.match(problems(replied).join('\n'), /the reason timeout says the judge call got no reply/);
  // calls on some attempts of the slot and not on others.
  const some = JSON.parse(JSON.stringify(ok)) as { draws: { attempts: Record<string, unknown>[] }[] };
  delete (some.draws[0]?.attempts[1] as Record<string, unknown>)['calls'];
  assert.match(problems(some).join('\n'), /calls is recorded on 1 of 2 attempts; record it on every attempt of the slot, or on none/);
});

test('placement: a system that gave no response: its last call has no reply, earlier tool calls may; no judge call', () => {
  const run = refundRun({ grades: { r1: ['~timeout'] } });
  const { servedModel: _s, receivedAt: _r, usage: _u, serving: _v, ...lost } = systemCall();
  assert.deepEqual(problems(v4(run, () => [systemCall(), lost as CallRecord], undefined)), []);
  assert.match(problems(v4(run, () => [lost as CallRecord, systemCall()], undefined)).join('\n'), /its last call carries no reply side/);
  assert.match(problems(v4(run, () => [], undefined)).join('\n'), /record that call/);
  assert.match(problems(v4(run, () => [lost as CallRecord, judgeCall()], undefined)).join('\n'), /an attempt the system gave no response on carries no judge call/);
});

test('several system calls are refused only under a declared toolChoice "none"', () => {
  const two = (run: RunArtifact) => v4(run, () => [systemCall(), systemCall(), judgeCall()]);
  assert.deepEqual(problems(two(base())), []);
  const none = base();
  const shape = { ...none.callShapes.system, toolChoice: 'none' as const, toolChoiceName: 'NOT_SENT' as const };
  const r = { ...none, callShapes: { ...none.callShapes, system: shape } };
  const fixed = JSON.parse(JSON.stringify(two(r as RunArtifact))) as { identity: Record<string, unknown> };
  // The declared hash follows the stored shape, so the only problem left is the rule itself.
  fixed.identity['systemCallShapeHash'] = hashOf(shape);
  assert.match(runArtifactProblems(fixed).join('\n'), /more than one system call on one attempt, but the system call shape declares toolChoice "none"/);
});

test('a per-call served id must equal the run\'s known served id for that role; a marker there is invalid', () => {
  assert.match(problems(v4(base(), () => [systemCall(), judgeCall({ servedModel: 'example-judge-2026-06-01' })])).join('\n'), /servedModel: is "example-judge-2026-06-01", but the run records judgeModelServed "example-judge-2026-01-15"/);
  assert.match(problems(v4(base(), () => [systemCall(), judgeCall({ servedModel: NOT_RETURNED })])).join('\n'), /records judgeModelServed as "UNKNOWN"/);
  assert.match(problems(v4(base(), () => [systemCall({ servedModel: 'model-y' }), judgeCall()])).join('\n'), /the run records systemModelServed "model-x-2026-01-01"/);
  // With the run's served id unknown, the calls may name any ids: the identity check refuses on the gap, as before.
  const open = refundRun({ grades: { r1: ['4', '4'], r2: ['4', '3'] }, identity: { judgeModelServed: GAP } });
  assert.deepEqual(problems(v4(open, (d) => [systemCall(), judgeCall({ servedModel: d.drawIndex === 0 ? 'a-1' : 'a-2' })])), []);
});

// ---- the counts, pinned --------------------------------------------------------------------------------------------

test('times: RFC 3339 UTC to nanoseconds; no offset, no leap second, no 30 February (fixture)', () => {
  assert.equal(timeNanos('1970-01-01T00:00:01Z'), 1_000_000_000n);
  assert.equal(timeNanos('1970-01-01T00:00:00.000000001Z'), 1n);
  assert.equal(timeNanos('1970-01-01T00:00:00.5Z'), 500_000_000n);
  assert.equal(timeNanos('2024-02-29T00:00:00Z') !== undefined, true);
  for (const bad of ['2026-02-29T00:00:00Z', '2026-11-08T23:59:60Z', '2026-11-08T10:00:00+00:00', '2026-11-08 10:00:00Z', '2026-11-08T10:00:00.1234567890Z']) assert.equal(timeNanos(bad), undefined, bad);
});

test('percent from integers, tenths rounded half up (fixture: the arithmetic is written out)', () => {
  // 37,249 / 100,000 = 0.37249; 1000 x that = 372.49; half up -> 372 -> "37.2%".
  assert.equal(tenthsOfPercent(37_249, 100_000), 372);
  assert.equal(percentText(372), '37.2%');
  // 1 / 16 = 6.25% exactly: 62.5 tenths, half up -> 63 -> "6.3%".
  assert.equal(tenthsOfPercent(1, 16), 63);
  assert.equal(percentText(63), '6.3%');
  // 1 / 3 = 33.33...%: 333.3 tenths -> 333; 2 / 3 = 666.6... tenths -> 667; 0 and 1 are 0.0% and 100.0%.
  assert.deepEqual([tenthsOfPercent(1, 3), tenthsOfPercent(2, 3), tenthsOfPercent(0, 5), tenthsOfPercent(5, 5)], [333, 667, 0, 1000]);
  assert.deepEqual([percentText(0), percentText(1000)], ['0.0%', '100.0%']);
  // Integers past 2^53 / 2000 do not overflow: the arithmetic is BigInt.
  assert.equal(tenthsOfPercent(9_000_000_000_000, 9_000_000_000_001), 1000);
  assert.throws(() => tenthsOfPercent(1, 0), RangeError);
});

test('cache-read share: sum of reads over sum of totals, calls with an unknown counter left out (fixture)', () => {
  // Three calls with a reply: (total 100, read 80), (total 200, read 20), (total UNKNOWN, read 50); one without a reply.
  // Counted: 80 + 20 = 100 over 100 + 200 = 300 -> 33.3...% -> 333 tenths -> "33.3%"; 1 left out; the unanswered one is not a call with usage.
  const { servedModel: _s, receivedAt: _r, usage: _u, serving: _v, ...lost } = judgeCall();
  const calls = [judgeCall({ usage: usage(100, 80) as never }), judgeCall({ usage: usage(200, 20) as never }), judgeCall({ usage: usage(GAP, 50) as never }), lost as CallRecord];
  assert.deepEqual(cacheShare(calls), { share: { numerator: 100, denominator: 300, tenthsOfPercent: 333 }, callsCounted: 2, callsLeftOut: 1 });
  assert.deepEqual(cacheShare([judgeCall({ usage: usage(GAP, 1) as never })]), { share: 'none', callsCounted: 0, callsLeftOut: 1 });
  // The two providers' counters, mapped as the run format says. Anthropic: input 20 + cache read 900 + cache write 80 = total 1000, read 900.
  // OpenAI: input_tokens 1000 already holds cached 900, so total 1000, read 900. Both are 90.0%.
  const anthropic = judgeCall({ usage: usage(20 + 900 + 80, 900, 80) as never });
  const openai = judgeCall({ usage: usage(1000, 900, NOT_RETURNED) as never });
  assert.equal(percentText((cacheShare([anthropic]).share as { tenthsOfPercent: number }).tenthsOfPercent), '90.0%');
  assert.equal(percentText((cacheShare([openai]).share as { tenthsOfPercent: number }).tenthsOfPercent), '90.0%');
});

test('how the draws of a case went out: together, apart, mixed, unknown, not recorded (fixture)', () => {
  // Five cases: c1's two draws in batch-1 (together); c2's in batch-1 and batch-2 (apart); c3's three draws in batch-1,
  // batch-1, batch-2 (mixed); c4 has one draw with submission UNKNOWN (unknown); c5's calls are sent on their own (apart).
  const run = refundRun({ grades: { c1: ['4', '4'], c2: ['4', '4'], c3: ['4', '4', '4'], c4: ['4', '4'], c5: ['4', '4'] } });
  const sub: Record<string, (string | undefined)[]> = { c1: ['batch-1', 'batch-1'], c2: ['batch-1', 'batch-2'], c3: ['batch-1', 'batch-1', 'batch-2'], c4: ['batch-1', GAP], c5: [undefined, undefined] };
  const r = v4(run, (d) => {
    const s = sub[d.caseId]?.[d.drawIndex];
    const { submission: _x, ...rest } = judgeCall();
    return [systemCall(), (s === undefined ? rest : { ...rest, submission: s }) as CallRecord];
  });
  assert.deepEqual(problems(r), []);
  assert.deepEqual(drawsTogether(r), { together: 1, apart: 2, mixed: 1, unknown: 1, notRecorded: 0, cases: 5 });
  assert.deepEqual(drawsTogether(base()), { together: 0, apart: 0, mixed: 0, unknown: 0, notRecorded: 2, cases: 2 });
});

test('time between the draws of a case: by send time, else by submission time, in whole milliseconds (fixture)', () => {
  // c1: three draws sent at t, t + 2.000 s and t + 7.500 s -> spread 7,500 ms. c2: two draws at t and t + 0.0004 s -> 0 ms
  // (0.4 ms truncated). c3: send times UNKNOWN, submissions batch-1 (10:00:00) and batch-2 (11:00:00) -> 3,600,000 ms by
  // submission time. c4: one send time UNKNOWN and no submission -> left out.
  const run = refundRun({ grades: { c1: ['4', '4', '4'], c2: ['4', '4'], c3: ['4', '4'], c4: ['4', '4'] } });
  const at: Record<string, [string, string | undefined][]> = {
    c1: [[T0, 'batch-1'], ['2026-11-08T10:00:02Z', 'batch-1'], ['2026-11-08T10:00:07.5Z', 'batch-1']],
    c2: [[T0, 'batch-1'], ['2026-11-08T10:00:00.0004Z', 'batch-1']],
    c3: [[GAP, 'batch-1'], [GAP, 'batch-2']],
    c4: [[T0, 'batch-1'], [GAP, undefined]],
  };
  const r = v4(run, (d) => {
    const [sentAt, s] = at[d.caseId]?.[d.drawIndex] as [string, string | undefined];
    const { submission: _x, ...rest } = judgeCall({ sentAt });
    return [systemCall(), (s === undefined ? rest : { ...rest, submission: s }) as CallRecord];
  });
  assert.deepEqual(problems(r), []);
  assert.deepEqual(drawSpreads(r), { bySendTime: { minMs: 0, maxMs: 7500, cases: 2 }, bySubmissionTime: { minMs: 3_600_000, maxMs: 3_600_000, cases: 1 }, casesLeftOut: 1 });
});

// ---- copies: conditions.drawsPerCopy ----------------------------------------------------------------------------------

/** A judged run of `grades` with one judge call per attempt, its submission and send time from `at(caseId, drawIndex)`. */
function copiesRun(grades: Record<string, string[]>, at: (c: string, d: number) => { submission?: string | undefined; sentAt?: string; noCalls?: boolean }, drawsPerCopy: number | undefined, conditions: RunConditions = CONDITIONS): RunArtifact {
  const r = v4(refundRun({ grades }), (d) => {
    const x = at(d.caseId, d.drawIndex);
    const { submission: _x, ...rest } = judgeCall({ sentAt: x.sentAt ?? T0 });
    return [systemCall(), (x.submission === undefined ? rest : { ...rest, submission: x.submission }) as CallRecord];
  }, { ...conditions, ...(drawsPerCopy === undefined ? {} : { drawsPerCopy }) });
  // Every submission the calls name is listed, as the validator requires.
  const judge = r.conditions?.judge as NonNullable<RunConditions['judge']>;
  const listed = new Set(judge.submissions.map((x) => x.id));
  const named = [...new Set(r.draws.flatMap((d) => d.attempts.flatMap((a) => (a.calls ?? []).map((c) => c.submission))))].filter((x): x is string => x !== undefined && x !== GAP && !listed.has(x)).sort();
  const extra = named.map((id) => ({ id, kind: 'provider-batch' as const, size: GAP, sharedWith: [], submittedAt: GAP, endedAt: GAP, recordedAt: GAP }));
  const withSubs = { ...r, conditions: { ...r.conditions, judge: { ...judge, submissions: [...judge.submissions, ...extra] } } } as RunArtifact;
  // A draw marked noCalls carries no calls at all.
  return { ...withSubs, draws: withSubs.draws.map((d) => (at(d.caseId, d.drawIndex).noCalls ? { ...d, attempts: d.attempts.map(({ calls: _c, ...a }) => a) } : d)) } as RunArtifact;
}

test('copies of a case: together, apart, mixed, split within a copy, unknown, not recorded (fixture)', () => {
  // drawsPerCase 4, drawsPerCopy 2: copy 1 is draws 0-1, copy 2 is draws 2-3. Submissions by draw (copy 1 | copy 2):
  //   k1  b1, b1 | b1, b1          copies together      within: one, one          draws line: together
  //   k2  b1, b1 | b2, b2          copies apart         within: one, one          draws line: mixed (b1 twice)
  //   k3  b1, b2 | b2, b3          copies mixed (b2)    within: split, split      draws line: mixed
  //   k4  b1, b2 | b3, b4          copies apart         within: split, split      draws line: apart
  //   k5  b1, UNKNOWN | b2, b2     copies unknown       within: unknown, one      draws line: unknown
  //   k6  all four sent alone      copies apart         within: split, split      draws line: apart
  //   k7  (no calls), b1 | b2, b2  copies not recorded  within: not recorded, one draws line: not recorded
  //   k8  b1, b1 | (not in file)   one copy present: not a case of two copies; within: one; draws line: together
  // Copies of a case: together 1 (k1), apart 3 (k2, k4, k6), mixed 1 (k3), unknown 1 (k5), not recorded 1 (k7);
  //   1 + 3 + 1 + 1 + 1 = 7 cases.
  // Within: 7 x 2 + 1 = 15 copies; one 2 + 2 + 1 + 1 + 1 = 7 (k1, k2, k5, k7, k8); split 2 + 2 + 2 = 6 (k3, k4, k6);
  //   unknown 1; not recorded 1; 7 + 6 + 1 + 1 = 15.
  // Draws line (unchanged): together 2 (k1, k8), apart 2 (k4, k6), mixed 2 (k2, k3), unknown 1, not recorded 1; 8 cases.
  const four = ['4', '4', '4', '4'];
  const grades = { k1: four, k2: four, k3: four, k4: four, k5: four, k6: four, k7: four, k8: ['4', '4', '-', '-'] };
  const plan: Record<string, (string | undefined | null)[]> = {
    k1: ['b1', 'b1', 'b1', 'b1'], k2: ['b1', 'b1', 'b2', 'b2'], k3: ['b1', 'b2', 'b2', 'b3'], k4: ['b1', 'b2', 'b3', 'b4'],
    k5: ['b1', GAP, 'b2', 'b2'], k6: [undefined, undefined, undefined, undefined], k7: [null, 'b1', 'b2', 'b2'], k8: ['b1', 'b1'],
  };
  const r = copiesRun(grades, (c, d) => {
    const x = plan[c]?.[d];
    return x === null ? { noCalls: true } : { submission: x };
  }, 2);
  assert.deepEqual(problems(r), []);
  const c = copiesRecord(r) as CopiesRecord;
  assert.equal(c.drawsPerCopy, 2);
  assert.deepEqual(c.together, { together: 1, apart: 3, mixed: 1, unknown: 1, notRecorded: 1, cases: 7 });
  assert.deepEqual(c.within, { one: 7, split: 6, unknown: 1, notRecorded: 1, copies: 15 });
  assert.deepEqual(drawsTogether(r), { together: 2, apart: 2, mixed: 2, unknown: 1, notRecorded: 1, cases: 8 });
  // A run that declares no copies has no copies record.
  assert.equal(copiesRecord(copiesRun(grades, () => ({ submission: 'b1' }), undefined)), 'not declared');
});

test('time between a case\'s copies: the earliest send time of each copy, else submission time, else left out (fixture)', () => {
  // drawsPerCase 4, drawsPerCopy 2, T = 10:00:00Z.
  //   s1: copy 1 sent T and T+1 s; copy 2 sent T+60 s and T+30 s -> copy times T and T+30 s (the earliest, not the
  //       first draw's) -> 30,000 ms by send time.
  //   s2: copy 1 sent T+0.0015 s and T+5 s; copy 2 sent T and T+2 s -> 1.5 ms, truncated -> 1 ms.
  //   s3: copy 1 sent T in batch-1 (submitted 10:00:00) and T in batch-2 (11:00:00); copy 2 has one send time UNKNOWN,
  //       both in batch-3 (12:30:00) -> no send time for copy 2; by submission time 10:00:00 and 12:30:00 -> 9,000,000 ms.
  //   s4: copy 1 known; copy 2 has one draw with send time UNKNOWN sent on its own -> neither time -> left out.
  // bySendTime: 1 to 30,000 over 2 cases; bySubmissionTime: 9,000,000 over 1 case; left out 1.
  const four = ['4', '4', '4', '4'];
  const cond: RunConditions = { ...CONDITIONS, judge: { ...(CONDITIONS.judge as NonNullable<RunConditions['judge']>), submissions: [
    ...(CONDITIONS.judge as NonNullable<RunConditions['judge']>).submissions,
    { id: 'batch-3', kind: 'provider-batch', size: 2, sharedWith: [], submittedAt: '2026-11-08T12:30:00Z', endedAt: NOT_RETURNED, recordedAt: GAP },
  ] } };
  const plan: Record<string, [string, string | undefined][]> = {
    s1: [[T0, 'batch-1'], ['2026-11-08T10:00:01Z', 'batch-1'], ['2026-11-08T10:01:00Z', 'batch-1'], ['2026-11-08T10:00:30Z', 'batch-1']],
    s2: [['2026-11-08T10:00:00.0015Z', 'batch-1'], ['2026-11-08T10:00:05Z', 'batch-1'], [T0, 'batch-1'], ['2026-11-08T10:00:02Z', 'batch-1']],
    s3: [[T0, 'batch-1'], [T0, 'batch-2'], [GAP, 'batch-3'], [T0, 'batch-3']],
    s4: [[T0, 'batch-1'], [T0, 'batch-1'], [T0, 'batch-1'], [GAP, undefined]],
  };
  const r = copiesRun({ s1: four, s2: four, s3: four, s4: four }, (c, d) => {
    const [sentAt, submission] = plan[c]?.[d] as [string, string | undefined];
    return { sentAt, submission };
  }, 2, cond);
  assert.deepEqual(problems(r), []);
  assert.deepEqual((copiesRecord(r) as CopiesRecord).spreads, { bySendTime: { minMs: 1, maxMs: 30_000, cases: 2 }, bySubmissionTime: { minMs: 9_000_000, maxMs: 9_000_000, cases: 1 }, casesLeftOut: 1 });
});

test('copies of one draw each equal the draws lines (independent recomputation)', () => {
  // Shares the reading of the definition: with drawsPerCopy 1 every copy is one draw, so the copies record must equal
  // drawsTogether and drawSpreads, and within counts each draw (one judge call each: one submission per draw).
  const ids = Array.from({ length: 40 }, (_, i) => `g${String(i).padStart(2, '0')}`);
  const grades = Object.fromEntries(ids.map((id) => [id, ['4', '4']]));
  const subOf = (c: number, d: number): string => `batch-${(c * 7 + d * (c % 3)) % 2 === 0 ? 1 : 2}`;
  const r = copiesRun(grades, (c, d) => ({ submission: subOf(ids.indexOf(c), d), sentAt: `2026-11-08T10:00:${String((ids.indexOf(c) + d * 13) % 60).padStart(2, '0')}Z` }), 1);
  const c = copiesRecord(r) as CopiesRecord;
  assert.deepEqual(c.together, drawsTogether(r));
  assert.deepEqual(c.spreads, drawSpreads(r));
  assert.deepEqual(c.within, { one: 80, split: 0, unknown: 0, notRecorded: 0, copies: 80 });
});

test('copies against draws on a generated run with every slot present (independent recomputation)', () => {
  // Shares the reading of the definition. drawsPerCase 6, drawsPerCopy 3, 60 cases, submissions from a formula. When
  // every slot is in the file: copies together = draws together; unknown and not recorded equal; copies apart >= draws
  // apart; copies apart + mixed = draws apart + mixed (a case not together is apart or mixed on both lines).
  const ids = Array.from({ length: 60 }, (_, i) => `h${String(i).padStart(2, '0')}`);
  const grades = Object.fromEntries(ids.map((id) => [id, ['4', '4', '4', '4', '4', '4']]));
  const sub = (c: number, d: number): string | undefined => {
    const v = (c * 31 + d * (c % 5 + 1) + Math.floor(d / 3) * (c % 7)) % 9;
    return v === 8 ? undefined : v === 7 && c % 11 === 0 ? GAP : `b${v % (1 + (c % 4))}`;
  };
  const r = copiesRun(grades, (c, d) => ({ submission: sub(ids.indexOf(c), d) }), 3);
  const c = (copiesRecord(r) as CopiesRecord).together;
  const d = drawsTogether(r);
  assert.equal(c.cases, d.cases);
  assert.equal(c.together, d.together);
  assert.equal(c.unknown, d.unknown);
  assert.equal(c.notRecorded, d.notRecorded);
  assert.ok(c.apart >= d.apart, `${c.apart} >= ${d.apart}`);
  assert.equal(c.apart + c.mixed, d.apart + d.mixed);
  assert.ok(d.mixed > 0 && c.apart > d.apart, 'the generated run has cases the copies line tells apart from the draws line');
});

test('drawsPerCopy: invalid input names the path; it must divide drawsPerCase into two copies or more', () => {
  const run = (k: unknown, grades: Record<string, string[]> = { r1: ['4', '4', '4', '4', '4', '4'] }, identity: Record<string, unknown> = {}) =>
    problems({ ...v4(refundRun({ grades, identity: identity as never }), () => [systemCall(), judgeCall()]), conditions: { ...CONDITIONS, drawsPerCopy: k } }).filter((x) => x.startsWith('artifact.conditions.drawsPerCopy'));
  for (const k of [0, -1, 1.5, '3', GAP, null, 2 ** 53]) assert.equal(run(k).length, 1, `drawsPerCopy ${JSON.stringify(k)}`);
  assert.match(run(1.5)[0] as string, /must be a positive integer \(leave the key out when the copies are not known\)/);
  assert.deepEqual(run(4), ['artifact.conditions.drawsPerCopy: 4 does not divide identity.drawsPerCase 6']);
  assert.deepEqual(run(6), ['artifact.conditions.drawsPerCopy: 6 of identity.drawsPerCase 6 is one copy per case; leave the key out when a case was asked once']);
  assert.deepEqual(run(3), []);
  assert.deepEqual(run(1), []);
  assert.deepEqual(run(2), []);
  // With drawsPerCase unknown the divisor check cannot run: refused.
  assert.equal(conditionsProblems({ drawsPerCopy: 2 }, 'c', true, GAP).length, 1);
  assert.match(conditionsProblems({ drawsPerCopy: 2 }, 'c', true, GAP)[0] as string, /c\.drawsPerCopy: needs a known identity\.drawsPerCase to divide; it is "UNKNOWN"/);
  // A block with only drawsPerCopy is valid; a key beside it is still an unknown field.
  assert.deepEqual(conditionsProblems({ drawsPerCopy: 2 }, 'c', true, 4), []);
  assert.ok(conditionsProblems({ drawsPerCopy: 2, copies: 2 }, 'c', true, 4).some((x) => x.startsWith('c.copies')));
});

test('non-refusal: declaring drawsPerCopy changes no gate or flips verdict', () => {
  const bar = parseBarFile(REFUND_BAR);
  const grades = { r1: ['4', '4', '4', '4'], r2: ['4', '3', '4', '4'] };
  const b = copiesRun(grades, (_c, d) => ({ submission: d < 2 ? 'batch-1' : 'batch-2' }), undefined);
  const c = copiesRun({ r1: ['4', '4', '4', '4'], r2: ['3', '3', '3', '4'] }, (_c, d) => ({ submission: d < 2 ? 'batch-1' : 'batch-2' }), undefined);
  const withK = (x: RunArtifact): RunArtifact => ({ ...x, conditions: { ...x.conditions, drawsPerCopy: 2 } });
  assert.deepEqual(problems(withK(b)), []);
  assert.deepEqual(JSON.stringify(gateRuns(withK(b), withK(c), bar)), JSON.stringify(gateRuns(b, c, bar)));
  const opts = { iterations: 200, seed: 7, alpha: 0.05 };
  assert.deepEqual(JSON.stringify(repeatFlips(withK(c), opts)), JSON.stringify(repeatFlips(c, opts)));
});

test('conditions: the copies lines and their JSON; nothing for a run that declares none', () => {
  const four = ['4', '4', '4', '4'];
  const at = (c: string, d: number) => ({ submission: c === 'a' ? (d < 2 ? 'batch-1' : 'batch-2') : 'batch-1', sentAt: d < 2 ? T0 : '2026-11-08T10:00:16Z' });
  const declared = put(copiesRun({ a: four, b: four }, at, 2));
  const undeclared = put(copiesRun({ a: four, b: four }, at, undefined));
  const one = cli('conditions', '--run', declared);
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /\nhow the copies of a case went out \(drawsPerCopy 2: copy 1 is draws 0-1, copy 2 is draws 2-3\):\n/);
  assert.match(one.stdout, /\n {2}of 2 cases with two or more copies: all in one submission 1 · each in its own 1 · mixed 0 · submission not recorded 0 · calls not recorded 0\n/);
  assert.match(one.stdout, /\n {2}of 4 copies: own draws in one submission 4 · in more than one 0 · submission not recorded 0 · calls not recorded 0\n/);
  assert.match(one.stdout, /\n {2}time between a case's copies, by send time: 16000 to 16000 ms over 2 cases; by submission time, where a send time is not recorded: no case; left out 0\n/);
  const none = cli('conditions', '--run', undeclared);
  assert.equal(none.status, 0, none.stderr);
  assert.doesNotMatch(none.stdout, /copies/);
  const two = cli('conditions', '--run', declared, '--other', undeclared);
  assert.equal(two.status, 0, two.stderr);
  assert.match(two.stdout, /\n {2}run: of 2 cases with two or more copies/);
  assert.match(two.stdout, /\n {2}other: copies not declared\n/);
  const j = cli('conditions', '--run', declared, '--other', undeclared, '--json');
  assert.equal(j.status, 0, j.stderr);
  const report = JSON.parse(j.stdout) as { copies: { first: CopiesRecord; second: string } };
  assert.equal(report.copies.second, 'not declared');
  assert.deepEqual(report.copies.first.together, { together: 1, apart: 1, mixed: 0, unknown: 0, notRecorded: 0, cases: 2 });
  assert.equal((JSON.parse(cli('conditions', '--run', undeclared, '--json').stdout) as { copies: { first: string } }).copies.first, 'not declared');
  // Ten copies of one draw: the first two and the last are named.
  const ten = put(copiesRun({ a: Array.from({ length: 10 }, () => '4') }, () => ({ submission: 'batch-1' }), 1));
  assert.match(cli('conditions', '--run', ten).stdout, /\(drawsPerCopy 1: copy 1 is draws 0, copy 2 is draws 1, …, copy 10 is draws 9\):/);
});

test('request hashes of two runs: paired by slot, role and order, never by hash (fixture)', () => {
  // Run A has slots r1#0, r1#1, r2#0, r2#1; run B lacks r2#1. Judge calls: r1#0 equal, r1#1 differ, r2#0 UNKNOWN in B.
  // System calls: equal everywhere they pair. Pairs: 3 slots x 2 roles = 6; equal 4 (3 system + r1#0 judge), differ 1, unknown 1.
  // Unpaired: r2#1's two calls in A.
  const a = v4(base(), () => [systemCall(), judgeCall()]);
  const bRun = refundRun({ grades: { r1: ['4', '4'], r2: ['4', '-'] } });
  const b = v4(bRun, (d) => [systemCall(), judgeCall({ requestHash: d.caseId === 'r1' && d.drawIndex === 1 ? hashOf('other') : d.caseId === 'r2' ? GAP : hashOf('request') })]);
  assert.deepEqual(requestHashPairs(a, b), { pairs: 6, equal: 4, differ: 1, unknown: 1, unpairedFirst: 2, unpairedSecond: 0 });
});

test('an independent recomputation: the together and pairing counts on a generated run (independent recomputation)', () => {
  // Shares the reading of the definition; checks the arithmetic of drawsTogether and requestHashPairs on 40 cases.
  const ids = Array.from({ length: 40 }, (_, i) => `g${String(i).padStart(2, '0')}`);
  const grades = Object.fromEntries(ids.map((id) => [id, ['4', '4']]));
  const subOf = (c: number, d: number): string => `batch-${(c * 7 + d * (c % 3)) % 2 === 0 ? 1 : 2}`;
  const run = v4(refundRun({ grades }), (d) => [systemCall(), judgeCall({ submission: subOf(ids.indexOf(d.caseId), d.drawIndex), requestHash: hashOf(`${d.caseId}`) })]);
  let together = 0;
  let apart = 0;
  for (let c = 0; c < 40; c++) (subOf(c, 0) === subOf(c, 1) ? together++ : apart++);
  assert.deepEqual(drawsTogether(run), { together, apart, mixed: 0, unknown: 0, notRecorded: 0, cases: 40 });
  const other = v4(refundRun({ grades }), (d) => [systemCall(), judgeCall({ submission: 'batch-1', requestHash: hashOf(ids.indexOf(d.caseId) % 4 === 0 ? 'x' : `${d.caseId}`) })]);
  const differ = ids.filter((_, i) => i % 4 === 0).length * 2;
  assert.deepEqual(requestHashPairs(run, other), { pairs: 160, equal: 160 - differ, differ, unknown: 0, unpairedFirst: 0, unpairedSecond: 0 });
});

// ---- conditions never refuse, and move no verdict --------------------------------------------------------------------

test('non-refusal: the same runs as v3 and as v4 with calls give the same gate verdict', () => {
  const bar = parseBarFile(REFUND_BAR);
  const b3 = refundRun({ grades: { r1: ['4', '4'], r2: ['4', '4'] } });
  const c3 = refundRun({ grades: { r1: ['4', '4'], r2: ['4', '3'] } });
  const plainResult = gateRuns(b3, c3, bar);
  const b4 = v4(b3, () => [systemCall(), judgeCall()]);
  const c4 = v4(c3, () => [systemCall({ sentAt: '2026-11-09T10:00:00Z', receivedAt: GAP }), judgeCall({ submission: 'batch-2', serving: { 'provider.service_tier': 'priority' }, requestHash: hashOf('different') })]);
  // The result echoes the draws it attributed, calls included; with those taken out it is the same object.
  const noCalls = (x: unknown): unknown => JSON.parse(JSON.stringify(x, (k, v: unknown) => (k === 'calls' ? undefined : v)));
  assert.deepEqual(noCalls(gateRuns(b4, c4, bar)), noCalls(plainResult));
});

test('conditions: exit 0 on two runs whose identities differ; one run; a v3 run reads "not recorded"; --json', () => {
  const a = put(plain());
  const b = put(v4(refundRun({ grades: { r1: ['4', '4'], r2: ['4', '3'] }, identity: { judgeModelServed: 'example-judge-2026-06-01' } }), () => [systemCall(), judgeCall({ servedModel: 'example-judge-2026-06-01' })]));
  const two = cli('conditions', '--run', a, '--other', b);
  assert.equal(two.status, 0, two.stderr);
  assert.match(two.stdout, /judgeModelServed\s+example-judge-2026-01-15\s+example-judge-2026-06-01\s+differs/);
  assert.match(two.stdout, /model ids returned\s+run: example-judge-2026-01-15 \(4 calls\)/);
  assert.match(two.stdout, /-> differs/);
  assert.match(two.stdout, /cache read share\s+run: 320 \/ 400 input tokens \(80\.0%\) over 4 calls/);
  assert.match(two.stdout, /request hashes, paired by slot, role and order \(never by hash\): equal on 8, differ on 0, not recorded on 0 of 8 pairs/);
  // Two judges side by side: the two fixed sentences close the text.
  assert.match(two.stdout, /\n\n.*\n.*\n$/);
  const one = cli('conditions', '--run', a);
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /recorded conditions of one run/);
  const old = cli('conditions', '--run', put(base()));
  assert.equal(old.status, 0, old.stderr);
  assert.match(old.stdout, /judge: not recorded \(no calls, no conditions block\)/);
  const j = cli('conditions', '--run', a, '--other', b, '--json');
  assert.equal(j.status, 0, j.stderr);
  const report = JSON.parse(j.stdout) as Record<string, unknown>;
  assert.equal(report['schema'], 'anchorset.conditions-report/v1');
  assert.equal(report['kind'], 'description');
  assert.equal(report['exitCode'], 0);
  assert.ok(Array.isArray(report['statements']));
  assert.deepEqual(conditionsReport(plain()).runs, 1);
});

test('conditions: usage 64 for a repeated --run or a missing one; invalid input 65 names the file and the path', () => {
  const a = put(plain());
  assert.equal(cli('conditions', '--run', a, '--run', a).status, 64);
  assert.equal(cli('conditions').status, 64);
  const bad = put(v4(base(), () => [systemCall(), judgeCall({ sentAt: 'now' })]));
  const r = cli('conditions', '--run', bad);
  assert.equal(r.status, 65);
  assert.match(r.stderr, /--run .*: artifact\.draws\[0\]\.attempts\[0\]\.calls\[1\]\.sentAt: must be a UTC time/);
});

test('docs/RUN_FORMAT.md: the conditions block it prints is a valid block', () => {
  const doc = readFileSync(join(root, 'docs', 'RUN_FORMAT.md'), 'utf8');
  const m = /```json\n("conditions": \{[\s\S]*?\n\})\n```/.exec(doc);
  assert.ok(m !== null, 'the conditions example is in the document');
  const block = (JSON.parse(`{${m[1] as string}}`) as { conditions: unknown }).conditions;
  // The example declares drawsPerCopy 3: valid for a run of six draws per case (two copies), refused for three (one).
  assert.deepEqual(conditionsProblems(block, 'conditions', true, 6), []);
  assert.equal((block as { drawsPerCopy?: unknown }).drawsPerCopy, 3);
  assert.equal(conditionsProblems(block, 'conditions', true, 3).length, 1);
});
