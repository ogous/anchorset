// The OpenAI Responses wire through judge-change, end to end, on the promptfoo fixtures the real tool wrote against the local
// stand-in (zero spend, no network). It stands beside importers.e2e.test.ts, which imports the Inspect fixtures too; these
// tests need the promptfoo importer only.
// Synthetic customer-support refund-bot data only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { sha256Hex } from '../src/index.ts';
import { READINGS } from '../examples/importers/shared.ts';
import { scratchEnv } from './helpers.ts';

const root = join(import.meta.dirname, '..');
const importers = join(root, 'examples', 'importers');
const pf = join(importers, 'promptfoo');
const work = mkdtempSync(join(tmpdir(), 'anchorset-openai-e2e-'));
after(() => rmSync(work, { recursive: true, force: true }));

const node = (script: string, args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: root, env: scratchEnv() });
const cli = (...args: string[]) => node(join(root, 'src', 'cli.ts'), args);
const makePlan = join(importers, 'make-plan.ts');
const bar = join(pf, 'bar.json');

/** A fixture of the promptfoo folder imported by the real command. */
function importFixture(fixture: string, name: string, from = 'fixtures'): { path: string; sha256: string; stdout: string } {
  const dir = join(work, 'runs');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  const r = node(join(pf, 'import.ts'), ['--in', join(pf, from, `${fixture}.json`), '--cases', join(pf, 'cases.json'), '--bar', bar, '--out', path, '--reading', READINGS[0]]);
  assert.equal(r.status, 0, r.stderr);
  return { path, sha256: sha256Hex(readFileSync(path)), stdout: r.stdout };
}

const planFlags = (moves: string, out: string): string[] => ['--bar', bar, '--system', 'refund-bot', '--stored-outputs', 'system-side-not-compared', '--measured-class', 'refund_policy', '--cut', 'pass', '--label-rule', 'majority', '--pooling', 'items-equal', '--estimate-draws', '0,1,2', '--judge-moves', moves, '--out', out];
const FOUR = 'judgeModelRequested,judgeModelServed,judgeCallShapeHash,judgeHarnessVersion';

/** The folder judge-change reads, holding the two run files under the names old.json and new.json. */
function inputs(name: string, oldRun: string, newRun: string): string {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  copyFileSync(oldRun, join(dir, 'old.json'));
  copyFileSync(newRun, join(dir, 'new.json'));
  return dir;
}

test('the OpenAI old and new judges go through judge-change: the plan names the model as the only move, and the wire (the same in both) moves nothing else', () => {
  const o = importFixture('openai-old-judge', 'oa-old');
  const n = importFixture('openai-new-judge', 'oa-new');
  const planPath = join(work, 'oa-plan.json');
  const made = node(makePlan, ['--old', o.path, '--new', n.path, ...planFlags('judgeModelRequested,judgeModelServed', planPath)]);
  assert.equal(made.status, 0, made.stderr);
  assert.equal(made.stderr, '', 'two OpenAI runs name one wire: no cross-wire note');
  const r = cli('judge-change', '--plan', planPath, '--bar', bar, '--inputs', inputs('oa-inputs', o.path, n.path));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^judge change on stored outputs: a measurement\. It has no verdict and never exits 1\.$/m);
  assert.match(r.stdout, /judgeModelRequested {1,}fake-judge-old -> fake-judge-strict-new/);
  // the served id equals the requested one on this wire, so the served field moves with the request: the same text, in both runs
  assert.match(r.stdout, /judgeModelServed {1,}fake-judge-old -> fake-judge-strict-new/);
  // the wire is the same text in both harness strings, so the harness field did not move and the report does not list it
  assert.doesNotMatch(r.stdout, /judgeHarnessVersion|judgeCallShapeHash/);
  // the stand-in's strict marker flips the one case, as for the other wire
  assert.match(r.stdout, /per-draw pass rate {1,}1\.000 {1,}1\.000 {1,}\+0\.000/);
  assert.match(r.stdout, /refund_safety\/refund-bot\/c3 {2}old judge fails draws \[\] · new judge fails draws \[0, 1, 2\]/);
});

