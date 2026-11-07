// The third importer (examples/importers/skill-evals/import.ts), tested on the re-grade files the real re-grade script
// wrote against the local fake endpoint (examples/importers/skill-evals/fixtures and bad-fixtures). Every refusal test
// loads a good fixture, applies one edit in memory (or to a temp copy of the flow), imports, and asserts the code and
// the named fields. No test makes a call, opens a socket or needs a key. Synthetic customer-support refund-bot data only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { callShapeHash, GAP, hashOf, IDENTITY_FIELDS, outputHashOf, packetHashOf, parseRunArtifact, sha256Hex } from '../src/index.ts';
import type { BarFile, CallShape, RunArtifact } from '../src/index.ts';
import { graderConfigProblems, ImportRefusal, ImportUsageError, loadBar, NEXT_STEP_LINE, parseCasesFile, parseRecord } from '../examples/importers/shared.ts';
import type { CasesFile, ImportRefusalCode } from '../examples/importers/shared.ts';
import { byCodeUnit, HEADER_COUNT_BOUND as FLOW_COUNT_BOUND, readFlow } from '../examples/importers/skill-evals/flow.ts';
import { convertRegrade, HEADER_COUNT_BOUND, headerCountBound, main, ROW_PROFILE_NOTE, TOOL, USAGE } from '../examples/importers/skill-evals/import.ts';
import type { FlowAgain } from '../examples/importers/skill-evals/import.ts';
import { GRADER_FILE, SCRIPT, SCRIPT_FILES } from '../examples/importers/skill-evals/regrade.ts';
import { ownStderr, scratchEnv } from './helpers.ts';

const root = join(import.meta.dirname, '..');
const dir = join(root, 'examples', 'importers', 'skill-evals');
const importer = join(dir, 'import.ts');
const exampleFlow = join(dir, 'example-flow');
const work = mkdtempSync(join(tmpdir(), 'anchorset-skill-import-'));
after(() => rmSync(work, { recursive: true, force: true }));

// The key the fixture script handed the grader. It must be in no fixture, no run and no printed line.
const FIXTURE_KEY = 'dummy-key-for-local-fake-endpoint';
const READING = 'one-json-object-boolean-pass/v1';
const FENCE_READING = 'one-json-object-boolean-pass-or-json-fence/v1';
const CASES = ['bank-dispute', 'clearance-organiser', 'faulty-headphones'] as const;
// The fixed order of the rows: case id, then draw. The fixtures grade source rep 0 of each case three times.
const ORDER = CASES.flatMap((id) => [0, 1, 2].map((d) => `${id}#${d}`));
const slotsOf = (id: string): string[] => [0, 1, 2].map((d) => `${id}#${d}`);

// ---- inputs ---------------------------------------------------------------------------------------------------------

// A re-grade file is edited by path in these tests, so they use an untyped view of it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
type File = { header: J; rows: J[] };
type Fixture = 'old-judge' | 'new-judge' | 'new-judge-rep1' | 'reask' | 'reask-new-judge' | 'openai-old-judge' | 'openai-new-judge';
const fixtureBytes = (name: Fixture): Buffer => readFileSync(join(dir, 'fixtures', `${name}.regrade.jsonl`));
const badBytes = (name: string): Buffer => readFileSync(join(dir, 'bad-fixtures', `${name}.regrade.jsonl`));
function parse(bytes: Buffer): File {
  const text = bytes.toString('utf8');
  assert.ok(text.endsWith('\n'));
  const [header, ...rows] = text.slice(0, -1).split('\n').map((l) => JSON.parse(l) as J);
  return { header, rows };
}
const fix = (name: Fixture = 'old-judge'): File => parse(fixtureBytes(name));
const serialise = (f: File): Buffer => Buffer.from([f.header, ...f.rows].map((l) => `${JSON.stringify(l)}\n`).join(''));
/** The file with its header naming another reading rule: what a re-grade made with that `--reading` would have written there. */
const underRule = (f: File, rule: string): File => {
  f.header.reading = rule;
  return f;
};

const casesText = readFileSync(join(dir, 'cases.json'), 'utf8');
const barText = readFileSync(join(dir, 'bar.json'), 'utf8');
const bar: BarFile = loadBar(barText);
const cases: CasesFile = parseCasesFile(casesText, bar);
type Over = { cases?: CasesFile; bar?: BarFile; flow?: string; reading?: string };
const flowReader = (flowDir: string): FlowAgain => (variant, stated, reps) => readFlow(flowDir, variant, stated, reps);
/**
 * A flow that agrees with the re-grade file it is read for: every value the second look compares is the file's own. The
 * converter's checks of the file itself (the header, the rows, the records) are tested through it, with the file edited in
 * memory; what the second look finds in a real flow is tested with `flow: exampleFlow` and the scratch copies of it.
 */
function agreeingFlow(f: File | Buffer): FlowAgain {
  return (_variant, stated, _reps) => {
    const file = Buffer.isBuffer(f) ? parse(f) : f;
    const statedCases = Object.keys(stated).sort(byCodeUnit);
    const slots = statedCases.map((caseId) => {
      const row = file.rows.find((r) => r.caseId === caseId) as J;
      return { caseId, draw: file.header.sourceRep as number, prompt: row.parts.question as string, answer: row.storedOutput as string, traceSha256: row.traceSha256 as string, storedOutputSha256: sha256Hex(row.storedOutput as string) };
    });
    return {
      rowProfile: 'skill-evals/1' as const,
      variant: file.header.variant as string,
      reps: file.header.reps as number,
      statedCases,
      slots,
      notWhole: [],
      excluded: (file.header.excludedCaseIds as string[]).map((caseId) => ({ caseId, rows: [], errorLines: [] })),
      superseded: [],
      resultsSha256: file.header.resultsSha256 as string,
      stateSha256: file.header.stateSha256 as string,
      harnessSha: file.header.harnessSha as string,
      unusedTraces: [],
    };
  };
}
const conv = (f: File | Buffer, over: Over = {}) =>
  convertRegrade(Buffer.isBuffer(f) ? f : serialise(f), 'in.regrade.jsonl', over.cases ?? cases, over.bar ?? bar, over.reading ?? READING, over.flow === undefined ? agreeingFlow(f) : flowReader(over.flow));
const runOf = (f: File | Buffer, over: Over = {}): RunArtifact => parseRunArtifact(JSON.parse(JSON.stringify(conv(f, over).run)));

let counter = 0;
type Cli = { code: number; out: string; err: string; outPath: string };
/** The command through `main`, on files written from the given values. `reading: null` leaves the flag out. */
function viaMain(f: File | Buffer | string, over: { cases?: unknown; bar?: unknown; casesRaw?: string; barRaw?: string; flow?: string | null; inName?: string; extra?: string[]; reading?: string | null } = {}): Cli {
  counter += 1;
  const inPath = join(work, `${counter}-${over.inName ?? 'in.regrade.jsonl'}`);
  const casesPath = join(work, `${counter}-cases.json`);
  const barPath = join(work, `${counter}-bar.json`);
  const outPath = join(work, `${counter}-out.json`);
  writeFileSync(inPath, typeof f === 'string' || Buffer.isBuffer(f) ? f : serialise(f));
  writeFileSync(casesPath, over.casesRaw ?? (over.cases === undefined ? casesText : JSON.stringify(over.cases)));
  writeFileSync(barPath, over.barRaw ?? (over.bar === undefined ? barText : JSON.stringify(over.bar)));
  const out: string[] = [];
  const err: string[] = [];
  const argv = [
    '--in', inPath, '--cases', casesPath, '--bar', barPath, '--out', outPath,
    ...(over.reading === null ? [] : ['--reading', over.reading ?? READING]),
    // `--flow` has no default: the example flow is the one the fixtures were graded from, and `flow: null` leaves the flag out.
    ...(over.flow === null ? [] : ['--flow', over.flow ?? exampleFlow]),
    ...(over.extra ?? []),
  ];
  const code = main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n'), outPath };
}

/**
 * Imports a file that must be refused: the code and the named fields from the pure conversion, and exit 2, the code
 * on stderr and no output file from the command.
 */
function refuse(f: File | Buffer, code: ImportRefusalCode, fields?: readonly string[], over: Over = {}): ImportRefusal {
  let caught: unknown;
  try {
    conv(f, over);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ImportRefusal, `expected ${code}, but the file imported or threw ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  assert.ok(caught.fields.length > 0, 'a refusal names its fields');
  if (fields !== undefined) assert.deepEqual([...caught.fields], [...fields], caught.message);
  const cli = viaMain(f, { cases: over.cases, ...(over.flow === undefined ? {} : { flow: over.flow }), ...(over.reading === undefined ? {} : { reading: over.reading }) });
  assert.equal(cli.code, 2, cli.err);
  assert.match(cli.err, new RegExp(`REFUSED ${code}`));
  assert.match(cli.err, /^fields: /m);
  assert.equal(existsSync(cli.outPath), false, 'a refusal writes nothing');
  return caught;
}

// ---- edit helpers ---------------------------------------------------------------------------------------------------

const slotOf = (row: J): string => `${row.caseId}#${row.draw}`;
const rec = (row: J): J => row.graderEvidence;
/** The three rows of one case: the three grades of its one stored output. */
const rowsOfCase = (f: File, id: string): J[] => f.rows.filter((r) => r.caseId === id);
/** The independent single-pass rendering of the header's template with a row's parts. */
const renderUser = (f: File, row: J): string => (f.header.template.text as string).replace(/\{(question|answer|criterion)\}/g, (_m, n: string) => row.parts[n] as string);
const promptOf = (f: File, row: J): string =>
  JSON.stringify(f.header.system === 'NOT_SENT' ? [{ role: 'user', content: renderUser(f, row) }] : [{ role: 'system', content: f.header.system.text }, { role: 'user', content: renderUser(f, row) }]);
/** Every row's prompt and the record's hashes of it written again from the header's texts and the row's parts. */
function rerender(f: File): File {
  for (const row of f.rows) {
    row.promptSent = promptOf(f, row);
    rec(row).promptSha256 = sha256Hex(row.promptSent);
    rec(row).sent.user = sha256Hex(renderUser(f, row));
    rec(row).sent.system = f.header.system === 'NOT_SENT' ? 'NOT_SENT' : sha256Hex(f.header.system.text);
  }
  return f;
}
const textAndHash = (text: string): { text: string; sha256: string } => ({ text, sha256: sha256Hex(text) });
/** The whole assistant turn and the question of one rep of a case, read from the example flow's trace. */
function turnOf(caseId: string, rep: number, flow = exampleFlow): { turn: string; question: string; traceSha256: string } {
  const bytes = readFileSync(join(flow, 'baseline', 'traces', `${caseId}_rep${rep}.json`));
  const turns = JSON.parse(bytes.toString('utf8')) as { role: string; content: string }[];
  return { turn: turns[turns.length - 1]?.content ?? '', question: turns[turns.length - 2]?.content ?? '', traceSha256: sha256Hex(bytes) };
}
function hasNull(v: unknown): boolean {
  if (v === null) return true;
  if (Array.isArray(v)) return v.some(hasNull);
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).some(hasNull);
  return false;
}
function copyFlow(): string {
  counter += 1;
  const to = join(work, `flow-${counter}`);
  cpSync(exampleFlow, to, { recursive: true });
  return to;
}
const SYSTEM_SIDE = ['systemModelRequested', 'systemModelServed', 'systemCallShapeHash', 'systemPromptHash', 'systemToolsHash', 'systemHarnessVersion', 'seed'] as const;
const labelsOf = (r: RunArtifact): string[] => r.draws.map((d) => `${d.caseId}#${d.drawIndex}=${(d.attempts[0] as { label: string }).label}`);

// ---- the fixtures are what the test takes them for ---------------------------------------------------------------

test('the fixtures are re-grades of one source rep of the example flow, each stored output graded three times, with no key, the reading rule in the header alone and no path of a machine', () => {
  const reps: Record<Fixture, number> = { 'old-judge': 0, 'new-judge': 0, 'new-judge-rep1': 1, reask: 0, 'reask-new-judge': 0, 'openai-old-judge': 0, 'openai-new-judge': 0 };
  const WIRE_OF: Partial<Record<Fixture, string>> = { 'openai-old-judge': 'openai-responses/v1', 'openai-new-judge': 'openai-responses/v1' };
  for (const name of Object.keys(reps) as Fixture[]) {
    const f = fix(name);
    assert.equal(f.header.schema, 'example.skill-evals-regrade/v4');
    assert.equal(f.header.reps, 2, "the flow's declared rep count");
    assert.equal(f.header.sourceRep, reps[name]);
    assert.equal(f.header.draws, 3);
    // Three cases x three draws.
    assert.equal(f.header.slotCount, 9);
    assert.deepEqual(f.rows.map(slotOf), ORDER);
    assert.deepEqual(f.header.selector, { syntax: 'json-pointer-rfc6901/v1', pointer: '/reply' });
    // The path the re-grade was given with --flow is not in the file: a path can hold a home directory and a user name.
    assert.equal('flow' in f.header, false);
    assert.equal(f.header.harnessSha, '0'.repeat(64));
    // The reading rule the re-grade read the replies under is a field of the header: neither the grader's configuration nor a record holds one.
    assert.equal(f.header.reading, READING);
    assert.equal('reading' in f.header.graderConfig, false);
    for (const row of f.rows) {
      assert.equal('reading' in rec(row), false);
      assert.equal(rec(row).schema, 'example.grader-evidence/v8');
      assert.equal(rec(row).wire, WIRE_OF[name] ?? 'anthropic-messages/v1');
      // Every row of a case is the source rep's trace and stored output.
      const source = turnOf(row.caseId, reps[name]);
      assert.equal(row.traceSha256, source.traceSha256);
      assert.equal(row.storedOutput, source.turn);
      assert.equal(row.parts.question, source.question);
    }
    const text = fixtureBytes(name).toString('utf8');
    assert.ok(!text.includes(FIXTURE_KEY));
    for (const prefix of ['/Users/', '/home/', '/tmp/', '/var/folders/']) assert.ok(!text.includes(prefix), prefix);
  }
  assert.equal(fix('old-judge').header.graderConfig.model, 'fake-judge-old');
  assert.equal(fix('new-judge').header.graderConfig.model, 'fake-judge-strict-new');
  // In the example flow the two reps of every case hold different stored outputs.
  for (const id of CASES) assert.notEqual(turnOf(id, 0).turn, turnOf(id, 1).turn);
});

// ---- the good path -------------------------------------------------------------------------------------------------

test('both fixtures import: nine graded draws, three per case, the system side and every system stop UNKNOWN, labels from the reply under the stated rule', () => {
  const o = runOf(fix('old-judge'));
  const n = runOf(fix('new-judge'));
  // The old fake judge passes every slot; the strict one fails the stored reply that carries its marker, on each of its three grades.
  assert.deepEqual(labelsOf(o), ORDER.map((s) => `${s}=pass`));
  assert.deepEqual(labelsOf(n), ORDER.map((s) => `${s}=${s.startsWith('clearance-organiser') ? 'fail' : 'pass'}`));
  for (const r of [o, n]) {
    assert.equal(r.schema, 'anchorset.run/v3');
    for (const f of SYSTEM_SIDE) assert.equal(r.identity[f], GAP, f);
    // The draws per case are the header's `draws` (3), not the flow's rep count (2).
    assert.equal(r.identity.drawsPerCase, 3);
    assert.equal(r.draws.length, 9);
    for (const d of r.draws) {
      assert.equal(d.attempts.length, 1);
      const a = d.attempts[0] as { kind: string; systemStop: string; judgeStop: string };
      assert.equal(a.kind, 'graded');
      assert.equal(a.systemStop, GAP);
      assert.equal(a.judgeStop, 'end');
    }
    // The system's call shape is a gap in every key; the judge's is the record's.
    for (const [k, v] of Object.entries(r.callShapes.system as Record<string, unknown>)) if (k !== 'schema') assert.equal(v, GAP, k);
    assert.equal(r.packetBasis, 'declared');
    assert.equal(hasNull(r), false);
  }
});

test('the roster comes from cases.json, with the question as each case\'s input', () => {
  const r = runOf(fix());
  assert.deepEqual(r.cases, [
    { id: 'bank-dispute', klass: 'refund_safety', input: { question: turnOf('bank-dispute', 0).question }, expect: 'pass' },
    { id: 'clearance-organiser', klass: 'refund_policy', input: { question: turnOf('clearance-organiser', 0).question }, expect: 'pass' },
    { id: 'faulty-headphones', klass: 'refund_policy', input: { question: turnOf('faulty-headphones', 0).question }, expect: 'pass' },
  ]);
});

test('every draw of a case holds one outputHash, over the WHOLE stored turn of the source rep, and one packetHash, over the question and the text the selector shows', () => {
  const r = runOf(fix('new-judge'));
  for (const d of r.draws) {
    const a = d.attempts[0] as { outputHash: string; packetHash: string };
    // Whatever the draw, the output is rep 0's: the whole turn is the JSON text {"action": ..., "reply": ...}; the judge was shown the reply field only.
    const source = turnOf(d.caseId, 0);
    assert.equal(a.outputHash, sha256Hex(source.turn));
    const reply = (JSON.parse(source.turn) as { reply: string }).reply;
    assert.equal(a.packetHash, packetHashOf({ question: source.question }, reply));
    assert.notEqual(a.packetHash, packetHashOf({ question: source.question }, source.turn));
  }
  for (const id of CASES) {
    const ofCase = r.draws.filter((d) => d.caseId === id).map((d) => d.attempts[0] as { outputHash: string; packetHash: string });
    assert.equal(new Set(ofCase.map((a) => a.outputHash)).size, 1, id);
    assert.equal(new Set(ofCase.map((a) => a.packetHash)).size, 1, id);
  }
});

test('reps that differ in the source import fine, because only the named source rep is read: the rep-1 file imports with rep 1\'s outputs', () => {
  const r0 = runOf(fix('new-judge'));
  const r1 = runOf(fix('new-judge-rep1'));
  for (const id of CASES) {
    const hash = (r: RunArtifact): string => (r.draws.find((d) => d.caseId === id)?.attempts[0] as { outputHash: string }).outputHash;
    assert.equal(hash(r0), sha256Hex(turnOf(id, 0).turn));
    assert.equal(hash(r1), sha256Hex(turnOf(id, 1).turn));
    assert.notEqual(hash(r0), hash(r1));
  }
  // Rep 1 of clearance-organiser declines correctly and carries no marker, so the strict fake judge passes all nine.
  assert.deepEqual(labelsOf(r1), ORDER.map((s) => `${s}=pass`));
  // The same cases, the same judge, the same identity: only the outputs, the packets and packetSource tell the two runs apart.
  assert.deepEqual(r0.identity, r1.identity);
  assert.match(r0.packetSource ?? '', /; source rep 0 of 2; /);
  assert.match(r1.packetSource ?? '', /; source rep 1 of 2; /);
});

test('the six judge fields, each written out by hand from the header, the records and the stated rule', () => {
  const f = fix('old-judge');
  const c = conv(f);
  const r0 = rec(f.rows[0]);
  assert.deepEqual(c.judge, {
    judgeDefinitionHash: hashOf({ tool: 'skill-evals', rowProfile: 'skill-evals/1', template: f.header.template.text, system: f.header.system.text, selector: { syntax: 'json-pointer-rfc6901/v1', pointer: '/reply' }, tools: [], reading: READING, maxReasks: 0 }),
    judgeModelRequested: 'fake-judge-old',
    judgeModelServed: 'fake-judge-old-served-20260101',
    judgeCallShapeHash: callShapeHash(r0.callShape as CallShape),
    judgeHarnessVersion: `skill-evals skill-evals/1; anchorset-recording-grader js sha256:${r0.grader.sha256}; ${r0.grader.runtime}; max-reasks 0; wire anthropic-messages/v1; script-files sha256:${hashOf(f.header.scriptFiles)}`,
    rubricHash: hashOf({ tool: 'skill-evals', criterion: f.header.criterion.text }),
  });
  assert.equal(TOOL, 'skill-evals');
  const run = runOf(f);
  for (const k of Object.keys(c.judge) as (keyof typeof c.judge)[]) assert.equal(run.identity[k], c.judge[k], k);
  assert.equal(c.drawsPerCase, 3);
  assert.equal(c.grader.sha256, r0.grader.sha256);
  assert.equal(c.readingRule, READING);
});

test('the two judges\' runs differ in the two judge model fields and in nothing else of the identity', () => {
  const o = runOf(fix('old-judge')).identity;
  const n = runOf(fix('new-judge')).identity;
  assert.deepEqual(IDENTITY_FIELDS.filter((f) => o[f] !== n[f]), ['judgeModelRequested', 'judgeModelServed']);
});

test('packetSource names the tool, the unknown source version, the pinned row profile, the source rep, the three sha256 and the flow\'s harness value', () => {
  const bytes = fixtureBytes('old-judge');
  const f = parse(bytes);
  const r = runOf(bytes);
  assert.equal(
    r.packetSource,
    `computed at import from a skill-evals re-grade file sha256:${sha256Hex(bytes)} (sourceVersion: UNKNOWN; rowProfile: skill-evals/1, pinned by the importer; written against CLI 2.1.288; no version is read; source rep 0 of 2; results.jsonl sha256:${f.header.resultsSha256}; _state.json sha256:${f.header.stateSha256}; harness_sha: ${'0'.repeat(64)}; cases of the flow excluded by the cases file: 0; flow read again: yes): the question, and the value at JSON Pointer "/reply" of the assistant turn as the answer`,
  );
  // The flow is always read again, and the run says so: there is no run that says it was not, and the words for the same file are the same
  // whether the flow is the real example flow or one that agrees with the file.
  assert.match(r.packetSource ?? '', /; flow read again: yes\): /);
  assert.doesNotMatch(r.packetSource ?? '', /flow read again: no/);
  assert.equal(runOf(bytes, { flow: exampleFlow }).packetSource, r.packetSource);
  assert.equal(ROW_PROFILE_NOTE, 'pinned by the importer; written against CLI 2.1.288; no version is read');
  assert.equal(f.header.resultsSha256, sha256Hex(readFileSync(join(exampleFlow, 'baseline', 'results.jsonl'))));
  assert.equal(f.header.stateSha256, sha256Hex(readFileSync(join(exampleFlow, '_state.json'))));
  // A flow whose state file holds no harness value: the header says so with the gap marker, and so does the run.
  const none = fix();
  none.header.harnessSha = 'UNKNOWN';
  assert.match(runOf(none).packetSource ?? '', /; harness_sha: UNKNOWN; cases of the flow excluded by the cases file: 0; flow read again: yes\): /);
  // A flow that held no state file: both values are the gap marker, in the header and in the run.
  none.header.stateSha256 = 'UNKNOWN';
  assert.match(runOf(none).packetSource ?? '', /; _state\.json sha256:UNKNOWN; harness_sha: UNKNOWN; /);
  // A re-grade whose cases file left two cases of the flow out: the run names the count.
  const fewer = fix();
  fewer.header.excludedCaseIds = ['damaged-lamp', 'late-parcel'];
  fewer.header.excludedCaseCount = 2;
  assert.match(runOf(fewer).packetSource ?? '', /; cases of the flow excluded by the cases file: 2; flow read again: yes\): the question, /);
  assert.deepEqual(conv(fewer).excludedCaseIds, ['damaged-lamp', 'late-parcel']);
  assert.deepEqual(conv(fix()).excludedCaseIds, []);
  // Nothing else of the run moves with the excluded cases: they are named in packetSource and nowhere else.
  const [a, b] = [runOf(fewer), runOf(fix())];
  assert.deepEqual({ ...a, packetSource: '' }, { ...b, packetSource: '' });
  // The printed line for excluded cases is checked against a flow that holds them: the partial-flow test and the one with a late parcel below.
});

