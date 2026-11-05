// One grade per answer (drawsPerCase 1): the wording each command adds, and that no JSON contract moves with it. What
// this file pins: the gate's line under its table and its "draw #N" rows appear exactly when both runs hold one draw per
// case, and its --json report is the same object either way; the line in the judge-controlled block; the flips refusal,
// whose code and fields are unchanged and whose message says what to do; the judge-flip list of `gate --rejudge-of`,
// folded from the one draw, with the judges' own variation "not measured (one draw per case)"; and judge-change's text
// "not measured (one draw per case)" where its JSON still says "not declared". Text only: no statistic. Fixtures are synthetic (a refund bot),
// written through write-run and the example plan helper.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const root = join(import.meta.dirname, '..');
const cli = join(root, 'src', 'cli.ts');
const work = mkdtempSync(join(tmpdir(), 'anchorset-one-draw-'));
after(() => rmSync(work, { recursive: true, force: true }));
const node = (script: string, args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: root });
const run = (args: string[]) => node(cli, args);
const sha256 = (x: string): string => createHash('sha256').update(x).digest('hex');
const BAR = join(root, 'examples', 'run-format', 'bar.json');
const LINE = "draws per case: 1 — each case's result is one draw; whether it repeats is not measured (flips needs at least two draws per case)";
const SPLIT = "  one draw per case: both effects include the judge's own repeat variation, which one draw cannot measure";
const WITHIN = 'not measured (one draw per case)';

type Obj = Record<string, unknown>;
const SENT = { sent: { endpoint: 'example-provider:messages', temperature: 0, maxOutputTokens: 512 }, everyOtherKey: 'NOT_SENT' };
const SYSTEM = { modelRequested: 'bot-model', modelServed: 'bot-model-2026-01-15', prompt: { json: 'shop assistant' }, tools: { json: [] }, harnessVersion: 'refund-eval 1.4.0', settings: SENT };
const JUDGE = { modelRequested: 'judge-model', modelServed: 'judge-model-2026-02-01', definition: { json: 'grade 1 to 5' }, harnessVersion: 'refund-eval 1.4.0', settings: SENT, gradedReplyStop: 'end' };
const IDS = ['q01', 'q02', 'q03', 'q04'];
const manifest = (over: Obj = {}): Obj => ({
  schema: 'anchorset.run-input/v1', origin: 'produced', graded: 'by-judge', bar: BAR, caseCount: IDS.length, sameForEveryCase: { class: 'reply_quality' }, expectByClass: { reply_quality: '4' },
  rubric: { json: 'reply quality' }, seed: 'NO_SEED', system: SYSTEM, judge: JUDGE, packets: { basis: 'recorded' }, ...over,
});
/** One row per answer, or `draws` rows per case; `grades` gives each case's grade. */
const rows = (grades: Record<string, string>, answer = (id: string) => `Reply to ${id}.`, draws = 0): Obj[] =>
  IDS.flatMap((id) => (draws === 0 ? [undefined] : Array.from({ length: draws }, (_, d) => d)).map((d) => ({
    case: id, ...(d === undefined ? {} : { draw: d }), grade: grades[id] ?? '4', answer: answer(id), stop: 'end', input: { message: `question ${id}` }, packetHash: sha256(`packet ${answer(id)}`),
  })));
