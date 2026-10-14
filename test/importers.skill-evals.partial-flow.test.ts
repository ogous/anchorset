// A flow with a failed case and a cut case, through the three commands of the third importer: one case whose every attempt
// failed (error lines, no row) and one case whose answer was cut at the output cap in both reps. With those two cases
// left out of the cases file, the check lists them as excluded, the re-grade grades the rest against the local fake
// endpoint (127.0.0.1 only, no key but a dummy value), its header holds the excluded ids, and the imported run's
// packetSource names their count. With either case named in the cases file, every command refuses.
//
// The flow is written here, by hand, into a temp folder: synthetic customer-support refund-bot data only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parseRunArtifact, sha256Hex } from '../src/index.ts';
import { startFakeEndpoint } from '../examples/importers/fake-endpoint.ts';
import { main as checkMain } from '../examples/importers/skill-evals/check.ts';
import { main as importMain } from '../examples/importers/skill-evals/import.ts';
import { ownStderr } from './helpers.ts';

const root = join(import.meta.dirname, '..');
const dir = join(root, 'examples', 'importers', 'skill-evals');
const work = mkdtempSync(join(tmpdir(), 'anchorset-skill-partial-'));
after(() => rmSync(work, { recursive: true, force: true }));

const READING = 'one-json-object-boolean-pass/v1';
const DUMMY_KEY = 'dummy-key-for-local-fake-endpoint';
const SYSTEM = 'You answer refund requests for a shop that sells audio gear and office furniture.';

// ---- the flow: four cases, two reps ----------------------------------------------------------------------------------

type Slot = { id: string; rep: number; prompt: string; answer: string; stop: string; status: string };
const QUESTIONS: Record<string, string> = {
  'unopened-speaker': 'Order A-20311, the bookshelf speaker. It arrived 3 days ago and I have not opened the box. I would like my money back.',
  'no-order-number': 'My desk lamp flickers. I want a refund.',
  'bulk-desks': 'Order A-20977: twelve standing desks for our office. Four arrived scratched. Please list, desk by desk, what you will do.',
  'gift-wrap': 'Order A-20140. Can you refund the gift wrap only?',
};
const SLOTS: Slot[] = [
  { id: 'unopened-speaker', rep: 0, prompt: QUESTIONS['unopened-speaker'] as string, answer: 'Order A-20311 is unopened and within 14 days of delivery, so I have refunded it in full.', stop: 'end_turn', status: 'ok' },
  { id: 'unopened-speaker', rep: 1, prompt: QUESTIONS['unopened-speaker'] as string, answer: 'I have refunded order A-20311: the speaker is unopened and was delivered 3 days ago.', stop: 'end_turn', status: 'ok' },
  { id: 'no-order-number', rep: 0, prompt: QUESTIONS['no-order-number'] as string, answer: 'I can look into the lamp. Could you send me the order number first?', stop: 'end_turn', status: 'ok' },
  { id: 'no-order-number', rep: 1, prompt: QUESTIONS['no-order-number'] as string, answer: 'Please tell me the order number of the desk lamp, and I will check it.', stop: 'end_turn', status: 'ok' },
  // Cut at the output cap in both reps: the stored answer stops in the middle of a sentence.
  { id: 'bulk-desks', rep: 0, prompt: QUESTIONS['bulk-desks'] as string, answer: 'Desk 1: no action. Desk 2: no action. Desk 3: scratched, so a colleague will', stop: 'max_tokens', status: 'truncated' },
  { id: 'bulk-desks', rep: 1, prompt: QUESTIONS['bulk-desks'] as string, answer: 'I have passed order A-20977 to a colleague. Desk by desk: desk 1 is', stop: 'max_tokens', status: 'truncated' },
];