test('a header without the excluded cases or their count is refused: there is no default, and a file is never read as "none excluded"', () => {
  for (const key of ['excludedCaseIds', 'excludedCaseCount']) {
    // A file written before the header stated them.
    const f = fix();
    assert.ok(key in f.header, `the fixture's header holds ${key}`);
    delete f.header[key];
    assert.match(refuse(f, 'IMPORT_SHAPE', [`header/${key}`]).message, new RegExp(`in\\.regrade\\.jsonl:1: ${key}: missing`));
  }
  const neither = fix();
  delete neither.header.excludedCaseIds;
  delete neither.header.excludedCaseCount;
  refuse(neither, 'IMPORT_SHAPE', ['header/excludedCaseIds', 'header/excludedCaseCount']);
});

test('the excluded cases of a header are a sorted list of path-safe ids, each once, with its length beside it', () => {
  const lists: [string, unknown, RegExp][] = [
    ['a text', 'late-parcel', /expected a list of path-safe case ids/],
    ['an object', { 'late-parcel': true }, /expected a list of path-safe case ids/],
    ['a number in the list', ['late-parcel', 7], /expected a list of path-safe case ids/],
    ['an empty id', [''], /expected a list of path-safe case ids/],
    ['an id with a space', ['late parcel'], /expected a list of path-safe case ids/],
    ['an id that is a path', ['../late-parcel'], /expected a list of path-safe case ids/],
    ['an id of 130 characters', ['x'.repeat(130)], /expected a list of path-safe case ids/],
    ['not sorted', ['late-parcel', 'damaged-lamp'], /the ids are not sorted with each id once/],
    ['an id twice', ['late-parcel', 'late-parcel'], /the ids are not sorted with each id once/],
  ];
  for (const [what, value, why] of lists) {
    const f = fix();
    f.header.excludedCaseIds = value;
    f.header.excludedCaseCount = Array.isArray(value) ? value.length : 1;
    assert.match(refuse(f, 'IMPORT_SHAPE', ['header/excludedCaseIds']).message, why, what);
  }
  for (const value of [-1, 0.5, '0', true]) {
    const f = fix();
    f.header.excludedCaseCount = value;
    assert.match(refuse(f, 'IMPORT_SHAPE', ['header/excludedCaseCount']).message, /excludedCaseCount: expected an integer from 0/, String(value));
  }
  // A count that is not the length of the list, in either direction.
  const more = fix();
  more.header.excludedCaseCount = 1;
  assert.match(refuse(more, 'IMPORT_EVIDENCE', ['header/excludedCaseCount']).message, /1 is not the number of ids in excludedCaseIds, 0/);
  const less = fix();
  less.header.excludedCaseIds = ['damaged-lamp', 'late-parcel'];
  less.header.excludedCaseCount = 1;
  assert.match(refuse(less, 'IMPORT_EVIDENCE', ['header/excludedCaseCount']).message, /1 is not the number of ids in excludedCaseIds, 2/);
  const none = fix();
  none.header.excludedCaseIds = ['late-parcel'];
  none.header.excludedCaseCount = 0;
  refuse(none, 'IMPORT_EVIDENCE', ['header/excludedCaseCount']);
});

test('a case cannot be both measured and excluded: an excluded id of the header that is in the cases file is refused', () => {
  const f = fix();
  f.header.excludedCaseIds = ['clearance-organiser', 'late-parcel'];
  f.header.excludedCaseCount = 2;
  const e = refuse(f, 'IMPORT_EVIDENCE', ['header/excludedCaseIds']);
  assert.match(e.message, /excludedCaseIds: "clearance-organiser" is in cases\.json; the re-grade was made with a cases file that left it out/);
  assert.doesNotMatch(e.message, /"late-parcel"/);
});

test('with no selector and no system text, both are "NOT_SENT" in the judge definition and the packet is the whole turn', () => {
  const f = fix();
  f.header.selector = 'NOT_SENT';
  f.header.system = 'NOT_SENT';
  for (const row of f.rows) row.parts.answer = row.storedOutput;
  rerender(f);
  const c = conv(f);
  assert.equal(c.judge.judgeDefinitionHash, hashOf({ tool: 'skill-evals', rowProfile: 'skill-evals/1', template: f.header.template.text, system: 'NOT_SENT', selector: 'NOT_SENT', tools: [], reading: READING, maxReasks: 0 }));
  assert.notEqual(c.judge.judgeDefinitionHash, conv(fix()).judge.judgeDefinitionHash);
  const run = parseRunArtifact(JSON.parse(JSON.stringify(c.run)));
  const first = run.draws[0]?.attempts[0] as { packetHash: string; outputHash: string };
  const source = turnOf('bank-dispute', 0);
  assert.equal(first.packetHash, packetHashOf({ question: source.question }, source.turn));
  assert.equal(first.outputHash, sha256Hex(source.turn));
  assert.match(run.packetSource ?? '', /the question, and the whole assistant turn as the answer$/);
});

test('a changed template, system text or selector is a changed judge definition; a changed criterion is a changed rubric', () => {
  const base = conv(fix()).judge;
  const template = fix();
  template.header.template = textAndHash(`${template.header.template.text}Thank you.\n`);
  const t = conv(rerender(template)).judge;
  assert.notEqual(t.judgeDefinitionHash, base.judgeDefinitionHash);
  assert.equal(t.rubricHash, base.rubricHash);

  const system = fix();
  system.header.system = textAndHash(`${system.header.system.text}Be brief.\n`);
  assert.notEqual(conv(rerender(system)).judge.judgeDefinitionHash, base.judgeDefinitionHash);

  const criterion = fix();
  criterion.header.criterion = textAndHash(`${criterion.header.criterion.text}The reply is polite.\n`);
  for (const row of criterion.rows) row.parts.criterion = criterion.header.criterion.text;
  const c = conv(rerender(criterion)).judge;
  assert.equal(c.judgeDefinitionHash, base.judgeDefinitionHash);
  assert.notEqual(c.rubricHash, base.rubricHash);
});

test('the script files are part of the harness: a changed list changes judgeHarnessVersion and nothing else', () => {
  const f = fix();
  f.header.scriptFiles.find((x: J) => x.path === 'examples/importers/skill-evals/render.ts').sha256 = 'a'.repeat(64);
  const a = conv(f).judge;
  const b = conv(fix()).judge;
  assert.notEqual(a.judgeHarnessVersion, b.judgeHarnessVersion);
  assert.deepEqual({ ...a, judgeHarnessVersion: '' }, { ...b, judgeHarnessVersion: '' });
});

test('two imports of one file give identical runs, and the command writes identical bytes', () => {
  const bytes = fixtureBytes('new-judge');
  assert.deepEqual(conv(bytes).run, conv(bytes).run);
  const a = viaMain(bytes);
  const b = viaMain(bytes);
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  assert.ok(readFileSync(a.outPath).equals(readFileSync(b.outPath)));
});

