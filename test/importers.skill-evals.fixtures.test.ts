// The committed fixtures of the third importer against the files in the tree. A re-grade file declares the sha256 of
// the script that wrote it, of every file that script imports, of the texts it sent and of the flow it read; and
// FIXTURES.sha256 records the inputs and the fixtures. This file recomputes every one of those hashes, so that an edit
// to a hashed file without making the fixtures again (examples/importers/skill-evals/fixtures.sh) fails `npm test`.
// It reads only: nothing here writes into the tree. Synthetic customer-support refund-bot data only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { sha256Hex } from '../src/index.ts';
import { GRADER_FILE, SCRIPT, SCRIPT_FILES } from '../examples/importers/skill-evals/regrade.ts';

const root = join(import.meta.dirname, '..');
const importers = join(root, 'examples', 'importers');
const dir = join(importers, 'skill-evals');
const AGAIN = 'make the fixtures again with examples/importers/skill-evals/fixtures.sh';
const work = mkdtempSync(join(tmpdir(), 'anchorset-skill-fixtures-test-'));
after(() => rmSync(work, { recursive: true, force: true }));

const fileSha = (path: string): string => sha256Hex(new Uint8Array(readFileSync(path)));
/** Every file below a folder, as paths relative to it with forward slashes, sorted. */
function filesBelow(folder: string): string[] {
  return (readdirSync(folder, { recursive: true }) as string[])
    .map((p) => p.split('\\').join('/'))
    .filter((p) => statSync(join(folder, p)).isFile())
    .sort();
}

/** The lines of FIXTURES.sha256. Every path is relative to examples/importers, so `shasum -a 256 -c` run there reads the whole file. */
type Listed = { sha256: string; path: string; file: string };
function listed(): Listed[] {
  const text = readFileSync(join(dir, 'FIXTURES.sha256'), 'utf8');
  assert.ok(text.endsWith('\n'));
  return text.slice(0, -1).split('\n').map((line) => {
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    assert.ok(m !== null, `FIXTURES.sha256: a line that is not "<sha256>  <path>": ${JSON.stringify(line)}`);
    const path = m[2] as string;
    return { sha256: m[1] as string, path, file: join(importers, path) };
  });
}

const FIXTURES = [
  'fixtures/old-judge.regrade.jsonl', 'fixtures/new-judge.regrade.jsonl', 'fixtures/new-judge-rep1.regrade.jsonl', 'fixtures/reask.regrade.jsonl', 'fixtures/reask-new-judge.regrade.jsonl',
  'bad-fixtures/failed-slot.regrade.jsonl', 'bad-fixtures/unreadable-reply.regrade.jsonl', 'bad-fixtures/reask-exhausted.regrade.jsonl',
];
/** The criterion text a fixture was graded under: the example's, or for a re-ask fixture one that carries the fake endpoint's marker. */
const CRITERION_OF: Record<string, string> = {
  'fixtures/reask.regrade.jsonl': 'fixture-inputs/criterion-reask.txt',
  'fixtures/reask-new-judge.regrade.jsonl': 'fixture-inputs/criterion-reask.txt',
  'bad-fixtures/reask-exhausted.regrade.jsonl': 'fixture-inputs/criterion-reask-exhausted.txt',
};
type Obj = Record<string, unknown>;
type TextAndHash = { text: string; sha256: string };
function fixture(path: string): { header: Obj; rows: Obj[] } {
  const [header, ...rows] = readFileSync(join(dir, path), 'utf8').slice(0, -1).split('\n').map((l) => JSON.parse(l) as Obj);
  assert.ok(header !== undefined, path);
  return { header, rows };
}

test('every sha256 recorded in FIXTURES.sha256 is the sha256 of the file in the tree', () => {
  const lines = listed();
  assert.ok(lines.length > 0);
  for (const l of lines) assert.equal(fileSha(l.file), l.sha256, `${l.path} is not the file the fixtures were made with: ${AGAIN}`);
  assert.equal(new Set(lines.map((l) => l.file)).size, lines.length, 'a file is listed twice');
});

