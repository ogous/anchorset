// What the user sees when the judge changes: the judge diff on a gate refusal (and in validate), the judge-flip list of
// `gate --rejudge-of`, the counts of slots that hold no grade (validate, and every refusal on such slots), the judges'
// own split draws beside the flips, the counts judge-change adds to its text, and the two fixed sentences. What this
// file pins: every refusal keeps its code, its fields and its exit code (written below as literals, as 0.2.0 gave
// them); every new count, on hand-worked fixtures whose arithmetic is written out beside them; and every refusal path
// of the new blocks. Fixtures are synthetic: a refund bot, from the one generator in test/helpers.ts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { caseSetHash } from '../src/artifact.ts';
import type { RunArtifact } from '../src/artifact.ts';
import { barHash } from '../src/gate.ts';
import { callShapeHash, NOT_SENT } from '../src/callshape.ts';
import { GAP, hashOf, NO_JUDGE, sha256Hex } from '../src/identity.ts';
import type { RunIdentity } from '../src/identity.ts';
import { AGREEMENT_SENTENCE, AGREEMENT_SENTENCE_WITH_REFERENCE, AS_DECLARED_SENTENCE, JUDGE_CHANGE_PLAN_SCHEMA, judgeChangeRuns, judgeChangeWithReading } from '../src/judgechange.ts';
import type { JudgeChangeInput, JudgeChangePlan, JudgeSide } from '../src/judgechange.ts';
import { gateExitCode, judgeDiff, ONE_DRAW_OWN_VARIATION } from '../src/regression.ts';
import type { GateRunResult, JudgeFlips } from '../src/regression.ts';
import { RefusalError } from '../src/errors.ts';
import { readLedger } from '../src/ledger.ts';
import { gateRunsWithAdmission as gateRuns, judgeRetry, makeJudgeCallShape, MINI_JUDGE, NEW_JUDGE, OLD_JUDGE, REFUND_BAR, refundRun } from './helpers.ts';

const root = join(import.meta.dirname, '..');
const cliPath = join(root, 'src', 'cli.ts');
const work = mkdtempSync(join(tmpdir(), 'anchorset-judge-report-'));
after(() => rmSync(work, { recursive: true, force: true }));
const cli = (...args: string[]) => spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', cwd: work });
let n = 0;
/** A run file in a fresh folder of its own; `name` may hold a space or a quote. */
function put(run: unknown, name = 'run.json'): string {
  const dir = join(work, `f-${(n += 1)}`);
  mkdirSync(dir);
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(run));
  return path;
}
const BAR = put(REFUND_BAR, 'bar.json');
type Obj = Record<string, unknown>;
const json = (s: string): Obj => JSON.parse(s) as Obj;
const evaluated = (r: GateRunResult): Extract<GateRunResult, { kind: 'evaluated' }> => {
  assert.equal(r.kind, 'evaluated', r.kind === 'refused' ? r.refusal.message : '');
  return r as Extract<GateRunResult, { kind: 'evaluated' }>;
};
const flipsOf = (r: GateRunResult): Exclude<JudgeFlips, { refused: unknown }> => {
  const f = evaluated(r).judgeFlips;
  assert.ok(f !== undefined && !('refused' in f), JSON.stringify(f));
  return f as Exclude<JudgeFlips, { refused: unknown }>;
};
/** The eight keys of a refusal object, as 0.2.0 printed them, with their values. */
const V1_KEYS = ['schema', 'tool', 'kind', 'command', 'code', 'fields', 'message', 'exitCode'];

// A plain pair: two cases of reply_quality, one of refund_policy, three draws, every draw graded 4.
const FOUR = { q01: ['4', '4', '4'], q02: ['4', '4', '4'], p1: ['4', '4', '4'] };
const SYSTEM_MOVED: Partial<RunIdentity> = { systemModelServed: 'model-x-2026-06-01' };
const newAnswer = (id: string): string => `Your refund for order ${id} was sent today.`;

