// Say what was measured, never what it means. Every command this file runs prints, in text and under --json, no word
// that reads a measurement as a verdict on a judge, a system or a switch: the list is below. It scans the tool's own
// text on neutral data (the fixtures hold none of the words), and it never filters what a user's files hold. One
// sentence is kept word for word, and is the one allowed use of its phrase: the judge-change note "which judge is right
// is not measured", which the study's recorded first-run reports carry. Each output that sets two judges side by side,
// or refuses on a judge or on slots that hold no grade, also holds the two fixed sentences. Synthetic data only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { caseSetHash } from '../src/artifact.ts';
import { barHash } from '../src/gate.ts';
import { GAP, hashOf, sha256Hex } from '../src/identity.ts';
import type { RunIdentity } from '../src/identity.ts';
import { AGREEMENT_SENTENCE, AS_DECLARED_SENTENCE, JUDGE_CHANGE_PLAN_SCHEMA } from '../src/judgechange.ts';
import type { JudgeChangePlan, JudgeSide } from '../src/judgechange.ts';
import { MINI_JUDGE, NEW_JUDGE, REFUND_BAR, refundRun } from './helpers.ts';

const root = join(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'anchorset-wording-'));
after(() => rmSync(work, { recursive: true, force: true }));
const cli = (...args: string[]) => spawnSync(process.execPath, [join(root, 'src', 'cli.ts'), ...args], { encoding: 'utf8', cwd: root });
let n = 0;
const put = (x: unknown, name = 'run.json'): string => {
  const dir = join(work, `w-${(n += 1)}`);
  mkdirSync(dir);
  writeFileSync(join(dir, name), JSON.stringify(x));
  return join(dir, name);
};

/** The words no output prints, matched as words and in any case. */
const FORBIDDEN = ['safe', 'safely', 'safety', 'equivalent', 'equivalence', 'interchangeable', 'within tolerance', 'validated', 'compliant', 'compliance', 'certified', 'audit-ready', 'the gate still holds', 'which judge is right', 'better judge'];
/** The one sentence kept as the study's first runs print it. */
const KEPT = 'which judge is right is not measured';
const forbidden = new RegExp(`(?<![\\w-])(?:${FORBIDDEN.map((w) => w.replace(/[-]/g, '\\-').replace(/ /g, '\\s+')).join('|')})(?![\\w-])`, 'gi');
const offending = (text: string): string[] => [...text.replaceAll(KEPT, '').matchAll(forbidden)].map((m) => m[0]);

test('the pattern finds each word as a word, in any case, and nothing inside another word', () => {
  for (const w of FORBIDDEN) assert.deepEqual(offending(`a ${w.toUpperCase()} b`), [w.toUpperCase()], w);
  assert.deepEqual(offending('is_safe_flag unsafe safeguards validate equivalently'), []);
  assert.deepEqual(offending(`note: ${KEPT}`), []);
  assert.deepEqual(offending('we know which judge is right'), ['which judge is right']);
});

const BAR = put(REFUND_BAR, 'bar.json');
const FOUR = { q01: ['4', '4', '4'], q02: ['4', '4', '4'], p1: ['4', '4', '4'] };
const moved: Partial<RunIdentity> = { systemModelServed: 'model-x-2026-06-01' };
const newAnswer = (id: string): string => `Your refund for order ${id} was sent today.`;
const OLD_GRADES = { p1: ['4', '4', '4'], q01: ['4', '4', '4'], q02: ['3', '4', '4'], q03: ['!parse-failure', '4', '4'], q04: ['4', '3', '4'] };
const NEW_GRADES = { p1: ['4', '3', '4'], q01: ['3', '4', '4'], q02: ['4', '4', '4'], q03: ['4', '4', '4'], q04: ['4', '3', '3'] };
const twoAnswers = (id: string, d: number): string => (id === 'q04' && d === 1 ? 'Your refund for order q04 was declined.' : `Your refund for order ${id} is on its way.`);

