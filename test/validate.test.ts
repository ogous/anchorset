// `anchorset validate`: whether gate would admit a run, with every reason it would refuse it, where gate names the
// first. What this file pins: each exit (0, 2, 64, 65); that the reasons are the gate's own, listed in its order, the
// first being the gate's refusal; the --baseline, --allow-differ and --rejudge-of paths; that manifest mode gives the
// report --run gives on the written file; and the --json report, printed on exit 2 in place of the refusal object. No
// statistic is computed. Fixtures are synthetic: a refund bot, written through write-run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { REPORT_SCHEMAS } from '../src/index.ts';

const root = join(import.meta.dirname, '..');
const cli = join(root, 'src', 'cli.ts');
const work = mkdtempSync(join(tmpdir(), 'anchorset-validate-'));
after(() => rmSync(work, { recursive: true, force: true }));
const node = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: root });
const sha256 = (x: string): string => createHash('sha256').update(x).digest('hex');

type Obj = Record<string, unknown>;
const SENT = { sent: { endpoint: 'example-provider:messages', temperature: 0, maxOutputTokens: 512 }, everyOtherKey: 'NOT_SENT' };
const SYSTEM = { modelRequested: 'bot-model', modelServed: 'bot-model-2026-01-15', prompt: { json: 'You are the support assistant of an online shop.' }, tools: { json: [] }, harnessVersion: 'refund-eval 1.4.0', settings: SENT };
const JUDGE = { modelRequested: 'judge-model', modelServed: 'judge-model-2026-02-01', definition: { json: 'Grade the reply from 1 to 5.' }, harnessVersion: 'refund-eval 1.4.0', settings: SENT, gradedReplyStop: 'end' };
const manifest = (over: Obj = {}): Obj => ({
  schema: 'anchorset.run-input/v1', origin: 'produced', graded: 'by-judge', bar: join(root, 'examples', 'run-format', 'bar.json'), caseCount: 3,
  sameForEveryCase: { class: 'reply_quality' }, expectByClass: { reply_quality: '4' }, rubric: { json: 'reply quality, 1 to 5' }, seed: 'NO_SEED', system: SYSTEM, judge: JUDGE, ...over,
});
const row = (id: string, over: Obj = {}): Obj => ({ case: id, grade: '4', answer: `Reply to ${id}.`, stop: 'end', input: { message: `question ${id}` }, ...over });
const rowsOf = (ids: readonly string[], over: (id: string) => Obj = () => ({})): Obj[] => ids.map((id) => row(id, over(id)));
const IDS = ['q01', 'q02', 'q03'];
const jsonl = (rs: readonly Obj[]): string => `${rs.map((r) => JSON.stringify(r)).join('\n')}\n`;