test('FIXTURES.sha256 lists every file a fixture depends on: the script and all it imports, the fake endpoint, the inputs, the whole example flow and each fixture', () => {
  const paths = new Set(listed().map((l) => l.path));
  const needed = [
    // The re-grade script and every local file it imports, the grader included: the list the script itself declares.
    ...SCRIPT_FILES.map((p) => p.replace(/^examples\/importers\//, '')),
    'fake-endpoint.ts',
    ...['cases.json', 'bar.json', 'template.txt', 'criterion.txt', 'system.txt'].map((f) => `skill-evals/${f}`),
    // The criterion texts of the re-ask fixtures, which carry the fake endpoint's marker.
    ...filesBelow(join(dir, 'fixture-inputs')).map((p) => `skill-evals/fixture-inputs/${p}`),
    ...filesBelow(join(dir, 'example-flow')).map((p) => `skill-evals/example-flow/${p}`),
    ...filesBelow(join(dir, 'fixtures')).map((p) => `skill-evals/fixtures/${p}`),
    ...filesBelow(join(dir, 'bad-fixtures')).map((p) => `skill-evals/bad-fixtures/${p}`),
  ];
  for (const p of needed) assert.ok(paths.has(p), `${p} is not in FIXTURES.sha256: ${AGAIN}`);
  assert.deepEqual([...paths].sort(), [...new Set(needed)].sort(), 'FIXTURES.sha256 lists a file no fixture depends on, or lacks one');
  assert.deepEqual(filesBelow(join(dir, 'fixtures')).map((p) => `fixtures/${p}`).concat(filesBelow(join(dir, 'bad-fixtures')).map((p) => `bad-fixtures/${p}`)).sort(), [...FIXTURES].sort());
});

test('every fixture\'s header declares the script files, the texts and the flow as they are in the tree', () => {
  const template = readFileSync(join(dir, 'template.txt'), 'utf8');
  const system = readFileSync(join(dir, 'system.txt'), 'utf8');
  for (const path of FIXTURES) {
    const criterionFile = CRITERION_OF[path] ?? 'criterion.txt';
    const criterion = readFileSync(join(dir, criterionFile), 'utf8');
    const { header, rows } = fixture(path);
    const why = `${path}: ${AGAIN}`;
    // The script files: the paths the script declares today, and for each the sha256 of the file in the tree.
    const scriptFiles = header['scriptFiles'] as { path: string; sha256: string }[];
    assert.deepEqual(scriptFiles.map((f) => f.path), [...SCRIPT_FILES], why);
    for (const f of scriptFiles) assert.equal(f.sha256, fileSha(join(root, f.path)), `${f.path} was edited after ${why}`);
    assert.equal(header['script'], SCRIPT, why);
    // The three texts, by their text and by their sha256.
    assert.deepEqual(header['template'], { text: template, sha256: fileSha(join(dir, 'template.txt')) }, `template.txt, ${why}`);
    assert.deepEqual(header['criterion'], { text: criterion, sha256: fileSha(join(dir, criterionFile)) }, `${criterionFile}, ${why}`);
    assert.deepEqual(header['system'], { text: system, sha256: fileSha(join(dir, 'system.txt')) }, `system.txt, ${why}`);
    for (const key of ['template', 'criterion', 'system']) assert.equal(sha256Hex((header[key] as TextAndHash).text), (header[key] as TextAndHash).sha256, key);
    // The flow: the two files of the header, and on every row the trace of the source rep and its assistant turn.
    assert.equal(header['resultsSha256'], fileSha(join(dir, 'example-flow', 'baseline', 'results.jsonl')), `results.jsonl, ${why}`);
    assert.equal(header['stateSha256'], fileSha(join(dir, 'example-flow', '_state.json')), `_state.json, ${why}`);
    assert.ok(rows.length > 0, path);
    for (const row of rows) {
      const trace = join(dir, 'example-flow', 'baseline', 'traces', `${String(row['caseId'])}_rep${String(header['sourceRep'])}.json`);
      assert.equal(row['traceSha256'], fileSha(trace), `${String(row['caseId'])}: its trace, ${why}`);
      const turns = JSON.parse(readFileSync(trace, 'utf8')) as { content: string }[];
      assert.equal(row['storedOutput'], turns[turns.length - 1]?.content, `${String(row['caseId'])}: its stored output, ${why}`);
      assert.equal(row['storedOutputSha256'], sha256Hex(row['storedOutput'] as string));
      // The grader that recorded the call is the grader file in the tree.
      const record = row['graderEvidence'] as { grader: { sha256: string } } | undefined;
      if (record !== undefined) assert.equal(record.grader.sha256, fileSha(join(root, GRADER_FILE)), `the grader file, ${why}`);
    }
  }
});

test('the fixture script refuses to run when a provider variable is set: it names the variable, never its value, and makes nothing', () => {
  const before = fileSha(join(dir, 'FIXTURES.sha256'));
  const VALUE = 'a-made-up-value-that-must-not-be-printed';
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'GEMINI_API_KEY']) {
    const out = mkdtempSync(join(work, 'out-'));
    // The output root and the scratch base are both outside the tree, so even a script that did run would write nothing into it.
    const r = spawnSync('bash', [join(dir, 'fixtures.sh')], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', [name]: VALUE, FIXTURES_OUT_ROOT: out, FIXTURES_SCRATCH_BASE: work } });
    assert.equal(r.status, 2, `${name}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`^fixtures\\.sh: refusing to run: these provider variables are set \\(names only\\): ${name} $`, 'm'), name);
    assert.ok(!r.stderr.includes(VALUE) && !r.stdout.includes(VALUE), name);
    assert.equal(r.stdout, '', `${name}: nothing was started`);
    assert.deepEqual(readdirSync(out), [], `${name}: nothing was made`);
  }
  assert.equal(fileSha(join(dir, 'FIXTURES.sha256')), before);
});