type Out = { what: string; text: string; sentences: boolean };
function outputs(): Out[] {
  const out: Out[] = [];
  const both = (what: string, sentences: boolean, ...args: string[]): void => {
    const t = cli(...args);
    out.push({ what: `${what} (text)`, text: t.stdout + t.stderr, sentences });
    const j = cli(...args, '--json');
    out.push({ what: `${what} (--json)`, text: j.stdout + j.stderr, sentences });
  };
  const base = put(refundRun({ grades: FOUR }));
  // The judge refusals.
  for (const [what, identity] of [
    ['served moved', NEW_JUDGE], ['cheaper judge', { ...MINI_JUDGE, judgeDefinitionHash: hashOf('judge prompt v2') }], ['rubric only', { rubricHash: hashOf('rubric v2') }],
    ['unknown judge field', { judgeModelServed: GAP }], ['gap and difference', { ...NEW_JUDGE, judgeHarnessVersion: GAP }], ['also differ', { ...NEW_JUDGE, systemPromptHash: hashOf('prompt v2') }],
  ] as const) {
    both(`gate refusal: ${what}`, true, 'gate', '--baseline', base, '--candidate', put(refundRun({ grades: FOUR, identity })), '--bar', BAR);
  }
  // The no-grade refusals.
  both('gate refusal: incomplete baseline', true, 'gate', '--baseline', put(refundRun({ grades: { ...FOUR, q01: ['4', '!parse-failure', '-'] } })), '--candidate', base, '--bar', BAR);
  both('flips refusal: incomplete run', true, 'flips', '--run', put(refundRun({ grades: { ...FOUR, q01: ['4', '!content-filter', '4'] } })));
  both('gate refusal: no answer', false, 'gate', '--baseline', put(refundRun({ grades: { ...FOUR, q01: ['4', 'E', '4'] } })), '--candidate', base, '--bar', BAR);
  // The judge-flip list, computed (three draws, with a no-grade case and a case of two answers), refused, and on one draw.
  const original = refundRun({ grades: OLD_GRADES, answer: twoAnswers });
  const rejudged = put(refundRun({ grades: NEW_GRADES, answer: twoAnswers, identity: NEW_JUDGE }));
  const candidate = put(refundRun({ grades: NEW_GRADES, answer: newAnswer, identity: { ...NEW_JUDGE, ...moved } }));
  const gateFlips = (o: unknown): string[] => ['gate', '--baseline', rejudged, '--rejudge-of', put(o), '--candidate', candidate, '--bar', BAR, '--allow-differ', 'systemModelServed'];
  both('gate --rejudge-of: the list', true, ...gateFlips(original));
  both('gate --rejudge-of: declared packets', false, ...gateFlips({ ...original, packetBasis: 'declared', packetSource: 'the rendered grading prompt of the refund-bot eval' }));
  both('gate --rejudge-of: a 4xx of the old judge', false, ...gateFlips(refundRun({ grades: { ...OLD_GRADES, q01: ['4', '!client-error', '4'] }, answer: twoAnswers })));
  const one = { q01: ['4'], q02: ['3'], p1: ['4'] };
  both('gate --rejudge-of: one draw', true, 'gate', '--baseline', put(refundRun({ grades: { ...one, q01: ['3'] }, identity: NEW_JUDGE })), '--rejudge-of', put(refundRun({ grades: one })), '--candidate', put(refundRun({ grades: one, identity: { ...NEW_JUDGE, ...moved }, answer: newAnswer })), '--bar', BAR, '--allow-differ', 'systemModelServed');
  both('gate: a candidate case with no grade', false, 'gate', '--baseline', base, '--candidate', put(refundRun({ grades: { ...FOUR, q02: ['4', '!timeout', '4'] }, identity: moved, answer: newAnswer })), '--bar', BAR, '--allow-differ', 'systemModelServed');
  // validate, against itself, against a moved judge, and with a re-judged baseline.
  both('validate: itself', true, 'validate', '--run', base, '--bar', BAR);
  both('validate: a moved judge', true, 'validate', '--run', put(refundRun({ grades: FOUR, identity: NEW_JUDGE })), '--bar', BAR, '--baseline', base);
  both('validate: --rejudge-of', true, 'validate', '--run', candidate, '--bar', BAR, '--baseline', rejudged, '--rejudge-of', put(original), '--allow-differ', 'systemModelServed');
  // judge-change: the committed example (a reference, a map, a spread), a plain pair, and a refusal on a slot.
  const e = join(root, 'examples', 'judge-change');
  out.push({ what: 'judge-change: the example (text)', text: cli('judge-change', '--plan', join(e, 'plan.json'), '--bar', join(e, 'bar.json'), '--inputs', join(e, 'runs')).stdout, sentences: true });
  out.push({ what: 'judge-change: the example (--json)', text: cli('judge-change', '--plan', join(e, 'plan.json'), '--bar', join(e, 'bar.json'), '--inputs', join(e, 'runs'), '--json').stdout, sentences: false });
  const jc = (newGrades: Record<string, string[]>): string[] => {
    const old = refundRun({ grades: { q01: ['4', '4', '4'], q02: ['3', '4', '4'], p1: ['4', '4', '4'] } });
    const neu = refundRun({ grades: newGrades, identity: NEW_JUDGE });
    const dir = join(work, `jc-${(n += 1)}`);
    mkdirSync(dir);
    const bytes = (x: unknown): string => JSON.stringify(x);
    writeFileSync(join(dir, 'old.json'), bytes(old));
    writeFileSync(join(dir, 'new.json'), bytes(neu));
    const side = (id: RunIdentity): JudgeSide => ({ judgeDefinitionHash: id.judgeDefinitionHash, judgeModelRequested: id.judgeModelRequested, judgeModelServed: id.judgeModelServed, judgeCallShapeHash: id.judgeCallShapeHash, judgeHarnessVersion: id.judgeHarnessVersion, rubricHash: id.rubricHash });
    const plan: JudgeChangePlan = {
      schema: JUDGE_CHANGE_PLAN_SCHEMA, barHash: barHash(REFUND_BAR), caseSetHash: caseSetHash(old.cases), drawsPerCase: 3, judges: { old: side(old.identity), new: side(neu.identity) }, judgeMoves: ['judgeModelServed'],
      systems: { 'refund-bot': { old: sha256Hex(bytes(old)), new: sha256Hex(bytes(neu)) } }, storedOutputs: 'system-side-compared', measuredClass: 'reply_quality', cut: '4', drawSets: { estimate: [0, 1, 2] }, labelRule: 'majority', pooling: 'items-equal',
    };
    const planPath = join(dir, 'plan.json');
    writeFileSync(planPath, JSON.stringify(plan));
    return ['judge-change', '--plan', planPath, '--bar', BAR, '--inputs', dir];
  };
  out.push({ what: 'judge-change: a plain pair (text)', text: cli(...jc({ q01: ['4', '3', '4'], q02: ['4', '4', '4'], p1: ['4', '4', '3'] })).stdout, sentences: true });
  both('judge-change refusal: a slot with no grade', true, ...jc({ q01: ['4', '!parse-failure', '4'], q02: ['4', '4', '4'], p1: ['4', '4', '4'] }));
  return out;
}

let cached: Out[] | undefined;
const touched = (): Out[] => (cached ??= outputs());

test('no output of a touched command holds a forbidden word, in text or under --json; the one kept sentence aside', () => {
  const all = touched();
  assert.equal(all.length, 39);
  const found = all.flatMap((o) => offending(o.text).map((w) => `${o.what}: "${w}"`));
  assert.deepEqual(found, []);
  // Every output was printed: none of them is empty.
  for (const o of all) assert.ok(o.text.trim().length > 0, o.what);
});

test('each output that sets two judges side by side, or refuses on a judge or on slots that hold no grade, holds both fixed sentences exactly', () => {
  for (const o of touched().filter((x) => x.sentences)) {
    assert.ok(o.text.includes(AGREEMENT_SENTENCE) || o.text.includes('Agreement between judges is not evidence of correctness; the reference labels were compared as given'), `${o.what}: the first sentence`);
    assert.ok(o.text.includes(AS_DECLARED_SENTENCE), `${o.what}: the second sentence`);
  }
});
