// A file somebody crafted, or a tool wrote badly, must end a command as invalid input (exit 65), never as an
// uncaught error and never as exit 1, which is the verdict "regression". Three kinds of file are held here:
// one nested very deep, one whose bytes are not UTF-8, and one that opens with a byte-order mark. The last test
// holds the other half: an error nobody foresaw has its own exit code. Synthetic refund-bot data only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parseRunArtifact } from '../src/artifact.ts';
import { main } from '../src/cli.ts';
import { InputError } from '../src/errors.ts';
import { parseBarFile } from '../src/gate.ts';
import { canonicalJson, findIllFormed, findNulls, HAS_BYTE_ORDER_MARK, hashOf, MAX_JSON_DEPTH, depthProblem, NOT_UTF8, parseJsonBytes, parseJsonText, sha256Hex, utf8Text } from '../src/identity.ts';
import { checkLedgerFile, makeJudgeChangeRecord, readLedger } from '../src/ledger.ts';
import { EXIT_CODES } from '../src/regression.ts';
import { main as studyCheck } from '../tools/study-check.ts';

const root = join(import.meta.dirname, '..');
const ex = (...p: string[]): string => join(root, 'examples', ...p);
const dir = mkdtempSync(join(tmpdir(), 'anchorset-hostile-'));
after(() => rmSync(dir, { recursive: true, force: true }));