let n = 0;
function write(m: Obj, rs: readonly Obj[], name = 'run.json'): string {
  const dir = join(work, `w-${(n += 1)}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
  writeFileSync(join(dir, 'grades.jsonl'), `${rs.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const out = join(dir, name);
  const r = run(['write-run', '--manifest', join(dir, 'manifest.json'), '--grades', join(dir, 'grades.jsonl'), '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  return out;
}
const moved = { system: { ...SYSTEM, modelServed: 'bot-model-2026-06-01' } };

describe('gate on one draw per case', () => {
  const base = write(manifest(), rows({}));
  const cand = write(manifest(moved), rows({ q02: '2' }, (id) => `New reply to ${id}.`));
  const gate = (b: string, c: string, ...extra: string[]) => run(['gate', '--baseline', b, '--candidate', c, '--bar', BAR, '--allow-differ', 'systemModelServed', ...extra]);
  it('prints the one-draw line under the table, and a BROKE row names its one draw and counts nothing', () => {
    const r = gate(base, cand);
    assert.equal(r.status, 1, r.stderr);
    const lines = r.stdout.split('\n');
    const table = lines.findIndex((l) => l.startsWith('class '));
    assert.equal(lines[table + 2], LINE, r.stdout);
    assert.ok(lines.includes('  reply_quality/q02  draw #0: 2'), r.stdout);
    assert.doesNotMatch(r.stdout, /attributed draw|draws fail/);
  });
  it('prints neither on runs of two draws per case: the line appears exactly when the draw count is 1', () => {
    const b2 = write(manifest({ drawsPerCase: 2 }), rows({}, undefined, 2));
    const c2 = write(manifest({ ...moved, drawsPerCase: 2 }), rows({ q02: '2' }, (id) => `New reply to ${id}.`, 2));
    const r = gate(b2, c2);
    assert.equal(r.status, 1, r.stderr);
    assert.doesNotMatch(r.stdout, /draws per case: 1/);
    assert.match(r.stdout, /reply_quality\/q02 {2}attributed draw #0: 2; 2 of 2 draws fail/);
  });
  it('--json is the same object with one draw: the same keys, and no line of the text in it', () => {
    const one = JSON.parse(gate(base, cand, '--json').stdout) as Obj;
    const b2 = write(manifest({ drawsPerCase: 2 }), rows({}, undefined, 2));
    const c2 = write(manifest({ ...moved, drawsPerCase: 2 }), rows({ q02: '2' }, (id) => `New reply to ${id}.`, 2));
    const two = JSON.parse(gate(b2, c2, '--json').stdout) as Obj;
    assert.deepEqual(Object.keys(one), Object.keys(two));
    assert.deepEqual(Object.keys(one), ['schema', 'tool', 'kind', 'gate', 'baselineGate', 'diff', 'folded', 'incomplete', 'allowedDifferences', 'newCases', 'exitCode']);
    assert.equal(one['schema'], 'anchorset.gate-report/v2');
    assert.doesNotMatch(JSON.stringify(one), /draws per case: 1|one draw per case/);
  });
  it('the judge-controlled block says what one draw cannot separate, and only on one draw', () => {
    const rejudged = write(manifest({ judge: { ...JUDGE, modelServed: 'judge-model-2026-06-01' } }), rows({ q01: '3' }));
    const c = write(manifest({ ...moved, judge: { ...JUDGE, modelServed: 'judge-model-2026-06-01' } }), rows({ q02: '2' }, (id) => `New reply to ${id}.`));
    const r = gate(rejudged, c, '--rejudge-of', base);
    assert.equal(r.status, 1, r.stderr);
    const lines = r.stdout.split('\n');
    const at = lines.findIndex((l) => l.startsWith('judge-controlled, against the baseline as first judged'));
    assert.ok(at >= 0, r.stdout);
    assert.equal(lines.slice(at + 1, lines.indexOf('', at)).at(-1), SPLIT);
    const b2 = write(manifest({ drawsPerCase: 2 }), rows({}, undefined, 2));
    const r2 = write(manifest({ drawsPerCase: 2, judge: { ...JUDGE, modelServed: 'judge-model-2026-06-01' } }), rows({ q01: '3' }, undefined, 2));
    const c2 = write(manifest({ ...moved, drawsPerCase: 2, judge: { ...JUDGE, modelServed: 'judge-model-2026-06-01' } }), rows({ q02: '2' }, (id) => `New reply to ${id}.`, 2));
    const two = gate(r2, c2, '--rejudge-of', b2);
    assert.match(two.stdout, /^judge-controlled, against/m);
    assert.doesNotMatch(two.stdout, /one draw per case/);
  });
  it('the judge-flip list folds each case from its one draw, prints no draw count, and does not measure the judges\' own variation', () => {
    const rejudged = write(manifest({ judge: { ...JUDGE, modelServed: 'judge-model-2026-06-01' } }), rows({ q01: '3' }));
    const c = write(manifest({ ...moved, judge: { ...JUDGE, modelServed: 'judge-model-2026-06-01' } }), rows({ q02: '2' }, (id) => `New reply to ${id}.`));
    const r = gate(rejudged, c, '--rejudge-of', base);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /^judge flips: the baseline's stored answers, original baseline \(old judge\) -> re-judged baseline \(new judge\), each folded from its one draw; each direction counted, never netted$/m);
    // q01: 4 under the old judge, 3 under the new; one draw, so no "k of N fail".
    assert.match(r.stdout, /^ {4}reply_quality\/q01 {2}expect >= 4 · old 4 -> new 3 · answer [0-9a-f]{12}…$/m);
    assert.match(r.stdout, /^ {2}the judge's own variation: not measured \(one draw per case\)$/m);
    const j = JSON.parse(gate(rejudged, c, '--rejudge-of', base, '--json').stdout) as { judgeFlips: { ownVariation: unknown; drawsPerCase: number } };
    assert.deepEqual([j.judgeFlips.drawsPerCase, j.judgeFlips.ownVariation], [1, 'not measured (one draw per case)']);
  });
});

describe('flips on one draw per case', () => {
  it('keeps refusing (exit 2, UNSUPPORTED_DESIGN, fields drawsPerCase), and the message says how to measure it', () => {
    const one = write(manifest(), rows({}));
    const r = run(['flips', '--run', one]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^REFUSED UNSUPPORTED_DESIGN\n {2}fields: drawsPerCase\n {2}the run has one draw per case; a flip needs at least two draws of a case: draw each case at least twice \(drawsPerCase 2 or more\) to measure how often the grade changes on a repeat$/m);
    const j = JSON.parse(run(['flips', '--run', one, '--json']).stdout) as Obj;
    assert.deepEqual([j['schema'], j['code'], j['fields'], j['exitCode']], ['anchorset.refusal/v2', 'UNSUPPORTED_DESIGN', ['drawsPerCase'], 2]);
  });
});

describe('judge-change on one draw per case', () => {
  it('prints "not measured" for the within-judge share, the difference read off it and the own variation, where the JSON keeps "not declared"', () => {
    const inputs = join(work, 'jc-inputs');
    mkdirSync(inputs);
    const old = write(manifest(), rows({ q04: '3' }), 'old.json');
    const neu = write(manifest({ judge: { ...JUDGE, modelServed: 'judge-model-2026-06-01' } }), rows({ q03: '3' }), 'new.json');
    const plan = join(work, 'plan.json');
    const p = node(join(root, 'examples', 'importers', 'make-plan.ts'), ['--old', old, '--new', neu, '--bar', BAR, '--out', plan, '--system', 'refund-bot', '--stored-outputs', 'system-side-compared', '--measured-class', 'reply_quality', '--cut', '4', '--label-rule', 'worst', '--pooling', 'items-equal', '--estimate-draws', '0', '--judge-moves', 'judgeModelServed']);
    assert.equal(p.status, 0, p.stderr + p.stdout);
    for (const [from, name] of [[old, 'old.json'], [neu, 'new.json']] as const) copyFileSync(from, join(inputs, name));
    const r = run(['judge-change', '--plan', plan, '--bar', BAR, '--inputs', inputs]);
    assert.equal(r.status, 0, r.stderr);
    const at = (label: string): string | undefined => r.stdout.split('\n').find((l) => l.startsWith(label));
    assert.equal(at('labels that differ between two sets of one judge')?.replace(/\s{2,}/, '  '), `labels that differ between two sets of one judge (worst)  ${WITHIN}`);
    assert.equal(at('the first share minus the second')?.replace(/\s{2,}/, '  '), `the first share minus the second (from the counts)  ${WITHIN}`);
    assert.equal(at("the judge's own variation"), `the judge's own variation: ${WITHIN}`);
    const j = JSON.parse(run(['judge-change', '--plan', plan, '--bar', BAR, '--inputs', inputs, '--json']).stdout) as { flips: Obj };
    assert.deepEqual([j.flips['withinJudge'], j.flips['beyondReask']], ['not declared', 'not declared']);
  });
});