describe('the judge diff of a gate refusal', () => {
  const base = refundRun({ grades: FOUR });
  it('served model moved under the same requested name: the six rows, the loud line, the size and the next commands; code, fields and exit as before', () => {
    const cand = refundRun({ grades: FOUR, identity: NEW_JUDGE });
    const r = gateRuns(base, cand, REFUND_BAR);
    assert.ok(r.kind === 'refused');
    assert.deepEqual([r.refusal.code, [...r.refusal.fields], gateExitCode(r)], ['IDENTITY_MISMATCH', ['judgeModelServed'], 2]);
    const d = judgeDiff(base, cand, r.refusal);
    assert.ok(d !== undefined);
    assert.deepEqual(d.fields.map((x) => [x.field, x.state]), [
      ['judgeModelRequested', 'same'], ['judgeModelServed', 'differs'], ['judgeDefinitionHash', 'same'], ['rubricHash', 'same'], ['judgeCallShapeHash', 'same'], ['judgeHarnessVersion', 'same'],
    ]);
    assert.equal(d.servedChangedUnderSameRequest, true);
    // Hashes are full in the diff (only the text shortens them).
    assert.ok(d.fields.filter((x) => x.field.endsWith('Hash')).every((x) => /^[0-9a-f]{64}$/.test(x.from)));
    // 3 cases x 3 draws = 9 slots, every one graded: at least 9 judge calls.
    assert.deepEqual(d.rejudge, { cases: 3, drawsPerCase: 3, slots: 9, slotsWithAnswer: 9, judgeCallsAtLeast: 9, retriesExtra: true, baselineSlotsWithJudgeRetry: 0 });
    const b = put(base, 'baseline.json');
    const c = put(cand, 'candidate.json');
    const t = cli('gate', '--baseline', b, '--candidate', c, '--bar', BAR);
    assert.equal(t.status, 2);
    const lines = t.stderr.split('\n');
    assert.deepEqual(lines.slice(0, 3), ['REFUSED IDENTITY_MISMATCH', '  fields: judgeModelServed', `  judgeModelServed example-judge-2026-01-15 != example-judge-2026-06-01; the judge differs between these runs; re-judge the baseline outputs with the current judge and pass --rejudge-of <original baseline>`]);
    assert.ok(lines.includes('the judge, baseline -> candidate:'), t.stderr);
    assert.match(t.stderr, /^ {2}model served {7}example-judge-2026-01-15 -> example-judge-2026-06-01 +DIFFERS$/m);
    assert.match(t.stderr, /^ {2}rubric {13}[0-9a-f]{12}… -> [0-9a-f]{12}… +same$/m);
    assert.match(t.stderr, /SERVED MODEL CHANGED UNDER THE SAME REQUESTED NAME: both runs asked for "example-judge"; the model served was example-judge-2026-01-15 for the baseline and example-judge-2026-06-01 for the candidate\./);
    assert.match(t.stderr, /^re-judge size: the baseline holds 3 cases x 3 draws per case = 9 slots, 9 of them with an answer to grade: at least 9 judge calls; retries are extra \(the baseline's own grading asked again on 0 slots\)\. anchorset knows no prices\.$/m);
    const out = b.replace(/\.json$/, '.rejudged.json');
    assert.ok(lines.includes(`  2. anchorset validate --run ${c} --bar ${BAR} --baseline ${out} --rejudge-of ${b}`), t.stderr);
    assert.ok(lines.includes(`  3. anchorset gate --baseline ${out} --rejudge-of ${b} --candidate ${c} --bar ${BAR}`), t.stderr);
    assert.deepEqual(lines.slice(-3), [AGREEMENT_SENTENCE, AS_DECLARED_SENTENCE, '']);
    const j = cli('gate', '--baseline', b, '--candidate', c, '--bar', BAR, '--json');
    assert.equal(j.status, 2);
    const o = json(j.stdout);
    assert.deepEqual(Object.keys(o).slice(0, 8), V1_KEYS);
    assert.deepEqual([o['schema'], o['kind'], o['command'], o['code'], o['fields'], o['exitCode']], ['anchorset.refusal/v2', 'refused', 'gate', 'IDENTITY_MISMATCH', ['judgeModelServed'], 2]);
    assert.equal(o['message'], r.refusal.message);
    const jd = o['judgeDiff'] as Obj;
    assert.deepEqual([jd['from'], jd['to'], jd['servedChangedUnderSameRequest'], jd['callShapeKeys'], jd['alsoDiffer']], ['baseline', 'candidate', true, [], []]);
    assert.equal((jd['next'] as string[]).length, 3);
    assert.deepEqual(o['statements'], [AGREEMENT_SENTENCE, AS_DECLARED_SENTENCE]);
    assert.equal(o['noGrade'], undefined);
  });

  it('a requested name that moved prints no loud line; a cheaper judge with an edited prompt and new settings lists the call-shape keys', () => {
    const shape = makeJudgeCallShape({ maxOutputTokens: 1024, toolChoice: 'auto', toolChoiceName: NOT_SENT });
    const cand = refundRun({ grades: FOUR, identity: { ...MINI_JUDGE, judgeDefinitionHash: hashOf('judge prompt v2') }, judgeShape: shape });
    const r = gateRuns(base, cand, REFUND_BAR);
    assert.ok(r.kind === 'refused');
    assert.deepEqual([r.refusal.code, [...r.refusal.fields]], ['IDENTITY_MISMATCH', ['judgeDefinitionHash', 'judgeModelRequested', 'judgeModelServed', 'judgeCallShapeHash']]);
    const d = judgeDiff(base, cand, r.refusal);
    assert.ok(d !== undefined);
    assert.equal(d.servedChangedUnderSameRequest, false);
    assert.deepEqual(d.fields.filter((x) => x.state === 'differs').map((x) => x.field), ['judgeModelRequested', 'judgeModelServed', 'judgeDefinitionHash', 'judgeCallShapeHash']);
    assert.deepEqual(d.callShapeKeys, ['maxOutputTokens 256 -> 1024', 'toolChoice "named" -> "auto"', 'toolChoiceName "grade" -> "NOT_SENT"']);
    const t = cli('gate', '--baseline', put(base), '--candidate', put(cand), '--bar', BAR);
    assert.equal(t.status, 2);
    assert.doesNotMatch(t.stderr, /SERVED MODEL CHANGED/);
    assert.match(t.stderr, /^ {4}call-shape keys: maxOutputTokens 256 -> 1024, toolChoice "named" -> "auto", toolChoiceName "grade" -> "NOT_SENT"$/m);
  });

  it('a rubric-only edit refuses as before, now with the re-judge hint, and the block says that only the rubric differs, claiming no cause', () => {
    const cand = refundRun({ grades: FOUR, identity: { rubricHash: hashOf('rubric v2') } });
    const r = gateRuns(base, cand, REFUND_BAR);
    assert.ok(r.kind === 'refused');
    assert.deepEqual([r.refusal.code, [...r.refusal.fields], gateExitCode(r)], ['IDENTITY_MISMATCH', ['rubricHash'], 2]);
    assert.ok(r.refusal.message.endsWith('; the judge differs between these runs; re-judge the baseline outputs with the current judge and pass --rejudge-of <original baseline>'), r.refusal.message);
    const t = cli('gate', '--baseline', put(base), '--candidate', put(cand), '--bar', BAR);
    assert.match(t.stderr, /^ {2}rubric {13}[0-9a-f]{12}… -> [0-9a-f]{12}… +DIFFERS$/m);
    assert.ok(t.stderr.includes("  Only the rubric differs. A case that moves under the new rubric may move because of the edit or because of the judge's own variation; anchorset cannot tell the two apart.\n"), t.stderr);
    assert.doesNotMatch(t.stderr, /on purpose/);
    assert.match(t.stderr, /An edit of the judge's prompt or rubric is a judge change too, also when the model is the same\./);
  });

  it('a definition-only edit: one row differs, and neither the loud line nor the rubric line is printed', () => {
    const cand = refundRun({ grades: FOUR, identity: { judgeDefinitionHash: hashOf('judge prompt v2') } });
    const r = gateRuns(base, cand, REFUND_BAR);
    assert.ok(r.kind === 'refused');
    assert.deepEqual([r.refusal.code, [...r.refusal.fields]], ['IDENTITY_MISMATCH', ['judgeDefinitionHash']]);
    const t = cli('gate', '--baseline', put(base), '--candidate', put(cand), '--bar', BAR);
    assert.match(t.stderr, /^ {2}judge definition +[0-9a-f]{12}… -> [0-9a-f]{12}… +DIFFERS$/m);
    assert.doesNotMatch(t.stderr, /SERVED MODEL CHANGED|Only the rubric differs/);
  });

  it('an unknown judge field: the row reads UNKNOWN, no size is printed, and the one next step is to state the field', () => {
    const cand = refundRun({ grades: FOUR, identity: { judgeModelServed: GAP } });
    const r = gateRuns(base, cand, REFUND_BAR);
    assert.ok(r.kind === 'refused');
    assert.deepEqual([r.refusal.code, [...r.refusal.fields], gateExitCode(r)], ['IDENTITY_GAP', ['judgeModelServed'], 2]);
    const d = judgeDiff(base, cand, r.refusal);
    assert.ok(d !== undefined);
    assert.equal(d.rejudge, undefined);
    assert.deepEqual(d.unknown, [{ field: 'judgeModelServed', in: ['to'] }]);
    const t = cli('gate', '--baseline', put(base), '--candidate', put(cand), '--bar', BAR, '--json');
    const jd = json(t.stdout)['judgeDiff'] as Obj;
    assert.equal(jd['rejudge'], undefined);
    assert.deepEqual(jd['next'], ['State judgeModelServed for the candidate (for write-run: judge.modelServed in the manifest); unknown never counts as unchanged. anchorset validate lists every unknown field.']);
    const text = cli('gate', '--baseline', put(base), '--candidate', put(cand), '--bar', BAR);
    assert.match(text.stderr, /^ {2}model served {7}example-judge-2026-01-15 -> UNKNOWN +UNKNOWN$/m);
    assert.doesNotMatch(text.stderr, /re-judge size/);
  });

  it('a known difference and a gap together: both steps, the statement first', () => {
    const cand = refundRun({ grades: FOUR, identity: { ...NEW_JUDGE, judgeHarnessVersion: GAP } });
    const r = gateRuns(base, cand, REFUND_BAR);
    assert.ok(r.kind === 'refused');
    assert.deepEqual([r.refusal.code, [...r.refusal.fields]], ['IDENTITY_MISMATCH', ['judgeModelServed', 'judgeHarnessVersion']]);
    const jd = json(cli('gate', '--baseline', put(base), '--candidate', put(cand), '--bar', BAR, '--json').stdout)['judgeDiff'] as Obj;
    const next = jd['next'] as string[];
    assert.equal(next.length, 4);
    assert.match(next[0] as string, /^State judgeHarnessVersion for the candidate \(for write-run: judge\.harnessVersion in the manifest\)/);
    assert.match(next[1] as string, /^Re-grade the baseline's stored answers with the candidate's judge/);
    assert.ok(jd['rejudge'] !== undefined);
  });

  it('one run graded by code: the rows read NO_JUDGE, and the step says that --rejudge-of needs a judge on both', () => {
    const byCode: RunArtifact = (() => {
      const r = refundRun({ grades: FOUR });
      const id: RunIdentity = { ...r.identity, judgeDefinitionHash: NO_JUDGE, judgeModelRequested: NO_JUDGE, judgeModelServed: NO_JUDGE, judgeCallShapeHash: NO_JUDGE, judgeHarnessVersion: NO_JUDGE };
      return { ...r, identity: id, callShapes: { system: r.callShapes.system, judge: NO_JUDGE }, packetBasis: NO_JUDGE, draws: r.draws.map((d) => ({ ...d, attempts: d.attempts.map((a) => (a.kind === 'graded' ? { ...a, judgeStop: NO_JUDGE, packetHash: NO_JUDGE } : a)) })) };
    })();
    const r = gateRuns(byCode, base, REFUND_BAR);
    assert.ok(r.kind === 'refused');
    assert.deepEqual([r.refusal.code, [...r.refusal.fields]], ['IDENTITY_MISMATCH', ['judgeDefinitionHash', 'judgeModelRequested', 'judgeModelServed', 'judgeCallShapeHash', 'judgeHarnessVersion']]);
    const t = cli('gate', '--baseline', put(byCode), '--candidate', put(base), '--bar', BAR);
    assert.match(t.stderr, /^ {2}model served {7}NO_JUDGE -> example-judge-2026-01-15 +NO_JUDGE$/m);
    assert.match(t.stderr, /1\. One run was graded by code and the other by a judge; --rejudge-of needs a judge on both\. Grade the baseline's stored answers with the candidate's judge and gate against that run as --baseline\./);
  });

  it('under --rejudge-of, a re-judged baseline graded by another judge than the candidate: the heading names it, and step 1 says to grade again with exactly the candidate\'s judge', () => {
    const original = refundRun({ grades: FOUR });
    const rejudged = refundRun({ grades: FOUR, identity: NEW_JUDGE });
    const cand = refundRun({ grades: FOUR, identity: { ...MINI_JUDGE, ...SYSTEM_MOVED }, answer: newAnswer });
    const r = gateRuns(rejudged, cand, REFUND_BAR, { rejudgeOf: original, allowDiffer: ['systemModelServed'] });
    assert.ok(r.kind === 'refused');
    assert.deepEqual([r.refusal.code, [...r.refusal.fields]], ['IDENTITY_MISMATCH', ['judgeModelRequested', 'judgeModelServed']]);
    const o = put(original, 'original.json');
    const t = cli('gate', '--baseline', put(rejudged), '--rejudge-of', o, '--candidate', put(cand), '--bar', BAR, '--allow-differ', 'systemModelServed');
    assert.equal(t.status, 2);
    assert.match(t.stderr, /^the judge, re-judged baseline -> candidate:$/m);
    assert.match(t.stderr, /1\. The re-judged baseline was not graded by the candidate's judge \(the rows above\)\. Re-grade the original baseline's stored answers again, with exactly the candidate's judge, prompt, rubric and settings\./);
    assert.ok(t.stderr.includes(`--rejudge-of ${o} --candidate`), t.stderr);
  });

  it('other fields that differ are named, and the printed commands carry the user\'s --allow-differ unchanged, never a waiver it lacked', () => {
    const cand = refundRun({ grades: FOUR, identity: { ...NEW_JUDGE, ...SYSTEM_MOVED, systemPromptHash: hashOf('prompt v2') }, answer: newAnswer });
    const r = gateRuns(base, cand, REFUND_BAR, { allowDiffer: ['systemModelServed'] });
    assert.ok(r.kind === 'refused');
    assert.deepEqual([r.refusal.code, [...r.refusal.fields]], ['IDENTITY_MISMATCH', ['systemPromptHash', 'judgeModelServed']]);
    const t = cli('gate', '--baseline', put(base), '--candidate', put(cand), '--bar', BAR, '--allow-differ', 'systemModelServed');
    assert.match(t.stderr, /^also differ, and gate refuses them after re-judging too: systemPromptHash\. Name a field in --allow-differ only for a change you made on purpose\.$/m);
    const commands = t.stderr.split('\n').filter((l) => /^ {2}[23]\. anchorset /.test(l));
    assert.equal(commands.length, 2);
    for (const l of commands) assert.ok(l.endsWith(' --allow-differ systemModelServed') && !l.includes('systemPromptHash'), l);
  });

  it('paths with a space and a quote are written as one shell word each', () => {
    const cand = refundRun({ grades: FOUR, identity: NEW_JUDGE });
    const b = put(base, "base line's.json");
    const t = cli('gate', '--baseline', b, '--candidate', put(cand), '--bar', BAR, '--json');
    const next = (json(t.stdout)['judgeDiff'] as Obj)['next'] as string[];
    const quoted = `'${b.replace(/'/g, "'\\''")}'`;
    assert.ok((next[2] as string).includes(`--rejudge-of ${quoted}`), next[2]);
    assert.ok((next[0] as string).endsWith(`--out '${b.replace(/\.json$/, '.rejudged.json').replace(/'/g, "'\\''")}'`), next[0]);
    // What a shell reads back is the path itself.
    const echoed = spawnSync('bash', ['-c', `printf '%s' ${quoted}`], { encoding: 'utf8' });
    assert.equal(echoed.stdout, b);
  });

  it('the re-judge size counts the slots that hold an answer to grade (a hand-worked fixture), with the retries beside it, and is UNKNOWN with an unknown draw count', () => {
    // 4 cases x 3 draws = 12 slots. q01#1 is an answer cut at its cap (T), q02#2 the system's own error (E), q03#0 has
    // no record (-): none of the three needs a judge call. q03#2 is a judge parse-failure: its answer still needs one.
    // So 12 - 3 = 9 slots with an answer. q01#0 and q02#0 were asked again once each: 2 slots with a judge retry.
    const grades = { q01: ['4', 'T', '4'], q02: ['4', '4', 'E'], q03: ['-', '4', '!parse-failure'], p1: ['4', '4', '4'] };
    const retries = { 'q01#0': [judgeRetry('q01', 'timeout')], 'q02#0': [judgeRetry('q02', 'rate-limited')] };
    const b = refundRun({ grades, retries });
    const cand = refundRun({ grades, identity: NEW_JUDGE });
    const r = gateRuns(b, cand, REFUND_BAR);
    assert.ok(r.kind === 'refused');
    assert.deepEqual([r.refusal.code, [...r.refusal.fields]], ['IDENTITY_MISMATCH', ['judgeModelServed']]);
    assert.deepEqual(judgeDiff(b, cand, r.refusal)?.rejudge, { cases: 4, drawsPerCase: 3, slots: 12, slotsWithAnswer: 9, judgeCallsAtLeast: 9, retriesExtra: true, baselineSlotsWithJudgeRetry: 2 });
    const unknownCount = refundRun({ grades: FOUR, identity: { drawsPerCase: GAP } });
    const rc = refundRun({ grades: FOUR, identity: { ...NEW_JUDGE } });
    const u = gateRuns(unknownCount, rc, REFUND_BAR);
    assert.ok(u.kind === 'refused');
    assert.deepEqual([u.refusal.code, [...u.refusal.fields]], ['IDENTITY_MISMATCH', ['judgeModelServed', 'drawsPerCase']]);
    assert.equal(judgeDiff(unknownCount, rc, u.refusal)?.rejudge, GAP);
    const t = cli('gate', '--baseline', put(unknownCount), '--candidate', put(rc), '--bar', BAR);
    assert.match(t.stderr, /^re-judge size: not counted \(the baseline's drawsPerCase is unknown\); retries are extra\. anchorset knows no prices\.$/m);
  });

  it('toward a candidate graded by code, no re-judge size is printed: grading by code needs no judge call; toward a judge it is', () => {
    const byCode = (r: RunArtifact): RunArtifact => {
      const id: RunIdentity = { ...r.identity, judgeDefinitionHash: NO_JUDGE, judgeModelRequested: NO_JUDGE, judgeModelServed: NO_JUDGE, judgeCallShapeHash: NO_JUDGE, judgeHarnessVersion: NO_JUDGE };
      return { ...r, identity: id, callShapes: { system: r.callShapes.system, judge: NO_JUDGE }, packetBasis: NO_JUDGE, draws: r.draws.map((d) => ({ ...d, attempts: d.attempts.map((a) => (a.kind === 'graded' ? { ...a, judgeStop: NO_JUDGE, packetHash: NO_JUDGE } : a)) })) };
    };
    const code = byCode(refundRun({ grades: FOUR }));
    const toCode = gateRuns(base, code, REFUND_BAR);
    assert.ok(toCode.kind === 'refused');
    assert.deepEqual([toCode.refusal.code, gateExitCode(toCode)], ['IDENTITY_MISMATCH', 2]);
    assert.equal(judgeDiff(base, code, toCode.refusal)?.rejudge, undefined);
    const t = cli('gate', '--baseline', put(base), '--candidate', put(code), '--bar', BAR);
    assert.doesNotMatch(t.stderr, /re-judge size|judge calls/);
    assert.match(t.stderr, /Grade the baseline's stored answers with the candidate's code/);
    const toJudge = gateRuns(code, base, REFUND_BAR);
    assert.ok(toJudge.kind === 'refused');
    assert.equal((judgeDiff(code, base, toJudge.refusal)?.rejudge as { judgeCallsAtLeast: number }).judgeCallsAtLeast, 9);
  });

  it('a refusal whose code does not fit the two runs it would describe gets no judge diff: the original\'s unknown served id, against a re-judged baseline whose judge differs from the candidate\'s', () => {
    const original = refundRun({ grades: FOUR, identity: { judgeModelServed: GAP } });
    const rejudged = refundRun({ grades: FOUR, identity: MINI_JUDGE });
    const cand = refundRun({ grades: FOUR, identity: { ...NEW_JUDGE, ...SYSTEM_MOVED }, answer: newAnswer });
    const r = gateRuns(rejudged, cand, REFUND_BAR, { rejudgeOf: original, allowDiffer: ['systemModelServed'] });
    assert.ok(r.kind === 'refused');
    assert.deepEqual([r.refusal.code, [...r.refusal.fields], gateExitCode(r)], ['IDENTITY_GAP', ['judgeModelServed'], 2]);
    assert.equal(judgeDiff(rejudged, cand, r.refusal), undefined);
    const o = json(cli('gate', '--baseline', put(rejudged), '--rejudge-of', put(original), '--candidate', put(cand), '--bar', BAR, '--allow-differ', 'systemModelServed', '--json').stdout);
    assert.deepEqual([o['code'], o['fields'], o['judgeDiff']], ['IDENTITY_GAP', ['judgeModelServed'], undefined]);
  });

  it('a field the gate never waives is not offered for --allow-differ: the draw count is named apart', () => {
    const four = { q01: ['4', '4', '4', '4'], q02: ['4', '4', '4', '4'], p1: ['4', '4', '4', '4'] };
    const cand = refundRun({ grades: four, identity: NEW_JUDGE });
    const r = gateRuns(base, cand, REFUND_BAR);
    assert.ok(r.kind === 'refused');
    assert.deepEqual([r.refusal.code, [...r.refusal.fields]], ['IDENTITY_MISMATCH', ['judgeModelServed', 'drawsPerCase']]);
    const t = cli('gate', '--baseline', put(base), '--candidate', put(cand), '--bar', BAR);
    assert.match(t.stderr, /^also differ, and can never be named in --allow-differ: drawsPerCase; the two runs must agree on them\.$/m);
    assert.doesNotMatch(t.stderr, /gate refuses them after re-judging too/);
    assert.deepEqual((json(cli('gate', '--baseline', put(base), '--candidate', put(cand), '--bar', BAR, '--json').stdout)['judgeDiff'] as Obj)['alsoDiffer'], ['drawsPerCase']);
  });

  it('no judge diff on any other refusal: a bar hash, a system field alone, an incomplete baseline, a system that gave no answer', () => {
    const cases: [string, RunArtifact, RunArtifact, readonly string[], string, string[]][] = [
      ['bar hash', refundRun({ grades: FOUR, identity: { barHash: hashOf('another bar') } }), base, [], 'HASH_MISMATCH', ['barHash']],
      ['system field', base, refundRun({ grades: FOUR, identity: SYSTEM_MOVED }), [], 'IDENTITY_MISMATCH', ['systemModelServed']],
      ['incomplete baseline', refundRun({ grades: { ...FOUR, q01: ['4', '!parse-failure', '4'] } }), refundRun({ grades: FOUR }), [], 'INCOMPLETE_RUN', ['q01#1']],
      ['no answer', refundRun({ grades: { ...FOUR, q01: ['4', 'E', '4'] } }), refundRun({ grades: FOUR }), [], 'INCOMPLETE_RUN', ['q01#1']],
    ];
    for (const [what, b, c, allow, code, fields] of cases) {
      const r = gateRuns(b, c, REFUND_BAR, { allowDiffer: allow as never });
      assert.ok(r.kind === 'refused', what);
      assert.deepEqual([r.refusal.code, [...r.refusal.fields]], [code, fields], what);
      assert.equal(judgeDiff(b, c, r.refusal), undefined, what);
      const o = json(cli('gate', '--baseline', put(b), '--candidate', put(c), '--bar', BAR, '--json').stdout);
      assert.deepEqual([o['code'], o['fields'], o['exitCode'], o['judgeDiff']], [code, fields, 2, undefined], what);
    }
  });

  it('a refusal about another pair gets no judge diff: an original whose judge field is unknown, against a re-judged baseline that agrees with the candidate', () => {
    const original = refundRun({ grades: FOUR, identity: { judgeHarnessVersion: GAP } });
    const rejudged = refundRun({ grades: FOUR, identity: NEW_JUDGE });
    const cand = refundRun({ grades: FOUR, identity: { ...NEW_JUDGE, ...SYSTEM_MOVED }, answer: newAnswer });
    const r = gateRuns(rejudged, cand, REFUND_BAR, { rejudgeOf: original, allowDiffer: ['systemModelServed'] });
    assert.ok(r.kind === 'refused');
    assert.deepEqual([r.refusal.code, [...r.refusal.fields]], ['IDENTITY_GAP', ['judgeHarnessVersion']]);
    assert.equal(judgeDiff(rejudged, cand, r.refusal), undefined);
  });
});

describe('slots that hold no grade, on a refusal', () => {
  it('a gate baseline: the refusal keeps its code, fields and exit, and carries the counts by reason; the counted slots are the refusal\'s fields', () => {
    // 3 cases x 3 draws = 9 slots: q01#1 parse-failure, q02#0 truncated (the judge's reply cut), q02#2 no record. 3 of 9.
    const b = refundRun({ grades: { q01: ['4', '!parse-failure', '4'], q02: ['!truncated', '4', '-'], p1: ['4', '4', '4'] } });
    const c = refundRun({ grades: FOUR });
    const r = gateRuns(b, c, REFUND_BAR);
    assert.ok(r.kind === 'refused');
    assert.deepEqual([r.refusal.code, [...r.refusal.fields], gateExitCode(r)], ['INCOMPLETE_RUN', ['q01#1', 'q02#0', 'q02#2'], 2]);
    const path = put(b);
    const o = json(cli('gate', '--baseline', path, '--candidate', put(c), '--bar', BAR, '--json').stdout);
    assert.deepEqual(Object.keys(o).slice(0, 8), V1_KEYS);
    assert.deepEqual([o['code'], o['fields'], o['exitCode']], ['INCOMPLETE_RUN', ['q01#1', 'q02#0', 'q02#2'], 2]);
    assert.deepEqual(o['noGrade'], [{
      run: path, role: 'baseline', judge: { requested: 'example-judge', served: 'example-judge-2026-01-15' }, slots: 3, of: 9,
      byReason: [{ role: 'judge', reason: 'parse-failure', slots: 1 }, { role: 'judge', reason: 'truncated', slots: 1 }, { role: 'none', reason: 'no record', slots: 1 }],
    }]);
    // The bucket holds the refusal: its slots sum to the fields, one each.
    assert.equal((o['noGrade'] as { slots: number }[]).reduce((k, x) => k + x.slots, 0), (o['fields'] as string[]).length);
    assert.deepEqual(o['statements'], [AGREEMENT_SENTENCE, AS_DECLARED_SENTENCE]);
    const t = cli('gate', '--baseline', path, '--candidate', put(c), '--bar', BAR);
    assert.match(t.stderr, /^slots that hold no grade, by run file \(gate reads none of them, and none is a pass, a fail or a flip\):$/m);
    assert.match(t.stderr, /^ {2}baseline +example-judge-2026-01-15 +3 of 9 +judge parse-failure 1, judge truncated 1, no record 1$/m);
    assert.match(t.stderr, /its parse-failure, content-filter or client-error is final/);
  });

  it('a re-judged baseline under --rejudge-of: named as such', () => {
    const original = refundRun({ grades: FOUR });
    const rejudged = refundRun({ grades: { ...FOUR, q02: ['4', '4', '!content-filter'] }, identity: NEW_JUDGE });
    const cand = refundRun({ grades: FOUR, identity: { ...NEW_JUDGE, ...SYSTEM_MOVED }, answer: newAnswer });
    const r = gateRuns(rejudged, cand, REFUND_BAR, { rejudgeOf: original, allowDiffer: ['systemModelServed'] });
    assert.ok(r.kind === 'refused');
    assert.deepEqual([r.refusal.code, [...r.refusal.fields]], ['INCOMPLETE_RUN', ['q02#2']]);
    const o = json(cli('gate', '--baseline', put(rejudged), '--rejudge-of', put(original), '--candidate', put(cand), '--bar', BAR, '--allow-differ', 'systemModelServed', '--json').stdout);
    assert.deepEqual([o['code'], o['fields'], o['exitCode']], ['INCOMPLETE_RUN', ['q02#2'], 2]);
    const g = (o['noGrade'] as Obj[])[0] as Obj;
    assert.deepEqual([g['role'], g['judge'], g['slots'], g['of'], g['byReason']], ['re-judged baseline', { requested: 'example-judge', served: 'example-judge-2026-06-01' }, 1, 9, [{ role: 'judge', reason: 'content-filter', slots: 1 }]]);
  });

  it('the judge\'s remedy line is printed only where a judge reason is counted: a system that timed out gets the counts without it', () => {
    const b = refundRun({ grades: { ...FOUR, q01: ['4', '~timeout', '4'] } });
    const t = cli('gate', '--baseline', put(b), '--candidate', put(refundRun({ grades: FOUR })), '--bar', BAR);
    assert.equal(t.status, 2);
    assert.match(t.stderr, /^ {2}baseline +example-judge-2026-01-15 +1 of 9 +system timeout 1$/m);
    assert.doesNotMatch(t.stderr, /may be asked again/);
  });

  it('a system that gave no answer is not a slot that holds no grade: its INCOMPLETE_RUN carries no counts', () => {
    const b = refundRun({ grades: { ...FOUR, q01: ['4', 'E', '4'] } });
    const o = json(cli('gate', '--baseline', put(b), '--candidate', put(refundRun({ grades: FOUR })), '--bar', BAR, '--json').stdout);
    assert.deepEqual([o['code'], o['fields'], o['exitCode']], ['INCOMPLETE_RUN', ['q01#1'], 2]);
    assert.equal(o['noGrade'], undefined);
    assert.equal(o['statements'], undefined);
  });

  it('flips: the run\'s counts beside its refusal, whose code and fields are as before', () => {
    // 3 cases x 3 draws: q01#2 judge timeout, q02#1 no record: 2 of 9.
    const run = refundRun({ grades: { q01: ['4', '4', '!timeout'], q02: ['4', '-', '4'], p1: ['4', '4', '4'] } });
    const path = put(run);
    const t = cli('flips', '--run', path, '--json');
    assert.equal(t.status, 2);
    const o = json(t.stdout);
    assert.deepEqual([o['schema'], o['command'], o['code'], o['fields'], o['exitCode']], ['anchorset.refusal/v2', 'flips', 'INCOMPLETE_RUN', ['q01#2', 'q02#1'], 2]);
    assert.deepEqual(o['noGrade'], [{ run: path, role: 'run', judge: { requested: 'example-judge', served: 'example-judge-2026-01-15' }, slots: 2, of: 9, byReason: [{ role: 'judge', reason: 'timeout', slots: 1 }, { role: 'none', reason: 'no record', slots: 1 }] }]);
    const text = cli('flips', '--run', path);
    assert.match(text.stderr, /^slots that hold no grade, by run file \(flips reads none of them/m);
    assert.ok(text.stderr.trimEnd().endsWith(`${AGREEMENT_SENTENCE}\n${AS_DECLARED_SENTENCE}`));
  });
});

// --- The judge-flip list -------------------------------------------------------------------------------------------
//
// A hand-worked fixture. Three draws per case; a case passes when each of its draws grades 4 or above (worst of 3).
//
//   case  class           old judge (original)     new judge (re-judged)   old -> new
//   p1    refund_policy   4 4 4  pass (0 fail)     4 3 4  fail (1 fail)    pass -> fail
//   p2    refund_policy   5 5 5  pass              5 5 5  pass             pass -> pass
//   q01   reply_quality   4 4 4  pass              3 4 4  fail (1 fail)    pass -> fail
//   q02   reply_quality   3 4 4  fail (1 fail)     4 4 4  pass             fail -> pass
//   q03   reply_quality   4 5 4  pass              4 4 4  pass             pass -> pass
//   q04   reply_quality   2 2 2  fail (3 fail)     2 3 2  fail (3 fail)    fail -> fail
//   q05   reply_quality   !parse-failure 4 4       4 4 4  pass             no grade
//   q06   reply_quality   4 !content-filter 4      3 3 3  fail (3 fail)    no grade
//   q07   reply_quality   4 4 !truncated           4 4 4  pass             no grade
//   q08   reply_quality   4 3 4  fail (1 fail)     4 3 3  fail (2 fail)    fail -> fail; its draws hold two answers (a b a)
//
// refund_policy: pass -> fail 1 (p1), fail -> pass 0. reply_quality: pass -> fail 1 (q01), fail -> pass 1 (q02): the
// two cancel in a net, and each is printed. No grade (old judge): q05, q06, q07, 3 cases, 3 of 30 slots.
// Split draws (0 < failing < 3): old judge q02, q08 = 2 of the 7 graded cases (refund_policy 0 of 2, reply_quality 2
// of 5); one answer 1 of 6 (q02), different answers 1 of 1 (q08). New judge p1, q01, q08 = 3 of 10 (refund_policy 1 of
// 2, reply_quality 2 of 8); one answer 2 of 9, different answers 1 of 1.
const OLD_GRADES = { p1: ['4', '4', '4'], p2: ['5', '5', '5'], q01: ['4', '4', '4'], q02: ['3', '4', '4'], q03: ['4', '5', '4'], q04: ['2', '2', '2'], q05: ['!parse-failure', '4', '4'], q06: ['4', '!content-filter', '4'], q07: ['4', '4', '!truncated'], q08: ['4', '3', '4'] };
const NEW_GRADES = { p1: ['4', '3', '4'], p2: ['5', '5', '5'], q01: ['3', '4', '4'], q02: ['4', '4', '4'], q03: ['4', '4', '4'], q04: ['2', '3', '2'], q05: ['4', '4', '4'], q06: ['3', '3', '3'], q07: ['4', '4', '4'], q08: ['4', '3', '3'] };
const twoAnswers = (id: string, d: number): string => (id === 'q08' && d === 1 ? 'Your refund for order q08 was declined.' : `Your refund for order ${id} is on its way.`);
const flipTrio = (over: { original?: Partial<Parameters<typeof refundRun>[0]>; rejudged?: Partial<Parameters<typeof refundRun>[0]> } = {}) => {
  const original = refundRun({ grades: OLD_GRADES, answer: twoAnswers, ...over.original });
  const rejudged = refundRun({ grades: NEW_GRADES, answer: twoAnswers, identity: NEW_JUDGE, ...over.rejudged });
  const candidate = refundRun({ grades: NEW_GRADES, answer: newAnswer, identity: { ...NEW_JUDGE, ...SYSTEM_MOVED } });
  return { original, rejudged, candidate };
};
const gateTrio = (t: ReturnType<typeof flipTrio>) => gateRuns(t.rejudged, t.candidate, REFUND_BAR, { rejudgeOf: t.original, allowDiffer: ['systemModelServed'] });

describe('the judge-flip list of gate --rejudge-of', () => {
  it('counts each direction apart per class, non-compensable first, lists the old judge\'s no-grade cases in their own column, and never nets (a hand-worked fixture)', () => {
    const f = flipsOf(gateTrio(flipTrio()));
    assert.deepEqual(f.classes, [
      { klass: 'refund_policy', nonCompensable: true, n: 2, passToFail: ['p1'], failToPass: [], noGradeOld: [] },
      { klass: 'reply_quality', nonCompensable: false, n: 8, passToFail: ['q01'], failToPass: ['q02'], noGradeOld: ['q05', 'q06', 'q07'] },
    ]);
    assert.deepEqual(f.cases.map((c) => c.caseId), ['p1', 'q01', 'q02', 'q05', 'q06', 'q07']);
    const q01 = f.cases.find((c) => c.caseId === 'q01');
    assert.deepEqual(q01, { caseId: 'q01', klass: 'reply_quality', expect: '4', answers: 1, answerHashes: [sha256Hex('Your refund for order q01 is on its way.')], old: { pass: true, failingDraws: 0, labels: ['4', '4', '4'] }, new: { pass: false, failingDraws: 1, labels: ['3', '4', '4'] } });
    assert.deepEqual(f.cases.find((c) => c.caseId === 'q05')?.old, { noGrade: [{ drawIndex: 0, reason: 'judge parse-failure' }], labels: [GAP, '4', '4'] });
    assert.deepEqual(f.cases.find((c) => c.caseId === 'q07')?.old, { noGrade: [{ drawIndex: 2, reason: 'judge truncated' }], labels: ['4', '4', GAP] });
    // q08 holds two answers, so no count is pooled: per class, reply_quality old splits q02 (one answer, of 4: q01
    // q02 q03 q04) and q08 (different answers, of 1); new splits q01 (one answer, of 7) and q08.
    const parts = (one: [number, number], many: [number, number]) => ({ oneAnswer: { split: one[0], of: one[1] }, differentAnswers: { split: many[0], of: many[1] } });
    assert.deepEqual(f.ownVariation, {
      old: { ...parts([1, 6], [1, 1]), byClass: [{ klass: 'refund_policy', ...parts([0, 2], [0, 0]) }, { klass: 'reply_quality', ...parts([1, 4], [1, 1]) }], noGradeCases: 3 },
      new: { ...parts([2, 9], [1, 1]), byClass: [{ klass: 'refund_policy', ...parts([1, 2], [0, 0]) }, { klass: 'reply_quality', ...parts([1, 7], [1, 1]) }], noGradeCases: 0 },
    });
    assert.equal(f.packets, 'recorded');
    // No key holds a net, a rate or a difference.
    assert.doesNotMatch(JSON.stringify(f), /"net|rate|share|delta|"change/i);
    assert.deepEqual(f.statements, [AGREEMENT_SENTENCE, AS_DECLARED_SENTENCE]);
  });

  it('prints the list after BROKE and FIXED and before the judge-controlled block, both 1s apart, with the case inputs and no netted line', () => {
    const t = flipTrio();
    const args = ['gate', '--baseline', put(t.rejudged), '--rejudge-of', put(t.original), '--candidate', put(t.candidate), '--bar', BAR, '--allow-differ', 'systemModelServed'];
    const r = cli(...args);
    assert.equal(r.status, 1, r.stderr);
    const out = r.stdout;
    assert.ok(out.indexOf('FIXED (') < out.indexOf('judge flips:') && out.indexOf('judge flips:') < out.indexOf('judge-controlled'), out);
    assert.match(out, /^ {2}class +n +pass -> fail +fail -> pass +no grade \(old judge\)$/m);
    assert.match(out, /^ {2}refund_policy \(strict\) +2 +1 +0 +0$/m);
    assert.match(out, /^ {2}reply_quality +8 +1 +1 +3$/m);
    assert.ok(out.indexOf('refund_policy (strict)') < out.indexOf('  reply_quality  '), 'non-compensable first');
    assert.match(out, /^ {4}reply_quality\/q01 {2}expect >= 4 · old 4 4 4 \(0 of 3 fail\) -> new 3 4 4 \(1 of 3 fail\) · answer [0-9a-f]{12}…$/m);
    assert.match(out, /^ {8}input \{"message":"Where is my refund for order q01\?"\}$/m);
    assert.match(out, /^ {2}no grade under the old judge \(3 cases; 3 of 30 slots: judge content-filter 1, judge parse-failure 1, judge truncated 1\); never a pass, a fail or a flip, and in no direction above:$/m);
    assert.match(out, /^ {4}reply_quality\/q06 {2}#1 judge content-filter · new judge fail \(3 of 3 fail\)$/m);
    assert.match(out, /^ {4}old judge {2}one answer 1 of 6, different answers 1 of 1 \(refund_policy: one answer 0 of 2, different answers 0 of 0; reply_quality: one answer 1 of 4, different answers 1 of 1; 3 cases with a slot that holds no grade are not counted\)$/m);
    assert.match(out, /· packets equal as recorded$/m);
    assert.match(out, /^ {4}1 of the 10 cases hold different answers across their draws; their splits mix the system's variation with the judge's, and are never pooled with the one-answer cases$/m);
    assert.doesNotMatch(out, /\bnet\b/);
    assert.ok(out.includes(`  ${AGREEMENT_SENTENCE}\n  ${AS_DECLARED_SENTENCE}\n`));
    const j = json(cli(...args, '--json').stdout);
    assert.equal(j['schema'], 'anchorset.gate-report/v2');
    assert.deepEqual((j['judgeFlips'] as Obj)['classes'], flipsOf(gateTrio(t)).classes);
  });

  it('the split of the same trio is refused as an incomplete run naming the original\'s slots; the verdict and exit code are those of a complete original', () => {
    const t = flipTrio();
    const r = evaluated(gateTrio(t));
    const jc = r.judgeControl;
    assert.ok(jc !== undefined && 'refused' in jc);
    assert.deepEqual([jc.refused.code, [...jc.refused.fields]], ['INCOMPLETE_RUN', ['q05#0', 'q06#1', 'q07#2']]);
    assert.ok(jc.refused.message.startsWith('INCOMPLETE_RUN: original baseline (--rejudge-of): 3 of 30 slots in 3 of 10 cases, content-filter 1, parse-failure 1, truncated 1; '), jc.refused.message);
    const complete = evaluated(gateTrio(flipTrio({ original: { grades: { ...OLD_GRADES, q05: ['4', '4', '4'], q06: ['4', '4', '4'], q07: ['4', '4', '4'] } } })));
    assert.deepEqual([r.gate, r.diff, gateExitCode(r)], [complete.gate, complete.diff, gateExitCode(complete)]);
    const out = cli('gate', '--baseline', put(t.rejudged), '--rejudge-of', put(t.original), '--candidate', put(t.candidate), '--bar', BAR, '--allow-differ', 'systemModelServed').stdout;
    assert.match(out, /^judge-controlled: not computed \(INCOMPLETE_RUN: q05#0, q06#1, q07#2\); this does not change the exit code$/m);
  });

  it('packets recorded on both sides, declared on both, and recorded beside declared: the list is computed, the same, and labelled by its basis; the split takes recorded packets only', () => {
    const plain = gateTrio(flipTrio());
    const recorded = flipsOf(plain);
    for (const [what, over] of [
      ['declared on both', { original: { packetBasis: 'declared' as const }, rejudged: { packetBasis: 'declared' as const } }],
      ['declared original, recorded re-judged', { original: { packetBasis: 'declared' as const } }],
      ['recorded original, declared re-judged', { rejudged: { packetBasis: 'declared' as const } }],
    ] as const) {
      const r = gateTrio(flipTrio(over));
      const f = flipsOf(r);
      assert.equal(f.packets, 'by declaration, not observed', what);
      assert.deepEqual([f.classes, f.cases, f.ownVariation], [recorded.classes, recorded.cases, recorded.ownVariation], what);
      const jc = evaluated(r).judgeControl;
      assert.ok(jc !== undefined && 'refused' in jc && jc.refused.code === 'PACKET_MISMATCH', what);
      assert.deepEqual([evaluated(r).gate, gateExitCode(r)], [evaluated(plain).gate, gateExitCode(plain)], what);
    }
    const t = flipTrio({ original: { packetBasis: 'declared' } });
    const args = ['gate', '--baseline', put(t.rejudged), '--rejudge-of', put(t.original), '--candidate', put(t.candidate), '--bar', BAR, '--allow-differ', 'systemModelServed'];
    const out = cli(...args);
    assert.equal(out.status, gateExitCode(plain));
    assert.match(out.stdout, /^ {2}old judge: .* · packets equal by declaration, not observed$/m);
    assert.match(out.stdout, /^ {2}reply_quality +8 +1 +1 +3$/m);
    assert.match(out.stdout, /^judge-controlled: not computed \(PACKET_MISMATCH: packetBasis \(original baseline \(--rejudge-of\)\)\); this does not change the exit code$/m);
    assert.equal((json(cli(...args, '--json').stdout)['judgeFlips'] as Obj)['packets'], 'by declaration, not observed');
  });

  it('unknown packets, a packet that differs, and a 4xx of the old judge: not computed, naming the code and fields; verdict and exit code unchanged', () => {
    const plain = gateTrio(flipTrio());
    const differs = flipTrio();
    const edited: RunArtifact = { ...differs.original, draws: differs.original.draws.map((d) => (d.caseId === 'q03' && d.drawIndex === 1 ? { ...d, attempts: d.attempts.map((a) => (a.kind === 'graded' ? { ...a, packetHash: sha256Hex('another view') } : a)) } : d)) };
    for (const [what, original, code, fields] of [
      ['unknown', flipTrio({ original: { packetBasis: 'UNKNOWN' } }).original, 'PACKET_MISMATCH', ['packetBasis (original baseline (--rejudge-of))']],
      ['differs', edited, 'PACKET_MISMATCH', ['packetHash[q03#1]']],
      ['4xx', flipTrio({ original: { grades: { ...OLD_GRADES, q03: ['4', '!client-error', '4'] } } }).original, 'MEASUREMENT_NOT_RUNNABLE', ['q03#1']],
    ] as const) {
      const r = evaluated(gateRuns(differs.rejudged, differs.candidate, REFUND_BAR, { rejudgeOf: original, allowDiffer: ['systemModelServed'] }));
      const f = r.judgeFlips;
      assert.ok(f !== undefined && 'refused' in f, what);
      assert.deepEqual([f.refused.code, [...f.refused.fields]], [code, fields], what);
      const jc = r.judgeControl;
      assert.ok(jc !== undefined && 'refused' in jc && jc.refused.code === code, what);
      assert.deepEqual([r.gate.pass, gateExitCode(r)], [evaluated(plain).gate.pass, gateExitCode(plain)], what);
    }
    const t = flipTrio({ original: { packetBasis: 'UNKNOWN' } });
    const out = cli('gate', '--baseline', put(t.rejudged), '--rejudge-of', put(t.original), '--candidate', put(t.candidate), '--bar', BAR, '--allow-differ', 'systemModelServed');
    assert.equal(out.status, gateExitCode(plain));
    assert.match(out.stdout, /^judge flips: not computed \(PACKET_MISMATCH: packetBasis \(original baseline \(--rejudge-of\)\)\); the verdict and exit code are not affected$/m);
    // The two blocks print their own remedies: the list's names declared packets too, the split's recorded ones only.
    assert.match(out.stdout, /^ {2}the two judges are compared only on packets both runs recorded or declared, /m);
    assert.match(out.stdout, /^ {2}the two judges are compared only on packets both runs recorded, and /m);
  });

  it('the judges\' own variation of a baseline whose draws hold different answers: every count in its two parts, per class too, and no pooled total', () => {
    // q01 and q02 hold a different answer on each draw. old q02 4 3 4 (split), new 4 4 4; q03 old 4 3 4 (split, one answer).
    const answer = (id: string, d: number): string => (id === 'q01' || id === 'q02' ? `answer ${id} draw ${d}` : `Your refund for order ${id} is on its way.`);
    const old = { p1: ['4', '4', '4'], q01: ['4', '4', '4'], q02: ['4', '3', '4'], q03: ['4', '3', '4'] };
    const neu = { p1: ['4', '4', '4'], q01: ['4', '4', '4'], q02: ['4', '4', '4'], q03: ['4', '4', '4'] };
    const original = refundRun({ grades: old, answer });
    const rejudged = refundRun({ grades: neu, answer, identity: NEW_JUDGE });
    const candidate = refundRun({ grades: neu, answer: newAnswer, identity: { ...NEW_JUDGE, ...SYSTEM_MOVED } });
    const f = flipsOf(gateRuns(rejudged, candidate, REFUND_BAR, { rejudgeOf: original, allowDiffer: ['systemModelServed'] }));
    const v = f.ownVariation;
    assert.ok(v !== ONE_DRAW_OWN_VARIATION);
    assert.equal(v.old.splitCases, undefined);
    assert.equal(v.old.of, undefined);
    assert.deepEqual(v.old.byClass.find((c) => c.klass === 'reply_quality'), { klass: 'reply_quality', oneAnswer: { split: 1, of: 1 }, differentAnswers: { split: 1, of: 2 } });
    assert.doesNotMatch(JSON.stringify(v), /"split":\d+,"of":\d+,"oneAnswer"/);
    const out = cli('gate', '--baseline', put(rejudged), '--rejudge-of', put(original), '--candidate', put(candidate), '--bar', BAR, '--allow-differ', 'systemModelServed').stdout;
    assert.match(out, /^ {4}old judge {2}one answer 1 of 2, different answers 1 of 2 \(refund_policy: one answer 0 of 1, different answers 0 of 0; reply_quality: one answer 1 of 1, different answers 1 of 2\)$/m);
    assert.match(out, /^ {4}2 of the 4 cases hold different answers across their draws/m);
  });

  it('a case one run does not hold is named as a changed case set before any ungraded slot of a case both hold', () => {
    const t = flipTrio({ original: { grades: { ...OLD_GRADES, q05: ['4', '4', '4'], q06: ['4', '4', '4'], q07: ['4', '4', '4'] } } });
    const allow = { rejudgeOf: t.original, allowDiffer: ['systemModelServed', 'caseSetHash'] as const };
    // The candidate lacks q04, and its q03#1 is a parse-failure.
    const { q04: _gone, ...rest } = NEW_GRADES;
    const lacking = refundRun({ grades: { ...rest, q03: ['4', '!parse-failure', '4'] }, answer: newAnswer, identity: { ...NEW_JUDGE, ...SYSTEM_MOVED } });
    // The candidate's extra case q09 holds a slot with no grade; with every grade, the same extra case.
    const extra = (q09: string[]) => refundRun({ grades: { ...NEW_GRADES, q09 }, answer: newAnswer, identity: { ...NEW_JUDGE, ...SYSTEM_MOVED } });
    for (const [what, cand, fields] of [['missing q04', lacking, ['q04']], ['extra q09, a slot with no grade', extra(['4', '!parse-failure', '4']), ['q09']], ['extra q09, every grade', extra(['4', '4', '4']), ['q09']]] as const) {
      const r = evaluated(gateRuns(t.rejudged, cand, REFUND_BAR, { ...allow, allowDiffer: [...allow.allowDiffer] }));
      const jc = r.judgeControl;
      assert.ok(jc !== undefined && 'refused' in jc, what);
      assert.deepEqual([jc.refused.code, [...jc.refused.fields]], ['ITEM_SET_MISMATCH', fields], what);
      assert.equal(gateExitCode(r), 1, what);
    }
  });

  it('a candidate holding a slot with no grade, or with no record, makes the split an incomplete run naming the slots, not a changed case set; the verdict and exit 1 stand', () => {
    const t = flipTrio({ original: { grades: { ...OLD_GRADES, q05: ['4', '4', '4'], q06: ['4', '4', '4'], q07: ['4', '4', '4'] } } });
    for (const [what, grades, fields, counts] of [
      ['no grade', { ...NEW_GRADES, q04: ['2', '!parse-failure', '2'], q05: ['!truncated', '4', '4'] }, ['q04#1', 'q05#0'], 'candidate: 2 of 30 slots in 2 of 10 cases, parse-failure 1, truncated 1; '],
      ['no record', { ...NEW_GRADES, q04: ['2', '-', '2'] }, ['q04#1'], 'candidate: 1 of 30 slots in 1 of 10 cases, no record 1; '],
    ] as const) {
      const cand = refundRun({ grades, answer: newAnswer, identity: { ...NEW_JUDGE, ...SYSTEM_MOVED } });
      const r = evaluated(gateRuns(t.rejudged, cand, REFUND_BAR, { rejudgeOf: t.original, allowDiffer: ['systemModelServed'] }));
      const jc = r.judgeControl;
      assert.ok(jc !== undefined && 'refused' in jc, what);
      assert.deepEqual([jc.refused.code, [...jc.refused.fields]], ['INCOMPLETE_RUN', fields], what);
      assert.ok(jc.refused.message.startsWith(`INCOMPLETE_RUN: ${counts}`) && jc.refused.message.endsWith('; a slot the candidate left without a grade, or with no record, is not split; the verdict stands and fails that case'), jc.refused.message);
      assert.equal(gateExitCode(r), 1, what);
      // The list reads the two baselines only, and is computed.
      assert.ok(r.judgeFlips !== undefined && !('refused' in r.judgeFlips), what);
    }
  });

  it('the ledger record of the gate holds the list as ids per class and the own-variation counts', () => {
    const t = flipTrio();
    const ledger = join(work, 'flips-ledger.jsonl');
    const r = cli('gate', '--baseline', put(t.rejudged), '--rejudge-of', put(t.original), '--candidate', put(t.candidate), '--bar', BAR, '--allow-differ', 'systemModelServed', '--ledger', ledger);
    assert.equal(r.status, 1, r.stderr);
    const rec = readLedger(ledger)[0];
    const jf = rec?.result['judgeFlips'] as Obj;
    const f = flipsOf(gateTrio(t));
    assert.deepEqual([jf['fold'], jf['drawsPerCase'], jf['packets'], jf['classes'], jf['ownVariation']], ['worst-of-N', 3, 'recorded', f.classes, f.ownVariation]);
    // On declared packets the record says so: it cannot be read as a list made on recorded ones.
    const d = flipTrio({ original: { packetBasis: 'declared' } });
    const declaredLedger = join(work, 'flips-ledger-declared.jsonl');
    assert.equal(cli('gate', '--baseline', put(d.rejudged), '--rejudge-of', put(d.original), '--candidate', put(d.candidate), '--bar', BAR, '--allow-differ', 'systemModelServed', '--ledger', declaredLedger).status, 1);
    assert.equal((readLedger(declaredLedger)[0]?.result['judgeFlips'] as Obj)['packets'], 'by declaration, not observed');
  });

  it('an original whose labels are not the bar\'s stops the gate as invalid input (65), whatever its packets and its judge\'s calls; with valid labels the same inputs give a verdict', () => {
    // A hand-worked fixture: the original's q03#1 holds the label "9", which the bar (1 to 5) does not have.
    const bad = (over: Partial<Parameters<typeof refundRun>[0]>) => flipTrio({ original: { grades: { ...OLD_GRADES, q03: ['4', '9', '4'] }, ...over } });
    const rows: [string, Partial<Parameters<typeof refundRun>[0]>][] = [
      ['recorded', {}],
      ['declared', { packetBasis: 'declared' }],
      ['unknown', { packetBasis: 'UNKNOWN' }],
      ['old judge 4xx', { grades: { ...OLD_GRADES, q03: ['4', '9', '4'], q04: ['2', '!client-error', '2'] } }],
    ];
    for (const [what, over] of rows) {
      const t = bad(over);
      const args = ['--rejudge-of', put(t.original), '--candidate', put(t.candidate), '--bar', BAR, '--allow-differ', 'systemModelServed'];
      const g = cli('gate', '--baseline', put(t.rejudged), ...args);
      assert.equal(g.status, 65, `${what}: ${g.stdout}${g.stderr}`);
      assert.match(g.stderr, /original baseline \(--rejudge-of\): .*"9"/, what);
      const v = cli('validate', '--run', put(t.candidate), '--bar', BAR, '--baseline', put(t.rejudged), '--rejudge-of', put(t.original), '--allow-differ', 'systemModelServed');
      assert.equal(v.status, 65, `validate, ${what}`);
    }
    const good = flipTrio({ original: { packetBasis: 'UNKNOWN' } });
    assert.equal(cli('gate', '--baseline', put(good.rejudged), '--rejudge-of', put(good.original), '--candidate', put(good.candidate), '--bar', BAR, '--allow-differ', 'systemModelServed').status, 1);
  });

  it('a slot the old judge holds no record of is refused by the admission of the re-judged baseline, before any list (ITEM_SET_MISMATCH)', () => {
    const r = gateTrio(flipTrio({ original: { grades: { ...OLD_GRADES, q03: ['4', '-', '4'] } } }));
    assert.ok(r.kind === 'refused');
    assert.deepEqual([r.refusal.code, [...r.refusal.fields]], ['ITEM_SET_MISMATCH', ['q03#1']]);
  });

  it('more than 30 flipped cases: the table is whole, each direction stops at 30 rows and says how many more are in --json', () => {
    const ids = Array.from({ length: 33 }, (_, i) => `q${String(i + 1).padStart(2, '0')}`);
    const old = Object.fromEntries(ids.map((id) => [id, ['4', '4']]));
    const neu = Object.fromEntries(ids.map((id) => [id, ['4', '3']]));
    const original = refundRun({ grades: old });
    const rejudged = refundRun({ grades: neu, identity: NEW_JUDGE });
    const candidate = refundRun({ grades: neu, identity: { ...NEW_JUDGE, ...SYSTEM_MOVED }, answer: newAnswer });
    const out = cli('gate', '--baseline', put(rejudged), '--rejudge-of', put(original), '--candidate', put(candidate), '--bar', BAR, '--allow-differ', 'systemModelServed').stdout;
    assert.match(out, /^ {2}pass -> fail \(33\):$/m);
    assert.match(out, /^ {4}and 3 more \(all in --json\)$/m);
    assert.equal(out.split('\n').filter((l) => /^ {4}reply_quality\/q\d\d {2}expect/.test(l)).length, 30);
  });

  it('on a stored-answer pair, the gate\'s list is judge-change\'s list under the worst rule, both directions, and judge-change\'s non-compensable counts are the gate\'s', () => {
    // judge-change reads one stored answer per case: q08's second answer is left out here.
    const oneAnswer = (id: string): string => `Your refund for order ${id} is on its way.`;
    const grades = (g: Record<string, string[]>) => Object.fromEntries(Object.entries(g).filter(([id]) => !['q05', 'q06', 'q07'].includes(id)));
    const original = refundRun({ grades: grades(OLD_GRADES), answer: oneAnswer });
    const rejudged = refundRun({ grades: grades(NEW_GRADES), answer: oneAnswer, identity: NEW_JUDGE });
    const f = flipsOf(gateRuns(rejudged, rejudged, REFUND_BAR, { rejudgeOf: original }));
    const bytes = (r: RunArtifact): Uint8Array => new TextEncoder().encode(JSON.stringify(r));
    const files: JudgeChangeInput[] = [{ name: 'old.json', bytes: bytes(original) }, { name: 'new.json', bytes: bytes(rejudged) }];
    const side = (id: RunIdentity): JudgeSide => ({ judgeDefinitionHash: id.judgeDefinitionHash, judgeModelRequested: id.judgeModelRequested, judgeModelServed: id.judgeModelServed, judgeCallShapeHash: id.judgeCallShapeHash, judgeHarnessVersion: id.judgeHarnessVersion, rubricHash: id.rubricHash });
    const plan: JudgeChangePlan = {
      schema: JUDGE_CHANGE_PLAN_SCHEMA, barHash: barHash(REFUND_BAR), caseSetHash: caseSetHash(original.cases), drawsPerCase: 3,
      judges: { old: side(original.identity), new: side(rejudged.identity) }, judgeMoves: ['judgeModelServed'],
      systems: { 'refund-bot': { old: sha256Hex(files[0]?.bytes as Uint8Array), new: sha256Hex(files[1]?.bytes as Uint8Array) } },
      storedOutputs: 'system-side-compared', measuredClass: 'reply_quality', cut: '4', drawSets: { estimate: [0, 1, 2] }, labelRule: 'worst', pooling: 'items-equal',
    };
    const { report, reading } = judgeChangeWithReading(files, REFUND_BAR, plan);
    const quality = f.classes.find((c) => c.klass === 'reply_quality');
    assert.deepEqual(report.flips.items.filter((x) => x.old && !x.new).map((x) => x.caseId), quality?.passToFail);
    assert.deepEqual(report.flips.items.filter((x) => !x.old && x.new).map((x) => x.caseId), quality?.failToPass);
    const strict = f.classes.find((c) => c.klass === 'refund_policy');
    const byClass = reading.byClass.find((c) => c.klass === 'refund_policy');
    assert.deepEqual([byClass?.passToFail.map((x) => x.split('/')[1]), byClass?.failToPass.map((x) => x.split('/')[1])], [strict?.passToFail, strict?.failToPass]);
  });
});

describe('the gate candidate\'s cases with a slot that holds no grade', () => {
  it('leave "missing cases:" for a line of their own, with their counts; the JSON and the exit code are as before', () => {
    const b = refundRun({ grades: FOUR });
    const c = refundRun({ grades: { ...FOUR, q02: ['4', '!parse-failure', '4'] }, identity: SYSTEM_MOVED, answer: newAnswer });
    const r = cli('gate', '--baseline', put(b), '--candidate', put(c), '--bar', BAR, '--allow-differ', 'systemModelServed');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^cases with a slot that holds no grade \(candidate: 1 of 9 slots in 1 of 3 cases, parse-failure 1\): q02$/m);
    assert.doesNotMatch(r.stdout, /^missing cases:/m);
    const j = json(cli('gate', '--baseline', put(b), '--candidate', put(c), '--bar', BAR, '--allow-differ', 'systemModelServed', '--json').stdout);
    assert.deepEqual([(j['gate'] as Obj)['missingCaseIds'], j['exitCode']], [['q02'], 1]);
  });
});

describe('judge-change: the counts beside the report, and a report that does not move', () => {
  // Two systems, A and B; the measured class reply_quality and the non-compensable refund_policy; six draws, the
  // estimate set 0-2 and the re-ask set 3-5; majority labels on the estimate set (2 or 3 passing draws of 3 pass).
  //
  //   item    old judge, estimate (re-ask)   label   new judge, estimate (re-ask)   label   old -> new
  //   A/q01   4 4 4 (4 4 4)                  P       4 4 4 (4 4 4)                  P       -
  //   A/q02   4 3 4 (3 3 4)                  P (F)   3 3 3 (3 3 3)                  F (F)   pass -> fail
  //   A/q03   3 3 3 (3 3 3)                  F       4 4 3 (4 4 4)                  P (P)   fail -> pass
  //   B/q01   4 4 4 (4 4 4)                  P       2 2 2 (2 2 2)                  F       pass -> fail
  //   B/q02   4 4 2 (4 4 4)                  P (P)   4 4 4 (4 4 4)                  P       -
  //   B/q03   3 4 3 (4 4 3)                  F (P)   3 3 4 (3 3 3)                  F (F)   -
  //
  // directions: pass -> fail 2 (A/q02, B/q01), fail -> pass 1 (A/q03), of 6 items; per system A 1 and 1, B 1 and 0.
  // own variation, estimate draws split: old A/q02, B/q02, B/q03 = 3 of 6; new A/q03, B/q03 = 2 of 6.
  // labels that differ between a judge's two sets: old A/q02 (P vs F), B/q03 (F vs P) = 2; new 0. (2 + 0) / (2 x 6) = 1/6.
  // refund_policy, worst of every draw: A/p1 old 444444 (pass) -> new 444424 (fail): pass -> fail 1; B/p1 555555 both.
  const OLD = { A: { q01: '444444', q02: '434334', q03: '333333', p1: '444444' }, B: { q01: '444444', q02: '442444', q03: '343443', p1: '555555' } };
  const NEW = { A: { q01: '444444', q02: '333333', q03: '443444', p1: '444424' }, B: { q01: '222222', q02: '444444', q03: '334333', p1: '555555' } };
  const sys = (s: 'A' | 'B'): Partial<RunIdentity> => ({ systemModelServed: `system-${s}` });
  const runOf = (g: Record<string, string>, s: 'A' | 'B', judge: Partial<RunIdentity>) => refundRun({ grades: Object.fromEntries(Object.entries(g).map(([id, x]) => [id, [...x]])), identity: { ...judge, ...sys(s) }, answer: (id) => `${s}: your refund for order ${id} is on its way.` });
  const runs = { Aold: runOf(OLD.A, 'A', OLD_JUDGE), Anew: runOf(NEW.A, 'A', NEW_JUDGE), Bold: runOf(OLD.B, 'B', OLD_JUDGE), Bnew: runOf(NEW.B, 'B', NEW_JUDGE) };
  const files: JudgeChangeInput[] = Object.entries(runs).map(([k, r]) => ({ name: `${k}.json`, bytes: new TextEncoder().encode(JSON.stringify(r)) }));
  const sha = (k: string): string => sha256Hex((files.find((f) => f.name === `${k}.json`) as JudgeChangeInput).bytes);
  const side = (id: RunIdentity): JudgeSide => ({ judgeDefinitionHash: id.judgeDefinitionHash, judgeModelRequested: id.judgeModelRequested, judgeModelServed: id.judgeModelServed, judgeCallShapeHash: id.judgeCallShapeHash, judgeHarnessVersion: id.judgeHarnessVersion, rubricHash: id.rubricHash });
  const plan = (over: Partial<JudgeChangePlan> = {}): JudgeChangePlan => ({
    schema: JUDGE_CHANGE_PLAN_SCHEMA, barHash: barHash(REFUND_BAR), caseSetHash: caseSetHash(runs.Aold.cases), drawsPerCase: 6,
    judges: { old: side(runs.Aold.identity), new: side(runs.Anew.identity) }, judgeMoves: ['judgeModelServed'],
    systems: { A: { old: sha('Aold'), new: sha('Anew') }, B: { old: sha('Bold'), new: sha('Bnew') } },
    storedOutputs: 'system-side-compared', measuredClass: 'reply_quality', cut: '4', drawSets: { estimate: [0, 1, 2], reask: [3, 4, 5] }, labelRule: 'majority', pooling: 'items-equal', ...over,
  });

  it('the direction counts sum to the flipped items, overall and per system; byClass puts the non-compensable class first (a hand-worked fixture)', () => {
    const { report, reading } = judgeChangeWithReading(files, REFUND_BAR, plan());
    assert.deepEqual(report.flips.items.map((x) => `${x.system}/${x.caseId}`), ['A/q02', 'A/q03', 'B/q01']);
    assert.deepEqual(reading.directions, { passToFail: 2, failToPass: 1, items: 6 });
    assert.equal(reading.directions.passToFail + reading.directions.failToPass, report.flips.items.length);
    assert.deepEqual(reading.perSystem, [{ system: 'A', passToFail: 1, failToPass: 1, items: 3 }, { system: 'B', passToFail: 1, failToPass: 0, items: 3 }]);
    assert.deepEqual(reading.byClass, [
      { klass: 'refund_policy', nonCompensable: true, labelledBy: 'worst of every draw', passToFail: ['A/p1'], failToPass: [] },
      { klass: 'reply_quality', nonCompensable: false, labelledBy: 'majority', passToFail: ['A/q02', 'B/q01'], failToPass: ['A/q03'] },
    ]);
    assert.deepEqual(reading.ownVariation, { old: { split: 3, items: 6 }, new: { split: 2, items: 6 }, set: 'estimate' });
    assert.deepEqual(reading.withinJudgeCounts, { old: 2, new: 0, items: 6 });
    const w = reading.withinJudgeCounts;
    assert.equal(report.flips.withinJudge, (w.old + w.new) / (2 * w.items));
  });

  it('the report itself gains no key: the report a recorded run made stays that run\'s report, and its notes are as they were', () => {
    const report = judgeChangeRuns(files, REFUND_BAR, plan());
    assert.deepEqual(Object.keys(report), ['kind', 'tool', 'contracts', 'planHash', 'barHash', 'inputs', 'labelRule', 'measuredClass', 'cut', 'drawSets', 'judges', 'notCompared', 'packetEquality', 'counts', 'perDrawPassRate', 'labelPassRate', 'flips', 'perSystem', 'nonCompensable', 'nonCompensableClasses', 'notMeasuredClasses', 'blocks', 'reference', 'gate', 'spread', 'map', 'notes']);
    assert.deepEqual(Object.keys(report.flips), ['rule', 'acrossJudges', 'withinJudge', 'beyondReask', 'items']);
    assert.deepEqual(Object.keys(report.perSystem[0] as object), ['system', 'items', 'perDrawPassRate', 'labelPassRate', 'flipsAcrossJudges']);
    assert.ok(report.notes.includes('which judge is right is not measured'));
    assert.deepEqual(judgeChangeWithReading(files, REFUND_BAR, plan()).report, report);
  });

  it('the text: the counts under the shares, the non-compensable block before the items, and the two sentences as its last notes', () => {
    const dir = join(work, 'jc');
    mkdirSync(dir);
    for (const f of files) writeFileSync(join(dir, f.name), f.bytes);
    const planPath = join(work, 'jc-plan.json');
    writeFileSync(planPath, JSON.stringify(plan()));
    const r = cli('judge-change', '--plan', planPath, '--bar', BAR, '--inputs', dir);
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout;
    assert.match(out, /^ {2}in each direction, never netted: pass -> fail 2 · fail -> pass 1 \(of 6 items\)$/m);
    assert.match(out, /^ {2}as counts: old judge 2 of 6 items, new judge 0 of 6 items differ between their two sets$/m);
    assert.match(out, /^the judge's own variation: items whose estimate draws split between pass and fail: old judge 3 of 6 · new judge 2 of 6$/m);
    assert.match(out, /^ {2}refund_policy: pass -> fail 1 · fail -> pass 0, worst of every draw$/m);
    assert.match(out, /^items whose label differs between the judges \(3: pass -> fail 2, fail -> pass 1\):$/m);
    assert.ok(out.indexOf('non-compensable classes (') < out.indexOf('items whose label differs'), out);
    assert.ok(out.trimEnd().endsWith(`note: ${AGREEMENT_SENTENCE}\nnote: ${AS_DECLARED_SENTENCE}`), out);
    // The JSON is the report, unchanged.
    const j = json(cli('judge-change', '--plan', planPath, '--bar', BAR, '--inputs', dir, '--json').stdout);
    assert.deepEqual(j, JSON.parse(JSON.stringify(judgeChangeRuns(files, REFUND_BAR, plan()))));
    // Six draws in one estimate set and no re-ask set: the shares read "not measured", and no count of a second set is printed.
    writeFileSync(planPath, JSON.stringify(plan({ drawSets: { estimate: [0, 1, 2, 3, 4, 5] }, labelRule: 'worst' })));
    const noReask = cli('judge-change', '--plan', planPath, '--bar', BAR, '--inputs', dir);
    assert.equal(noReask.status, 0, noReask.stderr);
    assert.match(noReask.stdout, /^labels that differ between two sets of one judge \(worst\) +not measured \(the plan declares no re-ask set\)$/m);
    assert.doesNotMatch(noReask.stdout, /as counts:/);
  });

  it('a refusal on slots that hold no grade keeps its code and fields, and carries the counts of every run file, by system and judge', () => {
    // A's new judge: q02#4 parse-failure, q03#1 truncated. 2 of 24 slots (4 cases x 6 draws). Every other run file 0 of 24.
    const broken = runOf(NEW.A, 'A', NEW_JUDGE);
    const edited: RunArtifact = { ...broken, draws: broken.draws.map((d) => (d.caseId === 'q02' && d.drawIndex === 4 ? { ...d, attempts: [judgeRetry('q02', 'truncated', 'A: your refund for order q02 is on its way.')].map((a) => ({ ...a, reason: 'parse-failure' }) as never) } : d.caseId === 'q03' && d.drawIndex === 1 ? { ...d, attempts: [judgeRetry('q03', 'truncated', 'A: your refund for order q03 is on its way.')] } : d)) };
    const dir = join(work, 'jc-broken');
    mkdirSync(dir);
    const all = { ...runs, Anew: edited };
    const fs = Object.entries(all).map(([k, r]) => ({ name: `${k}.json`, bytes: new TextEncoder().encode(JSON.stringify(r)) }));
    for (const f of fs) writeFileSync(join(dir, f.name), f.bytes);
    const p = { ...plan(), systems: { A: { old: sha('Aold'), new: sha256Hex((fs.find((f) => f.name === 'Anew.json') as JudgeChangeInput).bytes) }, B: { old: sha('Bold'), new: sha('Bnew') } } };
    const planPath = join(work, 'jc-broken-plan.json');
    writeFileSync(planPath, JSON.stringify(p));
    assert.throws(() => judgeChangeRuns(fs, REFUND_BAR, p), (e: unknown) => e instanceof RefusalError && e.code === 'INCOMPLETE_RUN' && e.fields.join() === 'A/q02#4 (new judge: judge parse-failure),A/q03#1 (new judge: judge truncated)');
    const r = cli('judge-change', '--plan', planPath, '--bar', BAR, '--inputs', dir, '--json');
    assert.equal(r.status, 2);
    const o = json(r.stdout);
    assert.deepEqual([o['schema'], o['command'], o['code'], o['fields'], o['exitCode']], ['anchorset.refusal/v2', 'judge-change', 'INCOMPLETE_RUN', ['A/q02#4 (new judge: judge parse-failure)', 'A/q03#1 (new judge: judge truncated)'], 2]);
    const rows = o['noGrade'] as Obj[];
    assert.deepEqual(rows.map((x) => [x['system'], x['role'], x['run'], x['slots'], x['of']]), [['A', 'old-judge', 'Aold.json', 0, 24], ['A', 'new-judge', 'Anew.json', 2, 24], ['B', 'old-judge', 'Bold.json', 0, 24], ['B', 'new-judge', 'Bnew.json', 0, 24]]);
    assert.deepEqual(rows[1]?.['byReason'], [{ role: 'judge', reason: 'parse-failure', slots: 1 }, { role: 'judge', reason: 'truncated', slots: 1 }]);
    assert.deepEqual(rows[1]?.['judge'], { requested: 'example-judge', served: 'example-judge-2026-06-01' });
    const text = cli('judge-change', '--plan', planPath, '--bar', BAR, '--inputs', dir);
    assert.match(text.stderr, /^ {2}A +new-judge +example-judge-2026-06-01 +2 of 24 +judge parse-failure 1, judge truncated 1$/m);
  });
});

describe('validate: the no-grade counts of every run it reads, the judge diff, the judge-flip status, and its kind', () => {
  it('counts each run\'s slots by role and reason, with the served judge and the judge\'s retries, and reports kind "preflight"', () => {
    // 3 cases x 3 draws = 9 slots each. Run (candidate): q01#0 judge parse-failure. Baseline (re-judged): q02#2
    // content-filter, and q02#1 asked again once after a timeout, then graded. Rejudge-of (original): q01#1 a judge
    // reply cut at its cap. Each run: 1 of 9; only the baseline's grading asked again (1 of 9 slots, timeout 1).
    const original = refundRun({ grades: { ...FOUR, q01: ['4', '!truncated', '4'] } });
    const rejudged = refundRun({ grades: { ...FOUR, q02: ['4', '4', '!content-filter'] }, identity: NEW_JUDGE, retries: { 'q02#1': [judgeRetry('q02', 'timeout')] } });
    const cand = refundRun({ grades: { ...FOUR, q01: ['!parse-failure', '4', '4'] }, identity: { ...NEW_JUDGE, ...SYSTEM_MOVED }, answer: newAnswer });
    const args = ['validate', '--run', put(cand), '--bar', BAR, '--baseline', put(rejudged), '--rejudge-of', put(original), '--allow-differ', 'systemModelServed'];
    const r = cli(...args, '--json');
    assert.equal(r.status, 2);
    const j = json(r.stdout);
    assert.equal(j['kind'], 'preflight');
    const rows = j['noGradeByRun'] as Obj[];
    assert.deepEqual(rows.map((x) => [x['run'], (x['judge'] as Obj)['served'], x['slots'], x['of'], x['byReason']]), [
      ['run', 'example-judge-2026-06-01', 1, 9, [{ role: 'judge', reason: 'parse-failure', slots: 1 }]],
      ['baseline', 'example-judge-2026-06-01', 1, 9, [{ role: 'judge', reason: 'content-filter', slots: 1 }]],
      ['rejudge-of', 'example-judge-2026-01-15', 1, 9, [{ role: 'judge', reason: 'truncated', slots: 1 }]],
    ]);
    assert.deepEqual((rows[1] as Obj)['judgeRetries'], { slotsWithRetry: 1, slots: 9, earlierAttemptsByReason: [{ reason: 'timeout', attempts: 1 }] });
    const refusal = ((j['gate'] as Obj)['refusals'] as Obj[])[0] as Obj;
    assert.deepEqual([refusal['code'], refusal['fields']], ['INCOMPLETE_RUN', ['q02#2']]);
    assert.equal(((refusal['noGrade'] as Obj[])[0] as Obj)['role'], 're-judged baseline');
    assert.deepEqual(j['judgeFlips'], { status: 'not checked', why: 'gate refuses before it computes the judge-flip list' });
    assert.deepEqual(j['statements'], [AGREEMENT_SENTENCE, AS_DECLARED_SENTENCE]);
    const t = cli(...args);
    assert.match(t.stdout, /^slots that hold no grade, per run \(counted; never a pass, a fail or a flip\):$/m);
    assert.match(t.stdout, /^ {2}baseline +example-judge-2026-06-01 +1 of 9 +judge content-filter 1 +1 of 9 slots \(earlier attempts: timeout 1\)$/m);
    assert.match(t.stdout, /^ {2}rejudge-of +example-judge-2026-01-15 +1 of 9 +judge truncated 1 +0 of 9 slots$/m);
    assert.ok(t.stdout.includes(`${AGREEMENT_SENTENCE}\n${AS_DECLARED_SENTENCE}\nresult: NOT READY for gate (exit 2)\n`), t.stdout);
  });

  it('a judge that moved: the judge diff stands under the refusal entry, with the next commands built from validate\'s own flags', () => {
    const base = refundRun({ grades: FOUR });
    const cand = refundRun({ grades: FOUR, identity: { ...NEW_JUDGE, ...SYSTEM_MOVED }, answer: newAnswer });
    const b = put(base, 'baseline.json');
    const c = put(cand, 'candidate.json');
    const j = json(cli('validate', '--run', c, '--bar', BAR, '--baseline', b, '--allow-differ', 'systemModelServed', '--json').stdout);
    const refusal = ((j['gate'] as Obj)['refusals'] as Obj[])[0] as Obj;
    assert.deepEqual([refusal['code'], refusal['fields']], ['IDENTITY_MISMATCH', ['judgeModelServed']]);
    const next = (refusal['judgeDiff'] as Obj)['next'] as string[];
    assert.equal(next[2], `anchorset gate --baseline ${b.replace(/\.json$/, '.rejudged.json')} --rejudge-of ${b} --candidate ${c} --bar ${BAR} --allow-differ systemModelServed`);
    assert.equal(refusal['statements'], undefined, 'the sentences stand once, at the top of the report');
    const t = cli('validate', '--run', c, '--bar', BAR, '--baseline', b, '--allow-differ', 'systemModelServed');
    assert.match(t.stdout, /^ {6}model served {7}example-judge-2026-01-15 -> example-judge-2026-06-01 +DIFFERS$/m);
  });

  it('the judge-flip status line: computed where the gate computes it, and the packet refusal where it does not', () => {
    const t = flipTrio({ original: { grades: { ...OLD_GRADES, q05: ['4', '4', '4'], q06: ['4', '4', '4'], q07: ['4', '4', '4'] } } });
    const args = ['validate', '--run', put(t.candidate), '--bar', BAR, '--baseline', put(t.rejudged), '--allow-differ', 'systemModelServed'];
    const ok = cli(...args, '--rejudge-of', put(t.original));
    assert.equal(ok.status, 0, ok.stdout);
    assert.match(ok.stdout, /^ {2}judge flips {4}computed$/m);
    const declared = cli(...args, '--rejudge-of', put({ ...t.original, packetBasis: 'declared', packetSource: 'the rendered grading prompt of the refund-bot eval' }));
    assert.match(declared.stdout, /^ {2}judge flips {4}computed \(packets equal by declaration, not observed\)$/m);
    const declaredJson = json(cli(...args, '--rejudge-of', put({ ...t.original, packetBasis: 'declared', packetSource: 'the rendered grading prompt of the refund-bot eval' }), '--json').stdout);
    assert.deepEqual(declaredJson['judgeFlips'], { status: 'computed', packets: 'by declaration, not observed' });
    assert.deepEqual(json(cli(...args, '--rejudge-of', put(t.original), '--json').stdout)['judgeFlips'], { status: 'computed', packets: 'recorded' });
    assert.match(declared.stdout, /^ {2}split {10}not computed: PACKET_MISMATCH packetBasis \(original baseline \(--rejudge-of\)\); the verdict is not affected$/m);
    const unknown = cli(...args, '--rejudge-of', put(flipTrio({ original: { packetBasis: 'UNKNOWN' } }).original));
    assert.match(unknown.stdout, /^ {2}judge flips {4}not computed: PACKET_MISMATCH packetBasis \(original baseline \(--rejudge-of\)\); the verdict is not affected$/m);
    // Where gate refuses first, each admission is still read: declared packets would be computed, so only the split is named.
    const gapped = refundRun({ grades: NEW_GRADES, answer: newAnswer, identity: { ...NEW_JUDGE, ...SYSTEM_MOVED, seed: GAP } });
    const j = json(cli('validate', '--run', put(gapped), '--bar', BAR, '--baseline', put(t.rejudged), '--allow-differ', 'systemModelServed', '--rejudge-of', put({ ...t.original, packetBasis: 'declared', packetSource: 'the rendered grading prompt of the refund-bot eval' }), '--json').stdout);
    assert.deepEqual([(j['split'] as Obj)['status'], j['judgeFlips']], ['not computed', { status: 'not checked', why: 'gate refuses before it computes the judge-flip list' }]);
  });
});

describe('the one-draw wording of the judge-flip list', () => {
  it('is the library\'s constant', () => {
    assert.equal(ONE_DRAW_OWN_VARIATION, 'not measured (one draw per case)');
    assert.equal(AGREEMENT_SENTENCE_WITH_REFERENCE, 'Agreement between judges is not evidence of correctness; the reference labels were compared as given, and anchorset does not know how they were made.');
    assert.equal(callShapeHash(makeJudgeCallShape()), refundRun({ grades: FOUR }).identity.judgeCallShapeHash);
  });
});