let n = 0;
/** The manifest and rows in a fresh folder; `write` also writes the run and returns its path. */
function input(m: Obj, rs: readonly Obj[]): { manifest: string; grades: string; dir: string } {
  const dir = join(work, `v-${(n += 1)}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
  writeFileSync(join(dir, 'grades.jsonl'), jsonl(rs));
  return { manifest: join(dir, 'manifest.json'), grades: join(dir, 'grades.jsonl'), dir };
}
function write(m: Obj, rs: readonly Obj[]): string {
  const i = input(m, rs);
  const out = join(i.dir, 'run.json');
  const r = node(['write-run', '--manifest', i.manifest, '--grades', i.grades, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  return out;
}
const BAR = join(root, 'examples', 'run-format', 'bar.json');
const validateRun = (run: string, ...extra: string[]) => node(['validate', '--run', run, '--bar', BAR, ...extra]);
const json = (r: { stdout: string }): Obj => JSON.parse(r.stdout) as Obj;
const refusals = (r: { stdout: string }): { code: string; fields: string[]; message: string }[] => ((json(r)['gate'] as Obj)['refusals'] as { code: string; fields: string[]; message: string }[]);

describe('validate: each exit', () => {
  it('exit 0: gate would admit the run; the report says READY and lists no reason', () => {
    const run = write(manifest(), rowsOf(IDS));
    const r = validateRun(run);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^gate would admit it\.$/m);
    assert.match(r.stdout, /^result: READY for gate \(exit 0\)$/m);
    assert.equal(node(['gate', '--baseline', run, '--candidate', run, '--bar', BAR]).status, 0);
  });

  it('exit 2: every reason is listed in the gate\'s order, and the first is the refusal gate prints', () => {
    const run = write(manifest({ seed: 'UNKNOWN', system: { ...SYSTEM, modelServed: 'UNKNOWN' } }), rowsOf(IDS, (id) => (id === 'q02' ? { stop: 'UNKNOWN' } : {})));
    const r = validateRun(run, '--json');
    assert.equal(r.status, 2, r.stderr);
    assert.deepEqual(refusals(r).map((x) => [x.code, x.fields]), [
      ['IDENTITY_GAP', ['systemStop[q02#0]']],
      ['IDENTITY_GAP', ['systemStop[q02#0]']],
      ['IDENTITY_GAP', ['systemModelServed', 'seed']],
    ]);
    assert.deepEqual((json(r)['gate'] as Obj)['notChecked'], [{ step: 'baseline completeness', why: "the baseline's system stop is unknown on some slots, and no fold reads such a slot" }]);
    const g = node(['gate', '--baseline', run, '--candidate', run, '--bar', BAR, '--json']);
    assert.equal(g.status, 2);
    const first = refusals(r)[0] as { code: string; fields: string[]; message: string };
    assert.deepEqual([first.code, first.fields, first.message], [json(g)['code'], json(g)['fields'], json(g)['message']]);
    const text = validateRun(run);
    assert.equal(text.status, 2);
    assert.match(text.stdout, /^gate would refuse it, for every reason below \(in the order gate checks them\):$/m);
    assert.match(text.stdout, /^result: NOT READY for gate \(exit 2\)$/m);
  });

  it('--json on exit 2 is the validate report, not the refusal object, and names its contract and the tool first', () => {
    const run = write(manifest({ seed: 'UNKNOWN' }), rowsOf(IDS));
    const r = validateRun(run, '--json');
    assert.equal(r.status, 2);
    const j = json(r);
    assert.deepEqual(Object.keys(j).slice(0, 2), ['schema', 'tool']);
    assert.equal(j['schema'], REPORT_SCHEMAS.validate);
    assert.equal(j['schema'], 'anchorset.validate-report/v1');
    assert.notEqual(j['schema'], REPORT_SCHEMAS.refusal);
    assert.deepEqual([j['kind'], j['mode'], j['against'], j['exitCode'], (j['gate'] as Obj)['admitted']], ['preflight', 'run', 'itself', 2, false]);
    assert.equal(r.stderr, '');
  });

  it('exit 64: the modes, --bar, --rejudge-of and --allow-differ are checked before anything is read', () => {
    const run = write(manifest(), rowsOf(IDS));
    const i = input(manifest(), rowsOf(IDS));
    const cases: [string[], RegExp][] = [
      [['validate'], /give --run and --bar, or --manifest and --grades/],
      [['validate', '--run', run], /--bar is required with --run/],
      [['validate', '--run', run, '--bar', BAR, '--manifest', i.manifest, '--grades', i.grades], /not both/],
      [['validate', '--manifest', i.manifest, '--grades', i.grades, '--bar', BAR], /--bar is not taken with --manifest/],
      [['validate', '--manifest', i.manifest], /--grades is required with --manifest/],
      [['validate', '--grades', i.grades], /--manifest is required with --grades/],
      [['validate', '--run', run, '--bar', BAR, '--rejudge-of', run], /--rejudge-of only applies with --baseline/],
      [['validate', '--run', run, '--bar', BAR, '--allow-differ', 'seed'], /--allow-differ only applies with --baseline/],
      [['validate', '--run', run, '--bar', BAR, '--baseline', run, '--allow-differ', 'nonsense'], /unknown identity field\(s\) nonsense/],
      [['validate', '--run', run, '--bar', BAR, '--baseline', run, '--allow-differ', 'judgeModelServed'], /judgeModelServed cannot be allowed to differ on a gate/],
      [['validate', '--run', run, '--bar', BAR, '--out', 'x'], /unknown flag --out/],
      [['validate', '--run', run, '--run', run, '--bar', BAR], /--run given twice/],
    ];
    for (const [args, words] of cases) {
      const r = node(args);
      assert.equal(r.status, 64, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, words, args.join(' '));
      assert.equal(r.stdout, '');
    }
  });

  it('exit 65: a run file that is not a run, or a manifest that is not in its format, every problem with its place', () => {
    const notRun = validateRun(BAR);
    assert.equal(notRun.status, 65, notRun.stderr);
    assert.match(notRun.stderr, /--run [^\n]*bar\.json: artifact/);
    const i = input(manifest({ origin: 'converted' }), rowsOf(IDS));
    const bad = node(['validate', '--manifest', i.manifest, '--grades', i.grades]);
    assert.equal(bad.status, 65, bad.stderr);
    assert.match(bad.stderr, /manifest\.origin: is "converted"/);
    const j = input(manifest(), rowsOf(IDS, (id) => (id === 'q01' ? { grade: '9' } : {})));
    const label = node(['validate', '--manifest', j.manifest, '--grades', j.grades, '--json']);
    assert.equal(label.status, 65, label.stderr);
    assert.equal(label.stdout, '', 'invalid input stays text on stderr, also under --json');
    assert.match(label.stderr, /grade "9" is not a label of the bar/);
  });
});

describe('validate: manifest mode is write-run without the file', () => {
  it('gives the report --run gives on the file write-run writes from the same input, and writes nothing', () => {
    const m = manifest({ seed: 'UNKNOWN' });
    const i = input(m, rowsOf(IDS));
    const fromManifest = node(['validate', '--manifest', i.manifest, '--grades', i.grades, '--json']);
    assert.equal(fromManifest.status, 2);
    const run = write(m, rowsOf(IDS));
    const fromRun = validateRun(run, '--json');
    const strip = (o: Obj): Obj => Object.fromEntries(Object.entries(o).filter(([k]) => !['mode', 'inputs', 'origin', 'declarations'].includes(k)));
    assert.deepEqual(strip(json(fromManifest)), strip(json(fromRun)));
    assert.deepEqual([json(fromManifest)['mode'], json(fromManifest)['origin']], ['manifest', 'produced']);
    assert.deepEqual((json(fromManifest)['declarations'] as { key: string }[]).map((d) => d.key), ['system.settings', 'judge.settings', 'judge.gradedReplyStop']);
    const text = node(['validate', '--manifest', i.manifest, '--grades', i.grades]);
    assert.match(text.stdout, /built in memory from anchorset\.run-input\/v1; nothing written/);
    assert.match(text.stdout, /stated by you about your harness: judge\.gradedReplyStop/);
  });
});

describe('validate: against a baseline', () => {
  const baseline = write(manifest(), rowsOf(IDS));
  it('a case set that differs: the cases in one run only are listed, and gate\'s refusal of the case-set hash is the reason', () => {
    const cand = write(manifest({ caseCount: 4 }), rowsOf([...IDS, 'q04']));
    const r = validateRun(cand, '--baseline', baseline);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /cases in the baseline only: none · in this run only: q04/);
    assert.match(r.stdout, /IDENTITY_MISMATCH {2}fields: caseSetHash/);
    assert.deepEqual((json(validateRun(cand, '--baseline', baseline, '--json'))['caseSets'] as Obj), { baselineOnly: [], runOnly: ['q04'] });
    // Allowed to differ, an added case counts in its class: gate would admit it.
    assert.equal(validateRun(cand, '--baseline', baseline, '--allow-differ', 'caseSetHash').status, 0);
  });
  it('a draw count that differs is refused, and can never be allowed', () => {
    const two = write(manifest({ drawsPerCase: 2 }), IDS.flatMap((id) => [0, 1].map((d) => row(id, { draw: d }))));
    const r = validateRun(two, '--baseline', baseline, '--json');
    assert.equal(r.status, 2);
    assert.ok(refusals(r).some((x) => x.code === 'IDENTITY_MISMATCH' && x.fields.includes('drawsPerCase')), JSON.stringify(refusals(r)));
    assert.equal(validateRun(two, '--baseline', baseline, '--allow-differ', 'drawsPerCase').status, 64);
  });
  it('a judge that moved: the refusal carries the re-judge hint', () => {
    const moved = write(manifest({ judge: { ...JUDGE, modelServed: 'judge-model-2026-06-01' } }), rowsOf(IDS));
    const r = validateRun(moved, '--baseline', baseline, '--json');
    assert.equal(r.status, 2);
    const first = refusals(r)[0] as { code: string; fields: string[]; message: string };
    assert.deepEqual([first.code, first.fields], ['IDENTITY_MISMATCH', ['judgeModelServed']]);
    assert.match(first.message, /re-judge the baseline outputs with the current judge and pass --rejudge-of <original baseline>/);
  });
  it('--allow-differ is passed through: a system model named as changed is admitted, and refused without it', () => {
    const cand = write(manifest({ system: { ...SYSTEM, modelServed: 'bot-model-2026-06-01' } }), rowsOf(IDS));
    const refused = validateRun(cand, '--baseline', baseline, '--json');
    assert.equal(refused.status, 2);
    assert.deepEqual(refusals(refused).map((x) => [x.code, x.fields]), [['IDENTITY_MISMATCH', ['systemModelServed']]]);
    assert.equal(validateRun(cand, '--baseline', baseline, '--allow-differ', 'systemModelServed').status, 0);
    // The manifest mode takes the same flags.
    const i = input(manifest({ system: { ...SYSTEM, modelServed: 'bot-model-2026-06-01' } }), rowsOf(IDS));
    assert.equal(node(['validate', '--manifest', i.manifest, '--grades', i.grades, '--baseline', baseline, '--allow-differ', 'systemModelServed']).status, 0);
  });
});

describe('validate: --rejudge-of, and the readiness of the other commands', () => {
  const packet = (id: string): Obj => ({ packetHash: sha256(`packet ${id}`) });
  const newJudge = { judge: { ...JUDGE, modelServed: 'judge-model-2026-06-01' } };
  it('with both baselines recording the same packets, the split is computed; with packets unknown it is not, and the verdict is not affected', () => {
    const original = write(manifest({ packets: { basis: 'recorded' } }), rowsOf(IDS, packet));
    const rejudged = write(manifest({ ...newJudge, packets: { basis: 'recorded' } }), rowsOf(IDS, (id) => ({ ...packet(id), grade: id === 'q01' ? '3' : '4' })));
    const cand = write(manifest({ ...newJudge, packets: { basis: 'recorded' }, system: { ...SYSTEM, modelServed: 'bot-model-2026-06-01' } }), rowsOf(IDS, (id) => ({ ...packet(id), answer: `New reply to ${id}.` })));
    const args = ['--baseline', rejudged, '--rejudge-of', original, '--allow-differ', 'systemModelServed'];
    const r = validateRun(cand, ...args);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ {2}split {10}computed$/m);
    assert.deepEqual(json(validateRun(cand, ...args, '--json'))['split'], { status: 'computed' });
    const unknownOriginal = write(manifest(), rowsOf(IDS));
    const u = validateRun(cand, '--baseline', rejudged, '--rejudge-of', unknownOriginal, '--allow-differ', 'systemModelServed');
    assert.equal(u.status, 0, u.stdout);
    assert.match(u.stdout, /^ {2}split {10}not computed: PACKET_MISMATCH packetBasis \(original baseline \(--rejudge-of\)\); the verdict is not affected$/m);
    // Where gate refuses, the split is still looked at: its own refusal is named, or it is not checked.
    const gapped = write(manifest({ ...newJudge, seed: 'UNKNOWN', packets: { basis: 'recorded' }, system: { ...SYSTEM, modelServed: 'bot-model-2026-06-01' } }), rowsOf(IDS, packet));
    const g = json(validateRun(gapped, ...args, '--json'));
    assert.equal(g['exitCode'], 2);
    assert.deepEqual(g['split'], { status: 'not checked', why: 'gate refuses before it computes the split' });
  });
  it('flips: n/a on one draw per case; reads a run of two draws with recorded packets; names its refusal otherwise. judge-change: its packet line, or n/a for a run graded by code', () => {
    const one = json(validateRun(write(manifest(), rowsOf(IDS)), '--json'));
    assert.deepEqual(one['flips'], { status: 'n/a', why: 'one draw per case: a flip needs at least two draws of a case' });
    assert.deepEqual((one['judgeChange'] as Obj)['status'], 'packets not admitted');
    const twoRows = IDS.flatMap((id) => [0, 1].map((d) => row(id, { draw: d, ...packet(id) })));
    const two = json(validateRun(write(manifest({ drawsPerCase: 2, packets: { basis: 'recorded' } }), twoRows), '--json'));
    assert.deepEqual(two['flips'], { status: 'reads it' });
    assert.deepEqual((two['judgeChange'] as Obj)['status'], 'packets admitted');
    const noPackets = json(validateRun(write(manifest({ drawsPerCase: 2 }), IDS.flatMap((id) => [0, 1].map((d) => row(id, { draw: d })))), '--json'));
    assert.deepEqual([(noPackets['flips'] as Obj)['status'], (noPackets['flips'] as Obj)['code'], (noPackets['flips'] as Obj)['fields']], ['refused', 'IDENTITY_GAP', ['packetBasis']]);
    const byCode = json(validateRun(write(Object.fromEntries(Object.entries(manifest({ graded: 'by-code' })).filter(([k]) => k !== 'judge')), rowsOf(IDS)), '--json'));
    assert.deepEqual(byCode['judgeChange'], { status: 'n/a', why: 'graded by code: judge-change compares two judges' });
    const text = validateRun(write(manifest(), rowsOf(IDS)));
    assert.match(text.stdout, /^ {2}flips {10}n\/a \(one draw per case: a flip needs at least two draws of a case\)$/m);
    assert.match(text.stdout, /^ {2}judge-change {3}packets UNKNOWN; judge-change admits recorded or declared, and needs a plan/m);
  });
  it('the exit code reads the gate\'s admission only: a run flips refuses and gate admits exits 0', () => {
    const r = validateRun(write(manifest({ drawsPerCase: 2 }), IDS.flatMap((id) => [0, 1].map((d) => row(id, { draw: d })))));
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /flips {10}refuses it: IDENTITY_GAP packetBasis/);
  });
  it('reads a file of the folder as it is: the hash of every file read is printed', () => {
    const run = write(manifest(), rowsOf(IDS));
    const j = json(validateRun(run, '--json'));
    assert.deepEqual(j['inputs'], [{ role: 'run', path: run, sha256: createHash('sha256').update(readFileSync(run)).digest('hex') }, { role: 'bar', path: BAR, sha256: createHash('sha256').update(readFileSync(BAR)).digest('hex') }]);
  });
});