/** Writes the flow and returns its path. The rows are in the order a runner might finish them, not sorted. */
function writeFlow(name: string): string {
  const flow = join(work, name);
  mkdirSync(join(flow, 'baseline', 'traces'), { recursive: true });
  writeFileSync(join(flow, '_state.json'), `${JSON.stringify({ reps: 2, harness_sha: '1'.repeat(64) }, null, 2)}\n`);
  const order = [2, 4, 0, 5, 3, 1].map((i) => SLOTS[i] as Slot);
  writeFileSync(
    join(flow, 'baseline', 'results.jsonl'),
    order.map((s) => `${JSON.stringify({ prompt_id: s.id, rep: s.rep, prompt: s.prompt, attachments: [], model: 'example-system-model', stop_reason: s.stop, status: s.status, latency_s: 1.5 })}\n`).join(''),
  );
  // The fourth case never produced an output: one failed attempt per rep, and no row.
  writeFileSync(
    join(flow, 'baseline', 'errors.jsonl'),
    [0, 1].map((rep) => `${JSON.stringify({ prompt_id: 'gift-wrap', rep, failure_class: 'error', error: 'example: the call to the system timed out', retries: 2 })}\n`).join(''),
  );
  for (const s of SLOTS) {
    writeFileSync(join(flow, 'baseline', 'traces', `${s.id}_rep${s.rep}.json`), `${JSON.stringify([{ role: 'system', content: SYSTEM }, { role: 'user', content: s.prompt }, { role: 'assistant', content: s.answer }], null, 2)}\n`);
  }
  return flow;
}

const CASE = { klass: 'refund_policy', expect: 'pass' };
let counter = 0;
function casesFile(ids: readonly string[]): string {
  counter += 1;
  const path = join(work, `cases-${counter}.json`);
  writeFileSync(path, JSON.stringify(Object.fromEntries(ids.map((id) => [id, CASE]))));
  return path;
}
const MEASURED = ['no-order-number', 'unopened-speaker'];

type Cli = { code: number; out: string; err: string };
function inProcess(mainOf: (argv: readonly string[], io: { out: (s: string) => void; err: (s: string) => void }) => number, argv: readonly string[]): Cli {
  const out: string[] = [];
  const err: string[] = [];
  const code = mainOf(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const check = (flow: string, cases: string): Cli => inProcess(checkMain, ['--flow', flow, '--variant', 'baseline', '--cases', cases, '--reps', '2']);

/**
 * The real re-grade script as its own process, with nothing inherited: a dummy key, every proxy variable at a dead
 * local port, and the judge at the fake endpoint's address. Not `spawnSync`: the endpoint lives in this process.
 */
function regrade(flow: string, cases: string, rep: number, outPath: string, baseUrl: string): Promise<Cli> {
  const argv = [
    join(dir, 'regrade.ts'), '--flow', flow, '--variant', 'baseline', '--cases', cases, '--reps', '2', '--rep', String(rep), '--draws', '2',
    '--template', join(dir, 'template.txt'), '--criterion', join(dir, 'criterion.txt'), '--model', 'fake-judge-old', '--max-tokens', '256', '--temperature', '0',
    '--thinking', 'NOT_SENT', '--effort', 'NOT_SENT', '--max-reasks', '0', '--base-url', baseUrl, '--reading', 'one-json-object-boolean-pass/v1', '--out', outPath,
  ];
  const dead = 'http://127.0.0.1:9';
  const env = { ANTHROPIC_API_KEY: DUMMY_KEY, NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: dead, HTTP_PROXY: dead, https_proxy: dead, http_proxy: dead, ALL_PROXY: dead, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, out, err: ownStderr(err) }));
  });
}

// ---- the check ---------------------------------------------------------------------------------------------------------

test('check: with the failed case and the cut case left out of the cases file, the flow reads, both reps can be re-graded and both cases are listed as excluded', () => {
  const flow = writeFlow('flow-check');
  const r = check(flow, casesFile(MEASURED));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  const lines = r.out.split('\n');
  assert.deepEqual(lines.slice(1, 8), [
    'cases: 2 in the cases file; reps declared: 2',
    'rep 0: whole (2 finished answers, each with its trace); it can be re-graded with --rep 0',
    'rep 1: whole (2 finished answers, each with its trace); it can be re-graded with --rep 1',
    'reps that can be re-graded: 0, 1 (2 of 2)',
    'excluded cases (in the flow, not in the cases file; never graded, their traces not read): 2',
    // The rows are lines 2 and 4 of results.jsonl as written above; the error lines are the file's two lines.
    '  bulk-desks: results.jsonl line 2 (rep 0, not a finished answer); results.jsonl line 4 (rep 1, not a finished answer)',
    '  gift-wrap: no row; errors.jsonl line 1, 2',
  ]);
  // No error line is superseded: neither is of a slot of a stated case.
  assert.match(r.out, /^superseded error lines: 0$/m);
});