type Ran = { status: number; stdout: string; stderr: string };
/** The command in this process: an error that escapes `main` fails the test by itself. */
const run = (...args: string[]): Ran => {
  const out: string[] = [];
  const err: string[] = [];
  const status = main(args, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
};
/** The command as a process, for the exit code a shell sees. */
const spawned = (...args: string[]): Ran => {
  const r = spawnSync(process.execPath, [join(root, 'src', 'cli.ts'), ...args], { encoding: 'utf8' });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
};
const study = (...args: string[]): Ran => {
  const r = spawnSync(process.execPath, [join(root, 'tools', 'study-check.ts'), ...args], { encoding: 'utf8' });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
};

let n = 0;
/** A copy of an example file with its bytes changed. */
const changed = (file: string[], change: (bytes: Buffer) => Buffer): string => {
  const path = join(dir, `${n++}-${file.at(-1) as string}`);
  writeFileSync(path, change(readFileSync(ex(...file))));
  return path;
};
/**
 * A copy of the judge-change example with one file changed and every file that names it by sha256 bound to the
 * new bytes (the plan names the runs, the manifest names all), so that only the change is wrong with it.
 */
const bound = (file: string, change: (bytes: Buffer) => Buffer): { dir: string; plan: string; bar: string; runs: string; manifest: string } => {
  const to = join(dir, `jc-${n++}`);
  cpSync(ex('judge-change'), to, { recursive: true });
  const rebind = (rel: string, pairs: [string, string][]): [string, string] => {
    const before = sha256Hex(readFileSync(join(to, rel)));
    writeFileSync(join(to, rel), pairs.reduce((t, [a, b]) => t.replaceAll(a, b), readFileSync(join(to, rel), 'utf8')));
    return [before, sha256Hex(readFileSync(join(to, rel)))];
  };
  const before = sha256Hex(readFileSync(join(to, file)));
  writeFileSync(join(to, file), change(readFileSync(join(to, file))));
  const moved: [string, string][] = [[before, sha256Hex(readFileSync(join(to, file)))]];
  if (file.startsWith('runs/')) moved.push(rebind('plan.json', moved));
  if (file !== 'manifest.json') rebind('manifest.json', moved);
  return { dir: to, plan: join(to, 'plan.json'), bar: join(to, 'bar.json'), runs: join(to, 'runs'), manifest: join(to, 'manifest.json') };
};

const invalid = (r: Ran, what: RegExp, name: string): void => {
  assert.equal(r.status, 65, `${name}: exit ${r.status}: ${r.stderr.slice(0, 300)}`);
  assert.match(r.stderr, what, name);
  assert.doesNotMatch(r.stderr, /\n\s+at .*\(|RangeError|TypeError|node:internal|Maximum call stack/, name);
  assert.equal(r.stdout, '', name);
};

// ---- 1. deep nesting ------------------------------------------------------------------------------------------------------

const lists = (depth: number, inner = ''): string => `${'['.repeat(depth)}${inner}${']'.repeat(depth)}`;
const objects = (depth: number, inner = '1'): string => `${'{"a":'.repeat(depth)}${inner}${'}'.repeat(depth)}`;
/** The file with a key added to its top-level object: the deep value sits where the parser of the file calls it an unknown field. */
const withKey = (value: string) => (bytes: Buffer): Buffer => Buffer.from(bytes.toString('utf8').replace(/^\{/, `{"zz":${value},`));
/** The file with the deep value where any JSON is allowed: the input of its first case. */
const asInput = (value: string) => (bytes: Buffer): Buffer => {
  const text = bytes.toString('utf8');
  const at = text.indexOf('"input":');
  assert.ok(at > 0);
  return Buffer.from(`${text.slice(0, at)}"input": ${value}, "zz${n}": 0,${text.slice(at + '"input":'.length).replace(/^[^,]*,/, '')}`);
};

test('findIllFormed and findNulls read a value nested 200,000 deep, and report in the order of the document', () => {
  const deepList = JSON.parse(lists(200_000, '"a\\ud800", null')) as unknown;
  const deepObject = JSON.parse(objects(200_000, '{"k\\udc00": null}')) as unknown;
  for (const v of [deepList, deepObject]) {
    const surrogates: string[] = [];
    const nulls: string[] = [];
    findIllFormed(v, 'x', surrogates);
    findNulls(v, 'x', nulls);
    assert.equal(surrogates.length, 1);
    assert.equal(nulls.length, 1);
    assert.match(surrogates[0] as string, /unpaired surrogate/);
    assert.ok((nulls[0] as string).endsWith(': null is not allowed'));
  }
  // The order and the paths are those of a reader that goes through the document from its first value to its last.
  const doc = JSON.parse('{"a":["\\ud800",{"b\\udc00":"\\ud801","c":null}],"d\\ud802":[null,"ok"],"e":"\\ud803"}') as unknown;
  const found: string[] = [];
  findIllFormed(doc, 'doc', found);
  assert.deepEqual(found.map((p) => p.slice(0, p.indexOf(' holds'))), [
    'doc.a[0]:',
    'doc.a[1]: the object key "b\\udc00"',
    'doc.a[1]."b\\udc00":',
    'doc: the object key "d\\ud802"',
    'doc.e:',
  ]);
  const nulls: string[] = [];
  findNulls(doc, 'doc', nulls);
  assert.deepEqual(nulls, ['doc.a[1].c: null is not allowed', 'doc.d\ud802[0]: null is not allowed']);
  // A scalar, an empty list and an empty object hold nothing to report.
  for (const v of [1, 'a', true, [], {}, undefined]) {
    const none: string[] = [];
    findIllFormed(v, 'v', none);
    findNulls(v, 'v', none);
    assert.deepEqual(none, []);
  }
  const top: string[] = [];
  findNulls(null, 'v', top);
  findIllFormed('\ud800', 'v', top);
  assert.deepEqual(top.map((p) => p.split(':')[0]), ['v', 'v']);
});

test(`a JSON text may nest ${MAX_JSON_DEPTH} deep and no deeper: the one rule of every file read`, () => {
  assert.equal(MAX_JSON_DEPTH, 128);
  const problem = { problem: 'objects and lists are nested more than 128 deep', notJson: false };
  for (const make of [lists, objects, (d: number): string => `{"a":${lists(d - 1)}}`]) {
    assert.equal(depthProblem(make(128)), undefined);
    assert.ok('json' in parseJsonText(make(128)));
    assert.equal(depthProblem(make(129)), problem.problem);
    assert.deepEqual(parseJsonText(make(129)), problem);
    assert.deepEqual(parseJsonText(make(200_000)), problem);
  }
  // Depth is how many are open at once: values side by side do not add up.
  assert.ok('json' in parseJsonText(`[${Array.from({ length: 500 }, () => lists(100)).join(',')}]`));
  // A bracket inside a string is a character, also after an escaped quote or an escaped backslash.
  assert.ok('json' in parseJsonText(JSON.stringify({ a: '['.repeat(500), 'k{{{': 'x\\"[[[', b: `\\${'{'.repeat(300)}` })));
  assert.ok('json' in parseJsonText(`["\\\\",${lists(127)}]`));
  assert.deepEqual(parseJsonText(`["\\\\",${lists(128)}]`), problem);
  assert.deepEqual(parseJsonText(`["a\\"[",${lists(128)}]`), problem);
  // A text that is not JSON keeps the parser's message, however deep it is.
  const cut = parseJsonText('['.repeat(5000));
  assert.ok('problem' in cut && cut.notJson && cut.problem.startsWith('invalid JSON: '));
  // The bytes of a file are read by the same rule.
  assert.deepEqual(parseJsonBytes(Buffer.from(lists(129))), problem);
});

test('canonicalJson and hashOf refuse a value nested deeper than a file may be, by name and not by a stack overflow', () => {
  const nested = (depth: number): unknown => JSON.parse(lists(depth));
  assert.equal(canonicalJson(nested(128)), lists(128));
  assert.equal(canonicalJson(JSON.parse(objects(128))), objects(128).replaceAll(' ', ''));
  for (const depth of [129, 5000, 200_000]) {
    for (const f of [canonicalJson, hashOf]) {
      assert.throws(() => f(nested(depth)), (e: unknown) => e instanceof TypeError && /^canonicalJson: objects and lists are nested more than 128 deep, at \$\[0\]/.test(e.message), String(depth));
    }
  }
  assert.throws(() => canonicalJson(JSON.parse(objects(129))), (e: unknown) => e instanceof TypeError && /nested more than 128 deep, at \$\.a\.a/.test(e.message));
});

test('an unknown key that is not well-formed text is named in its JSON form, so that the problem can be printed', () => {
  const run = JSON.parse(readFileSync(ex('refund-bot', 'baseline.json'), 'utf8')) as Record<string, unknown>;
  const bar = JSON.parse(readFileSync(ex('refund-bot', 'bar.json'), 'utf8')) as Record<string, Record<string, object>>;
  const problemsOf = (f: () => unknown): readonly string[] => {
    try {
      f();
    } catch (e) {
      assert.ok(e instanceof InputError, String(e));
      return e.problems;
    }
    return [];
  };
  const inRun = problemsOf(() => parseRunArtifact({ ...run, 'k\ud800': 1, identity: { ...(run['identity'] as object), 'i\udc00': 1 } }));
  assert.ok(inRun.includes('artifact."k\\ud800": unknown field'), inRun.join(' | '));
  assert.ok(inRun.includes('artifact.identity."i\\udc00": unknown field'), inRun.join(' | '));
  const [klass] = Object.keys(bar['classes'] as object) as [string];
  const inBar = problemsOf(() => parseBarFile({ ...bar, 'k\ud800': 1, classes: { ...bar['classes'], [klass]: { ...(bar['classes'] as Record<string, object>)[klass], 'c\udc00': 1 } } }));
  assert.ok(inBar.includes('bar."k\\ud800": unknown field'), inBar.join(' | '));
  assert.ok(inBar.includes(`bar.classes.${klass}."c\\udc00": unknown field`), inBar.join(' | '));
  for (const p of [...inRun, ...inBar]) assert.ok(p.isWellFormed(), JSON.stringify(p));
  // A key that is text is named as it always was.
  assert.ok(problemsOf(() => parseRunArtifact({ ...run, 'a key': 1 })).includes('artifact.a key: unknown field'));
  assert.ok(problemsOf(() => parseBarFile({ ...bar, extra: 1 })).includes('bar.extra: unknown field'));
});

test('the parsers read a value nested 200,000 deep without an error of their own: the file is refused or read, never a stack overflow', () => {
  const deep = JSON.parse(lists(200_000)) as unknown;
  const run = JSON.parse(readFileSync(ex('refund-bot', 'baseline.json'), 'utf8')) as Record<string, unknown>;
  assert.throws(() => parseRunArtifact({ ...run, zz: deep }), (e: unknown) => e instanceof InputError && e.problems.includes('artifact.zz: unknown field'));
  const bar = JSON.parse(readFileSync(ex('refund-bot', 'bar.json'), 'utf8')) as Record<string, unknown>;
  assert.throws(() => parseBarFile({ ...bar, zz: deep }), (e: unknown) => e instanceof InputError && e.problems.includes('bar.zz: unknown field'));
});

const DEEP = /nested more than 128 deep/;

test('gate: a run file or a bar nested 5,000 or 200,000 deep is invalid input (exit 65), never exit 1', () => {
  const [baseline, candidate, bar] = [ex('refund-bot', 'baseline.json'), ex('refund-bot', 'candidate.json'), ex('refund-bot', 'bar.json')];
  for (const depth of [5000, 200_000]) {
    for (const [name, place] of [['an unknown key', withKey(lists(depth))], ['an unknown key, objects', withKey(objects(depth))], ['a case input', asInput(objects(depth))]] as const) {
      const badRun = changed(['refund-bot', 'baseline.json'], place);
      const what = `${name}, ${depth}`;
      invalid(run('gate', '--baseline', badRun, '--candidate', candidate, '--bar', bar), DEEP, `baseline: ${what}`);
      invalid(run('gate', '--baseline', baseline, '--candidate', badRun, '--bar', bar, '--json'), DEEP, `candidate: ${what}`);
      invalid(run('gate', '--baseline', baseline, '--candidate', candidate, '--bar', bar, '--rejudge-of', badRun), DEEP, `rejudge-of: ${what}`);
    }
    const badBar = changed(['refund-bot', 'bar.json'], withKey(objects(depth)));
    invalid(run('gate', '--baseline', baseline, '--candidate', candidate, '--bar', badBar), DEEP, `bar: ${depth}`);
    // The file is named.
    const named = changed(['refund-bot', 'baseline.json'], withKey(lists(depth)));
    assert.ok(run('gate', '--baseline', named, '--candidate', candidate, '--bar', bar).stderr.includes(`${named}: objects and lists are nested more than 128 deep`));
  }
  // As a process: the exit code a script reads.
  const badRun = changed(['refund-bot', 'baseline.json'], withKey(lists(200_000)));
  invalid(spawned('gate', '--baseline', badRun, '--candidate', candidate, '--bar', bar), DEEP, 'as a process');
  // A file at the limit is read: this one is refused for its unknown key, by the parser of the file.
  const atLimit = changed(['refund-bot', 'baseline.json'], withKey(lists(127)));
  invalid(run('gate', '--baseline', atLimit, '--candidate', candidate, '--bar', bar), /artifact\.zz: unknown field/, 'at the limit');
});

test('agree, drift and flips: a file nested 5,000 or 200,000 deep is invalid input (exit 65)', () => {
  for (const depth of [5000, 200_000]) {
    for (const value of [lists(depth), objects(depth)]) {
      invalid(run('agree', '--ratings', changed(['refund-bot', 'ratings.json'], withKey(value))), DEEP, `agree ${depth}`);
      const badOld = changed(['refund-bot', 'anchor_old.json'], withKey(value));
      const badNew = changed(['refund-bot', 'anchor_new.json'], withKey(value));
      invalid(run('drift', '--old', badOld, '--new', ex('refund-bot', 'anchor_new.json'), '--flag', 'review,handoff'), DEEP, `drift old ${depth}`);
      invalid(run('drift', '--old', ex('refund-bot', 'anchor_old.json'), '--new', badNew, '--flag', 'review,handoff', '--json'), DEEP, `drift new ${depth}`);
      invalid(run('flips', '--run', changed(['refund-bot', 'judged.json'], withKey(value))), DEEP, `flips ${depth}`);
      invalid(run('flips', '--run', changed(['refund-bot', 'judged.json'], asInput(value)), '--json'), DEEP, `flips input ${depth}`);
    }
  }
});

test('judge-change: a plan, a bar, a run or a reference nested 5,000 or 200,000 deep is invalid input (exit 65)', () => {
  const [plan, bar, runs] = [ex('judge-change', 'plan.json'), ex('judge-change', 'bar.json'), ex('judge-change', 'runs')];
  for (const depth of [5000, 200_000]) {
    invalid(run('judge-change', '--plan', changed(['judge-change', 'plan.json'], withKey(lists(depth))), '--bar', bar, '--inputs', runs), DEEP, `plan ${depth}`);
    invalid(run('judge-change', '--plan', plan, '--bar', changed(['judge-change', 'bar.json'], withKey(objects(depth))), '--inputs', runs), DEEP, `bar ${depth}`);
    for (const file of ['runs/bot-v1.old-judge.json', 'runs/bot-v2.new-judge.json', 'runs/bot-v3.reference.json']) {
      const b = bound(file, withKey(lists(depth)));
      invalid(run('judge-change', '--plan', b.plan, '--bar', b.bar, '--inputs', b.runs), new RegExp(`${file.slice(5).replaceAll('.', '\\.')}: objects and lists are nested more than 128 deep`), `${file} ${depth}`);
    }
    const b = bound('runs/bot-v4.old-judge.json', asInput(objects(depth)));
    invalid(run('judge-change', '--plan', b.plan, '--bar', b.bar, '--inputs', b.runs, '--json'), DEEP, `a case input ${depth}`);
  }
});

test('a ledger line and a study manifest nested 200,000 deep are invalid input (exit 65)', () => {
  const ledger = join(dir, 'deep-ledger.jsonl');
  writeFileSync(ledger, `${lists(200_000)}\n`);
  const gate = ['gate', '--baseline', ex('refund-bot', 'baseline.json'), '--candidate', ex('refund-bot', 'candidate.json'), '--bar', ex('refund-bot', 'bar.json')];
  invalid(run(...gate, '--ledger', ledger), /deep-ledger\.jsonl: line 1: objects and lists are nested more than 128 deep/, 'ledger');
  assert.throws(() => readLedger(ledger), (e: unknown) => e instanceof InputError && e.code === 'INVALID_LEDGER');
  for (const file of ['manifest.json', 'plan.json', 'bar.json', 'runs/bot-v1.old-judge.json']) {
    const b = bound(file, withKey(lists(200_000)));
    invalid(study(b.manifest), DEEP, `study-check ${file}`);
  }
});

// ---- 2. bytes that are not UTF-8, and a byte-order mark ---------------------------------------------------------------------

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const withBom = (bytes: Buffer): Buffer => Buffer.concat([BOM, bytes]);
/** The first character of the file's first string, replaced by a byte no UTF-8 text holds. */
const badByte = (byte = 0xff) => (bytes: Buffer): Buffer => {
  const copy = Buffer.from(bytes);
  copy[copy.indexOf(0x22) + 1] = byte;
  return copy;
};
const BYTES = /invalid JSON: the bytes are not UTF-8 text/;
const MARK = /invalid JSON: the file starts with a byte-order mark/;

test('the one decoder: fatal, and a byte-order mark is a problem, not white space', () => {
  assert.deepEqual(utf8Text(Buffer.from('{"a":"é😀"}')), { text: '{"a":"é😀"}' });
  assert.deepEqual(utf8Text(new Uint8Array(0)), { text: '' });
  // A byte that no UTF-8 text holds, a sequence cut short, an overlong form, and a surrogate written as three bytes.
  for (const bad of [[0xff], [0xfe], [0x7b, 0xff, 0x7d], [0xc3], [0xe2, 0x82], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf8, 0x88, 0x80, 0x80, 0x80]]) {
    assert.deepEqual(utf8Text(new Uint8Array(bad)), { problem: 'the bytes are not UTF-8 text' }, bad.join());
  }
  assert.equal(NOT_UTF8, 'the bytes are not UTF-8 text');
  assert.deepEqual(utf8Text(withBom(Buffer.from('{}'))), { problem: 'the file starts with a byte-order mark' });
  assert.deepEqual(utf8Text(BOM), { problem: HAS_BYTE_ORDER_MARK });
  // The same character anywhere else is text (U+FEFF inside a string is a character of that string).
  assert.deepEqual(utf8Text(Buffer.from('{"a":"﻿"}')), { text: '{"a":"﻿"}' });
  // A file's bytes that are no text are no JSON: the problem says which of the two it is.
  assert.deepEqual(parseJsonBytes(new Uint8Array([0x7b, 0xff, 0x7d])), { problem: 'invalid JSON: the bytes are not UTF-8 text', notJson: true });
  assert.deepEqual(parseJsonBytes(withBom(Buffer.from('{}'))), { problem: 'invalid JSON: the file starts with a byte-order mark', notJson: true });
  assert.deepEqual(parseJsonBytes(Buffer.from('{"a":1}')), { json: { a: 1 } });
});

test('the defect: two run files whose identity differs only in an invalid byte were read as one text, and the gate compared them', () => {
  // The pair: the last character of the harness version is 0xFF in one file and 0xFE in the other.
  const needle = Buffer.from('refund-harness 1.4.0');
  const swap = (byte: number) => (bytes: Buffer): Buffer => {
    const copy = Buffer.from(bytes);
    const at = copy.indexOf(needle);
    assert.ok(at > 0);
    copy[at + needle.length - 1] = byte;
    return copy;
  };
  const ff = changed(['refund-bot', 'baseline.json'], swap(0xff));
  const fe = changed(['refund-bot', 'baseline.json'], swap(0xfe));
  // A lenient decoder writes U+FFFD for either byte: the two files, which differ, become the same text.
  assert.notDeepEqual(readFileSync(ff), readFileSync(fe));
  assert.equal(readFileSync(ff).toString('utf8'), readFileSync(fe).toString('utf8'));
  const bar = ex('refund-bot', 'bar.json');
  for (const r of [run('gate', '--baseline', ff, '--candidate', fe, '--bar', bar), spawned('gate', '--baseline', ff, '--candidate', fe, '--bar', bar)]) {
    invalid(r, BYTES, 'the pair');
    assert.ok(r.stderr.includes(`--baseline ${ff}: ${ff}: invalid JSON: the bytes are not UTF-8 text`) || r.stderr.includes(`${ff}: invalid JSON: the bytes are not UTF-8 text`), r.stderr);
  }
  invalid(run('gate', '--baseline', ex('refund-bot', 'baseline.json'), '--candidate', fe, '--bar', bar), new RegExp(`${fe.replaceAll('.', '\\.')}: invalid JSON: the bytes are not UTF-8 text`), 'the candidate is named');
});

test('every command: a file with a byte that is not UTF-8, or with a byte-order mark, is invalid input (exit 65) and is named', () => {
  const [baseline, candidate, bar] = [ex('refund-bot', 'baseline.json'), ex('refund-bot', 'candidate.json'), ex('refund-bot', 'bar.json')];
  const [plan, jcBar, runs] = [ex('judge-change', 'plan.json'), ex('judge-change', 'bar.json'), ex('judge-change', 'runs')];
  for (const [change, what, name] of [[badByte(), BYTES, 'bytes'], [badByte(0xc0), BYTES, 'bytes 0xC0'], [withBom, MARK, 'mark']] as const) {
    const bad = (...file: string[]): string => changed(file, change);
    const named = (path: string): RegExp => new RegExp(`${path.replaceAll('.', '\\.')}: ${what.source}`);
    let f = bad('refund-bot', 'baseline.json');
    invalid(run('gate', '--baseline', f, '--candidate', candidate, '--bar', bar), named(f), `gate baseline ${name}`);
    invalid(run('gate', '--baseline', baseline, '--candidate', f, '--bar', bar), named(f), `gate candidate ${name}`);
    invalid(run('gate', '--baseline', baseline, '--candidate', candidate, '--bar', bar, '--rejudge-of', f), named(f), `gate rejudge-of ${name}`);
    f = bad('refund-bot', 'bar.json');
    invalid(run('gate', '--baseline', baseline, '--candidate', candidate, '--bar', f), named(f), `gate bar ${name}`);
    f = bad('refund-bot', 'ratings.json');
    invalid(run('agree', '--ratings', f), named(f), `agree ${name}`);
    f = bad('refund-bot', 'anchor_old.json');
    invalid(run('drift', '--old', f, '--new', ex('refund-bot', 'anchor_new.json'), '--flag', 'review,handoff'), named(f), `drift old ${name}`);
    f = bad('refund-bot', 'anchor_new.json');
    invalid(run('drift', '--old', ex('refund-bot', 'anchor_old.json'), '--new', f, '--flag', 'review,handoff'), named(f), `drift new ${name}`);
    f = bad('refund-bot', 'judged.json');
    invalid(run('flips', '--run', f), named(f), `flips ${name}`);
    f = bad('judge-change', 'plan.json');
    invalid(run('judge-change', '--plan', f, '--bar', jcBar, '--inputs', runs), named(f), `judge-change plan ${name}`);
    f = bad('judge-change', 'bar.json');
    invalid(run('judge-change', '--plan', plan, '--bar', f, '--inputs', runs), named(f), `judge-change bar ${name}`);
    // A run and a reference the plan binds by the sha256 of these very bytes: the roster admits them, the reader refuses them.
    for (const file of ['runs/bot-v1.old-judge.json', 'runs/bot-v5.new-judge.json', 'runs/bot-v2.reference.json']) {
      const b = bound(file, change);
      invalid(run('judge-change', '--plan', b.plan, '--bar', b.bar, '--inputs', b.runs), named(file.slice(5)), `judge-change ${file} ${name}`);
    }
    // study-check: the manifest, and a file the manifest binds.
    for (const file of ['manifest.json', 'plan.json', 'bar.json', 'runs/bot-v1.new-judge.json', 'runs/bot-v1.reference.json']) {
      const b = bound(file, change);
      const r = study(b.manifest);
      invalid(r, new RegExp(what.source.replace('invalid JSON: ', '')), `study-check ${file} ${name}`);
      assert.ok(r.stderr.includes(file.startsWith('runs/') ? file.slice(5) : file), r.stderr);
    }
  }
});

test('a ledger: a line with a byte that is not UTF-8 is invalid input and the line is named; a byte-order mark is refused', () => {
  const ledger = join(dir, 'bytes', 'ledger.jsonl');
  const gate = ['gate', '--baseline', ex('refund-bot', 'baseline.json'), '--candidate', ex('refund-bot', 'baseline.json'), '--bar', ex('refund-bot', 'bar.json')];
  for (let i = 0; i < 3; i++) assert.equal(run(...gate, '--ledger', ledger).status, 0);
  const good = readFileSync(ledger);
  assert.equal(readLedger(ledger).length, 3);
  const lineStart = (k: number): number => {
    let at = 0;
    for (let i = 1; i < k; i++) at = good.indexOf(0x0a, at) + 1;
    return at;
  };
  for (const line of [1, 2, 3]) {
    const bad = Buffer.from(good);
    // Inside the first string of the line.
    bad[bad.indexOf(0x22, lineStart(line)) + 1] = 0xff;
    const path = join(dir, 'bytes', `bad-${line}.jsonl`);
    writeFileSync(path, bad);
    // The lenient reader put U+FFFD there and went on to judge the record it had made up.
    assert.throws(() => readLedger(path), (e: unknown) => e instanceof InputError && e.code === 'INVALID_LEDGER' && e.problems.join() === `line ${line}: the bytes are not UTF-8 text`);
    assert.throws(() => checkLedgerFile(path), (e: unknown) => e instanceof InputError && e.problems.join() === `${path}: line ${line}: the bytes are not UTF-8 text`);
    invalid(run(...gate, '--ledger', path), new RegExp(`line ${line}: the bytes are not UTF-8 text`), `line ${line}`);
    // Nothing was appended to it.
    assert.deepEqual(readFileSync(path), bad);
  }
  // A sequence cut by the end of a line is not completed by the next line.
  const cut = join(dir, 'bytes', 'cut.jsonl');
  writeFileSync(cut, Buffer.concat([good.subarray(0, lineStart(2) - 1), Buffer.from([0xe2, 0x82, 0x0a]), good.subarray(lineStart(2))]));
  assert.throws(() => readLedger(cut), (e: unknown) => e instanceof InputError && e.problems.join() === 'line 1: the bytes are not UTF-8 text');
  const marked = join(dir, 'bytes', 'marked.jsonl');
  writeFileSync(marked, withBom(good));
  assert.throws(() => readLedger(marked), (e: unknown) => e instanceof InputError && e.problems.join() === 'line 1: the file starts with a byte-order mark');
  invalid(run(...gate, '--ledger', marked), /line 1: the file starts with a byte-order mark/, 'mark');
  // An agree, a drift and a judge-change command check the same file the same way.
  const bad = join(dir, 'bytes', 'bad-2.jsonl');
  invalid(run('agree', '--ratings', ex('refund-bot', 'ratings.json'), '--ledger', bad), /line 2: the bytes are not UTF-8 text/, 'agree');
  invalid(run('drift', '--old', ex('refund-bot', 'anchor_old.json'), '--new', ex('refund-bot', 'anchor_new.json'), '--flag', 'review,handoff', '--ledger', bad), /line 2: the bytes are not UTF-8 text/, 'drift');
  invalid(run('judge-change', '--plan', ex('judge-change', 'plan.json'), '--bar', ex('judge-change', 'bar.json'), '--inputs', ex('judge-change', 'runs'), '--ledger', bad), /line 2: the bytes are not UTF-8 text/, 'judge-change');
});

test('the record of a judge-change report refuses plan or bar bytes with a byte-order mark, which one reader used to drop', () => {
  const planFile = readFileSync(ex('judge-change', 'plan.json'));
  const barFile = readFileSync(ex('judge-change', 'bar.json'));
  const out: string[] = [];
  assert.equal(main(['judge-change', '--plan', ex('judge-change', 'plan.json'), '--bar', ex('judge-change', 'bar.json'), '--inputs', ex('judge-change', 'runs'), '--json'], { out: (s) => out.push(s), err: () => undefined }), 0);
  const report = JSON.parse(out.join('\n')) as Parameters<typeof makeJudgeChangeRecord>[0]['report'];
  assert.equal(makeJudgeChangeRecord({ planFile, barFile, report }).kind, 'judge-change');
  const refused = (args: { planFile: Uint8Array; barFile: Uint8Array }, problem: string): void => {
    assert.throws(() => makeJudgeChangeRecord({ ...args, report }), (e: unknown) => e instanceof InputError && e.code === 'INVALID_LEDGER' && e.problems.includes(problem), problem);
  };
  refused({ planFile: withBom(planFile), barFile }, 'plan file: invalid JSON: the file starts with a byte-order mark');
  refused({ planFile, barFile: withBom(barFile) }, 'bar file: invalid JSON: the file starts with a byte-order mark');
  refused({ planFile, barFile: badByte()(barFile) }, 'bar file: invalid JSON: the bytes are not UTF-8 text');
});

// ---- an error nobody foresaw -----------------------------------------------------------------------------------------------

test('an unforeseen error is exit 70 with one line and no stack trace, never exit 1; the usage text names the code', () => {
  assert.equal(EXIT_CODES.INTERNAL, 70);
  assert.deepEqual(Object.values(EXIT_CODES).sort((a, b) => a - b), [0, 1, 2, 64, 65, 70]);
  const usage: string[] = [];
  assert.equal(main(['--help'], { out: (s) => usage.push(s), err: () => undefined }), 0);
  assert.ok(usage.join('\n').endsWith('exit codes: 0 ok · 1 regression · 2 refused comparison · 64 usage · 65 invalid input · 70 internal error'));
  // Forced: the printer fails, on a command that would exit 0 and on one that would exit 1.
  const demo = ['gate', '--baseline', ex('refund-bot', 'baseline.json'), '--candidate', ex('refund-bot', 'candidate.json'), '--bar', ex('refund-bot', 'bar.json'), '--allow-differ', 'systemModelServed,systemCallShapeHash'];
  assert.equal(run(...demo).status, 1);
  for (const argv of [['--help'], demo, [...demo, '--json'], ['flips', '--run', ex('refund-bot', 'judged.json')]]) {
    for (const thrown of [new Error('the pipe closed\n    at somewhere (file.ts:1:1)'), new RangeError('Maximum call stack size exceeded'), 'a string']) {
      const err: string[] = [];
      const status = main(argv, {
        out: () => {
          throw thrown;
        },
        err: (s) => err.push(s),
      });
      assert.equal(status, 70, argv.join(' '));
      assert.equal(err.length, 1);
      assert.equal(err[0], `anchorset: internal error: ${thrown instanceof Error ? thrown.message.replace(/\s*\n\s*/g, ' ') : thrown}`);
      assert.ok(!(err[0] as string).includes('\n'));
    }
  }
  // study-check has the same rule: its exit 1 means "a cell differs".
  const good: string[] = [];
  assert.equal(studyCheck([ex('judge-change', 'manifest.json')], { out: (s) => good.push(s), err: () => undefined }), 0);
  assert.ok(good.length > 0);
  const err: string[] = [];
  const status = studyCheck([ex('judge-change', 'manifest.json')], {
    out: () => {
      throw new TypeError('not foreseen\nsecond line');
    },
    err: (s) => err.push(s),
  });
  assert.deepEqual([status, err], [70, ['internal error: not foreseen second line']]);
});
