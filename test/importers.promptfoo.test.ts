// The promptfoo importer, tested on the fixtures the real
// tool wrote (examples/importers/promptfoo/fixtures). Every refusal test loads a good fixture, applies one edit in code,
// imports, and asserts the code and the named fields. Synthetic customer-support refund-bot data only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { identityDiff } from '../src/identity.ts';
import { NOT_SENT, parseRunArtifact, sha256Hex } from '../src/index.ts';
import type { BarFile } from '../src/index.ts';
import { GRADER_NAME, ImportRefusal, loadBar, NEXT_STEP_LINE, parseCasesFile } from '../examples/importers/shared.ts';
import type { CasesFile, ImportRefusalCode } from '../examples/importers/shared.ts';
import { convertPromptfoo, main } from '../examples/importers/promptfoo/import.ts';
import { ImportUsageError, READINGS } from '../examples/importers/shared.ts';
import { main as mainInspect } from '../examples/importers/inspect/import.ts';

const root = join(import.meta.dirname, '..');
const dirPf = join(root, 'examples', 'importers', 'promptfoo');
const importer = join(dirPf, 'import.ts');
const work = mkdtempSync(join(tmpdir(), 'anchorset-pf-import-'));
after(() => rmSync(work, { recursive: true, force: true }));

// ---- inputs ---------------------------------------------------------------------------------------------------------

// The tool's file is a deep tree; the edits below are by path, so the tests use an untyped view of it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const fixtureText = (name: string): string => readFileSync(join(dirPf, 'fixtures', `${name}.json`), 'utf8');
const fix = (name: string): J => JSON.parse(fixtureText(name));
const casesText = readFileSync(join(dirPf, 'cases.json'), 'utf8');
const barText = readFileSync(join(dirPf, 'bar.json'), 'utf8');
const bar: BarFile = loadBar(barText);
const cases: CasesFile = parseCasesFile(casesText, bar);
const bytes = (j: J): Buffer => Buffer.from(JSON.stringify(j, null, 2));

/** The reading rule is stated at import: every helper takes it, and the first rule when a test names none. */
type Over = { cases?: CasesFile; bar?: BarFile; reading?: string };
const conv = (j: J, over: Over = {}) => convertPromptfoo(bytes(j), 'result.json', over.cases ?? cases, over.bar ?? bar, (over.reading ?? READINGS[0]) as never);

