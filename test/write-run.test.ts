// `anchorset write-run`: a run file written from a run-input manifest (anchorset.run-input/v1) and one JSON line per
// attempt, through src/runinput.ts. What this file pins: what the command writes (every value it states, "UNKNOWN" for
// the rest, nothing defaulted), that what it writes is a run the library and the gate read, every refusal of an input
// that is not in its format (exit 65, nothing written, no temporary file left), the usage errors (exit 64), and that text
// read from the files cannot forge a printed line. It holds every case of the example script's test that the command
// replaced. Two values are pinned by independent recomputation (labelled where they stand); no statistic is computed.
// Fixtures are synthetic: a refund bot.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { IDENTITY_FIELDS, parseRunArtifact, REPORT_SCHEMAS } from '../src/index.ts';
import type { RunArtifact } from '../src/index.ts';

const root = join(import.meta.dirname, '..');
const cli = join(root, 'src', 'cli.ts');
const work = mkdtempSync(join(tmpdir(), 'anchorset-write-run-'));
after(() => rmSync(work, { recursive: true, force: true }));
const node = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: root });

const barText = readFileSync(join(root, 'examples', 'run-format', 'bar.json'), 'utf8');
type Obj = Record<string, unknown>;
const SENT = (maxOutputTokens: number) => ({ sent: { endpoint: 'example-provider:messages', temperature: 0, maxOutputTokens }, everyOtherKey: 'NOT_SENT' });
const SYSTEM = { modelRequested: 'bot-model', modelServed: 'bot-model-2026-01-15', prompt: { file: 'system_prompt.txt' }, tools: { json: [] }, harnessVersion: 'refund-eval 1.4.0', settings: SENT(512) };
const JUDGE = { modelRequested: 'judge-model', modelServed: 'judge-model-2026-02-01', definition: { file: 'judge_prompt.txt' }, harnessVersion: 'refund-eval 1.4.0', settings: SENT(256), gradedReplyStop: 'end' };
/** A judged run with every identity field stated, its call shapes and judge stop stated by the two declarations. */
const manifest = (over: Obj = {}): Obj => ({
  schema: 'anchorset.run-input/v1',
  origin: 'produced',
  graded: 'by-judge',
  bar: 'bar.json',
  caseCount: 3,
  sameForEveryCase: { class: 'reply_quality' },
  expectByClass: { reply_quality: '4' },
  rubric: { file: 'rubric.md' },
  seed: 'NO_SEED',
  system: SYSTEM,
  judge: JUDGE,
  ...over,
});
const without = (o: Obj, ...keys: string[]): Obj => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const byCode = (over: Obj = {}): Obj => without(manifest({ graded: 'by-code', ...over }), 'judge');
const IDS = ['q01', 'q02', 'q03'];
const row = (id: string, over: Obj = {}): Obj => ({ case: id, grade: '4', answer: `Reply to ${id}.`, stop: 'end', input: { message: `question ${id}` }, ...over });
const rows = (over: (id: string) => Obj = () => ({})): Obj[] => IDS.map((id) => row(id, over(id)));
const jsonl = (rs: readonly Obj[]): string => `${rs.map((r) => JSON.stringify(r)).join('\n')}\n`;