test('the motivating pair: the Anthropic old judge against the OpenAI new judge moves four judge fields, and the plan must declare all four', () => {
  const a = importFixture('old-judge', 'anth-old');
  const o = importFixture('openai-new-judge', 'oa-new-2');
  // declared: written, with the note on standard error
  const planPath = join(work, 'cross-plan.json');
  const made = node(makePlan, ['--old', a.path, '--new', o.path, ...planFlags(FOUR, planPath)]);
  assert.equal(made.status, 0, made.stderr);
  assert.match(made.stderr, /^The two run files were graded through two APIs \(`anthropic-messages\/v1` and `openai-responses\/v1`\)\./);
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as { judgeMoves: string[]; judges: { old: Record<string, string>; new: Record<string, string> } };
  assert.deepEqual(plan.judgeMoves, ['judgeModelRequested', 'judgeModelServed', 'judgeCallShapeHash', 'judgeHarnessVersion']);
  // judgeDefinitionHash does not move on a wire switch: the template, the reading rule and the bound are the same text
  assert.equal(plan.judges.old['judgeDefinitionHash'], plan.judges.new['judgeDefinitionHash']);
  assert.equal(plan.judges.old['rubricHash'], plan.judges.new['rubricHash']);
  assert.match(plan.judges.old['judgeHarnessVersion'] as string, /; wire anthropic-messages\/v1$/);
  assert.match(plan.judges.new['judgeHarnessVersion'] as string, /; wire openai-responses\/v1$/);
  const r = cli('judge-change', '--plan', planPath, '--bar', bar, '--inputs', inputs('cross-inputs', a.path, o.path));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /judgeHarnessVersion /);
  // left out: either of the last two is refused, by the library, naming the field
  for (const [left, field] of [['judgeModelRequested,judgeModelServed,judgeCallShapeHash', 'judgeHarnessVersion'], ['judgeModelRequested,judgeModelServed,judgeHarnessVersion', 'judgeCallShapeHash']] as const) {
    const refusedPlan = join(work, `refused-${field}.json`);
    const bad = node(makePlan, ['--old', a.path, '--new', o.path, ...planFlags(left, refusedPlan)]);
    assert.equal(bad.status, 2, bad.stderr);
    assert.match(bad.stderr, new RegExp(`^REFUSED IDENTITY_MISMATCH\\n {2}fields: ${field}\\n`));
    // and judge-change, given a plan written by hand with the field left out, refuses it too
    const hand = JSON.parse(readFileSync(planPath, 'utf8')) as { judgeMoves: string[] };
    hand.judgeMoves = hand.judgeMoves.filter((f) => f !== field);
    const handPath = join(work, `hand-${field}.json`);
    writeFileSync(handPath, JSON.stringify(hand, null, 2));
    const jc = cli('judge-change', '--plan', handPath, '--bar', bar, '--inputs', inputs(`hand-${field}`, a.path, o.path));
    assert.equal(jc.status, 2, jc.stderr);
    assert.match(jc.stderr, new RegExp(`REFUSED IDENTITY_MISMATCH[\\s\\S]*fields: ${field}`));
  }
});

test('the other listed promptfoo version: its OpenAI witnesses give the same measurement as the reference version\'s files', () => {
  const [ro, rn] = [importFixture('openai-old-judge', 'ref-old'), importFixture('openai-new-judge', 'ref-new')];
  const [wo, wn] = [importFixture('openai-old-judge', 'wit-old', 'by-version/0.125.1'), importFixture('openai-new-judge', 'wit-new', 'by-version/0.125.1')];
  const measure = (name: string, a: { path: string }, b: { path: string }): string => {
    const planPath = join(work, `${name}-plan.json`);
    const made = node(makePlan, ['--old', a.path, '--new', b.path, ...planFlags('judgeModelRequested,judgeModelServed', planPath)]);
    assert.equal(made.status, 0, made.stderr);
    const r = cli('judge-change', '--plan', planPath, '--bar', bar, '--inputs', inputs(`${name}-in`, a.path, b.path));
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split('\n').filter((l) => /per-draw pass rate|label pass rate|items whose label differs|old judge fails draws/.test(l)).join('\n');
  };
  const reference = measure('ref', ro, rn);
  assert.ok(reference.length > 0);
  assert.equal(measure('wit', wo, wn), reference);
});

test('an OpenAI file whose rows come from two grader processes is refused with IMPORT_HIDDEN_CALLS, by the command', () => {
  const j = JSON.parse(readFileSync(join(pf, 'fixtures', 'openai-old-judge.json'), 'utf8')) as { results: { results: { gradingResult: { componentResults: { metadata: { graderEvidence: { graderRunId: string } } }[] } }[] } };
  const rows = j.results.results;
  (rows[rows.length - 1] as (typeof rows)[number]).gradingResult.componentResults[0]!.metadata.graderEvidence.graderRunId = 'a-second-grader-process';
  const file = join(work, 'two-processes.json');
  writeFileSync(file, JSON.stringify(j, null, 2));
  const out = join(work, 'two-processes-run.json');
  const r = node(join(pf, 'import.ts'), ['--in', file, '--cases', join(pf, 'cases.json'), '--bar', bar, '--out', out, '--reading', READINGS[0]]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /REFUSED IMPORT_HIDDEN_CALLS/);
  assert.match(r.stderr, /fields: graderRunId/);
  assert.match(r.stderr, /two grader processes wrote this file \(2 distinct run ids\)/);
});

test('a v7 file is refused by the command with the instruction to grade again; the run files already imported stay valid', () => {
  const j = readFileSync(join(pf, 'fixtures', 'old-judge.json'), 'utf8').replaceAll('"example.grader-evidence/v8"', '"example.grader-evidence/v7"');
  const file = join(work, 'v7.json');
  writeFileSync(file, j);
  const r = node(join(pf, 'import.ts'), ['--in', file, '--cases', join(pf, 'cases.json'), '--bar', bar, '--out', join(work, 'v7-run.json'), '--reading', READINGS[0]]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /REFUSED IMPORT_EVIDENCE/);
  assert.match(r.stderr, /this record is of version example\.grader-evidence\/v7, an earlier version than example\.grader-evidence\/v8; re-grade with the current grader/);
});