let counter = 0;
type Cli = { code: number; out: string; err: string; outPath: string };
/** The command through `main`, on files written from the given values. */
function viaMain(j: J | string, over: { cases?: unknown; bar?: unknown; inName?: string; reading?: string; extra?: string[] } = {}): Cli {
  counter += 1;
  const inPath = join(work, `${counter}-${over.inName ?? 'in.json'}`);
  const casesPath = join(work, `${counter}-cases.json`);
  const barPath = join(work, `${counter}-bar.json`);
  const outPath = join(work, `${counter}-out.json`);
  writeFileSync(inPath, typeof j === 'string' ? j : JSON.stringify(j, null, 2));
  writeFileSync(casesPath, over.cases === undefined ? casesText : JSON.stringify(over.cases));
  writeFileSync(barPath, over.bar === undefined ? barText : JSON.stringify(over.bar));
  const out: string[] = [];
  const err: string[] = [];
  const code = main(['--in', inPath, '--cases', casesPath, '--bar', barPath, '--out', outPath, '--reading', over.reading ?? READINGS[0], ...(over.extra ?? [])], { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n'), outPath };
}

/**
 * Imports a file that must be refused: the code and the named fields from the pure conversion, and exit 2, the code
 * on stderr and no output file from the command.
 */
function refuse(j: J, code: ImportRefusalCode, over: Over = {}): ImportRefusal {
  let caught: unknown;
  try {
    conv(j, over);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ImportRefusal, `expected ${code}, but the file imported or threw ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  assert.ok(caught.fields.length > 0, 'a refusal names its fields');
  const cli = viaMain(j, { cases: over.cases, bar: over.bar, ...(over.reading === undefined ? {} : { reading: over.reading }) });
  assert.equal(cli.code, 2, cli.err);
  assert.match(cli.err, new RegExp(`REFUSED ${code}`));
  assert.equal(existsSync(cli.outPath), false, 'a refusal writes nothing');
  return caught;
}

// ---- edit helpers ---------------------------------------------------------------------------------------------------

const rowsOf = (j: J): J[] => j.results.results;
const comp = (row: J): J => row.gradingResult.componentResults[0];
const ev = (row: J): J => comp(row).metadata.graderEvidence;
const rowOf = (j: J, caseId: string, repeat: number): J => {
  const r = rowsOf(j).find((x) => x.vars.case_id === caseId && x.metadata.storedOutput.repeatIndex === repeat);
  assert.ok(r, `no row ${caseId}#${repeat}`);
  return r;
};
const rowsOfCase = (j: J, caseId: string): J[] => rowsOf(j).filter((x) => x.vars.case_id === caseId);

/** Edits the rendered prompt of a row, and makes the record say it was what the judge was sent (the edit is then the grader's own account). */
function setPrompt(row: J, edit: (messages: J[]) => void): void {
  const messages: J[] = JSON.parse(comp(row).metadata.renderedGradingPrompt);
  edit(messages);
  const text = JSON.stringify(messages);
  comp(row).metadata.renderedGradingPrompt = text;
  const e = ev(row);
  e.promptSha256 = sha256Hex(text);
  e.sent.user = sha256Hex(messages[messages.length - 1].content);
  e.sent.system = messages.length === 2 ? sha256Hex(messages[0].content) : NOT_SENT;
}

/** Gives every row of a case one new stored output, consistently: the output, its hash and the rendered prompt. */
function setCaseOutput(j: J, caseId: string, output: string): void {
  for (const row of rowsOfCase(j, caseId)) {
    const old = row.response.output;
    row.response.output = output;
    row.metadata.storedOutput.outputSha256 = sha256Hex(output);
    row.response.metadata.storedOutput.outputSha256 = sha256Hex(output);
    setPrompt(row, (m) => {
      const last = m[m.length - 1];
      last.content = last.content.split(old).join(output);
    });
  }
}

const fieldsOf = (e: ImportRefusal): string => e.fields.join(' | ');

// ---- the good path --------------------------------------------------------------------------------------------------

test('the old-judge fixture imports to a v3 run that the library parses', () => {
  const r = conv(fix('old-judge'));
  const run = parseRunArtifact(JSON.parse(JSON.stringify(r.run)));
  assert.equal(run.schema, 'anchorset.run/v3');
  assert.equal(r.drawsPerCase, 3);
  assert.deepEqual(run.cases.map((c) => [c.id, c.klass, c.expect]), [['c1', 'refund_policy', 'pass'], ['c2', 'refund_policy', 'pass'], ['c3', 'refund_safety', 'pass']]);
  assert.equal(run.draws.length, 9);
  for (const d of run.draws) {
    assert.equal(d.attempts.length, 1);
    const a = d.attempts[0];
    assert.ok(a !== undefined && a.kind === 'graded');
    assert.equal(a.label, 'pass');
    assert.equal(a.judgeStop, 'end');
    assert.equal(a.systemStop, 'UNKNOWN');
  }
  assert.equal(run.packetBasis, 'declared');
  assert.match(run.packetSource ?? '', /^computed at import from promptfoo 0\.123\.1 result file sha256:[0-9a-f]{64}: the output slot of the rendered grading prompt; no system log$/);
  assert.equal(run.packetSource?.includes(sha256Hex(bytes(fix('old-judge')))), true);
  const id = run.identity;
  assert.equal(id.judgeModelRequested, 'fake-judge-old');
  assert.equal(id.judgeModelServed, 'fake-judge-old-served-20260101');
  assert.equal(id.drawsPerCase, 3);
  assert.match(id.judgeHarnessVersion, /^promptfoo 0\.123\.1; anchorset-recording-grader js sha256:[0-9a-f]{64}; node v\d+\.\d+\.\d+; max-reasks 0$/);
  for (const f of ['judgeDefinitionHash', 'judgeCallShapeHash', 'rubricHash', 'barHash', 'caseSetHash'] as const) assert.match(id[f], /^[0-9a-f]{64}$/, f);
});

test('the system side and the seed are always UNKNOWN, in the identity and in the system call shape', () => {
  const run = conv(fix('old-judge')).run as J;
  for (const f of ['systemModelRequested', 'systemModelServed', 'systemCallShapeHash', 'systemPromptHash', 'systemToolsHash', 'systemHarnessVersion', 'seed']) assert.equal(run.identity[f], 'UNKNOWN', f);
  const sys = run.callShapes.system;
  assert.equal(sys.schema, 'anchorset.callshape/v1');
  for (const [k, v] of Object.entries(sys)) if (k !== 'schema') assert.equal(v, 'UNKNOWN', k);
  assert.equal(Object.keys(sys).length, Object.keys(run.callShapes.judge).length);
});

test('the new-judge fixture differs from the old in the judge model fields only, and in the label of the one case', () => {
  const a = conv(fix('old-judge'));
  const b = conv(fix('new-judge'));
  const ia = parseRunArtifact(JSON.parse(JSON.stringify(a.run))).identity;
  const ib = parseRunArtifact(JSON.parse(JSON.stringify(b.run))).identity;
  assert.deepEqual(identityDiff(ia, ib), ['judgeModelRequested', 'judgeModelServed']);
  assert.equal(ib.judgeModelRequested, 'fake-judge-strict-new');
  const labels = (r: J): string[] => r.run.draws.map((d: J) => `${d.caseId}#${d.drawIndex}=${d.attempts[0].label}`);
  assert.deepEqual(labels(a), ['c1#0=pass', 'c1#1=pass', 'c1#2=pass', 'c2#0=pass', 'c2#1=pass', 'c2#2=pass', 'c3#0=pass', 'c3#1=pass', 'c3#2=pass']);
  assert.deepEqual(labels(b), ['c1#0=pass', 'c1#1=pass', 'c1#2=pass', 'c2#0=pass', 'c2#1=pass', 'c2#2=pass', 'c3#0=fail', 'c3#1=fail', 'c3#2=fail']);
  // The packets are the same for both judges: they saw the same outputs.
  assert.deepEqual((a.run as J).draws.map((d: J) => d.attempts[0].packetHash), (b.run as J).draws.map((d: J) => d.attempts[0].packetHash));
});

test('determinism: the same source bytes give the same run bytes, in one process and across two', () => {
  const one = viaMain(fixtureText('old-judge'));
  const two = viaMain(fixtureText('old-judge'));
  assert.equal(one.code, 0, one.err);
  assert.equal(two.code, 0, two.err);
  assert.equal(readFileSync(one.outPath, 'utf8'), readFileSync(two.outPath, 'utf8'));
  const inPath = join(work, 'det-in.json');
  writeFileSync(inPath, fixtureText('old-judge'));
  const spawn = (n: number) => {
    const out = join(work, `det-out-${n}.json`);
    const r = spawnSync(process.execPath, [importer, '--in', inPath, '--cases', join(dirPf, 'cases.json'), '--bar', join(dirPf, 'bar.json'), '--out', out, '--reading', READINGS[0]], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return { text: readFileSync(out, 'utf8'), stdout: r.stdout };
  };
  const a = spawn(1);
  const b = spawn(2);
  assert.equal(a.text, b.text);
  assert.equal(a.stdout, b.stdout);
  assert.equal(a.text, readFileSync(one.outPath, 'utf8'));
  assert.equal(JSON.parse(a.text).packetSource.includes(sha256Hex(fixtureText('old-judge'))), true);
});

test('two runs of one re-grade differ in ids, times and the output path only; the identity, labels and draws are equal', () => {
  const a = fix('old-judge');
  const b = fix('old-judge');
  b.evalId = 'eval-other';
  b.results.timestamp = '2030-01-01T00:00:00.000Z';
  b.metadata.exportedAt = '2030-01-01T00:00:00.000Z';
  b.config.outputPath = ['out/other.json'];
  const runId = '11111111-1111-4111-8111-111111111111';
  rowsOf(b).forEach((r, i) => {
    r.id = `row-other-${i}`;
    r.latencyMs = 7 + i;
    ev(r).graderRunId = runId;
    ev(r).callId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  });
  const ra = conv(a).run as J;
  const rb = conv(b).run as J;
  assert.notEqual(ra.packetSource, rb.packetSource, 'the source bytes differ, and the run says which bytes it came from');
  delete ra.packetSource;
  delete rb.packetSource;
  assert.deepEqual(ra, rb);
});

test('the machine architecture and the output path of the source file are never copied into the run', () => {
  const j = fix('old-judge');
  j.metadata.arch = 'ARCH-MARKER-x9';
  j.metadata.platform = 'PLATFORM-MARKER-x9';
  j.metadata.nodeVersion = 'NODE-MARKER-x9';
  j.config.outputPath = ['/Users/someone/PATH-MARKER-x9/out.json'];
  const text = JSON.stringify(conv(j).run);
  for (const marker of ['ARCH-MARKER', 'PLATFORM-MARKER', 'NODE-MARKER', 'PATH-MARKER', '/Users/']) assert.equal(text.includes(marker), false, marker);
  const r = viaMain(j);
  assert.equal(r.code, 0, r.err);
  const written = readFileSync(r.outPath, 'utf8');
  for (const marker of ['ARCH-MARKER', 'PATH-MARKER']) assert.equal(written.includes(marker), false, marker);
  assert.equal(r.out.includes('ARCH-MARKER') || r.out.includes('PATH-MARKER'), false);
});

test('the short-outputs fixture, unedited, imports (a short output and a JSON-text output are ordinary data)', () => {
  const r = conv(fix('short-outputs'));
  const run = parseRunArtifact(JSON.parse(JSON.stringify(r.run)));
  assert.equal(run.draws.length, 9);
  assert.deepEqual(run.draws.map((d) => (d.attempts[0] as J).label), Array(9).fill('pass'));
});

test('the command writes the run, prints the plan fragment and the grader lines, and exits 0', () => {
  const r = viaMain(fixtureText('old-judge'));
  assert.equal(r.code, 0, r.err);
  const written = readFileSync(r.outPath, 'utf8');
  const parsed = parseRunArtifact(JSON.parse(written));
  const fragment = JSON.parse(r.out.slice(0, r.out.indexOf('\n}') + 2));
  assert.deepEqual(Object.keys(fragment), ['barHash', 'caseSetHash', 'drawsPerCase', 'judge', 'systems']);
  assert.deepEqual(Object.keys(fragment.judge), ['judgeDefinitionHash', 'judgeModelRequested', 'judgeModelServed', 'judgeCallShapeHash', 'judgeHarnessVersion', 'rubricHash']);
  for (const k of Object.keys(fragment.judge)) assert.equal(fragment.judge[k], (parsed.identity as J)[k], k);
  assert.equal(fragment.barHash, parsed.identity.barHash);
  assert.equal(fragment.caseSetHash, parsed.identity.caseSetHash);
  assert.equal(fragment.drawsPerCase, 3);
  assert.deepEqual(r.out.split('\n').slice(-2), [`run file sha256: ${sha256Hex(written)}`, NEXT_STEP_LINE]);
  assert.ok(r.out.includes('grader: anchorset-recording-grader js node v'));
  assert.ok(r.out.includes('system side and seed: UNKNOWN (this run can enter judge-change only under "system-side-not-compared"; `gate` refuses it)'));
  const shipped = sha256Hex(readFileSync(join(dirPf, 'grader-provider.cjs')));
  const line = r.out.includes("the record reports the shipped grader's sha256") ? 'same' : 'other';
  assert.equal(line, parsed.identity.judgeHarnessVersion.includes(`sha256:${shipped}`) ? 'same' : 'other');
});

test('a record that reports another grader sha256 is refused by default, and read as that grader\'s own account only when the user states the sha256', () => {
  const j = fix('old-judge');
  const other = sha256Hex('another grader file');
  for (const r of rowsOf(j)) ev(r).grader.sha256 = other;
  const refused = viaMain(j);
  assert.equal(refused.code, 2, refused.err);
  assert.match(refused.err, /^REFUSED IMPORT_EVIDENCE: grader\.sha256: the record is not from the shipped grader \(examples\/importers\/promptfoo\/grader-provider\.cjs\)/);
  assert.match(refused.err, /state its file's sha256 with --grader-sha256/);
  assert.match(refused.err, /^fields: grader\.sha256$/m);
  assert.equal(existsSync(refused.outPath), false, 'a refusal writes nothing');
  // the user states the sha256 of the grader they ran: the import goes through and says so
  const stated = viaMain(j, { extra: ['--grader-sha256', other] });
  assert.equal(stated.code, 0, stated.err);
  assert.ok(stated.out.includes(`the record reports the grader sha256 you stated with --grader-sha256, which is not the shipped grader`));
  assert.equal(stated.out.includes("the record reports the shipped grader's sha256"), false);
  assert.ok(stated.out.includes(other));
  assert.ok(parseRunArtifact(JSON.parse(readFileSync(stated.outPath, 'utf8'))).identity.judgeHarnessVersion.includes(`sha256:${other}`), 'the grader stated is in the run identity');
  // a stated sha256 that is not the record's is refused, and one that is not a sha256 is a usage error
  const wrong = viaMain(j, { extra: ['--grader-sha256', sha256Hex('a third file')] });
  assert.equal(wrong.code, 2, wrong.err);
  assert.match(wrong.err, /grader\.sha256: the record's grader file is sha256:[0-9a-f]{64}, not the sha256 stated with --grader-sha256/);
  for (const bad of ['abc', other.toUpperCase(), `${other}0`]) {
    const usage = viaMain(j, { extra: ['--grader-sha256', bad] });
    assert.equal(usage.code, 64, bad);
    assert.match(usage.err, /--grader-sha256 must be a full 64-character sha256/);
  }
  // stating the shipped file's own sha256 on a shipped record is allowed and changes nothing
  const good = viaMain(fixtureText('old-judge'), { extra: ['--grader-sha256', shippedSha()] });
  assert.equal(good.code, 0, good.err);
  assert.ok(good.out.includes("the record reports the shipped grader's sha256"));
});

// ---- the command's own codes ------------------------------------------------------------------------------------------

test('usage errors exit 64: a missing flag, an unknown flag, a repeated flag, an existing --out, an unreadable file', () => {
  const io = { out: () => undefined, err: () => undefined };
  const a = ['--in', join(dirPf, 'fixtures', 'old-judge.json'), '--cases', join(dirPf, 'cases.json'), '--bar', join(dirPf, 'bar.json'), '--reading', READINGS[0]];
  assert.equal(main([], io), 64);
  assert.equal(main(a, io), 64, 'no --out');
  assert.equal(main([...a, '--out', join(work, 'u1.json'), '--grader', 'x'], io), 64, 'a flag the importer does not have');
  assert.equal(main([...a, '--out', join(work, 'u2.json'), '--in', 'x'], io), 64, 'a flag given twice');
  assert.equal(main([...a, '--out'], io), 64, 'a flag without a value');
  const existing = join(work, 'exists.json');
  writeFileSync(existing, 'keep me');
  assert.equal(main([...a, '--out', existing], io), 64);
  assert.equal(readFileSync(existing, 'utf8'), 'keep me', '--out is never overwritten');
  assert.equal(main(['--in', join(work, 'no-such-file.json'), '--cases', join(dirPf, 'cases.json'), '--bar', join(dirPf, 'bar.json'), '--out', join(work, 'u3.json'), '--reading', READINGS[0]], io), 64);
});

test('--reading is required with no default; a missing flag and an unknown name are usage errors (exit 64) that list the two names, and nothing is written', () => {
  const base = ['--in', join(dirPf, 'fixtures', 'old-judge.json'), '--cases', join(dirPf, 'cases.json'), '--bar', join(dirPf, 'bar.json')];
  const run = (extra: string[], out: string): { code: number; err: string } => {
    const err: string[] = [];
    const code = main([...base, '--out', join(work, out), ...extra], { out: () => undefined, err: (x) => err.push(x) });
    assert.equal(existsSync(join(work, out)), code === 0, 'a usage error writes nothing');
    return { code, err: err.join('\n') };
  };
  const none = run([], 'd2-none.json');
  assert.equal(none.code, 64);
  assert.match(none.err, /missing --reading/);
  for (const [i, name] of ['', 'lenient', 'one-json-object-boolean-pass/v2', 'ONE-JSON-OBJECT-BOOLEAN-PASS/V1', 'one-json-object-boolean-pass'].entries()) {
    const r = run(['--reading', name], `d2-bad-${i}.json`);
    assert.equal(r.code, 64, JSON.stringify(name));
    if (name !== '') {
      assert.ok(r.err.includes(READINGS[0]) && r.err.includes(READINGS[1]), `lists both names: ${r.err}`);
    }
  }
  assert.equal(run(['--reading', READINGS[0], '--reading', READINGS[1]], 'd2-twice.json').code, 64);
  assert.equal(run(['--reading', READINGS[1]], 'd2-ok.json').code, 0);
  // a bad name is refused before any file is read: a missing input file does not hide it
  const err: string[] = [];
  assert.equal(main(['--in', join(work, 'nope.json'), '--cases', join(dirPf, 'cases.json'), '--bar', join(dirPf, 'bar.json'), '--out', join(work, 'd2-early.json'), '--reading', 'x'], { out: () => undefined, err: (x) => err.push(x) }), 64);
  assert.match(err.join(''), /--reading must be one of/);
});

test('convertPromptfoo refuses a rule name it does not know (a usage error), and there is no default', () => {
  for (const r of [undefined, '', 'other/v1']) {
    assert.throws(() => convertPromptfoo(bytes(fix('old-judge')), 'result.json', cases, bar, r as never), (e: unknown) => e instanceof ImportUsageError && /--reading must be one of/.test(e.message), String(r));
  }
});

test('success prints the rule: "reading rule: <name>"', () => {
  for (const rule of READINGS) {
    const r = viaMain(fixtureText('old-judge'), { reading: rule });
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.split('\n').includes(`reading rule: ${rule}`), r.out);
  }
});

test('the Inspect importer does not take --reading: given there, it is a usage error', () => {
  const dirIn = join(root, 'examples', 'importers', 'inspect');
  const err: string[] = [];
  const out = join(work, 'd2-inspect.json');
  const code = mainInspect(['--in', join(dirIn, 'fixtures', 'old-judge.json'), '--cases', join(dirIn, 'cases.json'), '--bar', join(dirIn, 'bar.json'), '--out', out, '--reading', READINGS[0]], { out: () => undefined, err: (x) => err.push(x) });
  assert.equal(code, 64);
  assert.match(err.join(''), /unknown argument "--reading"/);
  assert.equal(existsSync(out), false);
});

test('a cases file or bar that does not validate exits 65, and a class the bar lacks is exit 65, not a refusal', () => {
  const badClass = { c1: { klass: 'not_in_bar', expect: 'pass' }, c2: { klass: 'refund_policy', expect: 'pass' }, c3: { klass: 'refund_safety', expect: 'pass' } };
  const r = viaMain(fixtureText('old-judge'), { cases: badClass });
  assert.equal(r.code, 65, r.err);
  assert.match(r.err, /not a class of the bar/);
  assert.equal(existsSync(r.outPath), false);
  assert.equal(viaMain(fixtureText('old-judge'), { cases: { c1: { klass: 'refund_policy', expect: 'excellent' } } }).code, 65);
  assert.equal(viaMain(fixtureText('old-judge'), { cases: { c1: { klass: 'refund_policy', expect: 'pass', extra: 1 } } }).code, 65);
  assert.equal(viaMain(fixtureText('old-judge'), { bar: { labels: ['only'] } }).code, 65);
});

// ---- IMPORT_NO_RECORD ---------------------------------------------------------------------------------------------

test('the plain fixture (the built-in grader) is refused with the message that names the example grader', () => {
  const e = refuse(fix('plain'), 'IMPORT_NO_RECORD');
  assert.match(e.message, /examples\/importers\/promptfoo\/grader-provider\.cjs/);
  assert.match(e.message, /This importer reads the recording grader's record of each call, and this file holds none/);
  assert.match(e.message, /examples\/importers\/README\.md/);
});

test('IMPORT_NO_RECORD: a record of another schema on every row is no record', () => {
  const j = fix('old-judge');
  for (const r of rowsOf(j)) ev(r).schema = 'example.grader-evidence/v8';
  refuse(j, 'IMPORT_NO_RECORD');
});

test('IMPORT_EVIDENCE: a record on some rows only', () => {
  const j = fix('old-judge');
  delete comp(rowOf(j, 'c2', 1)).metadata.graderEvidence;
  const e = refuse(j, 'IMPORT_EVIDENCE');
  assert.match(fieldsOf(e), /results\/4\//);
});

// ---- IMPORT_TOOL_VERSION, IMPORT_SHAPE ----------------------------------------------------------------------------------

test('IMPORT_TOOL_VERSION: another promptfoo version, another format, a missing version', () => {
  const v = fix('old-judge');
  v.metadata.promptfooVersion = '0.124.0';
  assert.match(refuse(v, 'IMPORT_TOOL_VERSION').message, /tested on promptfoo 0\.123\.1, 0\.125\.1 \(format 3\); the file says version "0\.124\.0"/);
  const f = fix('old-judge');
  f.results.version = 2;
  refuse(f, 'IMPORT_TOOL_VERSION');
  const m = fix('old-judge');
  delete m.metadata;
  refuse(m, 'IMPORT_TOOL_VERSION');
});

test('IMPORT_SHAPE: a non-string output, a missing path, a wrong type, a missing runtimeOptions', () => {
  const o = fix('old-judge');
  rowOf(o, 'c1', 0).response.output = { text: 'an object' };
  assert.match(fieldsOf(refuse(o, 'IMPORT_SHAPE')), /\/results\/results\/\d+\/response\/output/);
  const r = fix('old-judge');
  delete r.results.results;
  refuse(r, 'IMPORT_SHAPE');
  const t = fix('old-judge');
  t.runtimeOptions = 'cli';
  assert.deepEqual(refuse(t, 'IMPORT_SHAPE').fields, ['/runtimeOptions']);
  const s = fix('old-judge');
  delete rowOf(s, 'c3', 2).metadata.storedOutput;
  refuse(s, 'IMPORT_SHAPE');
  const p = fix('old-judge');
  rowOf(p, 'c3', 2).gradingResult.componentResults[0].pass = 'yes';
  refuse(p, 'IMPORT_SHAPE');
});

test('IMPORT_SHAPE: a .jsonl file, a file that is not JSON, and a bare NaN without the Inspect-only sentence', () => {
  assert.throws(() => convertPromptfoo(Buffer.from('{"a":1}\n'), 'eval.jsonl', cases, bar, READINGS[0]), (e: unknown) => e instanceof ImportRefusal && e.code === 'IMPORT_SHAPE' && /\.jsonl/.test(e.message));
  const notJson = viaMain('this is not json', { inName: 'x.json' });
  assert.equal(notJson.code, 2);
  assert.match(notJson.err, /REFUSED IMPORT_SHAPE/);
  const nan = fixtureText('old-judge').replace('"score": 1,', '"score": NaN,');
  assert.notEqual(nan, fixtureText('old-judge'));
  const r = viaMain(nan);
  assert.equal(r.code, 2);
  assert.match(r.err, /not JSON/);
  assert.doesNotMatch(r.err, /bare NaN/, 'the sentence is true of the Inspect tool only');
  assert.equal(existsSync(r.outPath), false);
});

// ---- slots the tool marked --------------------------------------------------------------------------------------

test('a row whose component metadata is only graderError is IMPORT_UNGRADED, the row listed', () => {
  const j = fix('old-judge');
  comp(rowOf(j, 'c2', 1)).metadata = { graderError: true };
  const e = refuse(j, 'IMPORT_UNGRADED');
  assert.deepEqual(e.fields, ['c2#1']);
  assert.match(e.message, /1 slot\(s\) hold no finished, readable grade/);
  assert.match(e.message, /graderError/);
  assert.match(e.message, /Keep this file/);
  assert.doesNotMatch(e.message, /run (it|the re-grade) again/);
});

test('the two files the tool really wrote for a cut reply (no record kept) and for a reply with no verdict (record kept) are refused whole', () => {
  const real = (name: string): J => JSON.parse(readFileSync(join(dirPf, 'bad-fixtures', `${name}.json`), 'utf8'));
  const truncated = real('truncated');
  assert.ok(truncated.results.results.every((r: J) => comp(r).metadata.graderEvidence === undefined && comp(r).metadata.graderError === true), 'the tool kept an error and no record');
  const a = refuse(truncated, 'IMPORT_UNGRADED');
  assert.equal(a.fields.length, 9);
  assert.match(a.message, /graderError/);
  const noVerdict = real('no-verdict');
  assert.ok(noVerdict.results.results.every((r: J) => comp(r).metadata.graderEvidence !== undefined), 'the tool kept the record');
  const b = refuse(noVerdict, 'IMPORT_UNGRADED');
  assert.equal(b.fields.length, 9);
  assert.match(b.message, /not exactly one JSON object with a boolean "pass"/);
});

test('a row with gradingResult null and failureReason 2 is IMPORT_UNGRADED, and every such row is listed', () => {
  const j = fix('old-judge');
  for (const [id, n] of [['c1', 0], ['c3', 2]] as const) {
    const r = rowOf(j, id, n);
    r.gradingResult = null;
    r.failureReason = 2;
    r.error = 'Error: grader: the endpoint answered status 500 at /Users/someone/work/grader-provider.cjs:140';
  }
  const e = refuse(j, 'IMPORT_UNGRADED');
  assert.deepEqual(e.fields, ['c1#0', 'c3#2']);
  assert.match(e.message, /failureReason 2/);
  assert.match(e.message, /status 500/);
  assert.doesNotMatch(e.message, /Users\/someone/);
});

// ---- the record and the strict reading --------------------------------------------------------------------------

test('a stop other than end_turn is IMPORT_UNGRADED and the tool\'s grade is not written', () => {
  for (const stop of ['max_tokens', 'refusal', 'stop_sequence', 'tool_use', 'pause_turn', 'something_else']) {
    const j = fix('old-judge');
    const row = rowOf(j, 'c2', 1);
    ev(row).stopReason = stop;
    assert.equal(comp(row).pass, true, 'the tool\'s own grade stays in place');
    const e = refuse(j, 'IMPORT_UNGRADED');
    assert.deepEqual(e.fields, ['c2#1']);
    assert.ok(e.message.includes(`"${stop}"`), stop);
  }
});

test('IMPORT_UNGRADED: content that is not zero or more thinking blocks then exactly one text block', () => {
  const j = fix('old-judge');
  ev(rowOf(j, 'c1', 1)).contentTypes = ['text', 'tool_use'];
  ev(rowOf(j, 'c3', 0)).contentTypes = ['text', 'thinking'];
  ev(rowOf(j, 'c2', 2)).contentTypes = ['thinking', 'text', 'text'];
  assert.deepEqual(refuse(j, 'IMPORT_UNGRADED').fields, ['c1#1', 'c2#2', 'c3#0']);
});

test('a reply with no verdict, with comp.pass true, is IMPORT_UNGRADED', () => {
  const j = fix('old-judge');
  const row = rowOf(j, 'c1', 2);
  ev(row).reply = '{"reason": "no verdict"}';
  assert.equal(comp(row).pass, true);
  const e = refuse(j, 'IMPORT_UNGRADED');
  assert.deepEqual(e.fields, ['c1#2']);
  assert.match(e.message, /under the reading rule/);
});

test('a reply with prose before the object, which only the tool\'s lenient reading grades, is IMPORT_UNGRADED', () => {
  const j = fix('old-judge');
  ev(rowOf(j, 'c2', 0)).reply = 'Here is my verdict {"pass": false}';
  assert.deepEqual(refuse(j, 'IMPORT_UNGRADED').fields, ['c2#0']);
  for (const reply of ['{"pass": "true"}', '{"pass": tr', '', '```json\n{"pass": true}\n```', '[{"pass": true}]']) {
    const k = fix('old-judge');
    ev(rowOf(k, 'c2', 0)).reply = reply;
    refuse(k, 'IMPORT_UNGRADED');
  }
});

test('under the first rule a byte-order mark or a no-break space around the object is IMPORT_UNGRADED, and ASCII white space is read', () => {
  for (const reply of ['\uFEFF{"pass": true}', '\u00A0{"pass": true}', '{"pass": true}\u00A0']) {
    const j = fix('old-judge');
    ev(rowOf(j, 'c2', 0)).reply = reply;
    assert.deepEqual(refuse(j, 'IMPORT_UNGRADED').fields, ['c2#0'], JSON.stringify(reply));
  }
});

test('IMPORT_LABEL_DISAGREES: the strict reading says pass and the tool wrote fail', () => {
  const j = fix('old-judge');
  comp(rowOf(j, 'c2', 1)).pass = false;
  const e = refuse(j, 'IMPORT_LABEL_DISAGREES');
  assert.match(e.message, /c2#1: the reply says true, the tool wrote false/);
});

test('the tool\'s reason that is not the recorded reply\'s reason is IMPORT_EVIDENCE', () => {
  const j = fix('old-judge');
  comp(rowOf(j, 'c1', 0)).reason = 'something the grader never said';
  assert.match(fieldsOf(refuse(j, 'IMPORT_EVIDENCE')), /results\/\d+\/gradingResult\/componentResults\/0\/reason/);
});

// ---- the record --------------------------------------------------------------------------------------------------

test('a served model of UNKNOWN, a call shape with a key removed, a call shape with a key UNKNOWN: IMPORT_EVIDENCE', () => {
  const a = fix('old-judge');
  ev(rowOf(a, 'c2', 2)).servedModel = 'UNKNOWN';
  assert.match(fieldsOf(refuse(a, 'IMPORT_EVIDENCE')), /servedModel/);
  const b = fix('old-judge');
  delete ev(rowOf(b, 'c2', 2)).callShape.timeoutMs;
  assert.match(fieldsOf(refuse(b, 'IMPORT_EVIDENCE')), /callShape/);
  const c = fix('old-judge');
  ev(rowOf(c, 'c2', 2)).callShape.maxOutputTokens = 'UNKNOWN';
  assert.match(fieldsOf(refuse(c, 'IMPORT_EVIDENCE')), /callShape/);
  const d = fix('old-judge');
  ev(rowOf(d, 'c2', 2)).stopReason = null;
  refuse(d, 'IMPORT_EVIDENCE');
  const e = fix('old-judge');
  delete ev(rowOf(e, 'c2', 2)).responseId;
  assert.match(fieldsOf(refuse(e, 'IMPORT_EVIDENCE')), /responseId/);
});

test('the grader\'s config entry removed (the --grader case), its max_tokens changed, another grader file, an unsent key: IMPORT_EVIDENCE', () => {
  const a = fix('old-judge');
  delete a.config.defaultTest.options.provider;
  const e = refuse(a, 'IMPORT_EVIDENCE');
  assert.deepEqual(e.fields, ['/config/defaultTest/options/provider']);
  assert.match(e.message, /never by --grader/);
  const b = fix('old-judge');
  b.config.defaultTest.options.provider.config.max_tokens = 4096;
  assert.match(fieldsOf(refuse(b, 'IMPORT_EVIDENCE')), /config\/max_tokens/);
  const c = fix('old-judge');
  c.config.defaultTest.options.provider.id = 'file://some-other-grader.cjs';
  refuse(c, 'IMPORT_EVIDENCE');
  const d = fix('old-judge');
  d.config.defaultTest.options.provider.config.top_p = 0.5;
  assert.match(fieldsOf(refuse(d, 'IMPORT_EVIDENCE')), /config\/top_p/);
  const m = fix('old-judge');
  m.config.defaultTest.options.provider.config.model = 'fake-judge-strict-new';
  assert.match(fieldsOf(refuse(m, 'IMPORT_EVIDENCE')), /config\/model/);
  const t = fix('old-judge');
  delete t.config.defaultTest.options.provider.config.temperature;
  assert.match(fieldsOf(refuse(t, 'IMPORT_EVIDENCE')), /config\/temperature/);
  const u = fix('old-judge');
  u.config.defaultTest.options.provider.config.baseUrl = 'http://127.0.0.1:9999';
  assert.match(fieldsOf(refuse(u, 'IMPORT_EVIDENCE')), /config\/baseUrl/);
});

test('an assertion key beyond type and value (a weight, a transform, a provider, a metric, a threshold) is IMPORT_DERIVATION', () => {
  for (const [key, value] of [['weight', 2], ['transform', 'output.trim()'], ['provider', 'x'], ['metric', 'm'], ['threshold', 0.8]] as const) {
    const j = fix('old-judge');
    comp(rowOf(j, 'c1', 0)).assertion[key] = value;
    const e = refuse(j, 'IMPORT_DERIVATION');
    assert.match(fieldsOf(e), new RegExp(`assertion/${key}`));
  }
});

test('IMPORT_DERIVATION: a templated rubric (renderedAssertionValue)', () => {
  const j = fix('old-judge');
  comp(rowOf(j, 'c1', 0)).metadata.renderedAssertionValue = 'The reply follows the policy for {{item}}';
  assert.match(fieldsOf(refuse(j, 'IMPORT_DERIVATION')), /renderedAssertionValue/);
});

test('an endpoint with user information, a query or a fragment is IMPORT_EVIDENCE', () => {
  for (const endpoint of ['http://user:secret@127.0.0.1:18765/v1/messages', 'http://127.0.0.1:18765/v1/messages?key=abc', 'http://127.0.0.1:18765/v1/messages#frag']) {
    const j = fix('old-judge');
    ev(rowOf(j, 'c3', 1)).callShape.endpoint = endpoint;
    assert.match(fieldsOf(refuse(j, 'IMPORT_EVIDENCE')), /callShape\.endpoint/, endpoint);
  }
});

test('IMPORT_EVIDENCE: the prompt hash and the sent texts must be the rendered prompt\'s', () => {
  const a = fix('old-judge');
  const row = rowOf(a, 'c1', 0);
  const m = JSON.parse(comp(row).metadata.renderedGradingPrompt);
  m[1].content += ' ';
  comp(row).metadata.renderedGradingPrompt = JSON.stringify(m);
  assert.match(fieldsOf(refuse(a, 'IMPORT_EVIDENCE')), /renderedGradingPrompt/);
  const b = fix('old-judge');
  ev(rowOf(b, 'c1', 0)).sent.user = sha256Hex('another text');
  assert.match(fieldsOf(refuse(b, 'IMPORT_EVIDENCE')), /sent/);
  const c = fix('old-judge');
  ev(rowOf(c, 'c1', 0)).sent.system = 'NOT_SENT';
  refuse(c, 'IMPORT_EVIDENCE');
});

// ---- identity across rows, hidden and duplicate calls -------------------------------------------------------------------------------

test('IMPORT_MIXED_IDENTITY: rows that disagree on the served model, the call shape, the grader or the rubric', () => {
  const a = fix('old-judge');
  ev(rowOf(a, 'c3', 2)).servedModel = 'fake-judge-old-served-20260202';
  assert.deepEqual(refuse(a, 'IMPORT_MIXED_IDENTITY').fields, ['servedModel']);
  const b = fix('old-judge');
  ev(rowOf(b, 'c3', 2)).callShape.timeoutMs = 30000;
  assert.deepEqual(refuse(b, 'IMPORT_MIXED_IDENTITY').fields, ['callShape']);
  const c = fix('old-judge');
  ev(rowOf(c, 'c3', 2)).grader.sha256 = sha256Hex('a different grader');
  assert.deepEqual(refuse(c, 'IMPORT_MIXED_IDENTITY').fields, ['grader.sha256']);
  const d = fix('old-judge');
  const row = rowOf(d, 'c3', 2);
  const old = comp(row).assertion.value;
  comp(row).assertion.value = `${old} Extra clause.`;
  setPrompt(row, (m) => {
    m[1].content = m[1].content.split(old).join(`${old} Extra clause.`);
  });
  assert.deepEqual(refuse(d, 'IMPORT_MIXED_IDENTITY').fields, ['rubric']);
});

test('a call sequence with a hole, and two grader processes, are IMPORT_HIDDEN_CALLS', () => {
  const a = fix('old-judge');
  for (const r of rowsOf(a)) if (ev(r).callSeq >= 4) ev(r).callSeq += 1;
  const e = refuse(a, 'IMPORT_HIDDEN_CALLS');
  assert.deepEqual(e.fields, ['callSeq']);
  assert.match(e.message, /callSeq values are not 1 to 9, each once: 1, 2, 3, 5, 6, 7, 8, 9, 10/);
  const b = fix('old-judge');
  ev(rowOf(b, 'c1', 0)).graderRunId = '22222222-2222-4222-8222-222222222222';
  const f = refuse(b, 'IMPORT_HIDDEN_CALLS');
  assert.deepEqual(f.fields, ['graderRunId']);
  assert.match(f.message, /two grader processes/);
});

test('IMPORT_DUPLICATE_CALL: two slots that share a call id or a response id', () => {
  const a = fix('old-judge');
  ev(rowOf(a, 'c2', 0)).callId = ev(rowOf(a, 'c1', 0)).callId;
  assert.deepEqual([...refuse(a, 'IMPORT_DUPLICATE_CALL').fields].sort(), ['c1#0', 'c2#0']);
  const b = fix('old-judge');
  ev(rowOf(b, 'c3', 1)).responseId = ev(rowOf(b, 'c3', 0)).responseId;
  assert.deepEqual([...refuse(b, 'IMPORT_DUPLICATE_CALL').fields].sort(), ['c3#0', 'c3#1']);
});

// ---- the cache ------------------------------------------------------------------------------------------------------------------------

test('runtimeOptions.cache true, missing, and a cachedResponse mark with the cache said off: IMPORT_CACHE', () => {
  const a = fix('old-judge');
  a.runtimeOptions.cache = true;
  assert.deepEqual(refuse(a, 'IMPORT_CACHE').fields, ['/runtimeOptions/cache']);
  const m = fix('old-judge');
  delete m.runtimeOptions.cache;
  refuse(m, 'IMPORT_CACHE');
  const b = fix('old-judge');
  assert.equal(b.runtimeOptions.cache, false);
  comp(rowOf(b, 'c2', 2)).metadata.cachedResponse = true;
  const e = refuse(b, 'IMPORT_CACHE');
  assert.match(fieldsOf(e), /componentResults\/0\/metadata\/cachedResponse/);
  const ok = fix('old-judge');
  comp(rowOf(ok, 'c2', 2)).metadata.cachedResponse = false;
  conv(ok);
});

// ---- judge selection --------------------------------------------------------------------------------------------------------------------

test('IMPORT_JUDGE_SELECTION: two assertions on a row, an assertion that is not llm-rubric, two prompts, two providers', () => {
  const a = fix('old-judge');
  const row = rowOf(a, 'c1', 0);
  row.gradingResult.componentResults.push(structuredClone(comp(row)));
  refuse(a, 'IMPORT_JUDGE_SELECTION');
  const b = fix('old-judge');
  comp(rowOf(b, 'c1', 0)).assertion.type = 'contains';
  refuse(b, 'IMPORT_JUDGE_SELECTION');
  const c = fix('old-judge');
  c.config.prompts.push('{{question}} again');
  assert.match(refuse(c, 'IMPORT_JUDGE_SELECTION').message, /compares 2 prompts or providers; an import needs one stored output per case/);
  const d = fix('old-judge');
  d.config.providers.push('file://other-system.cjs');
  refuse(d, 'IMPORT_JUDGE_SELECTION');
  const e = fix('old-judge');
  rowOf(e, 'c1', 0).promptIdx = 1;
  refuse(e, 'IMPORT_JUDGE_SELECTION');
});

// ---- the roster, the draws, the outputs ---------------------------------------------------------------------------------------------------------

test('IMPORT_CASE_ID: a missing id, an empty id, a stored id that differs from the variable, variables that differ within a case', () => {
  const a = fix('old-judge');
  delete rowOf(a, 'c1', 0).vars.case_id;
  refuse(a, 'IMPORT_CASE_ID');
  const b = fix('old-judge');
  rowOf(b, 'c1', 0).vars.case_id = '';
  refuse(b, 'IMPORT_CASE_ID');
  const c = fix('old-judge');
  rowOf(c, 'c2', 1).metadata.storedOutput.caseId = 'c3';
  assert.match(fieldsOf(refuse(c, 'IMPORT_CASE_ID')), /storedOutput\/caseId/);
  const d = fix('old-judge');
  rowOf(d, 'c2', 1).vars.question = 'A different question';
  assert.match(refuse(d, 'IMPORT_CASE_ID').message, /c2: the variables differ/);
});

test('IMPORT_CASE_MISSING: a case of cases.json that is not in the file, and a case in the file that cases.json does not have', () => {
  const extra: CasesFile = { ...cases, c4: { klass: 'refund_policy', expect: 'pass' } };
  assert.deepEqual(refuse(fix('old-judge'), 'IMPORT_CASE_MISSING', { cases: extra }).fields, ['c4']);
  const fewer: CasesFile = { c1: cases['c1'] as never, c2: cases['c2'] as never };
  assert.deepEqual(refuse(fix('old-judge'), 'IMPORT_CASE_MISSING', { cases: fewer }).fields, ['c3']);
});

test('one case cut to two rows, a duplicate repeat index, a repeat index out of range, a missing repeat count: IMPORT_DRAW_COUNT', () => {
  const a = fix('old-judge');
  const drop = rowOf(a, 'c2', 2);
  a.results.results = rowsOf(a).filter((r) => r !== drop);
  const e = refuse(a, 'IMPORT_DRAW_COUNT');
  assert.deepEqual(e.fields, ['c2']);
  assert.match(e.message, /c2: 2 of 3 rows/);
  const b = fix('old-judge');
  rowOf(b, 'c3', 2).metadata.storedOutput.repeatIndex = 1;
  assert.deepEqual(refuse(b, 'IMPORT_DRAW_COUNT').fields, ['c3']);
  const c = fix('old-judge');
  rowOf(c, 'c1', 2).metadata.storedOutput.repeatIndex = 3;
  refuse(c, 'IMPORT_DRAW_COUNT');
  const d = fix('old-judge');
  delete d.runtimeOptions.repeat;
  assert.deepEqual(refuse(d, 'IMPORT_DRAW_COUNT').fields, ['/runtimeOptions/repeat']);
  const f = fix('old-judge');
  f.runtimeOptions.repeat = 4;
  refuse(f, 'IMPORT_DRAW_COUNT');
});

test('IMPORT_DRAW_COUNT: the order of the rows by testIdx contradicts the recorded repeat indexes', () => {
  const j = fix('old-judge');
  const a = rowOf(j, 'c2', 0);
  const b = rowOf(j, 'c2', 2);
  [a.testIdx, b.testIdx] = [b.testIdx, a.testIdx];
  assert.match(refuse(j, 'IMPORT_DRAW_COUNT').message, /order of the rows by testIdx/);
});

test('IMPORT_OUTPUTS_DIFFER: the draws of a case hold different outputs; an output whose hash is not the stored-outputs provider\'s', () => {
  const a = fix('old-judge');
  const row = rowOf(a, 'c1', 1);
  const old = row.response.output;
  row.response.output = `${old} (edited)`;
  row.metadata.storedOutput.outputSha256 = sha256Hex(row.response.output);
  setPrompt(row, (m) => {
    m[1].content = m[1].content.split(old).join(row.response.output);
  });
  assert.match(refuse(a, 'IMPORT_OUTPUTS_DIFFER').message, /c1: 2 distinct outputs/);
  const b = fix('old-judge');
  rowOf(b, 'c1', 1).metadata.storedOutput.outputSha256 = sha256Hex('not the output');
  assert.match(refuse(b, 'IMPORT_OUTPUTS_DIFFER').message, /differs from the stored-outputs provider's/);
});

// ---- the packet -----------------------------------------------------------------------------------------------------------------------

test('one row\'s prompt edited by one character is IMPORT_PACKET, naming the row and the position', () => {
  const j = fix('old-judge');
  const row = rowOf(j, 'c2', 1);
  setPrompt(row, (m) => {
    m[1].content = m[1].content.replace('Refunds are only', 'Refunds are onlx');
  });
  const e = refuse(j, 'IMPORT_PACKET');
  assert.deepEqual(e.fields, ['c2#1']);
  assert.match(e.message, /c2#1: the prompt differs from the skeleton filled with this row's parts, at message 1, position \d+/);
});

test('a changed fixed text on every row of one case gives two skeletons: IMPORT_PACKET', () => {
  const j = fix('old-judge');
  for (const row of rowsOfCase(j, 'c3')) {
    setPrompt(row, (m) => {
      m[0].content += ' Be strict.';
    });
  }
  assert.match(refuse(j, 'IMPORT_PACKET').message, /2 different skeletons/);
});

test('every row\'s output containing the rubric defines no skeleton: IMPORT_PACKET', () => {
  const j = fix('old-judge');
  const rubric = comp(rowOf(j, 'c1', 0)).assertion.value;
  for (const id of ['c1', 'c2', 'c3']) setCaseOutput(j, id, `As policy says: ${rubric}`);
  assert.match(refuse(j, 'IMPORT_PACKET').message, /no row fixes the prompt's skeleton: on every row (output|rubric) occurs/);
});

test('an output that is JSON text which the tool rendered again is IMPORT_PACKET, one that went through unchanged imports', () => {
  const again = fix('short-outputs');
  const compact = rowOf(again, 'c2', 0).response.output;
  assert.equal(compact.startsWith('{"refund"'), true);
  for (const row of rowsOfCase(again, 'c2')) {
    setPrompt(row, (m) => {
      m[1].content = m[1].content.split(compact).join(JSON.stringify(JSON.parse(compact), null, 2));
    });
  }
  const e = refuse(again, 'IMPORT_PACKET');
  assert.deepEqual([...e.fields].sort(), ['c2#0', 'c2#1', 'c2#2']);
  assert.doesNotThrow(() => conv(fix('short-outputs')));
});

test('a short output that also occurs in the tool\'s fixed text, and an output equal to a rubric word, import', () => {
  const j = fix('old-judge');
  setCaseOutput(j, 'c1', 'Yes');
  const fixed = JSON.parse(comp(rowOf(j, 'c1', 0)).metadata.renderedGradingPrompt)[0].content as string;
  assert.equal(fixed.includes('You'), true);
  const k = fix('old-judge');
  setCaseOutput(k, 'c2', 'You');
  assert.doesNotThrow(() => conv(j));
  assert.doesNotThrow(() => conv(k));
});

// ---- the bar -----------------------------------------------------------------------------------------------------------------------------------

test('a bar with no pass and fail labels is IMPORT_BAR, naming the label the file\'s grades hold', () => {
  const otherBar = loadBar(JSON.stringify({ labels: ['bad', 'good'], classes: { refund_policy: { direction: 'floor', minPassRate: 0.8 }, refund_safety: { direction: 'floor', nonCompensable: true, minPassRate: 1 } }, knownFailures: [] }));
  const otherCases: CasesFile = Object.fromEntries(Object.entries(cases).map(([id, c]) => [id, { klass: c.klass, expect: 'good' }]));
  const e = refuse(fix('old-judge'), 'IMPORT_BAR', { cases: otherCases, bar: otherBar });
  assert.deepEqual(e.fields, ['pass']);
  const f = refuse(fix('new-judge'), 'IMPORT_BAR', { cases: otherCases, bar: otherBar });
  assert.deepEqual([...f.fields].sort(), ['fail', 'pass']);
});

// ---- counter-fixtures -----------------------------------------------------------------------------------------------------------------------------

test('a per-test repeat equal to the global one, and a list-valued variable in the config of rows with distinct case ids, import', () => {
  const a = fix('old-judge');
  a.config.tests[0].options = { repeat: 3 };
  a.config.tests[0].repeat = 3;
  assert.doesNotThrow(() => conv(a));
  const b = fix('old-judge');
  b.config.tests[1].vars.question = ['I bought shoes 45 days ago and want a refund.', 'Shoes, 45 days, refund?'];
  assert.doesNotThrow(() => conv(b), 'config.tests is never read: the roster is cases.json');
  const c = fix('old-judge');
  c.config.tests.pop();
  assert.doesNotThrow(() => conv(c), 'config.tests is not the roster');
});

test('a per-test repeat that differs from the global one lands in the counts: fewer rows for that case is IMPORT_DRAW_COUNT', () => {
  const j = fix('old-judge');
  const drop = [rowOf(j, 'c1', 1), rowOf(j, 'c1', 2)];
  j.results.results = rowsOf(j).filter((r) => !drop.includes(r));
  refuse(j, 'IMPORT_DRAW_COUNT');
});

// ---- what the importer may import ---------------------------------------------------------------------------------------------------------------------------

test('the importer holds no second copy of the shared helpers, the flag parser or the grader\'s key lists', () => {
  const text = readFileSync(importer, 'utf8');
  for (const dup of [/const isObject\b/, /const typeName\b/, /const asObj\b/, /const asArr\b/, /const asStr\b/, /function parseArgs\b/, /GRADER_CONFIG_KEYS = \[/, /DEFAULT_BASE_URL =/, /DEFAULT_API_VERSION =/, /DEFAULT_TIMEOUT_MS =/]) {
    assert.doesNotMatch(text, dup);
  }
});

test('the importer imports only from ../shared.ts, the library entry and Node built-ins', () => {
  const text = readFileSync(importer, 'utf8');
  const specs = [...text.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1] as string);
  assert.ok(specs.length >= 3);
  const allowed = new Set(['../shared.ts', '../../../src/index.ts']);
  for (const s of specs) assert.ok(allowed.has(s) || s.startsWith('node:'), `import of ${s}`);
  assert.equal(/\bimport\s*\(/.test(text), false, 'no dynamic import');
  assert.equal(/\brequire\s*\(/.test(text), false, 'no require');
});

// ---- more edit-and-refuse tests ---------------------------------------------------------------------------------------------------------

const shippedSha = (): string => sha256Hex(readFileSync(join(dirPf, 'grader-provider.cjs')));

test('a null variable and an integer beyond 2^53 in a row\'s variables are IMPORT_SHAPE naming the variable', () => {
  const a = fix('old-judge');
  rowOf(a, 'c1', 0).vars.extra = null;
  assert.match(fieldsOf(refuse(a, 'IMPORT_SHAPE')), /^\/results\/results\/\d+\/vars\/extra$/);
  const b = fix('old-judge');
  for (const r of rowsOfCase(b, 'c1')) r.vars.big = 12345678901234567890;
  assert.match(fieldsOf(refuse(b, 'IMPORT_SHAPE')), /^\/results\/results\/\d+\/vars\/big$/);
  const c = fix('old-judge');
  rowOf(c, 'c2', 1).vars.nested = { deep: [1, null] };
  assert.match(fieldsOf(refuse(c, 'IMPORT_SHAPE')), /vars\/nested/);
});

test('an unwritable --out is exit 64, an empty flag value is exit 64, and an unexpected error is exit 70 with its words, never 1', () => {
  const io = { out: () => undefined, err: () => undefined };
  const a = ['--in', join(dirPf, 'fixtures', 'old-judge.json'), '--cases', join(dirPf, 'cases.json'), '--bar', join(dirPf, 'bar.json'), '--reading', READINGS[0]];
  const err: string[] = [];
  assert.equal(main([...a, '--out', join(work, 'no-such-folder', 'x.json')], { out: () => undefined, err: (s) => err.push(s) }), 64);
  assert.match(err.join('\n'), /cannot write .*x\.json \(ENOENT\)/);
  assert.equal(main([...a, '--out', ''], io), 64);
  assert.equal(main(['--in', '', '--cases', join(dirPf, 'cases.json'), '--bar', join(dirPf, 'bar.json'), '--out', join(work, 'f2-empty.json'), '--reading', READINGS[0]], io), 64);
  const e2: string[] = [];
  const code = main([...a, '--out', join(work, 'f2-internal.json')], {
    out: () => {
      throw new Error('boom');
    },
    err: (s) => e2.push(s),
  });
  assert.equal(code, 70);
  assert.deepEqual(e2, ['internal error: boom']);
});

test('a record that says the grader is not the JavaScript one is IMPORT_EVIDENCE, and "shipped" is printed for the shipped name, language and sha256 only', () => {
  const j = fix('old-judge');
  for (const r of rowsOf(j)) ev(r).grader.language = 'python';
  assert.match(fieldsOf(refuse(j, 'IMPORT_EVIDENCE')), /graderEvidence\.grader\.language/);
  const same = fix('old-judge');
  for (const r of rowsOf(same)) ev(r).grader.sha256 = shippedSha();
  const ok = viaMain(same);
  assert.equal(ok.code, 0, ok.err);
  assert.ok(ok.out.includes("the record reports the shipped grader's sha256"));
  const named = fix('old-judge');
  for (const r of rowsOf(named)) {
    ev(r).grader.sha256 = shippedSha();
    ev(r).grader.name = `${GRADER_NAME}-edited`;
  }
  const other = viaMain(named);
  assert.equal(other.code, 2, other.err);
  assert.match(other.err, /^REFUSED IMPORT_EVIDENCE: grader\.name: the record is not from the shipped grader/);
  assert.match(other.err, /^fields: grader\.name$/m);
  assert.equal(other.out.includes("the record reports the shipped grader's sha256"), false);
});

test('a row whose draw cannot be read is listed by its case, not as "#-1"', () => {
  const j = fix('old-judge');
  const row = rowOf(j, 'c1', 0);
  row.failureReason = 2;
  row.error = 'Error: grader: the endpoint answered status 500';
  delete row.metadata.storedOutput.repeatIndex;
  const e = refuse(j, 'IMPORT_UNGRADED');
  assert.deepEqual(e.fields, ['c1']);
  assert.doesNotMatch(e.message, /#-1/);
});

test('the refusal is printed as "REFUSED <message>" then "fields: ...", the success as the plan fragment, the run line and the grader line with its language', () => {
  const bad = viaMain(fix('plain'));
  assert.equal(bad.code, 2);
  const lines = bad.err.split('\n');
  assert.match(lines[0] ?? '', /^REFUSED IMPORT_NO_RECORD: /);
  assert.match(lines[1] ?? '', /^fields: /);
  const ok = viaMain(fixtureText('old-judge'));
  const fragment = JSON.parse(ok.out.slice(0, ok.out.indexOf('\n}') + 2));
  assert.deepEqual(fragment.systems, { '<system name>': { '<old or new>': sha256Hex(readFileSync(ok.outPath)) } });
  assert.match(ok.out, /\ngrader: anchorset-recording-grader js node v[\d.]+ sha256:[0-9a-f]{64}\n/);
});

test('the record\'s promptSha256 alone, edited, is IMPORT_EVIDENCE naming it', () => {
  const j = fix('old-judge');
  ev(rowOf(j, 'c1', 0)).promptSha256 = sha256Hex('another prompt');
  const e = refuse(j, 'IMPORT_EVIDENCE');
  assert.match(fieldsOf(e), /renderedGradingPrompt/);
  assert.match(fieldsOf(e), /graderEvidence\/promptSha256/);
  assert.match(e.message, /not the record's promptSha256/);
});

test('a prompt whose roles are not [system, user] or [user] is IMPORT_EVIDENCE, whatever the record says it sent', () => {
  for (const roles of [['assistant', 'user'], ['user', 'user'], ['system', 'system'], ['user', 'system'], ['assistant']]) {
    const j = fix('old-judge');
    setPrompt(rowOf(j, 'c1', 0), (m) => {
      if (roles.length === 1) m.splice(0, 1);
      roles.forEach((r, k) => {
        m[k].role = r;
      });
    });
    const e = refuse(j, 'IMPORT_EVIDENCE');
    assert.match(e.message, /the prompt must be \[system, user\] or \[user\]/, roles.join());
    assert.match(fieldsOf(e), /renderedGradingPrompt/);
  }
});

test('a stored-output record of another schema is IMPORT_SHAPE naming the schema path', () => {
  const j = fix('old-judge');
  rowOf(j, 'c1', 0).metadata.storedOutput.schema = 'example.stored-output/v2';
  assert.match(fieldsOf(refuse(j, 'IMPORT_SHAPE')), /^\/results\/results\/\d+\/metadata\/storedOutput\/schema$/);
});

test('a config timeoutMs or apiVersion that differs from the record is IMPORT_EVIDENCE naming it', () => {
  const a = fix('old-judge');
  a.config.defaultTest.options.provider.config.timeoutMs = 1000;
  assert.match(fieldsOf(refuse(a, 'IMPORT_EVIDENCE')), /config\/timeoutMs/);
  const b = fix('old-judge');
  b.config.defaultTest.options.provider.config.apiVersion = '2024-01-01';
  assert.match(fieldsOf(refuse(b, 'IMPORT_EVIDENCE')), /config\/apiVersion/);
});

test('a fixed text changed alike on every row moves judgeDefinitionHash only; a rubric changed alike moves rubricHash only', () => {
  const base = parseRunArtifact(JSON.parse(JSON.stringify(conv(fix('old-judge')).run))).identity;
  const fixed = fix('old-judge');
  for (const row of rowsOf(fixed)) {
    setPrompt(row, (m) => {
      m[0].content += ' Be strict.';
    });
  }
  const a = parseRunArtifact(JSON.parse(JSON.stringify(conv(fixed).run))).identity;
  assert.deepEqual(identityDiff(base, a), ['judgeDefinitionHash']);
  const rub = fix('old-judge');
  for (const row of rowsOf(rub)) {
    const old = comp(row).assertion.value;
    comp(row).assertion.value = `${old} Extra clause.`;
    setPrompt(row, (m) => {
      m.forEach((x) => {
        x.content = x.content.split(old).join(`${old} Extra clause.`);
      });
    });
  }
  const b = parseRunArtifact(JSON.parse(JSON.stringify(conv(rub).run))).identity;
  assert.deepEqual(identityDiff(base, b), ['rubricHash']);
});

// ---- thinking blocks, the thinking count, and the two named reading rules ---------------------------------

const [FIRST, SECOND] = READINGS;
const configOf = (j: J): J => j.config.defaultTest.options.provider.config;
const countLine = (out: string): string => out.split('\n').find((l) => l.startsWith('replies with a thinking block: ')) ?? 'NO LINE';

test('thinking fixture: some replies thought and some did not; the file imports, every label is read from the text block, and the count line is printed', () => {
  const j = fix('thinking');
  const types = rowsOf(j).map((r) => ev(r).contentTypes.join('+'));
  assert.ok(types.includes('thinking+text') && types.includes('text'), types.join(' '));
  const k = types.filter((t) => t === 'thinking+text').length;
  const r = viaMain(fixtureText('thinking'));
  assert.equal(r.code, 0, r.err);
  assert.equal(countLine(r.out), `replies with a thinking block: ${k} of 9`);
  assert.ok(k > 0 && k < 9);
  const run = parseRunArtifact(JSON.parse(readFileSync(r.outPath, 'utf8')));
  assert.equal(run.draws.length, 9);
  for (const d of run.draws) assert.equal((d.attempts[0] as J).judgeStop, 'end');
  // the replies of the record are the text blocks' text: no thinking text and no signature anywhere in the file
  assert.ok(rowsOf(j).every((x) => ev(x).reply.startsWith('{')));
  assert.ok(!fixtureText('thinking').includes('fake-signature'));
});

test('thinking fixture: the stated settings are in the call shape and the identity, and the judge differs from the unstated one in the call shape only', () => {
  const a = parseRunArtifact(JSON.parse(JSON.stringify(conv(fix('old-judge')).run))).identity;
  const t = fix('thinking');
  const cs = ev(rowsOf(t)[0]).callShape;
  assert.equal(cs.thinkingMode, 'adaptive');
  assert.equal(cs.effort, 'high');
  const b = parseRunArtifact(JSON.parse(JSON.stringify(conv(t).run))).identity;
  assert.ok(identityDiff(a, b).includes('judgeCallShapeHash'));
  assert.equal(ev(rowsOf(t)[0]).sent.thinking.type, 'adaptive');
  assert.deepEqual(ev(rowsOf(t)[0]).sent.output_config, { effort: 'high' });
});

test('the count line counts the blocks: a thinking or redacted_thinking block, any number of them, before the text block', () => {
  const j = fix('old-judge');
  ev(rowOf(j, 'c1', 0)).contentTypes = ['thinking', 'text'];
  ev(rowOf(j, 'c1', 1)).contentTypes = ['redacted_thinking', 'text'];
  ev(rowOf(j, 'c2', 0)).contentTypes = ['thinking', 'redacted_thinking', 'thinking', 'text'];
  ev(rowOf(j, 'c3', 2)).thinkingTokens = 99; // a counter alone is not a block
  const r = viaMain(j);
  assert.equal(r.code, 0, r.err);
  assert.equal(countLine(r.out), 'replies with a thinking block: 3 of 9');
  assert.equal(countLine(viaMain(fixtureText('old-judge')).out), 'replies with a thinking block: 0 of 9');
});

test('the counter and the blocks are not compared, and "ABSENT" is a counter value: each imports', () => {
  const j = fix('old-judge');
  ev(rowOf(j, 'c1', 0)).thinkingTokens = 'ABSENT';
  ev(rowOf(j, 'c1', 1)).thinkingTokens = 40;
  ev(rowOf(j, 'c1', 2)).contentTypes = ['thinking', 'text'];
  ev(rowOf(j, 'c1', 2)).thinkingTokens = 0;
  assert.equal(viaMain(j).code, 0);
});

test('a text block that is not last, a second text block and any other block type are IMPORT_UNGRADED, naming the slot and the types', () => {
  for (const types of [['text', 'thinking'], ['thinking', 'text', 'text'], ['thinking'], ['tool_use'], ['thinking', 'tool_use', 'text'], ['server_tool_use', 'text'], []]) {
    const j = fix('thinking');
    ev(rowOf(j, 'c1', 0)).contentTypes = types;
    const e = refuse(j, 'IMPORT_UNGRADED');
    assert.deepEqual(e.fields, ['c1#0'], JSON.stringify(types));
    assert.match(e.message, /zero or more thinking blocks followed by exactly one text block/);
  }
});

test('a stop at the output budget refuses, with a thinking block as without', () => {
  const j = fix('thinking');
  const row = rowsOf(j).find((r) => ev(r).contentTypes[0] === 'thinking');
  ev(row).stopReason = 'max_tokens';
  assert.equal(refuse(j, 'IMPORT_UNGRADED').fields.length, 1);
});

test('a record of an earlier version (v1 to v4) is IMPORT_EVIDENCE and says to re-grade with the current grader', () => {
  for (const old of ['example.grader-evidence/v1', 'example.grader-evidence/v2', 'example.grader-evidence/v3', 'example.grader-evidence/v4']) {
    const j = fix('old-judge');
    for (const r of rowsOf(j)) ev(r).schema = old;
    const e = refuse(j, 'IMPORT_EVIDENCE');
    assert.match(e.message, /re-grade with the current grader/);
    assert.match(fieldsOf(e), /graderEvidence\.schema/);
  }
});

test('a record that holds reading is IMPORT_EVIDENCE naming it and says to re-grade with the current grader', () => {
  const j = fix('old-judge');
  ev(rowOf(j, 'c2', 1)).reading = READINGS[0];
  const e = refuse(j, 'IMPORT_EVIDENCE');
  assert.match(e.message, /re-grade with the current grader/);
  assert.match(fieldsOf(e), /graderEvidence\.reading/);
});

test('a grader config that holds reading is IMPORT_EVIDENCE: it is not a setting the grader sends', () => {
  const j = fix('old-judge');
  configOf(j).reading = FIRST;
  assert.match(fieldsOf(refuse(j, 'IMPORT_EVIDENCE')), /config\/reading/);
});

test('the config must show the settings the record shows: a thinking or effort that differs, or is missing, is IMPORT_EVIDENCE naming it', () => {
  for (const [key, value] of [['thinking', { type: 'disabled' }], ['effort', 'low']] as const) {
    const j = fix('thinking');
    configOf(j)[key] = value;
    assert.match(fieldsOf(refuse(j, 'IMPORT_EVIDENCE')), new RegExp(`config/${key}`), key);
    const k = fix('thinking');
    delete configOf(k)[key];
    assert.match(fieldsOf(refuse(k, 'IMPORT_EVIDENCE')), new RegExp(`config/${key}`), `${key} missing`);
  }
});

test('the fenced fixture is imported under the second rule, and no record or config of it names a reading rule', () => {
  const j = fix('fenced');
  assert.ok(rowsOf(j).every((r) => !('reading' in ev(r))));
  assert.ok(!('reading' in configOf(j)));
  const fenced = rowsOf(j).filter((r) => ev(r).reply.startsWith('```json\n'));
  const bare = rowsOf(j).filter((r) => ev(r).reply.startsWith('{'));
  assert.ok(fenced.length > 0 && bare.length > 0 && fenced.length + bare.length === 9, `${fenced.length} fenced, ${bare.length} bare`);
  const r = viaMain(fixtureText('fenced'), { reading: SECOND });
  assert.equal(r.code, 0, r.err);
  assert.equal(parseRunArtifact(JSON.parse(readFileSync(r.outPath, 'utf8'))).draws.length, 9);
  assert.equal(countLine(r.out), 'replies with a thinking block: 0 of 9');
  assert.ok(r.out.split('\n').includes(`reading rule: ${SECOND}`));
});

test('the same fenced bytes under the first rule are refused, naming every fenced slot, each with the words that say it is readable under the second rule', () => {
  const j = fix('fenced');
  const fenced = rowsOf(j).filter((r) => ev(r).reply.startsWith('```json\n')).map((r) => `${r.vars.case_id}#${r.metadata.storedOutput.repeatIndex}`).sort();
  const e = refuse(j, 'IMPORT_UNGRADED', { reading: FIRST });
  assert.deepEqual([...e.fields].sort(), fenced);
  assert.match(e.message, new RegExp(FIRST));
  const words = `readable under ${SECOND}; that rule is a different judge definition`;
  assert.equal(e.message.split(words).length - 1, fenced.length, 'the words are said once per fenced slot');
  for (const slot of fenced) assert.match(e.message, new RegExp(`${slot} \\([^)]*; ${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`), slot);
  assert.doesNotMatch(e.message, /node |--reading|re-import/, 'it names no command and chooses nothing');
});

test('a reply unreadable under both rules does not get the words, and neither does one unreadable under the second rule', () => {
  const j = fix('fenced');
  const bare = rowsOf(j).find((r) => ev(r).reply.startsWith('{'));
  ev(bare).reply = 'no verdict here';
  const e = refuse(j, 'IMPORT_UNGRADED', { reading: FIRST });
  const slot = `${bare.vars.case_id}#${bare.metadata.storedOutput.repeatIndex}`;
  const part = new RegExp(`${slot} \\([^)]*\\)`).exec(e.message)?.[0] ?? '';
  assert.ok(part.length > 0, e.message);
  assert.doesNotMatch(part, /readable under/);
  // under the second rule nothing is readable under the first and not the second: the words never appear
  const k = fix('fenced');
  ev(rowsOf(k)[0]).reply = 'no verdict here';
  const u = refuse(k, 'IMPORT_UNGRADED', { reading: SECOND });
  assert.doesNotMatch(u.message, /readable under/);
});

test('the same source bytes imported under the two rules give two run files with two judge-definition hashes, and a plan cannot pair them as one judge', () => {
  const a = viaMain(fixtureText('old-judge'), { reading: FIRST });
  const b = viaMain(fixtureText('old-judge'), { reading: SECOND });
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  const ra = parseRunArtifact(JSON.parse(readFileSync(a.outPath, 'utf8')));
  const rb = parseRunArtifact(JSON.parse(readFileSync(b.outPath, 'utf8')));
  assert.notEqual(ra.identity.judgeDefinitionHash, rb.identity.judgeDefinitionHash);
  assert.deepEqual(identityDiff(ra.identity, rb.identity), ['judgeDefinitionHash']);
  assert.notEqual(sha256Hex(readFileSync(a.outPath)), sha256Hex(readFileSync(b.outPath)));
  // the judge block each import prints holds the hash of its own rule
  assert.ok(a.out.includes(ra.identity.judgeDefinitionHash) && !a.out.includes(rb.identity.judgeDefinitionHash));
  // the plan-level check, on the two judges of one measurement, is in importers.e2e.test.ts
});

test('the second rule refuses each shape it does not read, naming the slot: prose before, prose after, two fences, another tag, no tag, text after the object inside the fence', () => {
  const obj = '{"pass": true, "score": 1, "reason": "Local fake judge: pass."}';
  const shapes: Record<string, string> = {
    'prose before': `Here you go:\n\`\`\`json\n${obj}\n\`\`\``,
    'prose after': `\`\`\`json\n${obj}\n\`\`\`\nHope this helps.`,
    'two fences': `\`\`\`json\n${obj}\n\`\`\`\n\`\`\`json\n${obj}\n\`\`\``,
    'another tag': `\`\`\`JSON\n${obj}\n\`\`\``,
    'no tag': `\`\`\`\n${obj}\n\`\`\``,
    'text after the object inside the fence': `\`\`\`json\n${obj}\nthanks\n\`\`\``,
    'prose around a bare object': `Verdict: ${obj}`,
    'a closing fence with trailing spaces': `\`\`\`json\n${obj}\n\`\`\`   `,
    'an indented opening fence': `  \`\`\`json\n${obj}\n\`\`\``,
    'a no-break space before the opening fence': `\u00A0\`\`\`json\n${obj}\n\`\`\``,
    'a byte-order mark before a bare object': `\uFEFF${obj}`,
    'a no-break space after a bare object': `${obj}\u00A0`,
  };
  for (const [name, reply] of Object.entries(shapes)) {
    const j = fix('fenced');
    ev(rowOf(j, 'c2', 1)).reply = reply;
    const e = refuse(j, 'IMPORT_UNGRADED', { reading: SECOND });
    assert.deepEqual(e.fields, ['c2#1'], name);
  }
  // and the two shapes it does read, as the control: a bare object and a fenced one, with white space around either
  const ok = fix('fenced');
  ev(rowOf(ok, 'c2', 1)).reply = `\n  \t\n\`\`\`json\n${obj}\n\`\`\`\n \n`;
  assert.equal(viaMain(ok, { reading: SECOND }).code, 0);
});

test('IMPORT_LABEL_DISAGREES stays under the second rule: a fenced reply that says pass, with the tool\'s grade fail, is refused', () => {
  const j = fix('fenced');
  const row = rowsOf(j).find((r) => ev(r).reply.startsWith('```json\n'));
  comp(row).pass = false;
  const e = refuse(j, 'IMPORT_LABEL_DISAGREES', { reading: SECOND });
  assert.equal(e.fields.length, 1);
  assert.match(e.message, /the reply says true, the tool wrote false/);
});

test('the fenced reply\'s reason is the reason the tool wrote; a different one is IMPORT_EVIDENCE', () => {
  const j = fix('fenced');
  const row = rowsOf(j).find((r) => ev(r).reply.startsWith('```json\n'));
  comp(row).reason = 'another reason';
  assert.match(fieldsOf(refuse(j, 'IMPORT_EVIDENCE', { reading: SECOND })), /reason/);
});

test('a null setting in the config is printed as null, not as "not set"; an unreadable reply is not blamed on the tool\'s lenient reading', () => {
  const j = fix('thinking');
  configOf(j)['thinking'] = null;
  const e = refuse(j, 'IMPORT_EVIDENCE');
  assert.match(e.message, /config\/thinking: null but the record says/);
  assert.doesNotMatch(e.message, /not set/);
  const k = fix('thinking');
  ev(rowsOf(k)[0]).reply = 'no verdict here';
  const u = refuse(k, 'IMPORT_UNGRADED');
  assert.match(u.message, /under the reading rule/);
  assert.doesNotMatch(u.message, /lenient/);
});

// ---- a key given twice: the source file (exit 2), the cases file and the bar (exit 65) -------------------------------------

test('a key given twice in the result file is IMPORT_SHAPE (exit 2); in the cases file or the bar it is exit 65; nothing is written', () => {
  const dup = fixtureText('old-judge').replace('{', '{"results":null,');
  const r = viaMain(dup);
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /^REFUSED IMPORT_SHAPE: .*: the key "results" is given twice in the top-level object/);
  assert.equal(existsSync(r.outPath), false);
  const run = (casesData: string, barData: string): Cli => {
    counter += 1;
    const p = (n: string, d: string): string => {
      const f = join(work, `${counter}-${n}`);
      writeFileSync(f, d);
      return f;
    };
    const err: string[] = [];
    const outPath = join(work, `${counter}-out.json`);
    const code = main(['--in', p('in.json', fixtureText('old-judge')), '--cases', p('cases.json', casesData), '--bar', p('bar.json', barData), '--out', outPath, '--reading', READINGS[0]], { out: () => undefined, err: (s) => err.push(s) });
    return { code, out: '', err: err.join('\n'), outPath };
  };
  const c = run(casesText.replace('{', '{"c1":{"klass":"refund_policy","expect":"pass"},'), barText);
  assert.equal(c.code, 65, c.err);
  assert.match(c.err, /cases: the key "c1" is given twice/);
  const b = run(casesText, barText.replace('{', '{"labels":["pass"],'));
  assert.equal(b.code, 65, b.err);
  assert.match(b.err, /bar: the key "labels" is given twice/);
  assert.equal(existsSync(c.outPath) || existsSync(b.outPath), false);
});

// ---- a file somebody crafted: an unpaired surrogate, and a text nested without end -----------------

test('an unpaired surrogate anywhere in the result file is IMPORT_SHAPE with its JSON path (exit 2), never an internal error', () => {
  // JSON.stringify writes an unpaired surrogate as an escape: the bytes of each file below are plain text.
  const places: [string, (j: J) => void, string][] = [
    ['a stored output', (j) => { j.results.results[0].response.output += '\ud800'; }, '$.results.results[0].response.output'],
    ['a question', (j) => { j.results.results[1].testCase.vars.question = `\udc00${j.results.results[1].testCase.vars.question}`; }, '$.results.results[1].testCase.vars.question'],
    ['an object key', (j) => { j.results.results[0].namedScores['k\ud800'] = 1; }, '$.results.results[0].namedScores'],
    ['a text no check reads', (j) => { j.metadata.note = '\udc00\ud800'; }, '$.metadata.note'],
    ['the reply in a record', (j) => { j.results.results[2].gradingResult.componentResults[0].metadata.graderEvidence.reply += '\ud83d'; }, '$.results.results[2].gradingResult.componentResults[0].metadata.graderEvidence.reply'],
  ];
  for (const [name, edit, path] of places) {
    const j = fix('old-judge');
    edit(j);
    assert.ok(bytes(j).toString('utf8').isWellFormed(), name);
    const r = refuse(j, 'IMPORT_SHAPE');
    assert.deepEqual([...r.fields], [path], name);
    assert.ok(r.message.startsWith(`IMPORT_SHAPE: result.json: ${path}: `) && /holds an unpaired surrogate/.test(r.message), r.message);
    const cli = viaMain(j);
    assert.deepEqual([cli.code, /internal error/.test(cli.err), existsSync(cli.outPath)], [2, false, false], name);
  }
  // The rendered prompt is a JSON text inside a string: an escape in it spells a surrogate the file's own text does not hold.
  const inner = fix('old-judge');
  const meta = inner.results.results[0].gradingResult.componentResults[0].metadata;
  const rendered = (meta.renderedGradingPrompt as string).replace('"content":"', '"content":"\\ud800');
  assert.notEqual(rendered, meta.renderedGradingPrompt);
  assert.ok(rendered.isWellFormed() && JSON.stringify(inner).isWellFormed());
  meta.renderedGradingPrompt = rendered;
  meta.graderEvidence.promptSha256 = sha256Hex(rendered);
  const r = refuse(inner, 'IMPORT_SHAPE');
  assert.deepEqual([...r.fields], ['/results/results/0/gradingResult/componentResults/0/metadata/renderedGradingPrompt']);
  assert.match(r.message, /renderedGradingPrompt: \$\[0\]\.content: holds an unpaired surrogate/);
});

test('a result file, a cases file or a bar nested 5,000 or 200,000 deep is refused or invalid input (exit 2 or 65), never exit 70', () => {
  for (const depth of [5000, 200_000]) {
    const deep = `${'['.repeat(depth)}${']'.repeat(depth)}`;
    const source = viaMain(fixtureText('old-judge').replace(/^\{/, `{"zz":${deep},`));
    assert.equal(source.code, 2, source.err.slice(0, 200));
    assert.match(source.err, /^REFUSED IMPORT_SHAPE: .*in\.json: objects and lists are nested more than 128 deep$/m);
    // Where the tool's file may hold any JSON: the variables of a test case.
    const vars = fix('old-judge');
    vars.results.results[0].testCase.vars.extra = 'PLACE';
    const inVars = viaMain(JSON.stringify(vars).replace('"PLACE"', deep));
    assert.equal(inVars.code, 2, inVars.err.slice(0, 200));
    assert.match(inVars.err, /nested more than 128 deep/);
    assert.equal(existsSync(source.outPath) || existsSync(inVars.outPath), false);
  }
});

// ---- the bounded, recorded re-ask -------------------------------------------------------------------------------------

const REASK_LINE = 're-asks: 2 on 2 of 9 slots (truncated 1, timeout 0, transport 0, server-error 1, rate-limited 0); at most 2 per slot';
/** The slots of a file whose record holds earlier asks, with the reasons of those asks. */
const reaskedSlots = (j: J): [string, string[]][] =>
  rowsOf(j).filter((r) => ev(r).reask.earlier.length > 0).map((r): [string, string[]] => [`${r.vars.case_id}#${r.metadata.storedOutput.repeatIndex}`, ev(r).reask.earlier.map((a: J) => a.reason)]).sort();

test('fixtures/reask.json imports', () => {
  const j = fix('reask');
  // What the tool wrote under a bound of 2: one slot of c1 was cut once, one slot of c2 got a 529 once; 11 asks for 9 slots.
  assert.deepEqual(reaskedSlots(j), [['c1#0', ['truncated']], ['c2#0', ['server-error']]]);
  assert.ok(rowsOf(j).every((r) => ev(r).reask.max === 2 && ev(r).schema === 'example.grader-evidence/v7'));
  assert.equal(j.config.defaultTest.options.provider.config.maxReasks, 2);
  const seqs = rowsOf(j).flatMap((r) => [...ev(r).reask.earlier.map((a: J) => a.callSeq), ev(r).callSeq]).sort((a: number, b: number) => a - b);
  assert.deepEqual(seqs, Array.from({ length: 11 }, (_, i) => i + 1));
  const r = viaMain(fixtureText('reask'));
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  assert.deepEqual(lines.slice(-5, -2), ['replies with a thinking block: 0 of 9', REASK_LINE, `reading rule: ${READINGS[0]}`]);
  const run = parseRunArtifact(JSON.parse(readFileSync(r.outPath, 'utf8')));
  const shapes = Object.fromEntries(run.draws.map((d) => [`${d.caseId}#${d.drawIndex}`, d.attempts.map((a) => (a.kind === 'unmeasured' ? `${a.kind} ${a.role} ${a.reason}` : a.kind))]));
  assert.deepEqual(shapes['c1#0'], ['unmeasured judge truncated', 'graded']);
  assert.deepEqual(shapes['c2#0'], ['unmeasured judge server-error', 'graded']);
  assert.equal(Object.values(shapes).filter((s) => s.length === 1 && s[0] === 'graded').length, 7);
  // An earlier attempt shares the graded attempt's output hash and packet hash, and its system stop is unknown.
  for (const d of run.draws) {
    const last = d.attempts.at(-1);
    assert.ok(last !== undefined && last.kind === 'graded');
    for (const a of d.attempts.slice(0, -1)) {
      assert.ok(a.kind === 'unmeasured' && a.role === 'judge');
      assert.deepEqual([a.outputHash, a.packetHash, a.systemStop], [last.outputHash, last.packetHash, 'UNKNOWN']);
    }
  }
  const cut = run.draws.find((d) => d.caseId === 'c1' && d.drawIndex === 0)?.attempts[0] as { detail: string };
  assert.match(cut.detail, /^judge ask 1 of 2: the reply was cut at the output cap \(stop "max_tokens"\), status 200, response msg_fake_\d{4}, served model fake-judge-old-served-20260101; callSeq \d+, call id [0-9a-f-]{36}; usage input 100 output 20; thinking tokens 0; cut reply sha256:[0-9a-f]{64} \(\d+ UTF-8 bytes\)$/);
  // The sha256 and the length are the ones the grader recorded for the cut text, which no file holds.
  const cutAsk = rowsOf(j).map((r) => ev(r).reask.earlier).flat().find((a: J) => a.reason === 'truncated');
  assert.ok(cut.detail.endsWith(`; cut reply sha256:${cutAsk.replySha256} (${cutAsk.replyUtf8Bytes} UTF-8 bytes)`));
  assert.ok(cutAsk.replyUtf8Bytes > 0 && cutAsk.replySha256 !== 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const failed = run.draws.find((d) => d.caseId === 'c2' && d.drawIndex === 0)?.attempts[0] as { detail: string };
  assert.match(failed.detail, /^judge ask 1 of 2: no reply \(server-error\), status 529; callSeq \d+, call id [0-9a-f-]{36}$/);
  // The bound is in the judge's harness string, and nowhere on the system side, which stays unknown.
  assert.match(run.identity.judgeHarnessVersion, /; node v\d+\.\d+\.\d+; max-reasks 2$/);
  assert.equal(run.identity.systemHarnessVersion, 'UNKNOWN');
  assert.equal(run.identity.seed, 'UNKNOWN');
  // No client-error, parse-failure or content-filter attempt is ever written.
  assert.ok(run.draws.every((d) => d.attempts.every((a) => a.kind !== 'unmeasured' || ['truncated', 'timeout', 'transport', 'server-error', 'rate-limited'].includes(a.reason))));
});

test('the same bytes import to the same run bytes, on the reask fixture', () => {
  const a = viaMain(fixtureText('reask'));
  const b = viaMain(fixtureText('reask'));
  assert.equal(a.code, 0, a.err);
  assert.equal(readFileSync(a.outPath, 'utf8'), readFileSync(b.outPath, 'utf8'));
  assert.equal(a.out, b.out);
});

test('the bound enters the judge definition hash: two bounds give two definition hashes, each the value the harness string states', () => {
  const at = (max: number) => {
    const j = fix('reask');
    for (const r of rowsOf(j)) ev(r).reask.max = max;
    j.config.defaultTest.options.provider.config.maxReasks = max;
    return conv(j);
  };
  const [two, three] = [at(2), at(3)];
  assert.notEqual(two.judge.judgeDefinitionHash, three.judge.judgeDefinitionHash);
  assert.match(two.judge.judgeHarnessVersion, /; max-reasks 2$/);
  assert.match(three.judge.judgeHarnessVersion, /; max-reasks 3$/);
  for (const f of ['judgeModelRequested', 'judgeModelServed', 'judgeCallShapeHash', 'rubricHash'] as const) assert.equal(two.judge[f], three.judge[f], f);
});

test('bad-fixtures/reask-exhausted.json is refused', () => {
  const j = JSON.parse(readFileSync(join(dirPf, 'bad-fixtures', 'reask-exhausted.json'), 'utf8')) as J;
  // What the tool wrote: under a bound of 1 both asks of one slot were cut; the tool could not read the cut reply and
  // kept an error and no record for that slot, so the earlier ask of that slot is in no record of this file.
  assert.equal(j.config.defaultTest.options.provider.config.maxReasks, 1);
  const noRecord = rowsOf(j).filter((r) => r.gradingResult === null || comp(r)?.metadata?.graderEvidence === undefined);
  assert.equal(noRecord.length, 1);
  const e = refuse(j, 'IMPORT_UNGRADED');
  assert.deepEqual([...e.fields], ['c1#0']);
  assert.match(e.message, /^IMPORT_UNGRADED: 1 slot\(s\) hold no finished, readable grade: c1#0 \(/);
  assert.match(e.message, /Nothing was written\./);
});

test('a slot whose every ask was cut, with its record kept, is refused in the words of a used-up bound', () => {
  // The record a grader returns for such a slot, put where the tool would keep it had it kept one.
  const j = fix('reask');
  const row = rowOf(j, 'c1', 0);
  ev(row).stopReason = 'max_tokens';
  ev(row).reask.earlier.push({ ...ev(row).reask.earlier[0], callSeq: 12, callId: 'another-call', responseId: 'another-response' });
  ev(row).callSeq = 13;
  const e = refuse(j, 'IMPORT_UNGRADED');
  assert.deepEqual([...e.fields], ['c1#0']);
  assert.match(e.message, /c1#0 \([^)]*: the judge's reply was cut at the output cap on each of 3 asks; the bound of 2 re-asks is used up\)/);
});

test('an earlier ask edited to end_turn is IMPORT_REASK', () => {
  const j = fix('reask');
  const row = rowOf(j, 'c1', 0);
  ev(row).reask.earlier[0].stopReason = 'end_turn';
  const e = refuse(j, 'IMPORT_REASK');
  assert.match(fieldsOf(e), /graderEvidence\.reask\.earlier\[0\]\.stopReason$/);
  assert.match(e.message, /a reply that was not cut at the output cap was asked again/);
  // The other ways a result file can be made to hold the best of several asks, each refused by name.
  const more = fix('reask');
  ev(rowOf(more, 'c1', 0)).reask.max = 0;
  assert.match(refuse(more, 'IMPORT_REASK').message, /1 earlier ask\(s\), more than the bound of 0 re-ask\(s\) the record states/);
  const reason = fix('reask');
  ev(rowOf(reason, 'c2', 0)).reask.earlier[0].reason = 'parse-failure';
  assert.match(refuse(reason, 'IMPORT_REASK').message, /"parse-failure" is not one of the reasons a slot is asked again for/);
  const status = fix('reask');
  ev(rowOf(status, 'c2', 0)).reask.earlier[0].httpStatus = 200;
  assert.match(refuse(status, 'IMPORT_REASK').message, /a server error is a status from 500 to 599/);
});

test('an earlier ask taken out of a record leaves a hole in callSeq: IMPORT_HIDDEN_CALLS', () => {
  const j = fix('reask');
  ev(rowOf(j, 'c1', 0)).reask.earlier = [];
  const e = refuse(j, 'IMPORT_HIDDEN_CALLS');
  assert.match(e.message, /callSeq values over every ask \(9 slot\(s\) and 1 recorded re-ask\(s\)\) are not 1 to 10, each once/);
});

test('a stated bound that differs from the record is IMPORT_EVIDENCE, and so is a config that states none', () => {
  const j = fix('reask');
  j.config.defaultTest.options.provider.config.maxReasks = 3;
  const e = refuse(j, 'IMPORT_EVIDENCE');
  assert.deepEqual([...e.fields], ['/config/defaultTest/options/provider/config/maxReasks']);
  assert.match(e.message, /maxReasks: 3 but the record says the bound was 2 re-ask\(s\)/);
  const none = fix('old-judge');
  delete none.config.defaultTest.options.provider.config.maxReasks;
  assert.match(refuse(none, 'IMPORT_EVIDENCE').message, /maxReasks: "not set" but the record says the bound was 0 re-ask\(s\)/);
  // Two bounds in the records of one file.
  const mixed = fix('reask');
  ev(rowOf(mixed, 'c3', 2)).reask.max = 3;
  assert.deepEqual([...refuse(mixed, 'IMPORT_MIXED_IDENTITY').fields], ['reask.max']);
});

test('fixtures/fenced.json under the first rule is still refused, and no fenced slot was asked again', () => {
  const j = fix('fenced');
  const fenced = rowsOf(j).filter((r) => ev(r).reply.startsWith('```json\n'));
  assert.ok(fenced.length > 0);
  // The grader reads no reply: a finished reply the first rule cannot read was asked once, like every other.
  for (const r of rowsOf(j)) assert.deepEqual(ev(r).reask, { max: 0, earlier: [] });
  const e = refuse(j, 'IMPORT_UNGRADED');
  assert.equal(e.fields.length, fenced.length);
  assert.equal(e.message.split('readable under one-json-object-boolean-pass-or-json-fence/v1; that rule is a different judge definition').length - 1, fenced.length);
});

test('a record of the version before, as the earlier grader wrote it, is refused with the instruction to re-grade', () => {
  // v6: a cut ask with no sha256 and no length of the cut reply.
  const j = fix('reask');
  for (const r of rowsOf(j)) {
    ev(r).schema = 'example.grader-evidence/v6';
    for (const a of ev(r).reask.earlier) {
      delete a.replySha256;
      delete a.replyUtf8Bytes;
    }
  }
  const e = refuse(j, 'IMPORT_EVIDENCE');
  assert.match(e.message, /this record is of version example\.grader-evidence\/v6, an earlier version than example\.grader-evidence\/v7; re-grade with the current grader \(examples\/importers\/promptfoo\/grader-provider\.cjs, schema example\.grader-evidence\/v7\)/);
  // The same file under the current schema string is not a v7 file: the cut ask lacks the two keys.
  for (const r of rowsOf(j)) ev(r).schema = 'example.grader-evidence/v7';
  assert.match(refuse(j, 'IMPORT_REASK').message, /not the form of a "truncated" ask; it lacks replySha256, replyUtf8Bytes/);
  // v5: no usage and no reask.
  const k = fix('old-judge');
  for (const r of rowsOf(k)) {
    ev(r).schema = 'example.grader-evidence/v5';
    delete ev(r).usage;
    delete ev(r).reask;
  }
  assert.match(refuse(k, 'IMPORT_EVIDENCE').message, /this record is of version example\.grader-evidence\/v5, an earlier version than example\.grader-evidence\/v7; re-grade with the current grader/);
});

test('a reply that gives "pass" twice is not a verdict: the slot is IMPORT_UNGRADED under either rule, whatever the tool graded', () => {
  for (const reply of ['{"pass":true,"pass":false}', '{"pass":false,"pass":true}', '{"pass":true,"reason":"a","reason":"b"}']) {
    for (const reading of READINGS) {
      const j = fix('old-judge');
      const row = rowsOf(j)[0];
      ev(row).reply = reply;
      const e = refuse(j, 'IMPORT_UNGRADED', { reading });
      assert.equal(e.fields.length, 1, reply);
      assert.match(e.message, /not exactly one JSON object with a boolean "pass"/, reply);
      assert.ok(!e.message.includes('readable under'), reply);
    }
  }
});

// ---- the free-text fields of a record are one printable line --------------------------------------------------

/** The four values the rule names: a line feed, a carriage return, an escape character, 201 characters. */
const NOT_ONE_LINE: ReadonlyArray<readonly [string, string]> = [
  ['a line feed', 'node v24\nthe record reports the shipped grader'],
  ['a carriage return', 'node v24\rforged'],
  ['an escape character', 'node v24\u001b[2Jforged'],
  ['201 characters', 'a'.repeat(201)],
];
const FREE_TEXT_EDITS: ReadonlyArray<readonly [string, (r: J, v: string) => void]> = [
  ['grader.name', (r, v) => { r.grader.name = v; }],
  ['grader.runtime', (r, v) => { r.grader.runtime = v; }],
  ['graderRunId', (r, v) => { r.graderRunId = v; }],
  ['requestedModel', (r, v) => { r.requestedModel = v; }],
  ['stopReason', (r, v) => { r.stopReason = v; }],
  ['callShape.apiVersion', (r, v) => { r.callShape.apiVersion = v; }],
];

test('a free-text field of a record that is not one printable line is IMPORT_EVIDENCE naming the field, not printed', () => {
  for (const [field, edit] of FREE_TEXT_EDITS) {
    for (const [what, value] of NOT_ONE_LINE) {
      const j = fix('old-judge');
      edit(ev(rowsOf(j)[0]), value);
      const e = refuse(j, 'IMPORT_EVIDENCE');
      assert.ok(e.fields.some((f) => f.endsWith(`.${field}`)), `${field} with ${what}: ${fieldsOf(e)}`);
      assert.equal(e.message.includes(value), false, `${field} with ${what}: the value is not echoed`);
    }
  }
});

test('a usage error prints a path on one line: a file name holding a carriage return, an escape sequence and a line feed is written with escapes, and stderr holds exactly one line', () => {
  const out: string[] = [];
  const err: string[] = [];
  const hostile = join(work, '0.3.275\r\u001b[2Kgrader: anchorset-recording-grader\nthe record reports the shipped grader\'s sha256\u2028run file sha256: 000');
  const code = main(['--in', hostile, '--cases', join(dirPf, 'cases.json'), '--bar', join(dirPf, 'bar.json'), '--out', join(work, 'one-line-out.json'), '--reading', READINGS[0]], { out: (x) => out.push(x), err: (x) => err.push(x) });
  assert.equal(code, 64);
  assert.deepEqual(out, []);
  assert.match(err[0] ?? '', /^USAGE: cannot read /);
  assert.equal(err.length, 1, JSON.stringify(err));
  for (const line of err) assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(line), JSON.stringify(line));
  assert.ok(err.some((line) => line.includes('\\r\\u001b[2K') && line.includes('\\n') && line.includes('\\u2028')), JSON.stringify(err));
});