let n = 0;
/** A folder holding the manifest, the rows, the bar and the three texts the manifest names, and any extra file. */
function setup(m: unknown, grades: string | Uint8Array, extra: Record<string, string | Uint8Array> = {}): string {
  const dir = join(work, `case-${(n += 1)}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'bar.json'), barText);
  writeFileSync(join(dir, 'rubric.md'), '# Reply quality\n- 4: answers the question correctly.\n');
  writeFileSync(join(dir, 'system_prompt.txt'), 'You are the support assistant of an online shop.\n');
  writeFileSync(join(dir, 'judge_prompt.txt'), 'Grade the reply from 1 to 5.\n');
  writeFileSync(join(dir, 'manifest.json'), typeof m === 'string' ? m : JSON.stringify(m));
  writeFileSync(join(dir, 'grades.jsonl'), grades);
  for (const [name, body] of Object.entries(extra)) writeFileSync(join(dir, name), body);
  return dir;
}
const writeRun = (dir: string, extra: string[] = []) => node(['write-run', '--manifest', join(dir, 'manifest.json'), '--grades', join(dir, 'grades.jsonl'), '--out', join(dir, 'run.json'), ...extra]);
const written = (dir: string): RunArtifact => parseRunArtifact(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')));
const ok = (m: unknown, grades: string | Uint8Array, extra: Record<string, string | Uint8Array> = {}): { dir: string; run: RunArtifact; stdout: string } => {
  const dir = setup(m, grades, extra);
  const r = writeRun(dir);
  assert.equal(r.status, 0, r.stderr);
  return { dir, run: written(dir), stdout: r.stdout };
};
const gateSelf = (dir: string) => node(['gate', '--baseline', join(dir, 'run.json'), '--candidate', join(dir, 'run.json'), '--bar', join(dir, 'bar.json')]);
const sha256 = (x: string | Uint8Array): string => createHash('sha256').update(x).digest('hex');

describe('write-run: what it writes is a run the library accepts, and it says what it does not know', () => {
  it('everything stated, one grade per answer: the file parses, states every identity field, and the gate admits it against itself (exit 0)', () => {
    const { dir, run, stdout } = ok(manifest(), jsonl(rows()));
    assert.deepEqual(IDENTITY_FIELDS.filter((f) => run.identity[f] === 'UNKNOWN'), []);
    assert.equal(run.identity.drawsPerCase, 1);
    assert.equal(run.draws.length, 3);
    assert.match(stdout, /draws per case 1 \(one grade per answer\)/);
    assert.match(stdout, /gate, this run against itself: would admit it/);
    assert.equal(gateSelf(dir).status, 0);
    assert.equal(node(['validate', '--run', join(dir, 'run.json'), '--bar', join(dir, 'bar.json')]).status, 0);
  });

  it('the minimal declaration (a judged run stating only judge.modelRequested and judge.definition): exit 0, the exact list of unknown fields, the gate refuses naming the stops, and validate lists the stops and the fields together', () => {
    const minimal = { schema: 'anchorset.run-input/v1', origin: 'produced', graded: 'by-judge', bar: 'bar.json', caseCount: 3, sameForEveryCase: { class: 'reply_quality' }, expectByClass: { reply_quality: '4' }, judge: { modelRequested: 'judge-model', definition: { file: 'judge_prompt.txt' } } };
    const noStops = rows(() => ({ judgeStop: 'end' })).map((r) => without(r, 'stop'));
    const { dir, run, stdout } = ok(minimal, jsonl(noStops));
    const unknown = IDENTITY_FIELDS.filter((f) => run.identity[f] === 'UNKNOWN');
    assert.deepEqual(unknown, ['rubricHash', 'systemModelRequested', 'systemModelServed', 'systemCallShapeHash', 'systemPromptHash', 'systemToolsHash', 'systemHarnessVersion', 'judgeModelServed', 'judgeCallShapeHash', 'judgeHarnessVersion', 'seed']);
    assert.equal(run.identity.seed, 'UNKNOWN', 'a seed is never defaulted');
    assert.ok(run.draws.every((d) => d.attempts.every((a) => a.kind !== 'graded' || a.systemStop === 'UNKNOWN')), 'a stop the row does not state is UNKNOWN, never end');
    assert.match(stdout, new RegExp(`identity fields "UNKNOWN" \\(11\\): ${unknown.join(', ')}`));
    const g = gateSelf(dir);
    assert.equal(g.status, 2, g.stderr);
    assert.match(g.stderr, /REFUSED IDENTITY_GAP\n {2}fields: systemStop\[q01#0\], systemStop\[q02#0\], systemStop\[q03#0\]/);
    const v = node(['validate', '--run', join(dir, 'run.json'), '--bar', join(dir, 'bar.json')]);
    assert.equal(v.status, 2, v.stderr);
    assert.match(v.stdout, /IDENTITY_GAP {2}fields: systemStop\[q01#0\], systemStop\[q02#0\], systemStop\[q03#0\]/);
    // The text lists the first ten fields of a refusal and how many more; --json holds every one.
    assert.match(v.stdout, new RegExp(`IDENTITY_GAP {2}fields: ${unknown.slice(0, 10).join(', ')}, and 1 more`));
    const j = JSON.parse(node(['validate', '--run', join(dir, 'run.json'), '--bar', join(dir, 'bar.json'), '--json']).stdout) as { gate: { refusals: { code: string; fields: string[] }[] } };
    assert.deepEqual(j.gate.refusals.map((x) => x.fields), [['systemStop[q01#0]', 'systemStop[q02#0]', 'systemStop[q03#0]'], ['systemStop[q01#0]', 'systemStop[q02#0]', 'systemStop[q03#0]'], unknown]);
  });

  it('graded by code: the judge fields and the packets are NO_JUDGE, and the gate admits it', () => {
    const { dir, run } = ok(byCode(), jsonl(rows()));
    assert.equal(run.identity.judgeDefinitionHash, 'NO_JUDGE');
    assert.equal(run.callShapes.judge, 'NO_JUDGE');
    assert.equal(run.packetBasis, 'NO_JUDGE');
    assert.ok(run.draws.every((d) => d.attempts.every((a) => a.kind !== 'graded' || (a.judgeStop === 'NO_JUDGE' && a.packetHash === 'NO_JUDGE'))));
    assert.equal(gateSelf(dir).status, 0);
  });

  it('a judged run with no packets block: the basis and every packet hash are UNKNOWN; gate admits it, flips refuses it for its packets, and --rejudge-of does not compute the split (PACKET_MISMATCH) while the verdict stands', () => {
    const twoDraws = IDS.flatMap((id) => [0, 1].map((d) => row(id, { draw: d, answer: `Reply to ${id}, draw ${d}.` })));
    const { dir, run } = ok(manifest({ drawsPerCase: 2 }), jsonl(twoDraws));
    assert.equal(run.packetBasis, 'UNKNOWN');
    assert.ok(run.draws.every((d) => d.attempts.every((a) => a.kind !== 'graded' || a.packetHash === 'UNKNOWN')));
    assert.equal(gateSelf(dir).status, 0);
    const f = node(['flips', '--run', join(dir, 'run.json')]);
    assert.equal(f.status, 2, f.stderr);
    assert.match(f.stderr, /REFUSED IDENTITY_GAP\n {2}fields: packetBasis/);
    const p = join(dir, 'run.json');
    const rj = node(['gate', '--baseline', p, '--candidate', p, '--bar', join(dir, 'bar.json'), '--rejudge-of', p]);
    assert.equal(rj.status, 0, rj.stderr);
    assert.match(rj.stdout, /judge-controlled: not computed \(PACKET_MISMATCH: packetBasis/);
  });

  it('recorded packets: every judge row carries its packetHash, and the run states the basis', () => {
    const { run } = ok(manifest({ packets: { basis: 'recorded' } }), jsonl(rows((id) => ({ packetHash: sha256(`packet ${id}`) }))));
    assert.equal(run.packetBasis, 'recorded');
    assert.equal(run.packetSource, undefined);
    const declared = ok(manifest({ packets: { basis: 'declared', source: 'the case message and the reply, as shown' } }), jsonl(rows((id) => ({ packetHash: sha256(`packet ${id}`) })))).run;
    assert.deepEqual([declared.packetBasis, declared.packetSource], ['declared', 'the case message and the reply, as shown']);
  });

  it('a truncated row carries its answer, and its output hash is the sha256 of that answer, not of the failure note', () => {
    const cut = 'a reply cut at its cap';
    const { run } = ok(manifest(), jsonl(rows((id) => (id === 'q02' ? { grade: undefined, answer: cut, failed: 'truncated', detail: '', stop: 'max-tokens' } : {})).map((r) => JSON.parse(JSON.stringify(r)) as Obj)));
    const a = run.draws.find((d) => d.caseId === 'q02')?.attempts[0];
    assert.ok(a !== undefined && a.kind === 'failed');
    assert.equal(a.outputHash, createHash('sha256').update(cut, 'utf8').digest('hex'));
  });

  it('three draws with system and judge retries and each failure kind: the last attempt is the outcome, earlier ones are unmeasured, a failed row names its stop', () => {
    const A = 'answer A';
    const lines: Obj[] = [
      { case: 'q01', draw: 0, attempt: 0, unmeasured: 'timeout', role: 'system', detail: 'no response within 30000 ms' },
      { case: 'q01', draw: 0, attempt: 1, grade: '4', answer: 'a', stop: 'end' },
      { case: 'q01', draw: 1, attempt: 0, unmeasured: 'server-error', role: 'judge', detail: 'HTTP 500', answer: A, stop: 'end' },
      { case: 'q01', draw: 1, attempt: 1, grade: '5', answer: A, stop: 'end' },
      { case: 'q01', draw: 2, attempt: 0, failed: 'truncated', detail: 'cut at 512 tokens', answer: 'a reply cut at its cap', stop: 'max-tokens' },
      { case: 'q02', draw: 0, attempt: 0, grade: '4', answer: 'b', stop: 'end' },
      { case: 'q02', draw: 1, attempt: 0, failed: 'client-error', detail: 'HTTP 400', stop: 'NOT_SENT' },
      { case: 'q02', draw: 2, attempt: 0, failed: 'system-error', detail: 'the bot returned an error', stop: 'NOT_SENT' },
      { case: 'q03', draw: 0, attempt: 0, unmeasured: 'truncated', role: 'judge', detail: 'judge reply cut', answer: 'c', stop: 'end' },
      { case: 'q03', draw: 0, attempt: 1, grade: '4', answer: 'c', stop: 'end' },
      { case: 'q03', draw: 1, attempt: 0, grade: '3', answer: 'd', stop: 'end' },
      { case: 'q03', draw: 2, attempt: 0, unmeasured: 'parse-failure', role: 'judge', detail: 'not one grade', answer: 'e', stop: 'end' },
    ].map((r) => ({ ...r, input: { message: `question ${String(r['case'])}` } }));
    // Rows in any order: the run orders them by case, draw and attempt.
    const { run, stdout } = ok(manifest({ drawsPerCase: 3 }), jsonl([...lines].reverse()));
    assert.equal(run.identity.drawsPerCase, 3);
    assert.deepEqual(run.draws.map((d) => `${d.caseId}#${d.drawIndex}:${d.attempts.map((a) => a.kind).join(',')}`), [
      'q01#0:unmeasured,graded', 'q01#1:unmeasured,graded', 'q01#2:failed', 'q02#0:graded', 'q02#1:failed', 'q02#2:failed', 'q03#0:unmeasured,graded', 'q03#1:graded', 'q03#2:unmeasured',
    ]);
    assert.match(stdout, /slots with no grade: 1 \(q03#2 judge parse-failure\)/);
  });

  it('a slot the rows do not hold is not invented: with a case file of three cases and rows for two, the run holds the third case with no draw, and the gate refuses it as a baseline (INCOMPLETE_RUN)', () => {
    const cases = `${IDS.map((id) => JSON.stringify({ id, input: { message: `question ${id}` } })).join('\n')}\n`;
    const { dir, run, stdout } = ok(manifest({ cases: 'cases.jsonl' }), jsonl(rows().slice(0, 2).map((r) => without(r, 'input'))), { 'cases.jsonl': cases });
    assert.deepEqual(run.cases.map((c) => c.id), IDS);
    assert.equal(run.draws.length, 2);
    assert.match(stdout, /slots 3 · recorded 2 · missing 1 \(q03#0\)/);
    const g = gateSelf(dir);
    assert.equal(g.status, 2);
    assert.match(g.stderr, /REFUSED INCOMPLETE_RUN\n {2}fields: q03#0/);
  });

  it('the same input twice gives byte-identical files; answer and answerHash give the same run', () => {
    const a = ok(manifest(), jsonl(rows()));
    const b = ok(manifest(), jsonl(rows()));
    assert.equal(readFileSync(join(a.dir, 'run.json'), 'utf8'), readFileSync(join(b.dir, 'run.json'), 'utf8'));
    // Independent recomputation of the output hash: the sha256 of the answer's UTF-8 bytes, by node:crypto.
    const hashed = ok(manifest(), jsonl(rows((id) => ({ answer: undefined, answerHash: sha256(`Reply to ${id}.`) })).map((r) => without(r, 'answer'))));
    assert.equal(readFileSync(join(hashed.dir, 'run.json'), 'utf8'), readFileSync(join(a.dir, 'run.json'), 'utf8'));
  });

  it('hashed values: {json: []} is the documented no-tools hash and {file} is the sha256 of the file\'s bytes, unchanged (each an independent recomputation)', () => {
    const { run, dir } = ok(manifest(), jsonl(rows()));
    // The canonical JSON of [] is the two characters "[]"; its sha256, by node:crypto, and the value the run format documents.
    assert.equal(run.identity.systemToolsHash, sha256('[]'));
    assert.equal(run.identity.systemToolsHash, '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
    assert.equal(run.identity.systemPromptHash, sha256(readFileSync(join(dir, 'system_prompt.txt'))));
    assert.equal(run.identity.rubricHash, sha256(readFileSync(join(dir, 'rubric.md'))));
    // A file that only changes its line ends is another file.
    const crlf = ok(manifest(), jsonl(rows()), { 'system_prompt.txt': 'You are the support assistant of an online shop.\r\n' }).run;
    assert.notEqual(crlf.identity.systemPromptHash, run.identity.systemPromptHash);
    // {files: [...]} is the hash of the list of the files' sha256s, in the order given: a recomputation of the canonical JSON of that list.
    const files = ok(manifest({ judge: { ...JUDGE, definition: { files: ['judge_prompt.txt', 'rubric.md'] } } }), jsonl(rows())).run;
    const list = [sha256('Grade the reply from 1 to 5.\n'), sha256('# Reply quality\n- 4: answers the question correctly.\n')];
    assert.equal(files.identity.judgeDefinitionHash, sha256(`["${list[0]}","${list[1]}"]`));
    // {sha256} is written as given.
    const given = 'a'.repeat(64);
    assert.equal(ok(manifest({ rubric: { sha256: given } }), jsonl(rows())).run.identity.rubricHash, given);
  });

  it('settings declaration: {sent, everyOtherKey: "NOT_SENT"} expands to the whole call shape, every key not sent "NOT_SENT" and extras {}; absent settings are every key "UNKNOWN"', () => {
    const { run } = ok(manifest(), jsonl(rows()));
    const s = run.callShapes.system as unknown as Obj;
    assert.equal(s['schema'], 'anchorset.callshape/v1');
    assert.deepEqual([s['endpoint'], s['temperature'], s['maxOutputTokens'], s['extras']], ['example-provider:messages', 0, 512, {}]);
    const notSent = Object.entries(s).filter(([k]) => !['schema', 'endpoint', 'temperature', 'maxOutputTokens', 'extras'].includes(k));
    assert.equal(notSent.length, 19);
    assert.ok(notSent.every(([, v]) => v === 'NOT_SENT'), JSON.stringify(notSent));
    assert.equal((run.callShapes.judge as unknown as Obj)['maxOutputTokens'], 256);
    const absent = ok(manifest({ system: without(SYSTEM, 'settings') }), jsonl(rows())).run;
    assert.equal(absent.identity.systemCallShapeHash, 'UNKNOWN');
    assert.ok(Object.entries(absent.callShapes.system).every(([k, v]) => k === 'schema' || v === 'UNKNOWN'));
    // A whole call shape, inline or in a file, is taken as it is.
    const whole = { ...(run.callShapes.system as unknown as Obj) };
    assert.equal(ok(manifest({ system: { ...SYSTEM, settings: whole } }), jsonl(rows())).run.identity.systemCallShapeHash, run.identity.systemCallShapeHash);
    assert.equal(ok(manifest({ system: { ...SYSTEM, settings: { file: 'shape.json' } } }), jsonl(rows()), { 'shape.json': JSON.stringify(whole) }).run.identity.systemCallShapeHash, run.identity.systemCallShapeHash);
  });

  it('judge-stop declaration: judge.gradedReplyStop is every graded row\'s judge stop; without it each graded row states its own', () => {
    const { run } = ok(manifest(), jsonl(rows()));
    assert.ok(run.draws.every((d) => d.attempts.every((a) => a.kind !== 'graded' || a.judgeStop === 'end')));
    const perRow = ok(manifest({ judge: without(JUDGE, 'gradedReplyStop') }), jsonl(rows(() => ({ judgeStop: 'tool-use' })))).run;
    assert.ok(perRow.draws.every((d) => d.attempts.every((a) => a.kind !== 'graded' || a.judgeStop === 'tool-use')));
  });

  it('prints each declaration it used as the user\'s statement, in the text and in --json', () => {
    const { stdout } = ok(manifest(), jsonl(rows()));
    assert.match(stdout, /stated by you about your harness: system\.settings: the harness sent endpoint, temperature, maxOutputTokens, and no other call-shape key \("NOT_SENT"\), with no provider extras \(\{\}\)/);
    assert.match(stdout, /stated by you about your harness: judge\.settings: /);
    assert.match(stdout, /stated by you about your harness: judge\.gradedReplyStop: the judge's reply stopped with "end" on every graded row/);
    const plain = ok(manifest({ system: without(SYSTEM, 'settings'), judge: without(JUDGE, 'settings', 'gradedReplyStop') }), jsonl(rows(() => ({ judgeStop: 'end' }))));
    assert.doesNotMatch(plain.stdout, /stated by you/);
    const dir = setup(manifest(), jsonl(rows()));
    const j = JSON.parse(writeRun(dir, ['--json']).stdout) as { declarations: { key: string }[] };
    assert.deepEqual(j.declarations.map((d) => d.key), ['system.settings', 'judge.settings', 'judge.gradedReplyStop']);
  });

  it('--json: the report names its contract and the tool first, and holds the file\'s sha256, every input by sha256, the facts and the gate\'s admission', () => {
    const dir = setup(manifest({ seed: 'UNKNOWN' }), jsonl(rows()));
    const r = writeRun(dir, ['--json']);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout) as Obj;
    assert.deepEqual(Object.keys(j).slice(0, 2), ['schema', 'tool']);
    assert.equal(j['schema'], REPORT_SCHEMAS['write-run']);
    assert.equal(j['schema'], 'anchorset.write-run-report/v1');
    assert.deepEqual([j['kind'], j['origin'], j['input'], j['exitCode'], j['rows'], j['cases'], j['drawsPerCase'], j['packetBasis']], ['written', 'produced', 'anchorset.run-input/v1', 0, 3, 3, 1, 'UNKNOWN']);
    assert.equal(j['fileSha256'], sha256(readFileSync(join(dir, 'run.json'))));
    assert.deepEqual((j['inputs'] as { role: string }[]).map((x) => x.role), ['manifest', 'grades', 'bar', 'rubric', 'system.prompt', 'judge.definition']);
    assert.deepEqual(j['unknownIdentityFields'], ['seed']);
    const gate = j['gate'] as { admitted: boolean; refusals: { code: string; fields: string[] }[]; notChecked: unknown[] };
    assert.equal(gate.admitted, false);
    assert.deepEqual(gate.refusals.map((x) => [x.code, x.fields]), [['IDENTITY_GAP', ['seed']]]);
  });
});

describe('write-run: an input that is not in its format is refused (exit 65), every problem with its place, and nothing is written', () => {
  const refused = (label: string, m: unknown, grades: string | Uint8Array, words: RegExp, extra: Record<string, string | Uint8Array> = {}): void => {
    it(label, () => {
      const dir = setup(m, grades, extra);
      const r = writeRun(dir);
      assert.equal(r.status, 65, r.stderr + r.stdout);
      assert.match(r.stderr, words);
      assert.match(r.stderr, /^anchorset: invalid input \(/m);
      assert.equal(existsSync(join(dir, 'run.json')), false);
      assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
      assert.equal(r.stdout, '');
    });
  };
  const good = jsonl(rows());
  // The manifest.
  refused('a wrong schema', manifest({ schema: 'anchorset.run-input/v0' }), good, /manifest\.schema: must be "anchorset\.run-input\/v1"/);
  refused('an unknown key', manifest({ vibe: 'good' }), good, /manifest\.vibe: unknown key/);
  refused('an identity field by its own name, with where it is stated', manifest({ systemModelServed: 'x' }), good, /manifest\.systemModelServed: unknown key; state it as system\.modelServed/);
  refused('origin missing', without(manifest(), 'origin'), good, /manifest\.origin: is required; it must be "produced"[^\n]*docs\/IMPORTERS\.md/);
  refused('origin "converted": a result file of another tool goes through its importer', manifest({ origin: 'converted' }), good, /manifest\.origin: is "converted"; it must be "produced": write-run reads only rows that your own eval code wrote\. A result file of another tool goes through that tool's importer/);
  refused('origin of another value', manifest({ origin: 'imported' }), good, /manifest\.origin: is "imported"/);
  refused('graded missing', without(manifest(), 'graded'), good, /manifest\.graded: is required/);
  refused('a judge block in a run graded by code', manifest({ graded: 'by-code' }), good, /manifest\.judge: a run graded by code has no judge/);
  refused('a derived field stated (the bar\'s hash)', manifest({ barHash: 'a'.repeat(64) }), good, /manifest\.barHash: the run derives this from what it holds; state the things it comes from, not the hash/);
  refused('a derived field stated (a call-shape hash, in its block)', manifest({ system: { ...SYSTEM, systemCallShapeHash: 'a'.repeat(64) } }), good, /manifest\.system\.systemCallShapeHash: the run derives this/);
  refused('a value that reads as a gap', manifest({ system: { ...SYSTEM, modelServed: 'n/a' } }), good, /manifest\.system\.modelServed: "n\/a" reads as a gap/);
  refused('null', manifest({ seed: null }), good, /manifest\.seed: null is not allowed/);
  refused('a bad seed', manifest({ seed: -1 }), good, /manifest\.seed: must be a whole number from 0 to 4294967295/);
  refused('a bar file that cannot be read', manifest({ bar: 'no-such-bar.json' }), good, /cannot read no-such-bar\.json, named in /);
  refused('a named file that cannot be read', manifest({ rubric: { file: 'no-such-rubric.md' } }), good, /cannot read no-such-rubric\.md/);
  refused('a bar file that is not a bar', manifest({ bar: 'rubric.md' }), good, /rubric\.md: /);
  refused('a partial settings object: the missing keys are named, never filled in', manifest({ system: { ...SYSTEM, settings: { schema: 'anchorset.callshape/v1', endpoint: 'x', temperature: 0 } } }), good, /manifest\.system\.settings\.apiVersion: missing[\s\S]*manifest\.system\.settings\.extras: missing/);
  refused('a bad settings value (the call shape\'s own check)', manifest({ system: { ...SYSTEM, settings: { sent: { endpoint: 'x', temperature: 7 }, everyOtherKey: 'NOT_SENT' } } }), good, /manifest\.system\.settings\.temperature: must be a number in \[0, 2\]/);
  refused('a settings declaration: a key in "sent" that is not a call-shape key', manifest({ system: { ...SYSTEM, settings: { sent: { endpoint: 'x', max_tokens: 5 }, everyOtherKey: 'NOT_SENT' } } }), good, /manifest\.system\.settings\.sent\.max_tokens: not a key of a call shape/);
  refused('a settings declaration: a "sent" value of NOT_SENT', manifest({ system: { ...SYSTEM, settings: { sent: { endpoint: 'x', topP: 'NOT_SENT' } , everyOtherKey: 'NOT_SENT' } } }), good, /manifest\.system\.settings\.sent\.topP: "sent" lists what was sent/);
  refused('a settings declaration: a "sent" value of UNKNOWN', manifest({ judge: { ...JUDGE, settings: { sent: { endpoint: 'UNKNOWN' }, everyOtherKey: 'NOT_SENT' } } }), good, /manifest\.judge\.settings\.sent\.endpoint: "sent" lists what was sent/);
  refused('a settings declaration: UNKNOWN inside a "sent" value', manifest({ system: { ...SYSTEM, settings: { sent: { endpoint: 'x', responseFormat: { kind: 'UNKNOWN' } }, everyOtherKey: 'NOT_SENT' } } }), good, /manifest\.system\.settings\.sent\.responseFormat: holds "UNKNOWN"/);
  refused('a settings declaration: everyOtherKey that is not NOT_SENT', manifest({ system: { ...SYSTEM, settings: { sent: { endpoint: 'x' }, everyOtherKey: 'UNKNOWN' } } }), good, /manifest\.system\.settings\.everyOtherKey: must be "NOT_SENT"/);
  refused('a settings declaration: another shape', manifest({ system: { ...SYSTEM, settings: { sent: { endpoint: 'x' }, everyOtherKey: 'NOT_SENT', also: 1 } } }), good, /manifest\.system\.settings\.also: unknown key/);
  refused('a settings declaration with no "sent"', manifest({ system: { ...SYSTEM, settings: { everyOtherKey: 'NOT_SENT' } } }), good, /manifest\.system\.settings\.sent: must be an object/);
  refused('a settings declaration that leaves the endpoint out (a call always has one)', manifest({ system: { ...SYSTEM, settings: { sent: { temperature: 0 }, everyOtherKey: 'NOT_SENT' } } }), good, /manifest\.system\.settings\.endpoint: a call always has an endpoint/);
  refused('judge.gradedReplyStop that is not end or tool-use', manifest({ judge: { ...JUDGE, gradedReplyStop: 'max-tokens' } }), good, /manifest\.judge\.gradedReplyStop: must be "end" or "tool-use"/);
  refused('packets "declared" without a source', manifest({ packets: { basis: 'declared' } }), jsonl(rows(() => ({ packetHash: 'a'.repeat(64) }))), /manifest\.packets\.source: required with "declared"/);
  refused('packets in a run graded by code', byCode({ packets: { basis: 'recorded' } }), good, /manifest\.packets: a run graded by code/);
  refused('drawsPerCase with no draw column', manifest({ drawsPerCase: 2 }), good, /manifest\.drawsPerCase: is given, but no row carries "draw"/);
  refused('no drawsPerCase with a draw column', manifest(), jsonl(rows(() => ({ draw: 0 }))), /manifest\.drawsPerCase: is required when the rows carry "draw"/);
  refused('a caseCount that differs, naming both numbers', manifest({ caseCount: 4 }), good, /manifest\.caseCount: is 4, but the rows name 3 cases/);
  refused('no caseCount', without(manifest(), 'caseCount'), good, /manifest\.caseCount: is required/);
  refused('expectByClass missing a class that holds a case', manifest({ expectByClass: { other: '4' } }), good, /"other" is not a class of the bar[\s\S]*names no expected label for class "reply_quality"/);
  refused('a manifest that is not JSON', '{ not json', good, /manifest\.json: /);
  // The rows.
  refused('a blank line inside the rows', manifest(), `${JSON.stringify(row('q01'))}\n\n${JSON.stringify(row('q02'))}\n${JSON.stringify(row('q03'))}\n`, /grades\.jsonl line 2: a blank line/);
  refused('a line that is not JSON', manifest(), `${JSON.stringify(row('q01'))}\n{ not json\n`, /grades\.jsonl line 2: /);
  refused('a byte-order mark', manifest(), `\ufeff${good}`, /grades\.jsonl: the file starts with a byte-order mark/);
  refused('bytes that are not UTF-8', manifest(), new Uint8Array([0x7b, 0xff, 0x7d, 0x0a]), /grades\.jsonl: the bytes are not UTF-8 text/);
  refused('a duplicate key', manifest(), `{"case": "q01", "case": "q02", "grade": "4", "answer": "a"}\n`, /grades\.jsonl line 1: .*twice|duplicate/i);
  refused('an unknown key', manifest(), jsonl(rows((id) => (id === 'q02' ? { label: '4' } : {}))), /grades\.jsonl line 2: unknown key "label"/);
  refused('no case', manifest(), jsonl([without(row('q01'), 'case')]), /grades\.jsonl line 1: case is required/);
  refused('none of grade, failed and unmeasured', manifest(), jsonl([without(row('q01'), 'grade')]), /holds exactly one of grade, failed and unmeasured; this one holds none/);
  refused('two of grade, failed and unmeasured', manifest(), jsonl([row('q01', { failed: 'truncated' })]), /this one holds grade and failed/);
  refused('a grade that is not a label of the bar', manifest(), jsonl(rows((id) => (id === 'q03' ? { grade: '9' } : {}))), /UNKNOWN_LABEL[\s\S]*grades\.jsonl line 3: grade "9" is not a label of the bar/);
  refused('a grade that is a number', manifest(), jsonl(rows((id) => (id === 'q01' ? { grade: 4 } : {}))), /grade is the number 4; a grade is a label of the bar, written as a string \("4"\)/);
  refused('answer and answerHash both', manifest(), jsonl(rows((id) => (id === 'q01' ? { answerHash: 'a'.repeat(64) } : {}))), /give exactly one of answer .* and answerHash .*; this row gives both/);
  refused('neither answer nor answerHash', manifest(), jsonl(rows((id) => (id === 'q01' ? { answer: undefined } : {})).map((r) => JSON.parse(JSON.stringify(r)) as Obj)), /give exactly one of answer/);
  refused('a bad answerHash', manifest(), jsonl(rows((id) => (id === 'q01' ? { answerHash: 'ABC' } : {})).map((r) => (r['case'] === 'q01' ? without(r, 'answer') : r))), /answerHash must be a full 64-character lowercase sha256/);
  refused('max-tokens on a grade row: a truncated answer is recorded as failed, never turned into one', manifest(), jsonl(rows((id) => (id === 'q02' ? { stop: 'max-tokens' } : {}))), /grades\.jsonl line 2 \(slot q02#0, attempt 0\): systemStop: a truncated answer is recorded as failed/);
  refused('a stop that is not a stop', manifest(), jsonl(rows(() => ({ stop: 'finished' }))), /stop is "finished"; it is one of/);
  refused('judgeStop missing in a judged run with no declaration', manifest({ judge: without(JUDGE, 'gradedReplyStop') }), good, /judgeStop is required on a grade row of a run graded by a judge[^\n]*judge\.gradedReplyStop/);
  refused('judgeStop in a run graded by code', byCode(), jsonl(rows(() => ({ judgeStop: 'end' }))), /judgeStop is not allowed in a run graded by code/);
  refused('judgeStop in the row and judge.gradedReplyStop in the manifest: one source each', manifest(), jsonl(rows((id) => (id === 'q01' ? { judgeStop: 'end' } : {}))), /grades\.jsonl line 1: judgeStop is given in the row and by judge\.gradedReplyStop in the manifest; give it in one place/);
  refused('draw on some rows only', manifest({ drawsPerCase: 1 }), jsonl(rows((id) => (id === 'q01' ? { draw: 0 } : {}))), /draw is given on some rows and not on others \(not on lines 2, 3\)/);
  refused('attempt on some rows only', manifest(), jsonl(rows((id) => (id === 'q01' ? { attempt: 0 } : {}))), /attempt is given on some rows and not on others/);
  refused('draw out of range', manifest({ drawsPerCase: 1 }), jsonl(rows((id) => ({ draw: id === 'q02' ? 1 : 0 }))), /grades\.jsonl line 2: draw 1 is outside 0 to 0/);
  refused('a duplicate slot', manifest({ caseCount: 2 }), jsonl([row('q01'), row('q01'), row('q02')]), /slot q01#0 has 2 rows \(lines 1, 2\)/);
  refused('a duplicate attempt', manifest(), jsonl([row('q01', { attempt: 0 }), row('q01', { attempt: 0 }), row('q02', { attempt: 0 }), row('q03', { attempt: 0 })]), /slot q01#0 gives attempt 0 more than once/);
  refused('an attempt gap', manifest(), jsonl([row('q01', { attempt: 0, grade: undefined, unmeasured: 'timeout', role: 'system', detail: '', answer: undefined, stop: undefined }), row('q01', { attempt: 2 }), row('q02', { attempt: 0 }), row('q03', { attempt: 0 })].map((r) => JSON.parse(JSON.stringify(r)) as Obj)), /slot q01#0 has attempts 0, 2; they are numbered 0, 1, 2, \.\.\. with no gap/);
  refused('a retry after a final reason (the artifact\'s own rule, named by line)', manifest(), jsonl([
    { case: 'q01', attempt: 0, unmeasured: 'parse-failure', role: 'judge', detail: '', answer: 'a', stop: 'end', input: 1 },
    { case: 'q01', attempt: 1, grade: '4', answer: 'a', stop: 'end', input: 1 },
    row('q02', { attempt: 0, input: 1 }), row('q03', { attempt: 0, input: 1 }),
  ]), /grades\.jsonl line 1 \(slot q01#0, attempt 0\)[^\n]*the reason parse-failure is final/);
  refused('a judge retry on another answer', manifest(), jsonl([
    { case: 'q01', attempt: 0, unmeasured: 'timeout', role: 'judge', detail: '', answer: 'a', stop: 'end', input: 1 },
    { case: 'q01', attempt: 1, grade: '4', answer: 'b', stop: 'end', input: 1 },
    row('q02', { attempt: 0, input: 1 }), row('q03', { attempt: 0, input: 1 }),
  ]), /attempt 1\)[^\n]*a judge retry re-grades the same output/);
  refused('a failed row without its stop', manifest(), jsonl(rows((id) => (id === 'q01' ? { grade: undefined, answer: undefined, stop: undefined, failed: 'truncated', detail: 'cut' } : {})).map((r) => JSON.parse(JSON.stringify(r)) as Obj)), /stop is required on a failed row/);
  refused('a {json} value holding "UNKNOWN": the gap is written bare, never hashed into a known value', manifest({ rubric: { json: 'UNKNOWN' } }), good, /manifest\.rubric\.json: holds "UNKNOWN"/);
  refused('a {json} value holding "UNKNOWN" at depth', manifest({ system: { ...SYSTEM, tools: { json: [{ name: 'UNKNOWN' }] } } }), good, /manifest\.system\.tools\.json: holds "UNKNOWN"/);
  refused('a {json} string that reads as a gap', manifest({ rubric: { json: 'n/a' } }), good, /manifest\.rubric\.json: "n\/a" reads as a gap/);
  refused('a truncated row without its answer (its output hash is the answer\'s)', manifest(), jsonl(rows((id) => (id === 'q01' ? { grade: undefined, answer: undefined, failed: 'truncated', detail: 'cut', stop: 'max-tokens' } : {})).map((r) => JSON.parse(JSON.stringify(r)) as Obj)), /grades\.jsonl line 1[^\n]*give exactly one of answer/);
  refused('an answer on a failed row that has none (client-error)', manifest(), jsonl(rows((id) => (id === 'q01' ? { grade: undefined, failed: 'client-error', detail: 'HTTP 400', stop: 'NOT_SENT' } : {})).map((r) => JSON.parse(JSON.stringify(r)) as Obj)), /grades\.jsonl line 1[^\n]*answer is not allowed on a failed row without an answer/);
  refused('packetHash on some rows only', manifest({ packets: { basis: 'recorded' } }), jsonl(rows((id) => (id === 'q01' ? { packetHash: 'a'.repeat(64) } : {}))), /grades\.jsonl line 2: packetHash is required: the manifest states packets\.basis "recorded"/);
  refused('packetHash with no basis', manifest(), jsonl(rows(() => ({ packetHash: 'a'.repeat(64) }))), /packetHash is given, but the manifest states no packets\.basis/);
  refused('a basis with no packetHash', manifest({ packets: { basis: 'recorded' } }), good, /packetHash is required/);
  refused('a case not in the case file (an unmatched case)', manifest({ cases: 'cases.jsonl' }), jsonl(rows().map((r) => without(r, 'input'))), /UNKNOWN_CASE|case "q03" is not in the case file cases\.jsonl \(an unmatched case\)/, { 'cases.jsonl': `${['q01', 'q02'].map((id) => JSON.stringify({ id, input: id })).join('\n')}\n` });
  refused('a class not of the bar', manifest({ sameForEveryCase: { class: 'no_such_class' }, expectByClass: { no_such_class: '4' } }), good, /UNKNOWN_CLASS[\s\S]*class "no_such_class" is not a class of the bar/);
  refused('an expected label not of the bar', manifest({ expectByClass: { reply_quality: 'nope' } }), good, /UNKNOWN_LABEL[\s\S]*expect "nope" is not a label of the bar/);
  refused('a case field from two sources, also where the values agree', manifest(), jsonl(rows(() => ({ class: 'reply_quality' }))), /class: is given in the rows and manifest\.sameForEveryCase; each case field comes from one source/);
  refused('a case field from the case file and the rows', manifest({ cases: 'cases.jsonl' }), good, /input: is given in the case file and the rows/, { 'cases.jsonl': `${IDS.map((id) => JSON.stringify({ id, input: id })).join('\n')}\n` });
  refused('a case field with no source', manifest(), jsonl(rows().map((r) => without(r, 'input'))), /input: every case needs one; give it in the case file or the rows/);
  refused('a case field that disagrees across the rows of a case', manifest({ drawsPerCase: 2 }), jsonl(IDS.flatMap((id) => [0, 1].map((d) => row(id, { draw: d, input: id === 'q02' && d === 1 ? 'other' : id })))), /input of case "q02" differs between its rows \(lines 3, 4\)/);
  refused('input: null', manifest(), jsonl(rows((id) => (id === 'q01' ? { input: null } : {}))), /grades\.jsonl line 1: input is null; null is not allowed/);
  refused('a grades file with no row', manifest(), '', /grades\.jsonl: holds no line/);
  refused('the finished run file of the format page as a manifest: refused, naming its keys', readFileSync(join(root, 'examples', 'run-format', 'run.json'), 'utf8'), good, /manifest\.identity: unknown key; state it as rubric, seed, system and judge[\s\S]*manifest\.packetBasis: unknown key/);
});

describe('write-run: usage (exit 64), and --out', () => {
  it('every flag is required; a flag that is unknown or given twice is a usage error', () => {
    const dir = setup(manifest(), jsonl(rows()));
    const m = join(dir, 'manifest.json');
    const g = join(dir, 'grades.jsonl');
    const o = join(dir, 'run.json');
    assert.equal(node(['write-run', '--grades', g, '--out', o]).status, 64);
    assert.equal(node(['write-run', '--manifest', m, '--out', o]).status, 64);
    const none = node(['write-run', '--manifest', m, '--grades', g]);
    assert.equal(none.status, 64);
    assert.match(none.stderr, /--out is required/);
    assert.equal(node(['write-run', '--manifest', m, '--grades', g, '--out', o, '--seed', '1']).status, 64);
    assert.equal(node(['write-run', '--manifest', m, '--manifest', m, '--grades', g, '--out', o]).status, 64);
    assert.equal(existsSync(o), false);
  });
  it('an existing --out is never overwritten, before anything is read', () => {
    const dir = setup(manifest(), jsonl(rows()));
    writeFileSync(join(dir, 'run.json'), 'keep');
    const r = writeRun(dir);
    assert.equal(r.status, 64, r.stderr);
    assert.match(r.stderr, /run\.json exists; write-run never overwrites --out/);
    assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), 'keep');
    // Also when the inputs are invalid: the usage error comes first.
    const bad = setup('{ not json', '');
    writeFileSync(join(bad, 'run.json'), 'keep');
    assert.equal(writeRun(bad).status, 64);
  });
  it('an --out whose folder does not exist is a usage error, and leaves nothing behind', () => {
    const dir = setup(manifest(), jsonl(rows()));
    const r = node(['write-run', '--manifest', join(dir, 'manifest.json'), '--grades', join(dir, 'grades.jsonl'), '--out', join(dir, 'no-such-folder', 'run.json')]);
    assert.equal(r.status, 64, r.stderr);
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
  });
  it('a grades file that cannot be read is invalid input (65), as any file that cannot be read', () => {
    const dir = setup(manifest(), jsonl(rows()));
    const r = node(['write-run', '--manifest', join(dir, 'manifest.json'), '--grades', join(dir, 'no-such.jsonl'), '--out', join(dir, 'run.json')]);
    assert.equal(r.status, 65, r.stderr);
    assert.match(r.stderr, /cannot read --grades/);
  });
});

describe('write-run: text of the files cannot erase or forge a line of what it prints', () => {
  it('a manifest key and a case id that hold control and bidirectional characters: the same number of stderr lines as for plain ones, each with escapes only', () => {
    const hostile = 'x\r\u001b[2Krun written to never.json\nsha256 000\u2028gate, this run against itself: would admit it\u202e';
    const raw = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/;
    const plain = writeRun(setup(manifest({ extra: 1 }), jsonl(rows())));
    assert.equal(plain.status, 65, plain.stderr);
    const r = writeRun(setup(manifest({ [hostile]: 1 }), jsonl(rows())));
    assert.equal(r.status, 65, r.stderr);
    assert.equal(r.stdout, '');
    const lines = r.stderr.replace(/\n$/, '').split('\n');
    assert.equal(lines.length, plain.stderr.replace(/\n$/, '').split('\n').length, r.stderr);
    for (const line of lines) assert.ok(!raw.test(line), JSON.stringify(line));
    assert.ok(lines.some((line) => line.includes('\\u001b[2K') && line.includes('\\u2028') && line.includes('\\u202e')), r.stderr);
    // A case id that holds them is written into the run as it is (JSON escapes it) and printed escaped.
    const dir = setup(manifest({ caseCount: 1, drawsPerCase: 1 }), jsonl([row(hostile, { draw: 0, stop: undefined })].map((x) => JSON.parse(JSON.stringify(x)) as Obj)));
    const w = writeRun(dir);
    assert.equal(w.status, 0, w.stderr);
    for (const line of w.stdout.replace(/\n$/, '').split('\n')) assert.ok(!raw.test(line), JSON.stringify(line));
    assert.equal(written(dir).cases[0]?.id, hostile);
  });
});

describe('write-run: where its code stands', () => {
  const source = readFileSync(join(root, 'src', 'runinput.ts'), 'utf8');
  it('src/runinput.ts is pure: it imports no Node module, so it reads and writes no file', () => {
    const specs = [...source.matchAll(/^import (?:type )?(?:[^'"]*?from )?'([^']+)';/gm)].map((m) => m[1] as string);
    assert.ok(specs.length >= 5);
    for (const s of specs) assert.ok(s.startsWith('./') && s.endsWith('.ts'), s);
  });
  it('reads no other tool\'s result file: no importer, promptfoo, Inspect or skill-evals name in its code', () => {
    const code = source.split('\n').filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n');
    assert.doesNotMatch(code, /promptfoo|inspect_ai|skill-evals|examples\/importers/i);
  });
  it('the example script and its closed input are gone: one input format is kept up', () => {
    assert.equal(existsSync(join(root, 'examples', 'run-format', 'write-run.ts')), false);
    assert.equal(existsSync(join(root, 'examples', 'run-format', 'input', 'recorded.json')), false);
  });
});

describe('the example input of the format page', () => {
  const input = join(root, 'examples', 'run-format', 'input');
  it('examples/run-format/input is an input write-run takes: the run parses, states every identity field with both declarations, and gates against the example bar (4 of 5 pass, bar 0.5)', () => {
    const out = join(work, 'from-example.json');
    const r = node(['write-run', '--manifest', join(input, 'manifest.json'), '--grades', join(input, 'grades.jsonl'), '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    const run = parseRunArtifact(JSON.parse(readFileSync(out, 'utf8')));
    assert.deepEqual(IDENTITY_FIELDS.filter((f) => run.identity[f] === 'UNKNOWN'), []);
    assert.deepEqual([run.cases.length, run.draws.length, run.identity.drawsPerCase], [5, 5, 1]);
    assert.match(r.stdout, /stated by you about your harness: system\.settings/);
    assert.match(r.stdout, /stated by you about your harness: judge\.gradedReplyStop/);
    const bar = join(root, 'examples', 'run-format', 'bar.json');
    const g = node(['gate', '--baseline', out, '--candidate', out, '--bar', bar]);
    assert.equal(g.status, 0, g.stderr);
    // q04 holds a 2 under a floor at 4: four of five pass, 0.800, which meets the bar of 0.5.
    assert.match(g.stdout, /reply_quality {3}floor {11}4\/5 0\.800 {5}4\/5 0\.800, 0 new {6}0\.500 {3}ok/);
    assert.match(g.stdout, /^draws per case: 1 — /m);
  });
});
