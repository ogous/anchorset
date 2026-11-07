// stored-from-result.ts: the stored answers of a promptfoo result file, for the re-grade. Tested on the result files the real
// tool wrote (examples/importers/promptfoo/fixtures and by-version/0.125.1); every refusal test loads a good file, applies one
// edit in code and asserts the code and the named fields. Synthetic customer-support refund-bot data only.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ImportRefusal } from '../examples/importers/shared.ts';
import type { ImportRefusalCode } from '../examples/importers/shared.ts';
import { main, storedFromResult } from '../examples/importers/promptfoo/stored-from-result.ts';

const dirPf = join(import.meta.dirname, '..', 'examples', 'importers', 'promptfoo');
const work = mkdtempSync(join(tmpdir(), 'anchorset-pf-stored-'));
after(() => rmSync(work, { recursive: true, force: true }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const FILES = ['fixtures/old-judge.json', 'by-version/0.125.1/old-judge.json'];
const load = (rel: string = FILES[1] as string): J => JSON.parse(readFileSync(join(dirPf, rel), 'utf8'));
const bytes = (j: J): Buffer => Buffer.from(JSON.stringify(j, null, 2));
const stored = JSON.parse(readFileSync(join(dirPf, 'stored.json'), 'utf8')) as Record<string, string>;

function refused(j: J, code: ImportRefusalCode, field?: string): ImportRefusal {
  try {
    storedFromResult(bytes(j), 'result.json');
  } catch (e) {
    assert.ok(e instanceof ImportRefusal, String(e));
    assert.equal(e.code, code, e.message);
    if (field !== undefined) assert.ok(e.fields.some((f) => f.includes(field)), `${field} not in ${e.fields.join(', ')}`);
    return e;
  }
  assert.fail(`not refused: ${code}`);
}

for (const rel of FILES) {
  test(`${rel}: the answers are the example's stored.json, one per case, in the order the cases first appear`, () => {
    const r = storedFromResult(readFileSync(join(dirPf, rel)), 'result.json');
    assert.deepEqual(r.stored, stored);
    assert.deepEqual(Object.keys(r.stored), ['c1', 'c2', 'c3']);
    assert.equal(r.rows, 9);
    assert.equal(r.version, load(rel).metadata.promptfooVersion);
  });
}

test('a row that failed an assertion holds an answer and is kept (failureReason 1, its reason in error)', () => {
  const j = load();
  for (const row of j.results.results) {
    if (row.vars.case_id === 'c3') Object.assign(row, { failureReason: 1, success: false, error: 'Expected output to contain "refund"' });
  }
  assert.deepEqual(storedFromResult(bytes(j), 'result.json').stored, stored);
});

test('a version or format that is not tested is refused, by the importer\'s own check', () => {
  const j = load();
  j.metadata.promptfooVersion = '0.124.0';
  const e = refused(j, 'IMPORT_TOOL_VERSION', '/metadata/promptfooVersion');
  assert.match(e.message, /stored-from-result\.ts was tested on promptfoo/);
  const k = load();
  k.results.version = 2;
  refused(k, 'IMPORT_TOOL_VERSION', '/results/version');
});

test('more than one provider, or more than one prompt, is refused by the importer\'s own rule: one answer per case', () => {
  const edits: ((j: J) => void)[] = [
    (j) => j.config.providers.push('file://another-system.cjs'),
    (j) => j.config.prompts.push('{{question}} (again)'),
    (j) => j.results.prompts.push(j.results.prompts[0]),
    (j) => (j.results.results[4].promptIdx = 1),
  ];
  for (const edit of edits) {
    const j = load();
    edit(j);
    const e = refused(j, 'IMPORT_JUDGE_SELECTION');
    assert.match(e.message, /the re-grade needs one answer per case/);
  }
});

test('a test that answers from another provider, or from a fixed providerOutput, is refused (row, test or defaultTest)', () => {
  const edits: [(j: J) => void, string][] = [
    [(j) => (j.results.results[4].testCase.provider = { id: 'other-system', label: '' }), '/results/results/4/testCase'],
    [(j) => (j.results.results[4].testCase.providerOutput = 'A fixed output written in the config.'), '/results/results/4/testCase'],
    [(j) => (j.config.tests[1].provider = 'file://other.cjs'), '/config/tests/1'],
    [(j) => (j.config.defaultTest.provider = 'file://other.cjs'), '/config/defaultTest'],
    [(j) => (j.config.tests[1].providerOutput = 'A fixed output written in the config.'), '/config/tests/1'],
    [(j) => (j.config.defaultTest.providerOutput = 'A fixed output written in the config.'), '/config/defaultTest'],
  ];
  for (const [edit, field] of edits) {
    const j = load();
    edit(j);
    const e = refused(j, 'IMPORT_JUDGE_SELECTION', field);
    assert.match(e.message, /names its own provider or a fixed providerOutput/);
  }
  // The grader under defaultTest.options.provider is not the system: the good file holds one and is taken.
  assert.ok(load().config.defaultTest.options.provider !== undefined);
});

test('two tests that share a case_id with different variables are refused as such, before the answers are compared', () => {
  const j = load();
  const row = j.results.results.find((r: J) => r.vars.case_id === 'c2');
  row.vars = { ...row.vars, question: 'A different question under the same case id.' };
  row.response.output = 'A different answer.';
  const e = refused(j, 'IMPORT_CASE_ID', '/vars');
  assert.match(e.message, /c2: the variables differ between the rows of one case/);
});

test('a row that is not an object is refused as the file\'s shape', () => {
  const j = load();
  j.results.results[3] = null;
  refused(j, 'IMPORT_SHAPE', '/results/results/3');
});

test('a row with no case_id, an empty one or one that is not a string is refused, by its path', () => {
  for (const value of [undefined, '', 3]) {
    const j = load();
    if (value === undefined) delete j.results.results[2].vars.case_id;
    else j.results.results[2].vars.case_id = value;
    refused(j, 'IMPORT_CASE_ID', '/results/results/2/vars/case_id');
  }
});

test('a row the tool marked as an error, or an answer that is not text, is refused, by its path', () => {
  const edits: ((row: J) => void)[] = [
    (row) => Object.assign(row, { failureReason: 2, error: 'API error: 500' }),
    (row) => Object.assign(row, { error: 'something went wrong' }),
    (row) => delete row.failureReason,
    (row) => (row.response.output = { text: 'an object' }),
    (row) => (row.response.output = ['a', 'list']),
    (row) => delete row.response,
  ];
  for (const edit of edits) {
    const j = load();
    edit(j.results.results[5]);
    refused(j, 'IMPORT_OUTPUT_UNFINISHED', '/results/results/5');
  }
});

test('two different answers for one case are refused, naming the case', () => {
  const j = load();
  const row = j.results.results.find((r: J) => r.vars.case_id === 'c2');
  row.response.output = `${row.response.output} (and something else)`;
  const e = refused(j, 'IMPORT_OUTPUTS_DIFFER', 'case c2');
  assert.match(e.message, /run your system once/);
});

test('a file that is not JSON, and an empty result list, are refused', () => {
  assert.throws(() => storedFromResult(Buffer.from('{"results":'), 'result.json'), (e: unknown) => e instanceof ImportRefusal && e.code === 'IMPORT_SHAPE');
  const j = load();
  j.results.results = [];
  refused(j, 'IMPORT_SHAPE');
});

// ---- the command ------------------------------------------------------------------------------------------------------

const run = (argv: string[]): { code: number; out: string[]; err: string[] } => {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, { out: (s) => void out.push(s), err: (s) => void err.push(s) });
  return { code, out, err };
};

test('the command writes stored.json, prints the count and its sha256, exits 0, and never overwrites', () => {
  const out = join(work, 'stored.json');
  const r = run(['--in', join(dirPf, FILES[1] as string), '--out', out]);
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), stored);
  assert.match(r.out[0] as string, /^stored answers: 3 cases from 9 rows of a promptfoo 0\.125\.1 result file, written to /);
  assert.match(r.out[1] as string, /^stored file sha256: [0-9a-f]{64}$/);
  const again = run(['--in', join(dirPf, FILES[1] as string), '--out', out]);
  assert.equal(again.code, 64);
  assert.match(again.err.join('\n'), /never overwrites --out/);
});

test('a refused file exits 2 and writes nothing; a missing flag exits 64', () => {
  const j = load();
  j.results.results[0].vars.case_id = '';
  const src = join(work, 'bad.json');
  writeFileSync(src, bytes(j));
  const out = join(work, 'never.json');
  const r = run(['--in', src, '--out', out]);
  assert.equal(r.code, 2);
  assert.match(r.err.join('\n'), /IMPORT_CASE_ID/);
  assert.ok(!existsSync(out));
  assert.equal(run(['--in', src]).code, 64);
  assert.equal(run(['--in', src, '--out', out, '--extra', 'x']).code, 64);
});