test('check: with either case named in the cases file the flow has no rep that can be re-graded, and the refusal says how to leave the case out', () => {
  const flow = writeFlow('flow-named');
  // The case that is cut in both reps: neither rep is whole.
  const cut = check(flow, casesFile([...MEASURED, 'bulk-desks']));
  assert.equal(cut.code, 2);
  assert.match(cut.err, /^REFUSED IMPORT_OUTPUT_UNFINISHED: 4 problem\(s\) in the flow: none of its 2 declared rep\(s\) is whole, so none can be re-graded/);
  assert.match(cut.err, /stop_reason "max_tokens", not "end_turn": the stored output is not a finished answer; to measure without this case, leave it out of cases\.json: it is then listed as excluded/);
  assert.match(cut.err, /^fields: bulk-desks#0, bulk-desks#1$/m);
  // The case with no row at all.
  const failed = check(flow, casesFile([...MEASURED, 'gift-wrap']));
  assert.equal(failed.code, 2);
  assert.match(failed.err, /^REFUSED IMPORT_CASE_MISSING: 1 problem\(s\) in the flow \(row profile skill-evals\/1\): gift-wrap: in cases\.json, but no row holds this id \(errors\.jsonl line 1, 2 records failed attempts at it\)/);
  assert.match(failed.err, /leave it out of cases\.json: it is then listed as excluded/);
  assert.match(failed.err, /^fields: gift-wrap$/m);
});

// ---- the re-grade and the import -----------------------------------------------------------------------------------------

test('re-grade and import: the two measured cases are graded against the fake endpoint, the header holds the two excluded ids, and the run\'s packetSource names their count', async () => {
  const flow = writeFlow('flow-regrade');
  const cases = casesFile(MEASURED);
  const logPath = join(work, 'requests.jsonl');
  const endpoint = await startFakeEndpoint({ port: 0, logPath });
  const baseUrl = `http://127.0.0.1:${endpoint.port}`;
  const outPath = join(work, 'partial.regrade.jsonl');
  let graded: Cli;
  let refusedCut: Cli;
  let refusedFailed: Cli;
  const cutOut = join(work, 'cut.regrade.jsonl');
  const failedOut = join(work, 'failed.regrade.jsonl');
  try {
    graded = await regrade(flow, cases, 1, outPath, baseUrl);
    // With either case named in the cases file the re-grade refuses before any call and writes nothing.
    refusedCut = await regrade(flow, casesFile([...MEASURED, 'bulk-desks']), 1, cutOut, baseUrl);
    refusedFailed = await regrade(flow, casesFile([...MEASURED, 'gift-wrap']), 1, failedOut, baseUrl);
  } finally {
    await endpoint.close();
  }
  assert.equal(graded.code, 0, graded.err);
  assert.match(graded.out, /^slots graded: 4 of 4, 4 asks made \(0 re-asks; at most 0 per slot\), in the order case id then draw \(source rep 1, each stored output graded 2 times\)$/m);
  assert.match(graded.out, /^excluded cases \(in the flow, not in the cases file; not graded\): 2 \(bulk-desks, gift-wrap\)$/m);
  assert.equal(refusedCut.code, 2);
  assert.match(refusedCut.err, /^REFUSED IMPORT_OUTPUT_UNFINISHED: 2 problem\(s\) in rep 1 of the flow, which is not whole /);
  assert.match(refusedCut.err, /^fields: bulk-desks#1$/m);
  assert.equal(existsSync(cutOut), false);
  assert.equal(refusedFailed.code, 2);
  assert.match(refusedFailed.err, /^REFUSED IMPORT_CASE_MISSING: /);
  assert.equal(existsSync(failedOut), false);
  // The endpoint saw the four calls of the one re-grade that ran, and nothing of an excluded case was sent.
  const requests = readFileSync(logPath, 'utf8').split('\n').filter((l) => l !== '');
  assert.equal(requests.length, 4);
  for (const text of [QUESTIONS['bulk-desks'], QUESTIONS['gift-wrap'], 'Desk 1: no action']) assert.equal(readFileSync(logPath, 'utf8').includes(text as string), false, text);

  // The file: a header that declares the excluded cases, sorted, with their count, and four rows.
  const fileText = readFileSync(outPath, 'utf8');
  const [header, ...rows] = fileText.slice(0, -1).split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.ok(header);
  assert.equal(header['schema'], 'example.skill-evals-regrade/v4');
  // The flow was given by its path in a temp folder: the file holds no path of this machine.
  assert.equal('flow' in header, false);
  assert.equal(fileText.includes(flow), false);
  assert.deepEqual(header['excludedCaseIds'], ['bulk-desks', 'gift-wrap']);
  assert.equal(header['excludedCaseCount'], 2);
  assert.equal(header['sourceRep'], 1);
  assert.equal(header['slotCount'], 4);
  assert.equal(header['harnessSha'], '1'.repeat(64));
  assert.deepEqual(rows.map((r) => `${String(r['caseId'])}#${String(r['draw'])}`), ['no-order-number#0', 'no-order-number#1', 'unopened-speaker#0', 'unopened-speaker#1']);
  assert.equal(rows.every((r) => 'graderEvidence' in r && !('error' in r)), true);
  assert.equal(rows[0]?.['storedOutput'], 'Please tell me the order number of the desk lamp, and I will check it.');
  assert.equal(fileText.includes(DUMMY_KEY), false);

  // The import, with the flow read again: the excluded cases are computed again and found equal.
  const runPath = join(work, 'partial.run.json');
  const imported = inProcess(importMain, ['--in', outPath, '--cases', cases, '--bar', join(dir, 'bar.json'), '--out', runPath, '--reading', READING, '--flow', flow]);
  assert.equal(imported.code, 0, imported.err);
  assert.match(imported.out, /^excluded cases: 2 \(bulk-desks, gift-wrap\) \(cases the flow held and the cases file left out; computed again from the flow and found equal; the run measures the cases of the cases file only\)$/m);
  const run = parseRunArtifact(JSON.parse(readFileSync(runPath, 'utf8')));
  assert.equal(
    run.packetSource,
    `computed at import from a skill-evals re-grade file sha256:${sha256Hex(readFileSync(outPath))} (sourceVersion: UNKNOWN; rowProfile: skill-evals/1, pinned by the importer; written against CLI 2.1.288; no version is read; source rep 1 of 2; results.jsonl sha256:${sha256Hex(readFileSync(join(flow, 'baseline', 'results.jsonl')))}; _state.json sha256:${sha256Hex(readFileSync(join(flow, '_state.json')))}; harness_sha: ${'1'.repeat(64)}; cases of the flow excluded by the cases file: 2; flow read again: yes): the question, and the whole assistant turn as the answer`,
  );
  // The run measures the two stated cases, two draws each; an excluded case is nowhere in it but in that count.
  assert.deepEqual(run.cases.map((c) => c.id).sort(), MEASURED);
  assert.deepEqual(run.draws.map((d) => `${d.caseId}#${d.drawIndex}`), ['no-order-number#0', 'no-order-number#1', 'unopened-speaker#0', 'unopened-speaker#1']);
  assert.equal(run.identity.drawsPerCase, 2);
  assert.equal(readFileSync(runPath, 'utf8').includes('bulk-desks'), false);
  assert.equal(readFileSync(runPath, 'utf8').includes('gift-wrap'), false);

  // The same file under a cases file that names an excluded case is refused: the header was written without it.
  const named = inProcess(importMain, ['--in', outPath, '--cases', casesFile([...MEASURED, 'bulk-desks']), '--bar', join(dir, 'bar.json'), '--out', join(work, 'named.run.json'), '--reading', READING, '--flow', flow]);
  assert.equal(named.code, 2);
  assert.match(named.err, /^REFUSED IMPORT_EVIDENCE: .*excludedCaseIds: "bulk-desks" is in cases\.json/m);
  assert.equal(existsSync(join(work, 'named.run.json')), false);
});