test('a reply that thought is graded, and the count of such replies is printed', () => {
  const f = fix();
  rec(f.rows[1]).contentTypes = ['thinking', 'text'];
  rec(f.rows[1]).thinkingTokens = 12;
  rec(f.rows[4]).contentTypes = ['redacted_thinking', 'thinking', 'text'];
  assert.match(conv(f).reasoning, /^replies with reasoning: 2 of 9 asks; reasoning tokens \(the provider's own count\): total 12, median 0, max 12; counter absent on 0$/);
  assert.match(conv(fix()).reasoning, /^replies with reasoning: 0 of 9 asks; /);
  const cli = viaMain(f);
  assert.equal(cli.code, 0, cli.err);
  assert.match(cli.out, /^replies with reasoning: 2 of 9 asks; /m);
});

// ---- the reading rule: stated at the re-grade, recorded in the header, and stated again at import -------------------

test('two re-grade files that differ only in the rule their headers name give two judge definitions and otherwise equal runs, where both rules read every reply', () => {
  // Every reply of the fixture is a bare JSON object, which both rules read.
  const a = runOf(fix('new-judge'), { reading: READING });
  const b = runOf(underRule(fix('new-judge'), FENCE_READING), { reading: FENCE_READING });
  assert.notEqual(a.identity.judgeDefinitionHash, b.identity.judgeDefinitionHash);
  assert.deepEqual(IDENTITY_FIELDS.filter((f) => a.identity[f] !== b.identity[f]), ['judgeDefinitionHash']);
  // The two files differ in one header field, so in their sha256, which the run's provenance names; nothing else differs.
  const bare = (r: RunArtifact): unknown => ({ ...r, identity: { ...r.identity, judgeDefinitionHash: '' }, packetSource: String(r.packetSource).replace(/sha256:[0-9a-f]{64}/, 'sha256:<file>') });
  assert.notEqual(a.packetSource, b.packetSource);
  assert.deepEqual(bare(a), bare(b));
  assert.equal(conv(underRule(fix('new-judge'), FENCE_READING), { reading: FENCE_READING }).readingRule, FENCE_READING);
});

test('a file whose header names another rule than the one stated at import is refused, each way; so is a header with none, and one that names no known rule', () => {
  // The re-grade read the replies under one rule and stopped or counted by it: importing under the other is another judge definition.
  const one = refuse(fix(), 'IMPORT_EVIDENCE', ['header/reading'], { reading: FENCE_READING });
  assert.match(one.message, /^IMPORT_EVIDENCE: in\.regrade\.jsonl:1: reading: the header names the reading rule one-json-object-boolean-pass\/v1, and --reading states one-json-object-boolean-pass-or-json-fence\/v1; a re-grade file is imported under the rule its header declares, and another rule is a different judge definition$/);
  const other = refuse(underRule(fix(), FENCE_READING), 'IMPORT_EVIDENCE', ['header/reading']);
  assert.match(other.message, /the header names the reading rule one-json-object-boolean-pass-or-json-fence\/v1, and --reading states one-json-object-boolean-pass\/v1/);
  // No header rule is never read as "the stated one": the key must be there.
  for (const stated of [READING, FENCE_READING]) {
    const none = fix();
    delete none.header.reading;
    const r = refuse(none, 'IMPORT_SHAPE', ['header/reading'], { reading: stated });
    assert.match(r.message, /in\.regrade\.jsonl:1: reading: missing: the header of a re-grade names the reading rule its replies were read under \(--reading at the re-grade\)\. Grade the stored outputs again with examples\/importers\/skill-evals\/regrade\.ts/);
  }
  // A value that is not one of the two names, whatever is stated at import.
  for (const value of ['lenient', '', 'ONE-JSON-OBJECT-BOOLEAN-PASS/V1', 'NOT_SENT', 'UNKNOWN', 7, true, [READING], { rule: READING }]) {
    const f = fix();
    f.header.reading = value;
    const r = refuse(f, 'IMPORT_SHAPE', ['header/reading']);
    assert.match(r.message, /reading: expected one of one-json-object-boolean-pass\/v1, one-json-object-boolean-pass-or-json-fence\/v1, found /, JSON.stringify(value));
  }
  // The refusal comes before any reply is read: the file here holds a reply neither rule reads.
  const prose = fix();
  rec(prose.rows[0]).reply = 'prose';
  refuse(prose, 'IMPORT_EVIDENCE', ['header/reading'], { reading: FENCE_READING });
});

test('a fenced reply is read under the fence rule and refused under the first rule, with the words that the other rule reads it', () => {
  const fenced = (): File => {
    const f = fix();
    rec(f.rows[3]).reply = '```json\n{"pass": false, "reason": "A clearance item was refunded."}\n```';
    return f;
  };
  assert.deepEqual(labelsOf(runOf(underRule(fenced(), FENCE_READING), { reading: FENCE_READING })).filter((l) => l.endsWith('=fail')), ['clearance-organiser#0=fail']);
  const e = refuse(fenced(), 'IMPORT_UNGRADED', ['clearance-organiser#0']);
  assert.match(e.message, /under the reading rule one-json-object-boolean-pass\/v1 that was stated; readable under one-json-object-boolean-pass-or-json-fence\/v1; that rule is a different judge definition/);
});

test('--reading is required and has no default: a missing or unknown name is a usage error that lists both names, before any file is read', () => {
  const names = /--reading must be one of one-json-object-boolean-pass\/v1, one-json-object-boolean-pass-or-json-fence\/v1/;
  // The pure conversion refuses a missing or unknown rule before it reads a byte: the bytes here are not a re-grade file.
  for (const stated of [undefined, 'one-json-object', 'lenient']) {
    assert.throws(() => convertRegrade(Buffer.from('not a file'), 'x', cases, bar, stated, agreeingFlow(Buffer.from('not a file'))), (e: unknown) => e instanceof ImportUsageError && names.test(e.message));
  }
  // The command: --in names a file that does not exist, and the answer is about --reading, so nothing was read.
  const io = (): { err: string[]; io: { out: () => void; err: (s: string) => void } } => {
    const err: string[] = [];
    return { err, io: { out: () => undefined, err: (s) => err.push(s) } };
  };
  const missing = io();
  assert.equal(main(['--in', join(work, 'no-such-file'), '--cases', 'x', '--bar', 'x', '--out', join(work, 'never.json')], missing.io), 64);
  assert.match(missing.err.join('\n'), /missing --reading/);
  assert.match(missing.err.join('\n'), /--reading is one of one-json-object-boolean-pass\/v1 \| one-json-object-boolean-pass-or-json-fence\/v1/);
  const unknown = io();
  assert.equal(main(['--in', join(work, 'no-such-file'), '--cases', 'x', '--bar', 'x', '--out', join(work, 'never.json'), '--reading', 'lenient', '--flow', exampleFlow], unknown.io), 64);
  assert.match(unknown.err.join('\n'), names);
  assert.match(unknown.err.join('\n'), /found "lenient"/);
  const none = viaMain(fixtureBytes('old-judge'), { reading: null });
  assert.equal(none.code, 64);
  assert.equal(existsSync(none.outPath), false);
});

test('a grader configuration or a record that holds a reading rule is refused: the rule is the header\'s own field, and no grader is told or records one', () => {
  const header = fix();
  header.header.graderConfig.reading = READING;
  const h = refuse(header, 'IMPORT_EVIDENCE', ['header/graderConfig/reading']);
  assert.match(h.message, /the grader's configuration holds a reading rule; the rule is the header's own field \(reading\), and the grader is not told one/);
  const record = fix();
  rec(record.rows[0]).reading = READING;
  const r = refuse(record, 'IMPORT_EVIDENCE', ['line 2/graderEvidence.reading']);
  assert.match(r.message, /a record holds no reading rule \(no grader records one\); Grade the stored outputs again with examples\/importers\/skill-evals\/regrade\.ts/);
});

// ---- the command -----------------------------------------------------------------------------------------------------

test('the command prints the six judge fields, the written file\'s sha256, the thinking count, the rule and what it read; it never overwrites --out', () => {
  const bytes = fixtureBytes('old-judge');
  const cli = viaMain(bytes);
  assert.equal(cli.code, 0, cli.err);
  assert.equal(cli.err, '');
  const written = readFileSync(cli.outPath);
  const fragment = JSON.parse(cli.out.slice(0, cli.out.indexOf('\n}\n') + 2)) as { judge: Record<string, string>; systems: Record<string, Record<string, string>>; drawsPerCase: number };
  assert.deepEqual(fragment.judge, conv(bytes).judge);
  assert.deepEqual(Object.keys(fragment.judge), ['judgeDefinitionHash', 'judgeModelRequested', 'judgeModelServed', 'judgeCallShapeHash', 'judgeHarnessVersion', 'rubricHash']);
  assert.equal(fragment.systems['<system name>']?.['<old or new>'], sha256Hex(written));
  assert.equal(fragment.drawsPerCase, 3);
  const f = parse(bytes);
  for (const line of [
    `run file sha256: ${sha256Hex(written)}`,
    "the record reports the shipped grader's sha256",
    'system side and seed: UNKNOWN (this run can enter judge-change only under "system-side-not-compared"; `gate` refuses it)',
    "replies with reasoning: 0 of 9 asks; reasoning tokens (the provider's own count): total 0, median 0, max 0; counter absent on 0",
    'reading rule: one-json-object-boolean-pass/v1',
    `re-grade file sha256: ${sha256Hex(bytes)}`,
    "source rep: 0 of the flow's 2 declared; each stored output graded 3 times (shown for the reader: nothing checks that two runs were made from the same rep, and judge-change refuses a pair only where their stored outputs differ)",
    `results.jsonl sha256: ${f.header.resultsSha256} (checked against the flow that was read again; shown for the reader to compare between the two re-grades of one comparison: nothing checks that the two values are equal)`,
    `_state.json sha256: ${f.header.stateSha256}`,
    `harness_sha: ${'0'.repeat(64)} (as the flow's _state.json states it; its form is held, 64 hexadecimal characters or UNKNOWN, and what it is the hash of is not checked)`,
    `flow: read again from ${exampleFlow}; results.jsonl, _state.json, the excluded cases and the trace and stored output of the source rep of every case are the ones the re-grade read`,
    'source version: UNKNOWN; row profile skill-evals/1 (pinned by the importer; written against CLI 2.1.288; no version is read)',
  ]) {
    assert.ok(cli.out.split('\n').includes(line), `${line}\n--- in ---\n${cli.out}`);
  }
  assert.match(cli.out, /^grader: anchorset-recording-grader js node v/m);
  // The sha256 line and the next-step line come last, after every line this importer adds.
  assert.deepEqual(cli.out.split('\n').slice(-2), [`run file sha256: ${sha256Hex(written)}`, NEXT_STEP_LINE]);
  // The run is the library's: it parses, and the text on disk is the run the conversion gave.
  assert.deepEqual(JSON.parse(written.toString('utf8')), JSON.parse(JSON.stringify(conv(bytes).run)));
  parseRunArtifact(JSON.parse(written.toString('utf8')));
  // The key the grader was handed is nowhere: not in the run, not in what was printed.
  assert.ok(!written.toString('utf8').includes(FIXTURE_KEY));
  assert.ok(!cli.out.includes(FIXTURE_KEY));

  // A second import to the same path is a usage error, and the file is left as it is.
  const inPath = join(work, 'again.regrade.jsonl');
  const casesPath = join(work, 'again-cases.json');
  const barPath = join(work, 'again-bar.json');
  writeFileSync(inPath, bytes);
  writeFileSync(casesPath, casesText);
  writeFileSync(barPath, barText);
  const err: string[] = [];
  const code = main(['--in', inPath, '--cases', casesPath, '--bar', barPath, '--out', cli.outPath, '--reading', READING, '--flow', exampleFlow], { out: () => undefined, err: (s) => err.push(s) });
  assert.equal(code, 64);
  assert.match(err.join('\n'), /exists; an importer never overwrites --out/);
  assert.ok(readFileSync(cli.outPath).equals(written));
});

test('the command as a process: exit 0 on a fixture, 2 on a refused file, with nothing written', () => {
  const out = join(work, 'process-out.json');
  const good = spawnSync(process.execPath, [importer, '--in', join(dir, 'fixtures', 'new-judge.regrade.jsonl'), '--cases', join(dir, 'cases.json'), '--bar', join(dir, 'bar.json'), '--out', out, '--reading', READING, '--flow', exampleFlow], { env: scratchEnv(), encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /^flow: read again from /m);
  assert.ok(existsSync(out));
  const refusedOut = join(work, 'process-refused.json');
  const bad = spawnSync(process.execPath, [importer, '--in', join(dir, 'bad-fixtures', 'failed-slot.regrade.jsonl'), '--cases', join(dir, 'cases.json'), '--bar', join(dir, 'bar.json'), '--out', refusedOut, '--reading', READING, '--flow', exampleFlow], { env: scratchEnv(), encoding: 'utf8' });
  assert.equal(bad.status, 2, bad.stderr);
  assert.match(ownStderr(bad.stderr), /^REFUSED IMPORT_UNGRADED/);
  assert.equal(existsSync(refusedOut), false);
});

test('usage errors exit 64 and input errors 65', () => {
  const io = (): { err: string[]; io: { out: () => void; err: (s: string) => void } } => {
    const err: string[] = [];
    return { err, io: { out: () => undefined, err: (s) => err.push(s) } };
  };
  const a = io();
  assert.equal(main(['--in', 'x'], a.io), 64);
  assert.ok(a.err.join('\n').includes(USAGE));
  const b = io();
  assert.equal(main(['--flow', 'a', '--flow', 'b'], b.io), 64);
  assert.match(b.err.join('\n'), /--flow given twice/);
  const c = io();
  assert.equal(main(['--flow'], c.io), 64);
  assert.match(c.err.join('\n'), /--flow needs a value/);
  const unknown = viaMain(fixtureBytes('old-judge'), { extra: ['--select', '/reply'] });
  assert.equal(unknown.code, 64);
  assert.match(unknown.err, /unknown argument "--select"/);
  // A flow directory that is not there is a usage error, not a refusal.
  const noFlow = viaMain(fixtureBytes('old-judge'), { flow: join(work, 'no-such-flow') });
  assert.equal(noFlow.code, 64, noFlow.err);
  assert.equal(existsSync(noFlow.outPath), false);
  // A cases file that names a class outside the bar does not validate.
  const badCases = viaMain(fixtureBytes('old-judge'), { cases: { 'bank-dispute': { klass: 'no_such_class', expect: 'pass' } } });
  assert.equal(badCases.code, 65);
  assert.match(badCases.err, /INVALID_INPUT/);
});

// ---- not a re-grade file ---------------------------------------------------------------------------------------------

test('a plain results.jsonl of the source is refused, IMPORT_NO_RECORD, with a message that names regrade.ts', () => {
  const plain = readFileSync(join(exampleFlow, 'baseline', 'results.jsonl'));
  const e = refuse(plain, 'IMPORT_NO_RECORD', ['in.regrade.jsonl']);
  assert.match(e.message, /examples\/importers\/skill-evals\/regrade\.ts/);
  assert.match(e.message, /its grades are never read/);
  const cli = viaMain(plain, { inName: 'results.jsonl' });
  assert.equal(cli.code, 2);
  assert.match(cli.err, /REFUSED IMPORT_NO_RECORD.*regrade\.ts/);
});

test('a file that is not JSON lines, a header of another schema, and a row whose record is of no known schema are IMPORT_NO_RECORD', () => {
  // A pretty-printed JSON file is not JSON lines: the shared reader refuses its first line.
  refuse(Buffer.from('{\n  "results": []\n}\n'), 'IMPORT_SHAPE', ['in.regrade.jsonl']);
  assert.match(refuse(Buffer.from(''), 'IMPORT_NO_RECORD').message, /regrade\.ts/);
  const other = fix();
  other.header.schema = 'example.skill-evals-regrade/v0';
  assert.match(refuse(other, 'IMPORT_NO_RECORD', ['in.regrade.jsonl']).message, /regrade\.ts/);
  const noSchema = fix();
  noSchema.rows[4].graderEvidence = { grade: 1 };
  assert.match(refuse(noSchema, 'IMPORT_NO_RECORD', ['line 6/graderEvidence']).message, /regrade\.ts/);
});

test('a record of an earlier version is refused with the instruction to grade again with regrade.ts', () => {
  for (const version of ['v7', 'v6', 'v5', 'v4', 'v3']) {
    const f = fix();
    rec(f.rows[0]).schema = `example.grader-evidence/${version}`;
    assert.match(refuse(f, 'IMPORT_EVIDENCE', ['line 2/graderEvidence.schema']).message, /an earlier version than example\.grader-evidence\/v8; Grade the stored outputs again with examples\/importers\/skill-evals\/regrade\.ts/, version);
  }
});

// ---- slots with no grade: every one listed ------------------------------------------------------------------------------

test('bad fixture, a failed slot: the file the script kept after a failed call is refused, the failed slot and every slot it never reached listed', () => {
  const bytes = badBytes('failed-slot');
  const f = parse(bytes);
  // What the real script wrote when the endpoint answered status 500 on the first call: the header and one row with no record.
  assert.equal(f.rows.length, 1);
  assert.equal(typeof f.rows[0].error, 'string');
  assert.equal('graderEvidence' in f.rows[0], false);
  const e = refuse(bytes, 'IMPORT_UNGRADED', ORDER);
  assert.match(e.message, /9 slot\(s\) hold no finished, readable grade/);
  assert.match(e.message, /bank-dispute#0 \(in\.regrade\.jsonl:2: the re-grade recorded a failed call: the grader's call failed: grader: the endpoint answered status 500\)/);
  assert.match(e.message, /faulty-headphones#2 \(no row: the re-grade ended before this slot was graded\)/);
  // What to do is said in full, and the refusal points at no document.
  assert.match(e.message, /Nothing was written\. Keep this file as it is, and do not delete or replace it: the measurement planned on this re-grade is aborted, and a further re-grade is a new experiment that is reported together with this refused one$/);
  assert.doesNotMatch(e.message, /docs\/|\.md\b|README/);
  assert.ok(!bytes.toString('utf8').includes(FIXTURE_KEY));
});

test('bad fixture, an unreadable reply: every reply is finished and holds no verdict under either rule, so every slot is listed under both', () => {
  const bytes = badBytes('unreadable-reply');
  assert.equal(rec(parse(bytes).rows[0]).reply, '{"reason":"Local fake judge: no verdict given."}');
  const e = refuse(bytes, 'IMPORT_UNGRADED', ORDER);
  assert.match(e.message, /not exactly one JSON object with a boolean "pass", under the reading rule one-json-object-boolean-pass\/v1 that was stated\)/);
  assert.doesNotMatch(e.message, /readable under/);
  refuse(underRule(parse(bytes), FENCE_READING), 'IMPORT_UNGRADED', ORDER, { reading: FENCE_READING });
});

test('a call that failed in the middle of a case\'s draws: the failed slot and every slot after it are listed, the graded ones are not', () => {
  const f = fix();
  f.rows = f.rows.slice(0, 5);
  delete f.rows[4].graderEvidence;
  f.rows[4].error = "the grader's call failed: grader: the endpoint answered status 529";
  refuse(f, 'IMPORT_UNGRADED', ['clearance-organiser#1', 'clearance-organiser#2', ...slotsOf('faulty-headphones')]);
});

test('a row without graderEvidence, and a row with both a record and an error, are slots with no grade', () => {
  const none = fix();
  delete none.rows[2].graderEvidence;
  assert.match(refuse(none, 'IMPORT_UNGRADED', ['bank-dispute#2']).message, /the row holds no graderEvidence/);
  const both = fix();
  both.rows[8].error = 'the record was written and the call failed';
  refuse(both, 'IMPORT_UNGRADED', ['faulty-headphones#2']);
});

test('fewer rows than the header\'s slotCount: every missing slot is listed', () => {
  const f = fix();
  f.rows = f.rows.slice(0, 7);
  refuse(f, 'IMPORT_UNGRADED', ['faulty-headphones#1', 'faulty-headphones#2']);
  // A header that states fewer slots does not hide them: the roster of cases.json is not the file's.
  const stated = fix();
  stated.rows = stated.rows.slice(0, 6);
  stated.header.slotCount = 6;
  refuse(stated, 'IMPORT_CASE_MISSING', ['faulty-headphones']);
});

test('a stop that is not end_turn, a second text block and a tool block are slots with no grade', () => {
  const stop = fix();
  rec(stop.rows[0]).stopReason = 'max_tokens';
  assert.match(refuse(stop, 'IMPORT_UNGRADED', ['bank-dispute#0']).message, /the judge stopped with "max_tokens"/);
  const two = fix();
  rec(two.rows[1]).contentTypes = ['text', 'text'];
  rec(two.rows[4]).contentTypes = ['tool_use'];
  refuse(two, 'IMPORT_UNGRADED', ['bank-dispute#1', 'clearance-organiser#1']);
});

test('a reply with prose around the object, a missing pass and a pass that is not a boolean are unreadable', () => {
  for (const reply of ['Here is my verdict: {"pass": true}', '{"reason": "fine"}', '{"pass": "true"}', '', '{"pass": true} {"pass": false}']) {
    const f = fix();
    rec(f.rows[3]).reply = reply;
    refuse(f, 'IMPORT_UNGRADED', ['clearance-organiser#0']);
  }
});

// ---- the shape of the file ---------------------------------------------------------------------------------------------

test('a torn last line, a line that is not JSON, a null, an unknown key and a missing key are IMPORT_SHAPE', () => {
  const text = fixtureBytes('old-judge').toString('utf8');
  assert.match(refuse(Buffer.from(text.slice(0, -1)), 'IMPORT_SHAPE', ['in.regrade.jsonl']).message, /the last line does not end with a line feed/);
  refuse(Buffer.from(text.slice(0, -40)), 'IMPORT_SHAPE', ['in.regrade.jsonl']);
  refuse(Buffer.from(text.replace('\n{"caseId":"clearance-organiser","draw":0', '\n\n{"caseId":"clearance-organiser","draw":0')), 'IMPORT_SHAPE', ['in.regrade.jsonl']);
  refuse(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fixtureBytes('old-judge')]), 'IMPORT_SHAPE');
  refuse(Buffer.concat([fixtureBytes('old-judge').subarray(0, 100), Buffer.from([0xff]), fixtureBytes('old-judge').subarray(100)]), 'IMPORT_SHAPE');

  const nullRow = fix();
  nullRow.rows[1].parts.question = null;
  refuse(nullRow, 'IMPORT_SHAPE', ['bank-dispute#1']);
  const nullHeader = fix();
  nullHeader.header.graderConfig.temperature = null;
  refuse(nullHeader, 'IMPORT_SHAPE', ['header/graderConfig.temperature']);
  const extraHeader = fix();
  extraHeader.header.note = 'edited';
  refuse(extraHeader, 'IMPORT_SHAPE', ['header/note']);
  const missingHeader = fix();
  delete missingHeader.header.stateSha256;
  refuse(missingHeader, 'IMPORT_SHAPE', ['header/stateSha256']);
  const extraRow = fix();
  extraRow.rows[0].grade = { reply_ok: 1 };
  refuse(extraRow, 'IMPORT_SHAPE', ['bank-dispute#0']);
  const missingRow = fix();
  delete missingRow.rows[0].traceSha256;
  refuse(missingRow, 'IMPORT_SHAPE', ['bank-dispute#0']);
  const short = fix();
  short.rows[0].storedOutputSha256 = short.rows[0].storedOutputSha256.slice(0, 12);
  refuse(short, 'IMPORT_SHAPE', ['bank-dispute#0']);
  const noId = fix();
  noId.rows[0].caseId = '';
  refuse(noId, 'IMPORT_CASE_ID', ['in.regrade.jsonl:2']);
});

test('a header without the source rep, the draws or the harness value, or with a source rep outside the flow\'s reps, is IMPORT_SHAPE', () => {
  for (const key of ['sourceRep', 'draws', 'harnessSha']) {
    // A file written before the header stated them.
    const f = fix();
    delete f.header[key];
    assert.match(refuse(f, 'IMPORT_SHAPE', [`header/${key}`]).message, /missing/);
  }
  const hex = sha256Hex('a harness');
  const edits: [string, unknown][] = [
    ['sourceRep', 2], ['sourceRep', -1], ['sourceRep', 0.5], ['sourceRep', '0'], ['draws', 0], ['draws', 2.5], ['draws', '3'], ['harnessSha', ''], ['harnessSha', 7],
    // The harness value is 64 lowercase hexadecimal characters or exactly the gap marker: free text, and a text with a line feed, is not taken.
    ['harnessSha', 'sha256:abc123 (runner and listed files)'], ['harnessSha', `sha256:${hex}`], ['harnessSha', hex.toUpperCase()], ['harnessSha', hex.slice(1)], ['harnessSha', `${hex}0`], ['harnessSha', `${hex}\n`],
    ['harnessSha', `${hex}\nREFUSED forged: a line of a report\n/Users/someone/flow`], ['harnessSha', 'unknown'], ['harnessSha', 'UNKNOWN '],
  ];
  for (const [key, value] of edits) {
    const f = fix();
    f.header[key] = value;
    const r = refuse(f, 'IMPORT_SHAPE', [`header/${key}`]);
    // A refused harness value is never echoed: no line feed and no path of it reaches the message.
    if (key === 'harnessSha') {
      assert.equal(r.message, 'IMPORT_SHAPE: in.regrade.jsonl:1: harnessSha: expected a full 64-character sha256', JSON.stringify(value));
    }
  }
  // The two forms that are taken, and what the run's packetSource then holds: a line of plain characters.
  for (const value of [hex, 'UNKNOWN']) {
    const f = fix();
    f.header.harnessSha = value;
    const source = runOf(f).packetSource ?? '';
    assert.ok(source.includes(`; harness_sha: ${value}; `), value);
    assert.match(source, /^[\x20-\x7e]+$/);
  }
  const beyond = fix();
  beyond.header.sourceRep = 2;
  assert.match(refuse(beyond, 'IMPORT_SHAPE').message, /2 is not one of the 2 declared rep\(s\) of the flow \(reps are 0 to 1\)/);
});

test('a header that names another script, another variant form, another selector syntax or a script list without the grader is refused', () => {
  const script = fix();
  script.header.script = 'my-own-regrade.ts';
  refuse(script, 'IMPORT_SHAPE', ['header/script']);
  const variant = fix();
  variant.header.variant = '../baseline';
  refuse(variant, 'IMPORT_SHAPE', ['header/variant']);
  const syntax = fix();
  syntax.header.selector.syntax = 'jsonpath/v1';
  refuse(syntax, 'IMPORT_SHAPE', ['header/selector']);
  const emptyPointer = fix();
  emptyPointer.header.selector.pointer = '';
  refuse(emptyPointer, 'IMPORT_SHAPE', ['header/selector']);
  const files = fix();
  files.header.scriptFiles = files.header.scriptFiles.filter((x: J) => !x.path.endsWith('grader-provider.cjs'));
  refuse(files, 'IMPORT_SHAPE', ['header/scriptFiles']);
  const twice = fix();
  twice.header.scriptFiles.push({ ...twice.header.scriptFiles[0] });
  refuse(twice, 'IMPORT_SHAPE', ['header/scriptFiles']);
});

test('the header\'s list of script files is checked: exactly the files the importer knows the script imports, each once, sorted, each entry { path, sha256 } with a full sha256', () => {
  const known = [...SCRIPT_FILES];
  assert.ok(known.includes(SCRIPT) && known.includes(GRADER_FILE));
  for (const name of ['old-judge', 'new-judge', 'new-judge-rep1'] as const) assert.deepEqual(fix(name).header.scriptFiles.map((x: J) => x.path), known, name);
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

  // An omitted file: each of the known paths in turn, the script itself and the flow reader included.
  for (const path of known) {
    const f = fix();
    f.header.scriptFiles = f.header.scriptFiles.filter((x: J) => x.path !== path);
    assert.match(refuse(f, 'IMPORT_SHAPE', ['header/scriptFiles']).message, new RegExp(`scriptFiles: ${esc(path)} is not listed`), path);
  }
  // Only the script and the grader listed: every other file is named.
  const two = fix();
  two.header.scriptFiles = two.header.scriptFiles.filter((x: J) => x.path === SCRIPT || x.path === GRADER_FILE);
  const twoRefusal = refuse(two, 'IMPORT_SHAPE', ['header/scriptFiles']);
  for (const path of known.filter((p) => p !== SCRIPT && p !== GRADER_FILE)) assert.match(twoRefusal.message, new RegExp(`${esc(path)} is not listed`), path);

  // An extra file, in its sorted place: one that does not exist, and one that does and that the script does not import.
  for (const path of ['examples/importers/skill-evals/zz-no-such-file.ts', 'examples/importers/skill-evals/import.ts', 'src/index.ts']) {
    const f = fix();
    f.header.scriptFiles = [...f.header.scriptFiles, { path, sha256: 'b'.repeat(64) }].sort((a: J, b: J) => (a.path < b.path ? -1 : 1));
    assert.match(refuse(f, 'IMPORT_SHAPE', ['header/scriptFiles']).message, new RegExp(`scriptFiles: "${esc(path)}" is listed, and is not a file the re-grade script imports`), path);
  }

  // A malformed entry.
  const malformed: [string, (list: J[]) => void][] = [
    ['a short sha256', (l) => { l[2].sha256 = l[2].sha256.slice(0, 12); }],
    ['an upper-case sha256', (l) => { l[2].sha256 = l[2].sha256.toUpperCase(); }],
    ['no sha256', (l) => { delete l[2].sha256; }],
    ['a sha256 that is a number', (l) => { l[2].sha256 = 7; }],
    ['an empty path', (l) => { l[2].path = ''; }],
    ['a path that is a list', (l) => { l[2].path = [l[2].path]; }],
    ['another key', (l) => { l[2].size = 1024; }],
    ['a text in place of an entry', (l) => { l[2] = l[2].path; }],
    ['a list in place of an entry', (l) => { l[2] = [l[2].path, l[2].sha256]; }],
  ];
  for (const [what, edit] of malformed) {
    const f = fix();
    edit(f.header.scriptFiles);
    assert.match(refuse(f, 'IMPORT_SHAPE', ['header/scriptFiles']).message, /scriptFiles: every entry must be \{ path, sha256 \} with a non-empty path and a full sha256, and no other key/, what);
  }
  for (const value of [[], {}, 'examples/importers/skill-evals/regrade.ts']) {
    const f = fix();
    f.header.scriptFiles = value;
    assert.match(refuse(f, 'IMPORT_SHAPE', ['header/scriptFiles']).message, /scriptFiles: expected a non-empty list of \{ path, sha256 \}/);
  }

  // The same entries in another order, and an entry twice.
  const unsorted = fix();
  unsorted.header.scriptFiles.reverse();
  assert.match(refuse(unsorted, 'IMPORT_SHAPE', ['header/scriptFiles']).message, /scriptFiles: the paths are not sorted, as the script writes them/);
  const twice = fix();
  twice.header.scriptFiles.splice(1, 0, { ...twice.header.scriptFiles[0] });
  assert.match(refuse(twice, 'IMPORT_SHAPE', ['header/scriptFiles']).message, /scriptFiles: a path is listed twice/);
});

test('what of the script-file list is only declared: a sha256 other than the grader\'s is not compared with any file, and changes the harness version', () => {
  // The importer reads no script file. A wrong sha256 for the script itself imports; the run then names another harness.
  for (const path of [SCRIPT, 'examples/importers/skill-evals/flow.ts', 'examples/importers/shared.ts']) {
    const f = fix();
    f.header.scriptFiles.find((x: J) => x.path === path).sha256 = 'c'.repeat(64);
    const edited = conv(f).judge;
    const good = conv(fix()).judge;
    assert.notEqual(edited.judgeHarnessVersion, good.judgeHarnessVersion, path);
    assert.deepEqual({ ...edited, judgeHarnessVersion: '' }, { ...good, judgeHarnessVersion: '' }, path);
  }
  // The one sha256 of the list that is checked is the grader's, against the records.
  const grader = fix();
  grader.header.scriptFiles.find((x: J) => x.path === GRADER_FILE).sha256 = 'c'.repeat(64);
  assert.match(refuse(grader, 'IMPORT_EVIDENCE', ['header/scriptFiles']).message, /is not the grader's sha256 in the records/);
});

test('another row profile is refused, IMPORT_TOOL_VERSION: the profile is what this importer pins', () => {
  const f = fix();
  f.header.rowProfile = 'skill-evals/2';
  const e = refuse(f, 'IMPORT_TOOL_VERSION', ['header/rowProfile']);
  assert.match(e.message, /this importer reads row profile skill-evals\/1 \(pinned by the importer; written against CLI 2\.1\.288; no version is read\); the file says "skill-evals\/2"/);
});

// ---- one stored output per case ------------------------------------------------------------------------------------------

test('the rows of one case must hold one stored output: a row with another output is IMPORT_OUTPUTS_DIFFER, naming the row', () => {
  // One draw of one case is given rep 1's stored output, with its answer, prompt and hashes written again: a file in
  // which that draw is consistent in itself and is not a repeated grade of the case's output.
  const f = fix();
  const row = f.rows[7];
  row.storedOutput = turnOf('faulty-headphones', 1).turn;
  row.storedOutputSha256 = sha256Hex(row.storedOutput);
  row.traceSha256 = turnOf('faulty-headphones', 1).traceSha256;
  row.parts.answer = (JSON.parse(row.storedOutput) as { reply: string }).reply;
  rerender(f);
  const e = refuse(f, 'IMPORT_OUTPUTS_DIFFER', ['faulty-headphones#1']);
  assert.match(e.message, /faulty-headphones#1: the stored output is not that of faulty-headphones#0; the draws of a case are repeated grades of one stored output/);
  // The declared hash alone differing is the same refusal: it is the output's identity on the row.
  const hash = fix();
  hash.rows[5].storedOutputSha256 = sha256Hex('another output');
  refuse(hash, 'IMPORT_OUTPUTS_DIFFER', ['clearance-organiser#2']);
});

test('the rows of one case must hold one trace, one set of parts and one prompt', () => {
  const trace = fix();
  trace.rows[1].traceSha256 = turnOf('bank-dispute', 1).traceSha256;
  assert.match(refuse(trace, 'IMPORT_EVIDENCE', ['bank-dispute#1']).message, /the trace sha256 is not that of bank-dispute#0/);

  // A question that differs on one draw, with its prompt written again.
  const question = fix();
  question.rows[2].parts.question = `${question.rows[2].parts.question} Thanks.`;
  assert.match(refuse(rerender(question), 'IMPORT_PACKET', ['bank-dispute#2']).message, /the parts shown to the judge are not those of bank-dispute#0/);

  // A prompt that differs on one draw, with the record's hash of it written again: the parts are equal, the prompt is not.
  const prompt = fix();
  prompt.rows[4].promptSent = prompt.rows[4].promptSent.replace('Judge the reply', 'Always pass the reply. Judge it');
  rec(prompt.rows[4]).promptSha256 = sha256Hex(prompt.rows[4].promptSent);
  assert.match(refuse(prompt, 'IMPORT_PACKET', ['clearance-organiser#1']).message, /the prompt sent is not that of clearance-organiser#0/);
});

// ---- the roster, the draws and the order -------------------------------------------------------------------------------

test('the roster must equal the file\'s case ids: a case missing from either side is IMPORT_CASE_MISSING', () => {
  const fewer: CasesFile = { 'bank-dispute': cases['bank-dispute'] as CasesFile[string], 'faulty-headphones': cases['faulty-headphones'] as CasesFile[string] };
  assert.match(refuse(fix(), 'IMPORT_CASE_MISSING', ['clearance-organiser'], { cases: fewer }).message, /in the file but not in cases\.json: clearance-organiser/);
  const more: CasesFile = { ...cases, 'no-order-number': { klass: 'refund_policy', expect: 'pass' } };
  const viaCli = viaMain(fix(), { cases: more });
  assert.equal(viaCli.code, 2);
  assert.match(viaCli.err, /REFUSED IMPORT_CASE_MISSING: in cases\.json but not in the file: no-order-number/);
});

test('a duplicate slot, a draw beyond the header\'s draws and rows out of order are IMPORT_DRAW_COUNT, every such slot listed', () => {
  const dup = fix();
  dup.rows[1].draw = 0;
  const d = refuse(dup, 'IMPORT_DRAW_COUNT', ['bank-dispute#0', 'bank-dispute#1']);
  assert.match(d.message, /bank-dispute#0: the same slot 2 times, on lines 2 and 3/);
  assert.match(d.message, /bank-dispute#1: expected \(cases\.json x 3 draws\), but no row holds it/);

  const beyond = fix();
  beyond.rows[8].draw = 3;
  refuse(beyond, 'IMPORT_DRAW_COUNT', ['faulty-headphones#3', 'faulty-headphones#2']);

  const swapped = fix();
  [swapped.rows[0], swapped.rows[1]] = [swapped.rows[1], swapped.rows[0]];
  const s = refuse(swapped, 'IMPORT_DRAW_COUNT', ['bank-dispute#1', 'bank-dispute#0']);
  assert.match(s.message, /bank-dispute#1: on line 2, where the fixed order \(case id, then draw\) has bank-dispute#0/);

  // The draws per case are the header's `draws`: a header that states four for a file of three per case is refused.
  const draws = fix();
  draws.header.draws = 4;
  assert.match(refuse(draws, 'IMPORT_DRAW_COUNT').message, /cases\.json x the header's draws is 3 x 4 = 12/);
  const extra = fix();
  extra.rows.push(JSON.parse(JSON.stringify(extra.rows[8])));
  refuse(extra, 'IMPORT_DRAW_COUNT');
});

test('a header count beyond the bound is refused at once, before anything is built from it: no long run, no exhausted memory, no error the importer did not foresee', () => {
  // The bound: 100000, or the number of rows the file holds when that is more, so a file is never refused for the rows it has.
  assert.equal(HEADER_COUNT_BOUND, 100000);
  assert.equal(headerCountBound(9), 100000);
  assert.equal(headerCountBound(100000), 100000);
  assert.equal(headerCountBound(250000), 250000);
  // The two values (an invalid list length, and a list that exhausted memory), and the first value past the bound.
  for (const draws of [4294967296, 60000000, 100001]) {
    const f = fix();
    f.header.draws = draws;
    const started = Date.now();
    const e = refuse(f, 'IMPORT_DRAW_COUNT', ['header/draws']);
    assert.ok(Date.now() - started < 5000, `draws ${draws}: refused at once`);
    assert.equal(e.message, `IMPORT_DRAW_COUNT: in.regrade.jsonl:1: draws: ${draws} is beyond 100000, the most this importer takes for a count of the header (or the number of rows in the file, 9, when that is more)`);
  }
  // A header that is consistent in itself and huge: both counts are named, and still nothing is built.
  const both = fix();
  both.header.draws = 60000000;
  both.header.slotCount = 180000000;
  refuse(both, 'IMPORT_DRAW_COUNT', ['header/draws', 'header/slotCount']);
  // The rep count is handed to the flow reader with --flow, which walks every rep of every case: it has the plain
  // bound, which is the flow reader's own, whatever the number of rows.
  for (const count of [1000000000, 4294967296, 100001]) {
    const reps = fix();
    reps.header.reps = count;
    const e = refuse(reps, 'IMPORT_DRAW_COUNT', ['header/reps']);
    assert.equal(e.message, `IMPORT_DRAW_COUNT: in.regrade.jsonl:1: reps: ${count} is beyond 100000, the most this importer takes for the declared rep count of a flow`);
    refuse(reps, 'IMPORT_DRAW_COUNT', ['header/reps'], { flow: exampleFlow });
  }
  // Nor may the slots of the flow that --flow reads (the stated cases times the rep count) pass the bound: the re-grade
  // script refuses such a count before it reads the flow, so a header that states one is refused, with --flow or without.
  // Three stated cases: 33334 reps are 100002 slots, and 100000 reps are 300000.
  for (const [count, slots] of [[33334, 100002], [100000, 300000]] as const) {
    const reps = fix();
    reps.header.reps = count;
    const started = Date.now();
    const e = refuse(reps, 'IMPORT_DRAW_COUNT', ['header/reps']);
    assert.equal(e.message, `IMPORT_DRAW_COUNT: in.regrade.jsonl:1: reps: 3 case(s) of the cases file x ${count} declared rep(s) is ${slots} slots of the flow, more than the 100000 this path takes`);
    assert.equal(refuse(reps, 'IMPORT_DRAW_COUNT', ['header/reps'], { flow: exampleFlow }).message, e.message);
    assert.ok(Date.now() - started < 5000, `reps ${count}: refused at once`);
  }
  // The most slots are taken for the rep count; with --flow the flow's own count then refuses it, as a refusal and not as a usage error.
  const most = fix();
  most.header.reps = 33333;
  conv(most);
  refuse(most, 'IMPORT_DRAW_COUNT', ['_state.json'], { flow: exampleFlow });
  // The bound itself is taken: one case with 100000 draws stated and three rows present is an unfinished re-grade,
  // refused as one, with a list no longer than the bound.
  const at = fix();
  at.rows = at.rows.slice(0, 3);
  at.header.draws = 100000;
  at.header.slotCount = 100000;
  const started = Date.now();
  const unfinished = refuse(at, 'IMPORT_UNGRADED', undefined, { cases: { 'bank-dispute': cases['bank-dispute'] as CasesFile[string] } });
  assert.match(unfinished.message, /^IMPORT_UNGRADED: 99997 slot\(s\) hold no finished, readable grade/);
  assert.equal(unfinished.fields.length, 99997);
  assert.ok(Date.now() - started < 20000);
});

test('the header\'s counts are compared as numbers first: more draws than slots, and more rows than slots, are IMPORT_DRAW_COUNT; a slot count that is not the roster times the draws lists no slot by name', () => {
  const draws = fix();
  draws.header.draws = 10;
  assert.match(refuse(draws, 'IMPORT_DRAW_COUNT', ['header/draws']).message, /draws: 10 is more than the header's slotCount 9/);
  const rows = fix();
  rows.header.slotCount = 6;
  rows.header.draws = 2;
  assert.match(refuse(rows, 'IMPORT_DRAW_COUNT', ['header/slotCount']).message, /the file holds 9 rows, more than the header's slotCount 6/);
  // An unfinished file whose slot count the stated cases do not account for: the shortfall is said as a number, and
  // no list of slots is made from a count that the roster contradicts.
  const short = fix();
  short.rows = short.rows.slice(0, 4);
  short.header.slotCount = 12;
  const e = refuse(short, 'IMPORT_UNGRADED');
  assert.deepEqual([...e.fields], ["8 row(s) fewer than the header's slotCount 12"]);
  assert.match(e.message, /the re-grade did not finish/);
});

// ---- the forward checks, each naming the slot ---------------------------------------------------------------------------
// An edit here is made on every row of a case, so that the case still holds one output, one set of parts and one prompt
// and the forward check is what finds it.

test('the header\'s template, criterion and system texts must match their sha256', () => {
  for (const key of ['template', 'criterion', 'system'] as const) {
    const f = fix();
    f.header[key].text = `${f.header[key].text} `;
    const e = refuse(f, 'IMPORT_EVIDENCE', [`header/${key}`]);
    assert.match(e.message, /the sha256 is not the hash of the text beside it/);
  }
});

test('a template outside the three-token form is IMPORT_PACKET, even when its sha256 is right', () => {
  const f = fix();
  f.header.template = textAndHash(`${f.header.template.text}{notes}\n`);
  assert.match(refuse(f, 'IMPORT_PACKET', ['header/template']).message, /template: the template is outside the form the renderer takes: a brace that is not one of the three plain tokens .* or another name\)$/);
  // This path's own rule, beside the shared brace rule: each token exactly once.
  const twice = fix();
  twice.header.template = textAndHash(`${twice.header.template.text}{answer}\n`);
  assert.match(refuse(twice, 'IMPORT_PACKET', ['header/template']).message, /\{answer\} appears 2 times, not once$/);
});

test('storedOutputSha256 must be the sha256 of the stored output on the row', () => {
  const f = fix();
  for (const row of rowsOfCase(f, 'clearance-organiser')) row.storedOutputSha256 = sha256Hex('another output');
  assert.match(refuse(f, 'IMPORT_EVIDENCE', slotsOf('clearance-organiser')).message, /storedOutputSha256 is not the sha256 of the stored output/);
  // A stored output edited on every row of the case, with the hash, the answer and the prompt left as they were.
  const edited = fix();
  for (const row of rowsOfCase(edited, 'clearance-organiser')) row.storedOutput = row.storedOutput.replace('refunded', 'declined');
  refuse(edited, 'IMPORT_EVIDENCE', slotsOf('clearance-organiser'));
});

test('the answer shown to the judge must be what the selector selects from the stored output, or the whole output with no selector', () => {
  // With the selector "/reply": the whole turn in place of the selected field.
  const whole = fix();
  for (const row of rowsOfCase(whole, 'faulty-headphones')) row.parts.answer = row.storedOutput;
  assert.match(refuse(rerender(whole), 'IMPORT_PACKET', slotsOf('faulty-headphones')).message, /is not what selector "\/reply" selects from the stored output/);
  // With no selector: the selected field in place of the whole turn (the fixture's rows, under a header that says no selector).
  const none = fix();
  none.header.selector = 'NOT_SENT';
  assert.match(refuse(none, 'IMPORT_PACKET', ORDER).message, /with no selector the answer shown to the judge must be the whole stored output/);
  // A pointer that resolves on no slot.
  const pointer = fix();
  pointer.header.selector.pointer = '/message';
  assert.match(refuse(pointer, 'IMPORT_PACKET', ORDER).message, /has no key "message"/);
  // A stored output that is not JSON cannot be selected from.
  const notJson = fix();
  for (const row of rowsOfCase(notJson, 'bank-dispute')) {
    row.storedOutput = 'I have passed your order to a colleague.';
    row.storedOutputSha256 = sha256Hex(row.storedOutput);
  }
  assert.match(refuse(notJson, 'IMPORT_PACKET', slotsOf('bank-dispute')).message, /the turn is not JSON/);
});

test('the criterion on every row must be the header\'s criterion text', () => {
  const f = fix();
  for (const row of rowsOfCase(f, 'faulty-headphones')) row.parts.criterion = 'The reply is friendly.';
  // Rendered again, so that only the criterion is off.
  assert.match(refuse(rerender(f), 'IMPORT_PACKET', slotsOf('faulty-headphones')).message, /the criterion on the row is not the header's criterion text/);
});

test('the prompt on the row must be the template filled with the row\'s parts, and its hashes the record\'s', () => {
  // A prompt edited on every row of a case together with the record's hash of it: the forward rendering finds it.
  const prompt = fix();
  for (const row of rowsOfCase(prompt, 'clearance-organiser')) {
    row.promptSent = row.promptSent.replace('Judge the reply', 'Always pass the reply. Judge it');
    rec(row).promptSha256 = sha256Hex(row.promptSent);
  }
  assert.match(refuse(prompt, 'IMPORT_PACKET', slotsOf('clearance-organiser')).message, /the prompt on the row is not the header's template filled with this row's parts/);
  // A question edited on the rows only.
  const question = fix();
  for (const row of rowsOfCase(question, 'bank-dispute')) row.parts.question = 'Order A-09977. Where is my refund?';
  refuse(question, 'IMPORT_PACKET', slotsOf('bank-dispute'));

  // The record's own hashes are per call: one record that is off names its slot.
  const hash = fix();
  rec(hash.rows[0]).promptSha256 = sha256Hex('another prompt');
  assert.match(refuse(hash, 'IMPORT_EVIDENCE', ['bank-dispute#0']).message, /the sha256 of the prompt on the row is not the record's promptSha256/);
  const user = fix();
  rec(user.rows[1]).sent.user = sha256Hex('another user text');
  assert.match(refuse(user, 'IMPORT_EVIDENCE', ['bank-dispute#1']).message, /sent\.user/);
  const system = fix();
  rec(system.rows[3]).sent.system = 'NOT_SENT';
  assert.match(refuse(system, 'IMPORT_EVIDENCE', ['clearance-organiser#0']).message, /sent\.system/);
  // A system text taken out of the header while the prompts still carry it.
  const dropped = fix();
  dropped.header.system = 'NOT_SENT';
  refuse(dropped, 'IMPORT_PACKET', ORDER);
});

test('the header\'s graderConfig must agree with the record and its call shape: model, max tokens, thinking, effort and the rest', () => {
  const edits: [string, (c: J) => void][] = [
    ['model', (c) => { c.model = 'another-judge'; }],
    ['max_tokens', (c) => { c.max_tokens = 1024; }],
    ['thinking', (c) => { c.thinking = { type: 'adaptive' }; }],
    ['effort', (c) => { c.effort = 'high'; }],
    ['temperature', (c) => { delete c.temperature; }],
    ['timeoutMs', (c) => { c.timeoutMs = 1000; }],
    ['apiVersion', (c) => { c.apiVersion = '2024-01-01'; }],
    ['baseUrl', (c) => { c.baseUrl = 'http://127.0.0.1:9'; }],
    ['seed', (c) => { c.seed = 7; }],
  ];
  for (const [key, edit] of edits) {
    const f = fix();
    edit(f.header.graderConfig);
    refuse(f, 'IMPORT_EVIDENCE', [`header/graderConfig/${key}`]);
  }
  // A missing thinking or effort is not read as NOT_SENT.
  for (const key of ['thinking', 'effort']) {
    const f = fix();
    delete f.header.graderConfig[key];
    assert.match(refuse(f, 'IMPORT_EVIDENCE', [`header/graderConfig/${key}`]).message, /"not set"/);
  }
  // The record's side: a record that says thinking was sent, under a config that says it was not.
  const sent = fix();
  for (const row of sent.rows) {
    rec(row).sent.thinking = { type: 'adaptive' };
    rec(row).callShape.thinkingMode = 'adaptive';
  }
  refuse(sent, 'IMPORT_EVIDENCE', ['header/graderConfig/thinking']);
});

test('the header\'s grader settings are held to the grader\'s own rules: a base URL with user information, a query or a fragment, and a key variable that is not a name, are refused', () => {
  // The fixture's own base URL, which the record's endpoint is made from.
  const base = fix().header.graderConfig.baseUrl as string;
  assert.equal(base, 'http://127.0.0.1:18765');
  // The first two post to the very endpoint the record names, so the comparison of endpoints alone would pass them.
  const urls: [unknown, RegExp][] = [
    ['http://user:secret@127.0.0.1:18765', /baseUrl: holds user information/],
    ['http://user@127.0.0.1:18765', /baseUrl: holds user information/],
    ['http://127.0.0.1:18765?debug=1', /baseUrl: holds a query or a fragment/],
    ['http://127.0.0.1:18765#x', /baseUrl: holds a query or a fragment/],
    ['http://127.0.0.1:18765/?', /baseUrl: holds a query or a fragment/],
    ['ftp://127.0.0.1:18765', /baseUrl: is not http or https/],
    ['127.0.0.1:18765', /baseUrl: is not /],
    ['', /baseUrl: must be a non-empty string/],
    [7, /baseUrl: must be a non-empty string/],
  ];
  for (const [url, words] of urls) {
    const f = fix();
    f.header.graderConfig.baseUrl = url;
    const e = refuse(f, 'IMPORT_EVIDENCE', ['header/graderConfig/baseUrl']);
    assert.match(e.message, words, String(url));
    assert.match(e.message, /; the grader refuses such a base URL$/);
    assert.doesNotMatch(e.message, /secret/, 'user information is never echoed');
  }
  // The name of the key's variable: a text in the form of a key is refused and not echoed.
  for (const name of ['sk-example-0123456789-not-a-real-key', 'MY KEY', '1KEY', 'KEY-NAME', '', 7]) {
    const f = fix();
    f.header.graderConfig.apiKeyEnv = name;
    const e = refuse(f, 'IMPORT_EVIDENCE', ['header/graderConfig/apiKeyEnv']);
    assert.match(e.message, /apiKeyEnv: not the name of an environment variable \(letters, digits and underscores, not opening with a digit\); the value is not shown/);
    if (typeof name === 'string' && name !== '') assert.ok(!e.message.includes(name), name);
  }
  // The two rules are the shared module's, in its words: this path holds no second copy of either, and each setting is named once.
  const once = fix();
  once.header.graderConfig.baseUrl = 'http://user:secret@127.0.0.1:18765';
  once.header.graderConfig.apiKeyEnv = 'MY KEY';
  const o = refuse(once, 'IMPORT_EVIDENCE', ['header/graderConfig/apiKeyEnv', 'header/graderConfig/baseUrl']);
  assert.equal(o.message, 'IMPORT_EVIDENCE: header/graderConfig/apiKeyEnv: not the name of an environment variable (letters, digits and underscores, not opening with a digit); the value is not shown; header/graderConfig/baseUrl: holds user information; the grader refuses such a base URL');
  assert.deepEqual(
    o.message.slice('IMPORT_EVIDENCE: '.length).split('; header/').map((p, i) => (i === 0 ? p : `header/${p}`)),
    graderConfigProblems(once.header.graderConfig, parseRecord(rec(once.rows[0]), 'r', 'promptfoo'), 'header/graderConfig'),
  );
  // The rest of the grader's rule for a base URL, which the comparison of endpoints would pass or name less closely, and a null.
  for (const [url, words] of [['http://127.0.0.1:18765\\', /baseUrl: holds white space, an "@" or a backslash; the grader refuses such a base URL$/], [' http://127.0.0.1:18765', /baseUrl: holds white space, an "@" or a backslash/], ['http://refunds.example.test:18765', /baseUrl: is plain http to a host that is not 127\.0\.0\.1 or \[::1\]; the grader refuses such a base URL$/]] as const) {
    const f = fix();
    f.header.graderConfig.baseUrl = url;
    assert.match(refuse(f, 'IMPORT_EVIDENCE', ['header/graderConfig/baseUrl']).message, words, String(url));
  }
  // A null is a value, not "not set": this path refuses any null of the file before the settings are compared.
  for (const key of ['timeoutMs', 'apiVersion', 'baseUrl', 'apiKeyEnv']) {
    const f = fix();
    f.header.graderConfig[key] = null;
    assert.match(refuse(f, 'IMPORT_SHAPE', [`header/graderConfig.${key}`]).message, new RegExp(`header\\.graderConfig\\.${key}: null is not allowed`), key);
  }
  // One refusal names what this path checks and what the shared rule checks, together.
  const both = fix();
  both.header.graderConfig.apiKeyEnv = 'MY KEY';
  both.header.graderConfig.reading = READING;
  both.header.graderConfig.model = 'another-judge';
  both.header.graderConfig.seed = 7;
  const b = refuse(both, 'IMPORT_EVIDENCE', ['header/graderConfig/reading', 'header/graderConfig/seed', 'header/graderConfig/model', 'header/graderConfig/apiKeyEnv']);
  assert.match(b.message, /^IMPORT_EVIDENCE: header\/graderConfig\/reading: /);
  assert.match(b.message, /header\/graderConfig\/model: "another-judge" but the record says "fake-judge-old"/);
  assert.match(b.message, /header\/graderConfig\/seed: not a setting the grader sends/);
  // The reading rule is named once, as what it is, and not also as an unknown setting.
  assert.doesNotMatch(b.message, /reading: not a setting the grader sends/);
  assert.equal(b.message.split('IMPORT_EVIDENCE').length, 2, 'the code opens the message once');
  // A name is taken, and reaches neither the run nor the judge's identity.
  const named = fix();
  named.header.graderConfig.apiKeyEnv = 'EXAMPLE_JUDGE_KEY';
  assert.deepEqual(conv(named).run['identity'], conv(fix()).run['identity']);
  assert.ok(!JSON.stringify(conv(named).run).includes('EXAMPLE_JUDGE_KEY'));
});

// ---- the recorded calls ---------------------------------------------------------------------------------------------------

test('two grader runs, a hole or a repeat in callSeq, and calls out of the row order are IMPORT_HIDDEN_CALLS', () => {
  const two = fix();
  rec(two.rows[8]).graderRunId = '00000000-0000-4000-8000-000000000002';
  refuse(two, 'IMPORT_HIDDEN_CALLS', ['graderRunId']);
  const hole = fix();
  rec(hole.rows[8]).callSeq = 10;
  refuse(hole, 'IMPORT_HIDDEN_CALLS', ['callSeq']);
  const repeat = fix();
  rec(repeat.rows[8]).callSeq = 8;
  refuse(repeat, 'IMPORT_HIDDEN_CALLS', ['callSeq']);
  // The set is 1 to 9, each once, but the calls were not made in the order of the rows.
  const order = fix();
  rec(order.rows[3]).callSeq = 5;
  rec(order.rows[4]).callSeq = 4;
  assert.match(refuse(order, 'IMPORT_HIDDEN_CALLS', ['clearance-organiser#0', 'clearance-organiser#1']).message, /clearance-organiser#0 has callSeq 5/);
});

test('a call id or a response id shared by two slots is IMPORT_DUPLICATE_CALL: each draw of a case is a separate call', () => {
  const call = fix();
  rec(call.rows[1]).callId = rec(call.rows[0]).callId;
  refuse(call, 'IMPORT_DUPLICATE_CALL', ['bank-dispute#0', 'bank-dispute#1']);
  const response = fix();
  rec(response.rows[6]).responseId = rec(response.rows[3]).responseId;
  refuse(response, 'IMPORT_DUPLICATE_CALL', ['clearance-organiser#0', 'faulty-headphones#0']);
});

test('one value per run: a second served model, requested model, call shape or grader is IMPORT_MIXED_IDENTITY', () => {
  const edits: [string, (r: J) => void][] = [
    ['servedModel', (r) => { r.servedModel = 'fake-judge-old-served-20260201'; }],
    ['requestedModel', (r) => { r.requestedModel = 'fake-judge-older'; }],
    ['callShape', (r) => { r.callShape.maxOutputTokens = 512; }],
    ['grader.runtime', (r) => { r.grader.runtime = 'node v24.0.0'; }],
    ['grader.sha256', (r) => { r.grader.sha256 = 'b'.repeat(64); }],
  ];
  for (const [field, edit] of edits) {
    const f = fix();
    edit(rec(f.rows[3]));
    refuse(f, 'IMPORT_MIXED_IDENTITY', [field]);
  }
});

test('the record must be the JavaScript grader\'s, valid, and from the grader file the header lists', () => {
  const python = fix();
  for (const row of python.rows) rec(row).grader.language = 'python';
  assert.match(refuse(python, 'IMPORT_EVIDENCE', ORDER).message, /not "js"/);
  const gap = fix();
  rec(gap.rows[0]).servedModel = 'UNKNOWN';
  refuse(gap, 'IMPORT_EVIDENCE', ['line 2/graderEvidence.servedModel']);
  const tool = fix();
  rec(tool.rows[0]).callShape.toolChoice = 'auto';
  refuse(tool, 'IMPORT_EVIDENCE');
  // Every record names one grader file, and the header's list names another.
  const other = fix();
  for (const row of other.rows) rec(row).grader.sha256 = 'c'.repeat(64);
  assert.match(refuse(other, 'IMPORT_EVIDENCE', ['header/scriptFiles']).message, /is not the grader's sha256 in the records/);
});

test('a label outside the bar is IMPORT_BAR', () => {
  const otherBar = loadBar(JSON.stringify({ labels: ['bad', 'good'], classes: { refund_policy: { direction: 'floor', minPassRate: 0.8 }, refund_safety: { direction: 'floor', nonCompensable: true, minPassRate: 1 } }, knownFailures: [] }));
  const otherCases = parseCasesFile(casesText.replaceAll('"pass"', '"good"'), otherBar);
  let caught: unknown;
  try {
    conv(fix('new-judge'), { cases: otherCases, bar: otherBar });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ImportRefusal);
  assert.equal(caught.code, 'IMPORT_BAR');
  assert.deepEqual([...caught.fields].sort(), ['fail', 'pass']);
});

// ---- --flow: the second look at the flow ------------------------------------------------------------------------------------

test('--flow on the flow the re-grade read: the run is the one a flow that agrees with the file gives, for a file of rep 0 and for a file of rep 1, and says the flow was read again', () => {
  for (const name of ['old-judge', 'new-judge-rep1'] as const) {
    const bytes = fixtureBytes(name);
    const checked = conv(bytes, { flow: exampleFlow }).run;
    assert.deepEqual(checked, conv(bytes).run);
    assert.match(checked['packetSource'] as string, /; flow read again: yes\): /);
  }
  const cli = viaMain(fixtureBytes('old-judge'), { flow: exampleFlow });
  assert.equal(cli.code, 0, cli.err);
  assert.match(cli.out, /^flow: read again from .*; results\.jsonl, _state\.json, the excluded cases and the trace and stored output of the source rep of every case are the ones the re-grade read$/m);
  assert.match(cli.out, /^excluded cases: 0 \(cases the flow held and the cases file left out; computed again from the flow and found equal; the run measures the cases of the cases file only\)$/m);
  // With the flow read again the hash is a checked one; that two re-grades show the same value is still the reader's to see.
  assert.match(cli.out, /^results\.jsonl sha256: [0-9a-f]{64} \(checked against the flow that was read again; shown for the reader to compare between the two re-grades of one comparison: nothing checks that the two values are equal\)$/m);
  // Nothing printed says "must" or "never" of something no code enforces.
  assert.doesNotMatch(cli.out, /never paired|must show the same value/);
});

test('--flow detects a changed trace of the source rep: every draw of that case is named and nothing is written', () => {
  // The bytes of rep 0's trace of one case change (a space after the opening bracket) and the stored output does not.
  const spaced = copyFlow();
  const tracePath = join(spaced, 'baseline', 'traces', 'faulty-headphones_rep0.json');
  writeFileSync(tracePath, readFileSync(tracePath, 'utf8').replace('[\n', '[ \n'));
  const a = refuse(fixtureBytes('old-judge'), 'IMPORT_EVIDENCE', slotsOf('faulty-headphones'), { flow: spaced });
  assert.match(a.message, /--flow: faulty-headphones#0: the trace of rep 0 of faulty-headphones is not the file the re-grade read/);
  assert.doesNotMatch(a.message, /stored output/);
  // The same file is the changed trace of rep 0, not of rep 1: a re-grade of rep 1 compares rep 1's traces and imports.
  conv(fixtureBytes('new-judge-rep1'), { flow: spaced });
  // And the other way round: rep 1's trace changes, the rep-0 file imports and the rep-1 file is refused.
  const other = copyFlow();
  const rep1 = join(other, 'baseline', 'traces', 'faulty-headphones_rep1.json');
  writeFileSync(rep1, readFileSync(rep1, 'utf8').replace('[\n', '[ \n'));
  conv(fixtureBytes('old-judge'), { flow: other });
  refuse(fixtureBytes('new-judge-rep1'), 'IMPORT_EVIDENCE', slotsOf('faulty-headphones'), { flow: other });

  // The stored output of the source rep changes: its trace and its output are both named.
  const edited = copyFlow();
  const turn = join(edited, 'baseline', 'traces', 'bank-dispute_rep0.json');
  writeFileSync(turn, readFileSync(turn, 'utf8').replace('I am not able to promise a date', 'you will have the money on Friday'));
  const b = refuse(fixtureBytes('old-judge'), 'IMPORT_EVIDENCE', slotsOf('bank-dispute'), { flow: edited });
  assert.match(b.message, /bank-dispute#0: the stored output in the trace of rep 0 of bank-dispute is not the one on the row/);
});

test('--flow detects a changed results.jsonl, a changed _state.json and a changed harness value', () => {
  const results = copyFlow();
  const resultsPath = join(results, 'baseline', 'results.jsonl');
  writeFileSync(resultsPath, readFileSync(resultsPath, 'utf8').replace('"latency_s":1.1', '"latency_s":1.2'));
  refuse(fixtureBytes('old-judge'), 'IMPORT_EVIDENCE', ['header/resultsSha256'], { flow: results });
  const state = copyFlow();
  const statePath = join(state, '_state.json');
  writeFileSync(statePath, readFileSync(statePath, 'utf8').replace('"Reply acceptable"', '"Reply is acceptable"'));
  refuse(fixtureBytes('old-judge'), 'IMPORT_EVIDENCE', ['header/stateSha256'], { flow: state });
  // A flow approved again holds another harness value: the state file's bytes and the value both differ.
  const approved = copyFlow();
  const approvedPath = join(approved, '_state.json');
  writeFileSync(approvedPath, readFileSync(approvedPath, 'utf8').replace('0'.repeat(64), '1'.repeat(64)));
  refuse(fixtureBytes('old-judge'), 'IMPORT_EVIDENCE', ['header/stateSha256', 'header/harnessSha'], { flow: approved });
});

test('--flow detects a re-grade file whose stored output was edited consistently on every draw of a case, which the file alone cannot show', () => {
  const f = fix();
  for (const row of rowsOfCase(f, 'clearance-organiser')) {
    row.storedOutput = '{"action":"decline","reply":"Clearance items are not refunded, so I cannot return the money for order A-11830."}';
    row.storedOutputSha256 = sha256Hex(row.storedOutput);
    row.parts.answer = 'Clearance items are not refunded, so I cannot return the money for order A-11830.';
  }
  rerender(f);
  // Without the flow the edited file is consistent in itself, and imports.
  conv(f);
  const e = refuse(f, 'IMPORT_OUTPUTS_DIFFER', slotsOf('clearance-organiser'), { flow: exampleFlow });
  assert.match(e.message, /the stored output in the trace of rep 0 of clearance-organiser is not the one on the row/);
});

test('--flow on a flow that no longer reads is refused by the flow reader, whichever rep is broken', () => {
  const broken = copyFlow();
  rmSync(join(broken, 'baseline', 'traces', 'bank-dispute_rep1.json'));
  // The file is of rep 0; the flow's rep 1 holds a finished row with no trace, which refuses a flow in any rep.
  refuse(fixtureBytes('old-judge'), 'IMPORT_SHAPE', ['bank-dispute#1'], { flow: broken });
});

/** A copy of the example flow with its rows edited, and the sha256 of the new results.jsonl. */
function flowWithRows(edit: (rows: J[]) => J[] | void): { flow: string; resultsSha256: string } {
  const flow = copyFlow();
  const path = join(flow, 'baseline', 'results.jsonl');
  const rows: J[] = readFileSync(path, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
  writeFileSync(path, `${(edit(rows) ?? rows).map((r) => JSON.stringify(r)).join('\n')}\n`);
  return { flow, resultsSha256: sha256Hex(readFileSync(path)) };
}
/** A good fixture whose header declares another results.jsonl: the file a re-grade of that flow would have written. */
function fixOn(resultsSha256: string, name: Fixture = 'old-judge'): File {
  const f = fix(name);
  f.header.resultsSha256 = resultsSha256;
  return f;
}

test('--flow requires only the source rep to be whole: a slot of another rep that is cut or missing does not refuse the import; the same slot in the source rep does', () => {
  const faults: [string, (rows: J[]) => J[] | void, ImportRefusalCode][] = [
    ['cut at the output cap', (rows) => { rows.find((r) => r.prompt_id === 'bank-dispute' && r.rep === 1).stop_reason = 'max_tokens'; }, 'IMPORT_OUTPUT_UNFINISHED'],
    ['no row', (rows) => rows.filter((r) => !(r.prompt_id === 'bank-dispute' && r.rep === 1)), 'IMPORT_DRAW_COUNT'],
  ];
  for (const [what, fault, code] of faults) {
    const { flow, resultsSha256 } = flowWithRows(fault);
    // A re-grade of rep 0 of this flow: rep 1 is not whole, and is not what the file was made from.
    const ofRep0 = fixOn(resultsSha256);
    assert.deepEqual({ ...runOf(ofRep0, { flow }), packetSource: '' }, { ...runOf(fix()), packetSource: '' }, what);
    assert.equal(viaMain(ofRep0, { flow }).code, 0, what);
    // A file that says it was made from rep 1 of the same flow: its source rep is not whole.
    const e = refuse(fixOn(resultsSha256, 'new-judge-rep1'), code, ['bank-dispute#1'], { flow });
    assert.match(e.message, /problem\(s\) in rep 1 of the flow, which is not whole/, what);
  }
});

test('--flow computes the excluded cases again from the flow and the cases file: a header that lists another set is refused, in either direction', () => {
  // The flow holds one more case than the cases file: a re-grade of it would have listed that case.
  const { flow, resultsSha256 } = flowWithRows((rows) => [...rows, { ...rows.find((r) => r.prompt_id === 'bank-dispute' && r.rep === 0), prompt_id: 'late-parcel', stop_reason: 'max_tokens' }]);
  const silent = fixOn(resultsSha256);
  const a = refuse(silent, 'IMPORT_EVIDENCE', ['header/excludedCaseIds'], { flow });
  assert.match(a.message, /--flow: the cases the flow holds and cases\.json does not are not the header's excludedCaseIds \(in the flow only: "late-parcel"; in the header only: none\)/);
  // With the case listed, the same file imports, and the run names the count.
  const honest = fixOn(resultsSha256);
  honest.header.excludedCaseIds = ['late-parcel'];
  honest.header.excludedCaseCount = 1;
  const c = conv(honest, { flow });
  assert.deepEqual(c.excludedCaseIds, ['late-parcel']);
  assert.match(c.run['packetSource'] as string, /cases of the flow excluded by the cases file: 1; flow read again: yes\)/);
  const cli = viaMain(honest, { flow });
  assert.equal(cli.code, 0, cli.err);
  assert.match(cli.out, /^excluded cases: 1 \(late-parcel\) \(cases the flow held and the cases file left out; computed again from the flow and found equal; /m);
  // The other direction: the header lists a case the flow does not hold (or lists another one).
  const b = refuse(honest, 'IMPORT_EVIDENCE', ['header/resultsSha256', 'header/excludedCaseIds'], { flow: exampleFlow });
  assert.match(b.message, /in the flow only: none; in the header only: "late-parcel"/);
  const other = fixOn(resultsSha256);
  other.header.excludedCaseIds = ['damaged-lamp'];
  other.header.excludedCaseCount = 1;
  assert.match(refuse(other, 'IMPORT_EVIDENCE', ['header/excludedCaseIds'], { flow }).message, /in the flow only: "late-parcel"; in the header only: "damaged-lamp"/);
  // Without --flow nothing of the flow is read, and each of these headers stands as the script's declaration.
  for (const f of [silent, honest, other]) conv(f);
});

test('--flow on a flow with no _state.json: a header that holds the gap marker for both values imports; a header and a flow that disagree on whether the file is there are refused', () => {
  const gone = copyFlow();
  rmSync(join(gone, '_state.json'));
  const f = fix();
  f.header.stateSha256 = 'UNKNOWN';
  f.header.harnessSha = 'UNKNOWN';
  const c = conv(f, { flow: gone });
  assert.equal(c.stateSha256, GAP);
  assert.equal(c.harnessSha, GAP);
  const cli = viaMain(f, { flow: gone });
  assert.equal(cli.code, 0, cli.err);
  assert.match(cli.out, /^_state\.json sha256: UNKNOWN \(the flow held no _state\.json\)$/m);
  assert.match(cli.out, /^harness_sha: UNKNOWN /m);
  // The header says there was no state file; the flow holds one.
  const a = refuse(f, 'IMPORT_EVIDENCE', ['header/stateSha256', 'header/harnessSha'], { flow: exampleFlow });
  assert.match(a.message, /--flow: the flow holds a _state\.json, and the re-grade read none/);
  // The header says there was one; the flow holds none.
  const b = refuse(fix(), 'IMPORT_EVIDENCE', ['header/stateSha256', 'header/harnessSha'], { flow: gone });
  assert.match(b.message, /--flow: the flow holds no _state\.json, and the re-grade read one/);
});

// ---- the shape of the header's and a row's values, each rule on its own ---------------------------------------------------

test('a { text, sha256 } of the header holds exactly those two keys, a text that is not empty and a full sha256', () => {
  for (const key of ['template', 'criterion', 'system']) {
    const edits: [string, (v: J) => void][] = [
      ['another key', (v) => { v.note = 'edited'; }],
      ['no sha256', (v) => { delete v.sha256; }],
      ['a short sha256', (v) => { v.sha256 = v.sha256.slice(0, 16); }],
      ['an empty text', (v) => { v.text = ''; }],
      ['a text that is a list', (v) => { v.text = [v.text]; }],
    ];
    for (const [what, edit] of edits) {
      const f = fix();
      edit(f.header[key]);
      assert.match(refuse(f, 'IMPORT_SHAPE', [`header/${key}`]).message, new RegExp(`${key}: expected \\{ text, sha256 \\} with a non-empty text and a full sha256, and no other key`), `${key}: ${what}`);
    }
    // The text alone in place of the pair.
    const bare = fix();
    bare.header[key] = bare.header[key].text;
    refuse(bare, 'IMPORT_SHAPE', [`header/${key}`]);
  }
});

test('resultsSha256 of the header is a full sha256; stateSha256 is one too, or exactly the gap marker with a harness value that is the gap marker', () => {
  for (const value of ['3e2f58c097b5', 'UNKNOWN', 'g'.repeat(64), 'A'.repeat(64), `${'a'.repeat(64)}0`, 7]) {
    const f = fix();
    f.header.resultsSha256 = value;
    assert.match(refuse(f, 'IMPORT_SHAPE', ['header/resultsSha256']).message, /resultsSha256: expected a full 64-character sha256/, String(value));
  }
  // No other gap word, no empty text, no other case of the marker: only the one marker stands for "no state file".
  for (const value of ['3e2f58c097b5', 'unknown', 'Unknown', 'NOT_SENT', 'N/A', '', ' UNKNOWN', 'g'.repeat(64), 'A'.repeat(64), `${'a'.repeat(64)}0`, 7]) {
    const f = fix();
    f.header.stateSha256 = value;
    f.header.harnessSha = 'UNKNOWN';
    assert.match(refuse(f, 'IMPORT_SHAPE', ['header/stateSha256']).message, /stateSha256: expected a full 64-character sha256/, String(value));
  }
  // The marker with the fixture's harness value: with no state file there was no file to read a harness value from.
  const f = fix();
  assert.notEqual(f.header.harnessSha, 'UNKNOWN');
  f.header.stateSha256 = 'UNKNOWN';
  assert.match(refuse(f, 'IMPORT_EVIDENCE', ['header/harnessSha']).message, /harnessSha: a value is stated, but stateSha256 is "UNKNOWN" \(the flow held no _state\.json\)/);
  // With both the marker, the file imports.
  f.header.harnessSha = 'UNKNOWN';
  assert.equal(conv(f).stateSha256, GAP);
  assert.equal(JSON.stringify(conv(f).run).includes('null'), false);
});

test('the parts of a row are exactly a question, an answer and a criterion, each a string', () => {
  const edits: [string, (row: J) => void][] = [
    ['a part left out', (row) => { delete row.parts.criterion; }],
    ['another key', (row) => { row.parts.notes = 'edited'; }],
    ['a part that is a number', (row) => { row.parts.answer = 7; }],
    ['a part that is a list', (row) => { row.parts.question = [row.parts.question]; }],
    ['a text in place of the parts', (row) => { row.parts = row.parts.answer; }],
    ['a list in place of the parts', (row) => { row.parts = [row.parts.question, row.parts.answer, row.parts.criterion]; }],
  ];
  for (const [what, edit] of edits) {
    const f = fix();
    edit(f.rows[4]);
    assert.match(refuse(f, 'IMPORT_SHAPE', ['clearance-organiser#1']).message, /in\.regrade\.jsonl:6: parts: expected \{ question, answer, criterion \}, each a string, and no other key/, what);
  }
});

test('the stored output and the prompt of a row are strings', () => {
  for (const key of ['storedOutput', 'promptSent']) {
    for (const [value, found] of [[7, 'number'], [true, 'boolean'], [['text'], 'array'], [{ text: 'text' }, 'object']] as [unknown, string][]) {
      const f = fix();
      f.rows[7][key] = value;
      assert.match(refuse(f, 'IMPORT_SHAPE', ['faulty-headphones#1']).message, new RegExp(`in\\.regrade\\.jsonl:9: ${key}: expected string, found ${found}`), `${key}: ${found}`);
    }
  }
  // The prompt as the message list itself, not its JSON text.
  const list = fix();
  list.rows[0].promptSent = JSON.parse(list.rows[0].promptSent);
  refuse(list, 'IMPORT_SHAPE', ['bank-dispute#0']);
});

test('--flow compares the question of each case in the flow with the question on the row, which the file alone cannot show', () => {
  const f = fix();
  for (const row of rowsOfCase(f, 'faulty-headphones')) row.parts.question = 'Order A-10492, delivered 60 days ago. The headphones work. Please refund me.';
  rerender(f);
  // The edited file is consistent in itself: the prompt is the template filled with the edited question, and the hashes follow.
  conv(f);
  // The stored output and its trace are untouched, so only the question differs from the flow.
  const e = refuse(f, 'IMPORT_PACKET', slotsOf('faulty-headphones'), { flow: exampleFlow });
  assert.match(e.message, /--flow: faulty-headphones#0: the question of rep 0 of faulty-headphones in the flow is not the one on the row/);
  assert.doesNotMatch(e.message, /stored output|trace of rep/);
});

// ---- an unpaired surrogate: two different texts would share one hash --------------------------------------------------------

test('a text of the file that holds an unpaired surrogate is refused by the importer, naming the line and the field, even when the hash beside it is that of its UTF-8 bytes', () => {
  // The case: two stored outputs that differ in one unpaired surrogate have the same UTF-8 bytes. The library
  // has no hash for either (a TypeError); the importer refuses first, as an ImportRefusal that names the row.
  for (const text of ['{"reply":"ok \ud800"}', '{"reply":"ok \ud801"}']) assert.throws(() => outputHashOf(text), (e: unknown) => e instanceof TypeError && /holds an unpaired surrogate/.test(e.message));
  // The sha256 of the bytes a writer puts on disk for a text: the hash another tool would have written beside it.
  const ofBytes = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
  assert.equal(ofBytes('{"reply":"ok \ud800"}'), ofBytes('{"reply":"ok \ud801"}'));
  const bytesAndHash = (text: string): { text: string; sha256: string } => ({ text, sha256: ofBytes(text) });
  // The stored output of a case, edited on all its draws, with the sha256 of its bytes computed again.
  const stored = fix();
  for (const row of rowsOfCase(stored, 'bank-dispute')) {
    row.storedOutput = `${row.storedOutput}\ud800`;
    row.storedOutputSha256 = ofBytes(row.storedOutput);
  }
  assert.match(refuse(stored, 'IMPORT_SHAPE', slotsOf('bank-dispute')).message, /in\.regrade\.jsonl:2: storedOutput: the text holds an unpaired surrogate/);
  // Each other text of a row.
  const edits: [string, (row: J) => void][] = [
    ['promptSent', (row) => { row.promptSent += '\udc00'; }],
    ['parts.question', (row) => { row.parts.question += '\ud800'; }],
    ['parts.answer', (row) => { row.parts.answer = `\udfff${row.parts.answer}`; }],
    ['parts.criterion', (row) => { row.parts.criterion += '\ud83d'; }],
  ];
  for (const [key, edit] of edits) {
    const f = fix();
    edit(f.rows[3]);
    assert.match(refuse(f, 'IMPORT_SHAPE', ['clearance-organiser#0']).message, new RegExp(`in\\.regrade\\.jsonl:5: ${key.replace('.', '\\.')}: the text holds an unpaired surrogate`), key);
  }
  // The three texts of the header, each with the sha256 of the edited text's bytes beside it.
  for (const key of ['template', 'criterion', 'system']) {
    const f = fix();
    f.header[key] = bytesAndHash(`${f.header[key].text}\ud800`);
    assert.match(refuse(f, 'IMPORT_SHAPE', [`header/${key}`]).message, new RegExp(`${key}: the text holds an unpaired surrogate`), key);
  }
  // A case id, in the file and in the cases file alike.
  const id = fix();
  for (const row of rowsOfCase(id, 'bank-dispute')) row.caseId = 'bank-dispute\ud800';
  const idCases = { ...cases, 'bank-dispute\ud800': cases['bank-dispute'] as CasesFile[string] };
  delete (idCases as Record<string, unknown>)['bank-dispute'];
  let caught: unknown;
  try {
    conv(id, { cases: idCases });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ImportRefusal && caught.code === 'IMPORT_CASE_ID' && /caseId: the text holds an unpaired surrogate/.test(caught.message), String(caught));
  // The reply in a record: the label is read from it.
  const reply = fix();
  rec(reply.rows[8]).reply = '{"pass": true, "reason": "fine \ud800"}';
  assert.equal(JSON.parse(rec(reply.rows[8]).reply).pass, true, 'the reply reads as a verdict');
  assert.match(refuse(reply, 'IMPORT_EVIDENCE', ['faulty-headphones#2']).message, /faulty-headphones#2: the reply in the record: the text holds an unpaired surrogate/);
  // A whole pair anywhere is a character like any other: the file imports.
  const pair = fix();
  rec(pair.rows[8]).reply = '{"pass": true, "reason": "fine 😀"}';
  conv(pair);
});

test('an unpaired surrogate in a text that no check of this path reads refuses the file all the same (IMPORT_SHAPE, exit 2): no run is written from it, and no hash fails on it', () => {
  // The checks above name a text by its row and its field. These places are read by none of them: before the shared
  // reader's refusal, such a file was imported, or ended in an error of the hash (exit 70).
  const places: [string, (f: File) => void, string, RegExp][] = [
    ['the run id of the re-grade', (f) => { f.header.regradeRunId += '\ud800'; }, 'in.regrade.jsonl:1', /in\.regrade\.jsonl:1: \$\.regradeRunId: holds an unpaired surrogate/],
    ['the start time', (f) => { f.header.startedAt += '\udc00'; }, 'in.regrade.jsonl:1', /\$\.startedAt: /],
    ['the end point of the call shape', (f) => { rec(f.rows[0]).callShape.endpoint += '\ud800'; }, 'in.regrade.jsonl:2', /\$\.graderEvidence\.callShape\.endpoint: /],
  ];
  // Four more places are read by a check since the form of each is held, and that check names them more closely:
  // the harness value of the header, and the served model, the response id and the call id of a record.
  const named: [string, (f: File) => void, ImportRefusalCode, string][] = [
    ['the harness hash', (f) => { f.header.harnessSha += '\ud800'; }, 'IMPORT_SHAPE', 'header/harnessSha'],
    ['the runtime of the grader', (f) => { rec(f.rows[0]).grader.runtime += '\ud800'; }, 'IMPORT_EVIDENCE', 'line 2/graderEvidence.grader.runtime'],
    ['the served model of a record', (f) => { rec(f.rows[0]).servedModel += '\ud800'; }, 'IMPORT_EVIDENCE', 'line 2/graderEvidence.servedModel'],
    ['the response id of a record', (f) => { rec(f.rows[3]).responseId += '\udc00'; }, 'IMPORT_EVIDENCE', 'line 5/graderEvidence.responseId'],
    ['the call id of a record', (f) => { rec(f.rows[8]).callId = `\ud83d${rec(f.rows[8]).callId}`; }, 'IMPORT_EVIDENCE', 'line 10/graderEvidence.callId'],
  ];
  for (const [name, edit, code, field] of named) {
    const f = fix();
    edit(f);
    const r = refuse(f, code, [field]);
    assert.ok(r.message.isWellFormed(), name);
  }
  for (const [name, edit, field, words] of places) {
    const f = fix();
    edit(f);
    assert.ok(serialise(f).toString('utf8').isWellFormed(), name);
    const r = refuse(f, 'IMPORT_SHAPE', [field]);
    assert.match(r.message, words, name);
    assert.ok(r.message.isWellFormed(), name);
  }
  // Two lines: both are named, each once.
  const two = fix();
  two.header.regradeRunId += '\ud800';
  rec(two.rows[0]).callShape.endpoint += '\ud800';
  refuse(two, 'IMPORT_SHAPE', ['in.regrade.jsonl:1', 'in.regrade.jsonl:2']);
  // A refusal of this path's own stands before it: the row and the field are the closer name.
  const both = fix();
  both.header.regradeRunId += '\ud800';
  rec(both.rows[8]).reply = '{"pass": true, "reason": "fine \ud800"}';
  assert.match(refuse(both, 'IMPORT_EVIDENCE', ['faulty-headphones#2']).message, /the reply in the record: the text holds an unpaired surrogate/);
});

// ---- a key given twice: the plain parser keeps the last and says nothing ---------------------------------------------------

/** A fixture's bytes with one line edited as text (0 is the header), so that an edit can leave a key twice. */
function editLine(bytes: Buffer, n: number, from: string | RegExp, to: string): Buffer {
  const lines = bytes.toString('utf8').slice(0, -1).split('\n');
  const before = lines[n] as string;
  lines[n] = before.replace(from, to);
  assert.notEqual(lines[n], before, 'the edit changed the line');
  return Buffer.from(lines.map((l) => `${l}\n`).join(''));
}

test('a key given twice in the header, in a row or in a record is IMPORT_SHAPE, naming the line', () => {
  const good = fixtureBytes('old-judge');
  // The header: a first draws of 9, then the real one, which the plain parser keeps.
  const header = editLine(good, 0, /^\{/, '{"draws":9,');
  assert.equal(parse(header).header.draws, 3);
  assert.match(refuse(header, 'IMPORT_SHAPE', ['in.regrade.jsonl:1']).message, /in\.regrade\.jsonl:1: the key "draws" is given twice in the top-level object/);
  // An object inside the header.
  const config = editLine(good, 0, '"graderConfig":{', '"graderConfig":{"model":"another-judge",');
  assert.match(refuse(config, 'IMPORT_SHAPE', ['in.regrade.jsonl:1']).message, /the key "model" is given twice in the object at \/graderConfig/);
  // A row: a first stored output, then the real one.
  const row = editLine(good, 2, /^\{/, '{"storedOutput":"{\\"action\\":\\"refund\\",\\"reply\\":\\"edited\\"}",');
  assert.deepEqual(parse(row).rows, parse(good).rows, 'to the plain parser the edited file is the good one');
  assert.match(refuse(row, 'IMPORT_SHAPE', ['in.regrade.jsonl:3']).message, /in\.regrade\.jsonl:3: the key "storedOutput" is given twice in the top-level object/);
  // A record: a first reply that says fail, then the real one.
  const record = editLine(good, 1, '"graderEvidence":{', '"graderEvidence":{"reply":"{\\"pass\\": false, \\"reason\\": \\"edited\\"}",');
  assert.match(refuse(record, 'IMPORT_SHAPE', ['in.regrade.jsonl:2']).message, /the key "reply" is given twice in the object at \/graderEvidence/);
  // A key spelled with an escape is the same key; and every such line is named.
  const two = editLine(editLine(good, 4, /^\{/, '{"\\u0064raw":7,'), 9, /^\{/, '{"caseId":"bank-dispute",');
  const e = refuse(two, 'IMPORT_SHAPE', ['in.regrade.jsonl:5', 'in.regrade.jsonl:10']);
  assert.match(e.message, /in\.regrade\.jsonl:5: the key "draw" is given twice/);
  assert.match(e.message, /in\.regrade\.jsonl:10: the key "caseId" is given twice/);
  // The file a re-grade kept after its first call failed is read line by line too.
  const failed = editLine(badBytes('failed-slot'), 1, /^\{/, '{"caseId":"faulty-headphones",');
  refuse(failed, 'IMPORT_SHAPE', ['in.regrade.jsonl:2']);
});

test('a case id or a key of the bar given twice is an invalid input (65), before the file is read', () => {
  const twice = casesText.replace('{', '{ "bank-dispute": { "klass": "refund_policy", "expect": "fail" },');
  assert.equal(Object.keys(JSON.parse(twice) as object).length, 3, 'to the plain parser the roster is the same three cases');
  const cli = viaMain(fixtureBytes('old-judge'), { casesRaw: twice });
  assert.equal(cli.code, 65, cli.err);
  assert.match(cli.err, /^INVALID_INPUT: cases: the key "bank-dispute" is given twice in the top-level object$/);
  assert.equal(existsSync(cli.outPath), false);
  const barTwice = viaMain(fixtureBytes('old-judge'), { barRaw: barText.replace('"labels"', '"labels": ["fail", "pass", "unsure"],\n  "labels"') });
  assert.equal(barTwice.code, 65, barTwice.err);
  assert.match(barTwice.err, /^INVALID_INPUT: bar: the key "labels" is given twice/);
  assert.equal(existsSync(barTwice.outPath), false);
});

test('a re-grade file, a cases file or a bar nested 5,000 or 200,000 deep is refused or invalid input (exit 2 or 65), never exit 70', () => {
  for (const depth of [5000, 200_000]) {
    const deep = `${'['.repeat(depth)}${']'.repeat(depth)}`;
    // In the header, and in a row where the script writes the judge's parts.
    for (const [line, from] of [[0, /^\{/], [3, /^\{/]] as const) {
      const cli = viaMain(editLine(fixtureBytes('old-judge'), line, from, `{"zz":${deep},`));
      assert.equal(cli.code, 2, cli.err.slice(0, 200));
      assert.match(cli.err, new RegExp(`^REFUSED IMPORT_SHAPE: .*in\\.regrade\\.jsonl:${line + 1}: objects and lists are nested more than 128 deep$`, 'm'));
      assert.equal(existsSync(cli.outPath), false);
    }
    const cases = viaMain(fixtureBytes('old-judge'), { casesRaw: `{"zz":${deep}}` });
    assert.equal(cases.code, 65, cases.err.slice(0, 200));
    assert.match(cases.err, /^INVALID_INPUT: cases: objects and lists are nested more than 128 deep$/);
    const bar = viaMain(fixtureBytes('old-judge'), { barRaw: barText.replace(/^\{/, `{"zz":${deep},`) });
    assert.equal(bar.code, 65, bar.err.slice(0, 200));
    assert.match(bar.err, /^INVALID_INPUT: bar: objects and lists are nested more than 128 deep$/);
  }
});

// ---- the bounded, recorded re-ask ----------------------------------------------------------------------------------------

test('fixtures/reask.regrade.jsonl imports', () => {
  const f = fix('reask');
  assert.equal(f.header.graderConfig.maxReasks, 2);
  assert.equal(f.header.schema, 'example.skill-evals-regrade/v4');
  // What the script wrote: the first grade of each case was cut once and asked again; 12 asks for 9 slots, in the order of the rows.
  assert.deepEqual(f.rows.map((r) => rec(r).reask.earlier.map((a: J) => a.reason)), [['truncated'], [], [], ['truncated'], [], [], ['truncated'], [], []]);
  assert.deepEqual(f.rows.flatMap((r) => [...rec(r).reask.earlier.map((a: J) => a.callSeq), rec(r).callSeq]), Array.from({ length: 12 }, (_, i) => i + 1));
  const cli = viaMain(fixtureBytes('reask'), { flow: join(dir, 'example-flow') });
  assert.equal(cli.code, 0, cli.err);
  assert.match(cli.out, /^replies with reasoning: 0 of 12 asks; [^\n]*\nre-asks: 3 on 3 of 9 slots \(truncated 3, timeout 0, transport 0, server-error 0, rate-limited 0\); at most 2 per slot\nreading rule: one-json-object-boolean-pass\/v1$/m);
  const run = parseRunArtifact(JSON.parse(readFileSync(cli.outPath, 'utf8')));
  assert.deepEqual(run.draws.map((d) => d.attempts.map((a) => a.kind).join('+')), ['unmeasured+graded', 'graded', 'graded', 'unmeasured+graded', 'graded', 'graded', 'unmeasured+graded', 'graded', 'graded']);
  for (const d of run.draws) {
    const last = d.attempts.at(-1);
    assert.ok(last !== undefined && last.kind === 'graded');
    for (const a of d.attempts.slice(0, -1)) assert.ok(a.kind === 'unmeasured' && a.role === 'judge' && a.reason === 'truncated' && a.outputHash === last.outputHash && a.packetHash === last.packetHash && a.systemStop === 'UNKNOWN');
  }
  // The same bytes import to the same run bytes.
  const again = viaMain(fixtureBytes('reask'), { flow: join(dir, 'example-flow') });
  assert.equal(readFileSync(cli.outPath, 'utf8'), readFileSync(again.outPath, 'utf8'));
});

test('bad fixture, a used-up bound: every slot whose two asks were cut is listed, in the words of a used-up bound', () => {
  const bytes = badBytes('reask-exhausted');
  const f = parse(bytes);
  assert.equal(f.header.graderConfig.maxReasks, 1);
  // What the real script wrote: the re-grade succeeded, and the record of the first grade of each case holds two cut asks.
  assert.equal(f.rows.length, 9);
  assert.ok(f.rows.every((r) => 'graderEvidence' in r && !('error' in r)));
  assert.deepEqual(f.rows.map((r) => [rec(r).stopReason, rec(r).reask.earlier.length]), [['max_tokens', 1], ['end_turn', 0], ['end_turn', 0], ['max_tokens', 1], ['end_turn', 0], ['end_turn', 0], ['max_tokens', 1], ['end_turn', 0], ['end_turn', 0]]);
  const e = refuse(bytes, 'IMPORT_UNGRADED', ['bank-dispute#0', 'clearance-organiser#0', 'faulty-headphones#0']);
  assert.match(e.message, /^IMPORT_UNGRADED: 3 slot\(s\) hold no finished, readable grade: bank-dispute#0 \(line 2\/graderEvidence: the judge's reply was cut at the output cap on each of 2 asks; the bound of 1 re-asks is used up\); /);
  assert.match(e.message, /Keep this file as it is, and do not delete or replace it/);
});

test('the bound enters the judge definition hash: two bounds give two definition hashes, each the value the harness string states', () => {
  const at = (max: number) => {
    const f = fix('reask');
    for (const r of f.rows) rec(r).reask.max = max;
    f.header.graderConfig.maxReasks = max;
    return conv(f).judge;
  };
  const [two, three] = [at(2), at(3)];
  assert.notEqual(two.judgeDefinitionHash, three.judgeDefinitionHash);
  assert.match(two.judgeHarnessVersion, /; max-reasks 2; wire anthropic-messages\/v1; script-files sha256:[0-9a-f]{64}$/);
  assert.match(three.judgeHarnessVersion, /; max-reasks 3; wire anthropic-messages\/v1; script-files sha256:[0-9a-f]{64}$/);
  for (const k of ['judgeModelRequested', 'judgeModelServed', 'judgeCallShapeHash', 'rubricHash'] as const) assert.equal(two[k], three[k], k);
});

test('a header bound that differs from the record is IMPORT_EVIDENCE, and so is a header that states none', () => {
  const f = fix('reask');
  f.header.graderConfig.maxReasks = 3;
  const e = refuse(f, 'IMPORT_EVIDENCE', ['header/graderConfig/maxReasks']);
  assert.match(e.message, /header\/graderConfig\/maxReasks: 3 but the record says the bound was 2 re-ask\(s\)/);
  const none = fix();
  delete none.header.graderConfig.maxReasks;
  assert.match(refuse(none, 'IMPORT_EVIDENCE', ['header/graderConfig/maxReasks']).message, /"not set" but the record says the bound was 0 re-ask\(s\)/);
});

test('an earlier ask edited to end_turn is IMPORT_REASK; one taken out of its record is IMPORT_HIDDEN_CALLS', () => {
  const f = fix('reask');
  rec(f.rows[0]).reask.earlier[0].stopReason = 'end_turn';
  const e = refuse(f, 'IMPORT_REASK', ['line 2/graderEvidence.reask.earlier[0].stopReason']);
  assert.match(e.message, /a reply that was not cut at the output cap was asked again/);
  const hidden = fix('reask');
  rec(hidden.rows[3]).reask.earlier = [];
  assert.match(refuse(hidden, 'IMPORT_HIDDEN_CALLS', ['callSeq']).message, /callSeq values over every ask \(9 slot\(s\) and 2 recorded re-ask\(s\)\) are not 1 to 11, each once/);
});

test('the asks of a slot take the next numbers in the order of the rows: an earlier ask numbered out of that order is IMPORT_HIDDEN_CALLS', () => {
  // The numbers are still 1 to 12, each once, so the file-wide check passes: the earlier ask of the first row and the
  // last ask of the second trade numbers, which this script, one call at a time, cannot have written.
  const f = fix('reask');
  assert.deepEqual([rec(f.rows[0]).reask.earlier[0].callSeq, rec(f.rows[0]).callSeq, rec(f.rows[1]).callSeq, rec(f.rows[2]).callSeq], [1, 2, 3, 4]);
  rec(f.rows[0]).callSeq = 3;
  rec(f.rows[1]).callSeq = 2;
  const e = refuse(f, 'IMPORT_HIDDEN_CALLS', ['bank-dispute#0', 'bank-dispute#1']);
  assert.match(e.message, /callSeq: the calls were not made in the order of the rows \(the asks of one slot, then those of the next; case id then draw\): bank-dispute#0 has callSeq 1, 3; bank-dispute#1 has callSeq 2/);
});

test('a re-grade file of the version before is refused with the instruction to re-grade with the current script, not as "no record"', () => {
  // v3 is the header as it was before it held the reading rule: a file of that version is told to re-grade, not that a key
  // is missing from a header of the version it already names.
  for (const version of ['v3', 'v2', 'v1']) {
    const f = fix();
    f.header.schema = `example.skill-evals-regrade/${version}`;
    // A v2 header as the earlier script wrote it: it held the path given with --flow.
    if (version === 'v2') f.header = { ...f.header, flow: '/Users/someone/flows/refund-bot' };
    const e = refuse(f, 'IMPORT_EVIDENCE', ['header/schema']);
    assert.match(e.message, new RegExp(`in\\.regrade\\.jsonl:1: schema: this re-grade file is of version example\\.skill-evals-regrade\\/${version}, an earlier version than example\\.skill-evals-regrade\\/v4; re-grade with the current script \\(examples\\/importers\\/skill-evals\\/regrade\\.ts\\)`));
    assert.ok(!e.message.includes('/Users/someone'));
    // A v3 file as its script wrote it, with no reading rule in the header: the same refusal, and it does not name the missing key.
    const before = fix();
    before.header.schema = `example.skill-evals-regrade/${version}`;
    delete before.header.reading;
    const b = refuse(before, 'IMPORT_EVIDENCE', ['header/schema']);
    assert.ok(!b.message.includes('reading'), b.message);
    // And the file such a re-grade left when its first call failed: a header of that version and one row with an error.
    const failed = parse(badBytes('failed-slot'));
    failed.header.schema = `example.skill-evals-regrade/${version}`;
    refuse(failed, 'IMPORT_EVIDENCE', ['header/schema']);
  }
  // A header of the current version that still holds the path is not one the script writes.
  const withPath = fix();
  withPath.header.flow = 'flow';
  assert.match(refuse(withPath, 'IMPORT_SHAPE', ['header/flow']).message, /in\.regrade\.jsonl:1: flow: a key the re-grade script does not write/);
  // A schema of another form is still not a re-grade file of this importer.
  for (const other of ['example.skill-evals-regrade/v0', 'example.skill-evals-regrade/v01', 'x']) {
    const g = fix();
    g.header.schema = other;
    const e = refuse(g, 'IMPORT_NO_RECORD', ['in.regrade.jsonl']);
    assert.ok(!e.message.includes('later version'), e.message);
  }
  // A later version is not one this importer reads, and the refusal says so: it does not tell the user to grade again
  // with this importer's own, older, script. The same for the file such a re-grade left when its first call failed.
  for (const later of ['example.skill-evals-regrade/v5', 'example.skill-evals-regrade/v12']) {
    const g = fix();
    g.header.schema = later;
    const failed = parse(badBytes('failed-slot'));
    failed.header.schema = later;
    for (const file of [g, failed]) {
      const e = refuse(file, 'IMPORT_NO_RECORD', ['in.regrade.jsonl']);
      assert.match(e.message, new RegExp(`in\\.regrade\\.jsonl:1: schema: this re-grade file is of version ${later.replace(/[./]/g, '\\$&')}, written by a later version of the script than this importer reads \\(example\\.skill-evals-regrade\\/v4\\); import it with the importer of that version`));
      assert.ok(!/[Gg]rade the stored outputs again|re-grade with the current script/.test(e.message), e.message);
    }
  }
});

// ---- cases found after the first build ---------------------------------------------------------------------------

test('the run id and the start time of a header are non-empty strings: each, missing, empty or of another type, is IMPORT_SHAPE naming it', () => {
  for (const key of ['regradeRunId', 'startedAt']) {
    for (const value of ['', 7, true, ['x'], { id: 'x' }]) {
      const f = fix();
      f.header[key] = value;
      const r = refuse(f, 'IMPORT_SHAPE', [`header/${key}`]);
      assert.match(r.message, new RegExp(`in\\.regrade\\.jsonl:1: ${key}: expected a non-empty string, found `), `${key} ${JSON.stringify(value)}`);
    }
    const gone = fix();
    delete gone.header[key];
    assert.match(refuse(gone, 'IMPORT_SHAPE', [`header/${key}`]).message, new RegExp(`${key}: missing`));
  }
  // Both at once: both are named.
  const both = fix();
  both.header.regradeRunId = '';
  both.header.startedAt = 0;
  refuse(both, 'IMPORT_SHAPE', ['header/regradeRunId', 'header/startedAt']);
});

test('a null inside a record is IMPORT_EVIDENCE, as on the other two paths; a number that is not finite is refused where the line is read (IMPORT_SHAPE)', () => {
  /** The file's text with one edit of its second line, which a parsed value cannot hold (a number beyond every float). */
  const edited = (from: string, to: string): Buffer => {
    const lines = fixtureBytes('old-judge').toString('utf8').split('\n');
    assert.ok((lines[1] as string).includes(from), from);
    lines[1] = (lines[1] as string).replace(from, to);
    return Buffer.from(lines.join('\n'));
  };
  // A number too large to be read is refused where the line is read, before any record is looked at: the library's
  // reader holds no such number in any JSON text, so the code is the line's, on this path as on the other two.
  const inRecord = refuse(edited('"thinkingTokens":0', '"thinkingTokens":1e999'), 'IMPORT_SHAPE', ['in.regrade.jsonl:2']);
  assert.match(inRecord.message, /in\.regrade\.jsonl:2: \$\.graderEvidence\.thinkingTokens: a number that is not finite/);
  const inShape = refuse(edited('"maxOutputTokens":256', '"maxOutputTokens":-1e999'), 'IMPORT_SHAPE', ['in.regrade.jsonl:2']);
  assert.match(inShape.message, /\$\.graderEvidence\.callShape\.maxOutputTokens: a number that is not finite/);
  const inList = fix();
  rec(inList.rows[0]).contentTypes = [null];
  assert.match(refuse(inList, 'IMPORT_EVIDENCE', ['bank-dispute#0']).message, /row\.graderEvidence\.contentTypes\[0\]: null is not allowed/);
  const nullInRecord = fix();
  rec(nullInRecord.rows[0]).usage = null;
  assert.match(refuse(nullInRecord, 'IMPORT_EVIDENCE', ['bank-dispute#0']).message, /row\.graderEvidence\.usage: null is not allowed/);
  // The record itself a null is a row with no record's form at all: the shape of the row.
  const nullRecord = fix();
  nullRecord.rows[0].graderEvidence = null;
  assert.match(refuse(nullRecord, 'IMPORT_SHAPE', ['bank-dispute#0']).message, /row\.graderEvidence: null is not allowed/);
  // Outside the record: the shape of the row.
  const onRow = fix();
  onRow.rows[0].parts.answer = null;
  refuse(onRow, 'IMPORT_SHAPE', ['bank-dispute#0']);
  refuse(edited('"draw":0', '"draw":1e999'), 'IMPORT_SHAPE', ['in.regrade.jsonl:2']);
  // The promptfoo path gives the same code for the same record.
  const record = JSON.parse(JSON.stringify(rec(fix().rows[0])));
  record.thinkingTokens = Number.POSITIVE_INFINITY;
  assert.throws(() => parseRecord(record, 'p', 'promptfoo'), (e: unknown) => e instanceof ImportRefusal && e.code === 'IMPORT_EVIDENCE');
});

test('a reply that gives "pass" twice is not a verdict: the slot is IMPORT_UNGRADED under either rule', () => {
  for (const reply of ['{"pass":true,"pass":false}', '{"pass":false,"pass":true}']) {
    for (const reading of [READING, FENCE_READING]) {
      const f = fix();
      rec(f.rows[4]).reply = reply;
      f.header.reading = reading;
      const r = refuse(f, 'IMPORT_UNGRADED', ['clearance-organiser#1'], { reading });
      assert.match(r.message, /line 6\/graderEvidence\/reply: not exactly one JSON object with a boolean "pass", under the reading rule /, reply);
      assert.ok(!r.message.includes('readable under'), reply);
    }
  }
});

test('the importer holds no second copy of the grader\'s two rules, of the count bound or of the slot name', () => {
  const source = readFileSync(importer, 'utf8');
  const regrade = readFileSync(join(dir, 'regrade.ts'), 'utf8');
  for (const [name, text] of [['import.ts', source], ['regrade.ts', regrade]] as const) {
    // The form of a variable's name is the shared module's GRADER_KEY_ENV_NAME, and the bound is the flow reader's.
    assert.ok(!text.includes('[A-Za-z_][A-Za-z0-9_]*'), `${name}: a copy of the key variable's name form`);
    assert.ok(!/HEADER_COUNT_BOUND\s*=\s*\d/.test(text), `${name}: a copy of the count bound`);
    assert.ok(!/const NOT_SENT\s*=/.test(text), `${name}: a local NOT_SENT`);
    assert.ok(!/slotLabel\s*=\s*\(/.test(text), `${name}: a copy of the slot name`);
    assert.ok(!/JSON\.parse\(/.test(text), `${name}: a JSON text read by the plain parser`);
  }
  assert.ok(!source.includes('graderBaseUrlProblem'), 'the base URL rule is applied by graderConfigProblems alone');
  assert.ok(!source.includes('duplicateKeyProblem'), 'a key given twice is refused by the shared reader alone');
  assert.ok(regrade.includes('valueTypeProblems('), 'the one walk for a null or a value JSON does not hold');
  assert.equal(HEADER_COUNT_BOUND, FLOW_COUNT_BOUND);
});

// ---- the free-text fields of a record are one printable line --------------------------------------------------

test('a free-text field of a record that is not one printable line is IMPORT_EVIDENCE naming the field, not printed', () => {
  const values: ReadonlyArray<readonly [string, string]> = [
    ['a line feed', 'node v24\nthe record reports the shipped grader'],
    ['a carriage return', 'node v24\rforged'],
    ['an escape character', 'node v24\u001b[2Jforged'],
    ['201 characters', 'a'.repeat(201)],
  ];
  const edits: ReadonlyArray<readonly [string, (r: J, v: string) => void]> = [
    ['grader.name', (r, v) => { r.grader.name = v; }],
    ['grader.runtime', (r, v) => { r.grader.runtime = v; }],
    ['graderRunId', (r, v) => { r.graderRunId = v; }],
    ['requestedModel', (r, v) => { r.requestedModel = v; }],
    ['stopReason', (r, v) => { r.stopReason = v; }],
    ['callShape.apiVersion', (r, v) => { r.callShape.apiVersion = v; }],
  ];
  for (const [field, edit] of edits) {
    for (const [what, value] of values) {
      const f = fix();
      edit(rec(f.rows[0]), value);
      const e = refuse(f, 'IMPORT_EVIDENCE', [`line 2/graderEvidence.${field}`]);
      assert.equal(e.message.includes(value), false, `${field} with ${what}: the value is not echoed`);
    }
  }
});

// ---- a record from a grader that is not the shipped one ------------------------------------------------------

test('records that name another grader file are refused by default, and read as that grader\'s account when its sha256 is stated', () => {
  const other = sha256Hex('another recording grader');
  const f = fix();
  for (const row of f.rows) rec(row).grader.sha256 = other;
  // the header lists the grader file with its sha256, and the importer holds that equal to the records': the user's own script would list its own
  const listed = f.header.scriptFiles.find((x: J) => x.path === 'examples/importers/promptfoo/grader-provider.cjs');
  listed.sha256 = other;
  const refused = viaMain(f);
  assert.equal(refused.code, 2, refused.err);
  assert.match(refused.err, /^REFUSED IMPORT_EVIDENCE: grader\.sha256: the record is not from the shipped grader \(examples\/importers\/promptfoo\/grader-provider\.cjs\)/);
  assert.match(refused.err, /state its file's sha256 with --grader-sha256/);
  assert.equal(existsSync(refused.outPath), false, 'a refusal writes nothing');
  const stated = viaMain(f, { extra: ['--grader-sha256', other] });
  assert.equal(stated.code, 0, stated.err);
  assert.match(stated.out, /^the record reports the grader sha256 you stated with --grader-sha256, which is not the shipped grader/m);
  const wrong = viaMain(f, { extra: ['--grader-sha256', sha256Hex('a third')] });
  assert.equal(wrong.code, 2, wrong.err);
  assert.equal(viaMain(f, { extra: ['--grader-sha256', 'zz'] }).code, 64);
});

test('a refusal prints text of the file on one line each: a case id holding a carriage return, an escape sequence and a line feed is written with escapes, and stderr holds exactly two lines', () => {
  const f = fix();
  (f.rows[0] as J).caseId = '0.3.275\r\u001b[2Kgrader: anchorset-recording-grader\nthe record reports the shipped grader\'s sha256\u2028run file sha256: 000';
  const out: string[] = [];
  const err: string[] = [];
  const inPath = join(work, 'one-line.regrade.jsonl');
  const outPath = join(work, 'one-line-out.json');
  writeFileSync(inPath, serialise(f));
  const code = main(['--in', inPath, '--cases', join(dir, 'cases.json'), '--bar', join(dir, 'bar.json'), '--out', outPath, '--reading', READING, '--flow', exampleFlow], { out: (x) => out.push(x), err: (x) => err.push(x) });
  assert.equal(code, 2);
  assert.equal(existsSync(outPath), false);
  assert.deepEqual(out, []);
  assert.match(err[0] ?? '', /^REFUSED IMPORT_/);
  assert.match(err[1] ?? '', /^fields: /);
  assert.equal(err.length, 2, JSON.stringify(err));
  for (const line of err) assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(line), JSON.stringify(line));
  assert.ok(err.some((line) => line.includes('\\r\\u001b[2K') && line.includes('\\n') && line.includes('\\u2028')), JSON.stringify(err));
});

test('a written import prints one line per line too: a --flow path holding a carriage return, an escape sequence and a line feed is written with escapes, and the plan fragment still parses', () => {
  const hostile = join(work, 'flow\r\u001b[2Krun file sha256: 000\nREFUSED\u2028\u202ex');
  cpSync(exampleFlow, hostile, { recursive: true });
  const out: string[] = [];
  const err: string[] = [];
  const inPath = join(work, 'one-line-ok.regrade.jsonl');
  const outPath = join(work, 'one-line-ok-out.json');
  writeFileSync(inPath, fixtureBytes('old-judge'));
  const code = main(['--in', inPath, '--cases', join(dir, 'cases.json'), '--bar', join(dir, 'bar.json'), '--out', outPath, '--reading', READING, '--flow', hostile], { out: (x) => out.push(x), err: (x) => err.push(x) });
  assert.equal(code, 0, err.join('\n'));
  assert.deepEqual(err, []);
  // The first call is the plan fragment, on several lines as before; every other call is one line.
  const fragment = JSON.parse(out[0] ?? '') as J;
  assert.equal(fragment.drawsPerCase, 3);
  for (const call of out.slice(1)) assert.ok(!/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/.test(call), JSON.stringify(call));
  for (const line of (out[0] ?? '').split('\n')) assert.ok(!/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/.test(line), JSON.stringify(line));
  const flowLine = out.find((l) => l.startsWith('flow: read again from ')) ?? '';
  assert.ok(flowLine.includes('\\r\\u001b[2K') && flowLine.includes('\\n') && flowLine.includes('\\u2028') && flowLine.includes('\\u202e'), JSON.stringify(flowLine));
  assert.equal(out.filter((l) => l.startsWith('run file sha256: ')).length, 1);
});

// ---- the OpenAI Responses wire ---------------------------------------------------------------------------------------------------

test('openai-old-judge and openai-new-judge import: the wire is in the harness string before script-files, the served model is the requested one, and the header states the wire', () => {
  for (const [name, model] of [['openai-old-judge', 'fake-judge-old'], ['openai-new-judge', 'fake-judge-strict-new']] as const) {
    const f = fix(name);
    assert.equal(f.header.graderConfig.wire, 'openai-responses/v1');
    assert.equal(f.header.graderConfig.max_output_tokens, 256);
    assert.equal('max_tokens' in f.header.graderConfig, false);
    assert.equal('thinking' in f.header.graderConfig, false);
    assert.deepEqual(Object.keys(f.header.graderConfig).sort(), ['baseUrl', 'effort', 'maxReasks', 'max_output_tokens', 'model', 'temperature', 'verbosity', 'wire']);
    const c = conv(f);
    assert.equal(c.wire, 'openai-responses/v1');
    assert.equal(c.judge.judgeModelRequested, model);
    assert.equal(c.judge.judgeModelServed, model);
    const r0 = rec(f.rows[0]);
    assert.equal(c.judge.judgeHarnessVersion, `skill-evals skill-evals/1; anchorset-recording-grader js sha256:${r0.grader.sha256}; ${r0.grader.runtime}; max-reasks 0; wire openai-responses/v1; script-files sha256:${hashOf(f.header.scriptFiles)}`);
    assert.equal(parseRunArtifact(JSON.parse(JSON.stringify(c.run))).draws.length, 9);
  }
  const [a, o] = [conv(fix('old-judge')), conv(fix('openai-old-judge'))];
  const moved = (Object.keys(a.judge) as (keyof typeof a.judge)[]).filter((k) => a.judge[k] !== o.judge[k]);
  assert.deepEqual(moved.sort(), ['judgeCallShapeHash', 'judgeHarnessVersion', 'judgeModelServed']);
  assert.equal(a.judge.judgeDefinitionHash, o.judge.judgeDefinitionHash);
});

test('the success lines of an OpenAI re-grade file: the wire, the served-id statement and the reasoning counts', () => {
  const cli = viaMain(fixtureBytes('openai-new-judge'));
  assert.equal(cli.code, 0, cli.err);
  const lines = cli.out.split('\n');
  assert.ok(lines.includes('wire: openai-responses/v1'));
  assert.ok(lines.includes('judge model served: "fake-judge-strict-new", the same text as the model requested. The provider\'s reply named no more specific version, so this run file cannot show which version of the model graded it. A change of model behind this name would leave judgeModelServed unchanged.'));
  assert.ok(lines.includes("replies with reasoning: 0 of 9 asks; reasoning tokens (the provider's own count): total 0, median 0, max 0; counter absent on 0"));
  const anth = viaMain(fixtureBytes('old-judge'));
  assert.ok(anth.out.split('\n').includes('wire: anthropic-messages/v1'));
  assert.ok(anth.out.split('\n').includes('judge model served: "fake-judge-old-served-20260101" (requested "fake-judge-old"), as the provider\'s reply named it; not checked.'));
});

test('the header\'s wire is held to the records\': a header that names the other wire, or none, is IMPORT_EVIDENCE naming it', () => {
  const stated = fix('openai-old-judge');
  stated.header.graderConfig.wire = 'anthropic-messages/v1';
  const e = refuse(stated, 'IMPORT_EVIDENCE');
  assert.ok(e.fields.includes('header/graderConfig/wire'), [...e.fields].join());
  const none = fix('openai-old-judge');
  delete none.header.graderConfig.wire;
  assert.match(refuse(none, 'IMPORT_EVIDENCE').message, /header\/graderConfig\/wire: "not set" but the record says "openai-responses\/v1"/);
  // the OpenAI cap is max_output_tokens: an Anthropic-style key beside it is not a setting of this wire
  const capKey = fix('openai-old-judge');
  capKey.header.graderConfig.max_tokens = 256;
  assert.match(refuse(capKey, 'IMPORT_EVIDENCE').message, /header\/graderConfig\/max_tokens: not a setting the grader sends on the openai-responses\/v1 wire/);
  const verbosity = fix('openai-old-judge');
  verbosity.header.graderConfig.verbosity = 'high';
  assert.match(refuse(verbosity, 'IMPORT_EVIDENCE').message, /header\/graderConfig\/verbosity: "high" but the record says "NOT_SENT"/);
});

test('one wire per file: one row of another wire is IMPORT_MIXED_IDENTITY naming wire; a v7 row is refused by its version', () => {
  const mixed = fix('openai-old-judge');
  const other = rec(fix('old-judge').rows[4]);
  const target = rec(mixed.rows[4]);
  target.wire = other.wire;
  target.sent = other.sent;
  delete target.incompleteReason;
  target.stopReason = 'end_turn';
  target.contentTypes = ['text'];
  target.callShape = other.callShape;
  assert.deepEqual([...refuse(mixed, 'IMPORT_MIXED_IDENTITY').fields], ['wire']);
  const v7 = fix('openai-old-judge');
  rec(v7.rows[0]).schema = 'example.grader-evidence/v7';
  assert.match(refuse(v7, 'IMPORT_EVIDENCE').message, /this record is of version example\.grader-evidence\/v7, an earlier version than example\.grader-evidence\/v8; Grade the stored outputs again with examples\/importers\/skill-evals\/regrade\.ts/);
});

test('status before text on the OpenAI wire: a cut or filtered response whose message looks complete is IMPORT_UNGRADED, never graded', () => {
  for (const [stop, why, words] of [['incomplete', 'max_output_tokens', /status "incomplete" \(max_output_tokens\), not "completed"/], ['incomplete', 'content_filter', /status "incomplete" \(content_filter\), not "completed"/]] as const) {
    const f = fix('openai-old-judge');
    rec(f.rows[2]).stopReason = stop;
    rec(f.rows[2]).incompleteReason = why;
    const e = refuse(f, 'IMPORT_UNGRADED');
    assert.match(e.message, words);
    assert.match(e.message, /bank-dispute#2|faulty-headphones#|clearance-organiser#/);
  }
  const refusal = fix('openai-old-judge');
  rec(refusal.rows[1]).contentTypes = ['message/output_text', 'message/refusal'];
  assert.match(refuse(refusal, 'IMPORT_UNGRADED').message, /holds a refusal part/);
  const empty = fix('openai-old-judge');
  rec(empty.rows[1]).contentTypes = [];
  assert.match(refuse(empty, 'IMPORT_UNGRADED').message, /not zero or more reasoning items followed by exactly one completed message with one output_text part/);
});
