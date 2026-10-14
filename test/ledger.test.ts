import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { agreementReport } from '../src/agreement.ts';
import { driftReport } from '../src/drift.ts';
import { InputError } from '../src/errors.ts';
import { canonicalJson, hashOf, sha256Hex } from '../src/identity.ts';
import { appendRecord, checkLedgerFile, makeGateRecord, makeRatingsRecord, readLedger, validateRecord } from '../src/ledger.ts';
import { REPORT_SCHEMAS, TOOL_NAME, TOOL_VERSION } from '../src/version.ts';
import { gateInputs, makeIdentity, makeJudgedIdentity } from './helpers.ts';

const dir = mkdtempSync(join(tmpdir(), 'anchorset-ledger-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const rec = (n: number) => makeGateRecord({ inputs: gateInputs(), result: { exitCode: 0, n }, at: new Date('2026-01-02T03:04:05.000Z') });

test('appendRecord creates directories and appends canonical JSON lines; readLedger reads them back', () => {
  const path = join(dir, 'nested', 'deeper', 'ledger.jsonl');
  appendRecord(path, rec(1));
  appendRecord(path, rec(2));
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], canonicalJson(rec(1)));
  const back = readLedger(path);
  assert.deepEqual(back, [rec(1), rec(2)]);
  assert.equal(back[0]?.inputsHash.length, 64);
  assert.equal(back[0]?.tool.name, 'anchorset');
});

test('validateRecord rejects missing identity fields, any null, and a result that does not match its hash', () => {
  assert.deepEqual(validateRecord(rec(1)), []);
  const { seed: _s, ...identity } = makeIdentity();
  assert.ok(validateRecord({ ...rec(1), identity }).some((p) => p.includes('seed')));
  assert.ok(validateRecord({ ...rec(1), result: { exitCode: 0, n: null } }).some((p) => p.includes('null')));
  assert.ok(validateRecord({ ...rec(1), result: { exitCode: 1, n: 1 } }).some((p) => p.includes('resultHash')));
  assert.ok(validateRecord({ ...rec(1), kind: 'other' }).some((p) => p.includes('kind')));
  assert.ok(validateRecord({ ...rec(1), at: 'yesterday' }).some((p) => p.includes('at')));
  assert.throws(() => appendRecord(join(dir, 'x.jsonl'), { ...rec(1), inputsHash: 'short' }), InputError);
});

test('a later edit of a record is found when its hashes are stale, and a removed line is not found (the ledger is not chained)', () => {
  const path = join(dir, 'edited.jsonl');
  appendRecord(path, rec(1));
  appendRecord(path, rec(2));
  appendRecord(path, rec(3));
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  // An edit of the result that leaves resultHash as it was: invalid, on reading and on appending.
  const edited = lines.map((l, i) => (i === 1 ? l.replace('"n":2', '"n":9') : l));
  assert.notEqual(edited[1], lines[1]);
  const editedPath = join(dir, 'edited-stale.jsonl');
  writeFileSync(editedPath, `${edited.join('\n')}\n`);
  assert.throws(() => readLedger(editedPath), (e: unknown) => e instanceof InputError && e.code === 'INVALID_LEDGER' && e.problems.some((p) => p.startsWith('line 2:') && p.includes('resultHash')));
  const before = readFileSync(editedPath, 'utf8');
  assert.throws(() => appendRecord(editedPath, rec(4)), (e: unknown) => e instanceof InputError && e.code === 'INVALID_LEDGER' && e.problems.some((p) => p.includes('resultHash')));
  assert.equal(readFileSync(editedPath, 'utf8'), before);
  // A removed line leaves a ledger that reads and extends as any other: nothing chains the lines.
  const removedPath = join(dir, 'edited-removed.jsonl');
  writeFileSync(removedPath, `${[lines[0], lines[2]].join('\n')}\n`);
  assert.deepEqual(readLedger(removedPath), [rec(1), rec(3)]);
  appendRecord(removedPath, rec(4));
  assert.deepEqual(readLedger(removedPath), [rec(1), rec(3), rec(4)]);
});

test('readLedger reports the bad line number', () => {
  const path = join(dir, 'bad.jsonl');
  appendRecord(path, rec(1));
  appendFileSync(path, '{"not":"a record"}\n');
  assert.throws(() => readLedger(path), (e: unknown) => e instanceof InputError && e.problems.every((p) => p.startsWith('line 2:')));
  const path2 = join(dir, 'garbled.jsonl');
  appendFileSync(path2, 'not json\n');
  assert.throws(() => readLedger(path2), (e: unknown) => e instanceof InputError && e.problems[0] === 'line 1: not valid JSON');
});

test('a ledger line that gives a key twice is unreadable, like any malformed line: the line, the key and its place are named, and nothing is appended', () => {
  const exactly = (f: () => unknown, problems: string[]): void => {
    assert.throws(f, (e: unknown) => {
      assert.ok(e instanceof InputError && e.code === 'INVALID_LEDGER', String(e));
      assert.deepEqual(e.problems, problems);
      return true;
    });
  };
  const good = canonicalJson(rec(1));
  // The record's own value comes last each time, so JSON.parse reads the record that was written, and it validates.
  const top = good.replace(/^\{/, '{"kind":"drift",');
  const nested = good.replace('"result":{', '"result":{"exitCode":1,');
  const escaped = good.replace(/^\{/, '{"\\u0061t":"2020-01-01T00:00:00.000Z",');
  for (const line of [top, nested, escaped]) {
    assert.notEqual(line, good);
    assert.deepEqual(JSON.parse(line), rec(1));
  }
  const path = join(dir, 'twice.jsonl');
  writeFileSync(path, `${good}\n${top}\n`);
  exactly(() => readLedger(path), ['line 2: the key "kind" is given twice in the top-level object']);
  exactly(() => checkLedgerFile(path), [`${path}: line 2: the key "kind" is given twice in the top-level object`]);
  exactly(() => appendRecord(path, rec(2)), [`${path}: line 2: the key "kind" is given twice in the top-level object`]);
  assert.equal(readFileSync(path, 'utf8'), `${good}\n${top}\n`);
  writeFileSync(path, `${nested}\n`);
  exactly(() => readLedger(path), ['line 1: the key "exitCode" is given twice in the object at /result']);
  writeFileSync(path, `${escaped}\n`);
  exactly(() => readLedger(path), ['line 1: the key "at" is given twice in the top-level object']);
  // The same key in two records is no repeat: each line is its own text.
  writeFileSync(path, `${good}\n${good}\n`);
  assert.deepEqual(readLedger(path), [rec(1), rec(1)]);
  // A line that is not JSON keeps its own message, also when a key is repeated in it.
  writeFileSync(path, `${top.slice(0, 40)}\n`);
  exactly(() => readLedger(path), ['line 1: not valid JSON']);
});

test('every ledger record names its schema', () => {
  assert.equal(rec(1).schema, 'anchorset.ledger/v3');
  const { schema: _schema, ...unversioned } = rec(1);
  assert.ok(validateRecord(unversioned).some((p) => p.includes('record.schema')));
  // Any other schema string, an earlier version's included, gets the one plain message.
  for (const other of ['anchorset.ledger/v0', 'anchorset.ledger/v1', 'anchorset.ledger/v2', 'anchorset.ledger/v4']) {
    assert.deepEqual(validateRecord({ ...rec(1), schema: other }).filter((p) => p.startsWith('record.schema')), ['record.schema: must be "anchorset.ledger/v3"'], other);
  }
});

test('appendRecord says where the record went: its line and the sha256 of that line', () => {
  const path = join(dir, 'position.jsonl');
  assert.deepEqual(appendRecord(path, rec(1)), { line: 1, recordHash: hashOf(rec(1)) });
  assert.deepEqual(appendRecord(path, rec(2)), { line: 2, recordHash: hashOf(rec(2)) });
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  assert.equal(sha256Hex(lines[1] as string), hashOf(rec(2)));
});

test('appendRecord refuses a file it cannot fully read, and leaves it byte-identical', () => {
  const cases: [string, string][] = [
    ['garbled first line', '{"schema": "anchor'],
    ['a foreign record after a valid one', `${canonicalJson(rec(1))}\n${JSON.stringify({ schema: 'someone-else/v1', note: 'x' })}\n`],
    ['an empty line in the middle', `${canonicalJson(rec(1))}\n\n${canonicalJson(rec(2))}\n`],
    ['a JSON null', 'null\n'],
  ];
  for (const [name, content] of cases) {
    const path = join(dir, `bad-${name.replace(/ /g, '-')}.jsonl`);
    writeFileSync(path, content);
    const before = readFileSync(path);
    assert.throws(() => appendRecord(path, rec(3)), (e: unknown) => e instanceof InputError && e.code === 'INVALID_LEDGER', name);
    assert.deepEqual(readFileSync(path), before, name);
  }
});

const invalidLedger = (f: () => unknown, fragment: string | RegExp): void => {
  assert.throws(f, (e: unknown) => {
    assert.ok(e instanceof InputError && e.code === 'INVALID_LEDGER', String(e));
    assert.ok(e.problems.some((p) => (typeof fragment === 'string' ? p.includes(fragment) : fragment.test(p))), e.problems.join(' | '));
    return true;
  });
};

test('a non-empty ledger whose last byte is not a newline is refused, and the valid record it holds is not damaged', () => {
  // One valid record, written without its newline. An append would land on the same line: both records unreadable.
  const path = join(dir, 'unterminated.jsonl');
  writeFileSync(path, canonicalJson(rec(1)));
  const before = readFileSync(path);
  invalidLedger(() => checkLedgerFile(path), 'unterminated.jsonl: line 1: the file does not end with a newline');
  invalidLedger(() => appendRecord(path, rec(2)), 'the file does not end with a newline');
  invalidLedger(() => readLedger(path), 'line 1: the file does not end with a newline');
  assert.deepEqual(readFileSync(path), before);
  // The record is still there, whole: once the newline is restored it reads back, and the next record goes on line 2.
  writeFileSync(path, `${canonicalJson(rec(1))}\n`);
  assert.deepEqual(readLedger(path), [rec(1)]);
  assert.deepEqual(appendRecord(path, rec(2)), { line: 2, recordHash: hashOf(rec(2)) });
  assert.deepEqual(readLedger(path), [rec(1), rec(2)]);
  // Two records, the second unterminated: the line named is the last one.
  const two = join(dir, 'unterminated-two.jsonl');
  writeFileSync(two, `${canonicalJson(rec(1))}\n${canonicalJson(rec(2))}`);
  invalidLedger(() => checkLedgerFile(two), 'line 2: the file does not end with a newline');
  // A cut-short last line is named for what it is first: not valid JSON.
  const cut = join(dir, 'cut.jsonl');
  writeFileSync(cut, `${canonicalJson(rec(1))}\n${canonicalJson(rec(2)).slice(0, 40)}`);
  invalidLedger(() => checkLedgerFile(cut), 'line 2: not valid JSON');
  // An empty file holds no record and is fine; so is a file that does not exist yet.
  const empty = join(dir, 'empty.jsonl');
  writeFileSync(empty, '');
  assert.equal(checkLedgerFile(empty), 0);
  assert.deepEqual(appendRecord(empty, rec(1)), { line: 1, recordHash: hashOf(rec(1)) });
  assert.equal(checkLedgerFile(join(dir, 'not-yet', 'ledger.jsonl')), 0);
  assert.ok(!existsSync(join(dir, 'not-yet')), 'a check creates nothing');
});

test('a ledger path that is not a regular file is refused: a device that keeps nothing, and a directory', { skip: process.platform === 'win32' && 'no /dev/null' }, () => {
  // /dev/null takes every byte and keeps none: a record "appended" there is a record nobody can read.
  assert.ok(statSync('/dev/null').isCharacterDevice());
  invalidLedger(() => checkLedgerFile('/dev/null'), '/dev/null: is not a regular file');
  invalidLedger(() => appendRecord('/dev/null', rec(1)), '/dev/null: is not a regular file');
  const asDir = join(dir, 'a-directory');
  mkdirSync(asDir);
  invalidLedger(() => checkLedgerFile(asDir), 'a-directory: is a directory');
  invalidLedger(() => appendRecord(asDir, rec(1)), 'a-directory: is a directory');
  // A path under a file.
  const file = join(dir, 'plain.txt');
  writeFileSync(file, 'x');
  invalidLedger(() => checkLedgerFile(join(file, 'ledger.jsonl')), 'a parent of this path is a file, not a directory');
});

test('a ledger this process may not write to is refused by the check, not after the measurement', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'needs POSIX permissions and a user who is not root' }, () => {
  const readOnly = join(dir, 'read-only.jsonl');
  writeFileSync(readOnly, `${canonicalJson(rec(1))}\n`);
  chmodSync(readOnly, 0o444);
  invalidLedger(() => checkLedgerFile(readOnly), /read-only\.jsonl: EACCES/);
  assert.deepEqual(readLedger(readOnly), [rec(1)]);
  // A file that does not exist yet, in a folder nothing can be added to; and under a folder that does not exist in one.
  const locked = join(dir, 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0o555);
  try {
    invalidLedger(() => checkLedgerFile(join(locked, 'ledger.jsonl')), /ledger\.jsonl: EACCES/);
    invalidLedger(() => checkLedgerFile(join(locked, 'deeper', 'still', 'ledger.jsonl')), /ledger\.jsonl: EACCES/);
  } finally {
    chmodSync(locked, 0o755);
  }
});

// --- agreement and drift records: bound to the rating files by sha256 and to the resampling seed, never to a run identity ---
const AT = new Date('2026-01-02T03:04:05.000Z');
const bytes = (x: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(x, null, 2)}\n`);
const items = ['i1', 'i2', 'i3', 'i4'];
const packetOf = Object.fromEntries(items.map((i) => [i, hashOf({ packet: i })]));
const ratingsJson = { schema: 'anchorset.ratings/v1', categories: ['x', 'y'], ratings: { a: { i1: 'x', i2: 'x', i3: 'y', i4: 'y' }, b: { i1: 'x', i2: 'y', i3: 'y', i4: 'y' } }, packetHashes: { a: packetOf, b: packetOf }, bootstrap: { iterations: 50, seed: 4 } };
// What the command prints and records: the report under its contract string and the tool.
const contract = (schema: string) => ({ schema, tool: { name: TOOL_NAME, version: TOOL_VERSION } });
const agreement = () => ({ ...contract(REPORT_SCHEMAS.agree), ...agreementReport(ratingsJson.ratings, { packetHashes: ratingsJson.packetHashes, categories: ratingsJson.categories, bootstrap: ratingsJson.bootstrap }) });
const oldJson = { schema: 'anchorset.anchor/v1', labels: ['x', 'y'], verdicts: ratingsJson.ratings.a, packetHashes: packetOf };
const newJson = { schema: 'anchorset.anchor/v1', labels: ['x', 'y'], verdicts: ratingsJson.ratings.b, packetHashes: packetOf };
const drift = () => ({ ...contract(REPORT_SCHEMAS.drift), ...driftReport(new Map(Object.entries(oldJson.verdicts)), new Map(Object.entries(newJson.verdicts)), { labels: oldJson.labels, flagLabels: ['y'], packetHashes: { old: new Map(Object.entries(packetOf)), new: new Map(Object.entries(packetOf)) }, bootstrap: { iterations: 50, seed: 6 } }) });
const agreementRecord = () => makeRatingsRecord({ kind: 'agreement', ratingsFile: bytes(ratingsJson), report: agreement(), at: AT });
const driftRecord = () => makeRatingsRecord({ kind: 'drift', oldFile: bytes(oldJson), newFile: bytes(newJson), report: drift(), at: AT });
/** The record with its binding changed and inputsHash recomputed, so only the binding's own problem is left. */
const rebind = (record: Record<string, unknown>, change: (m: Record<string, unknown>) => unknown): Record<string, unknown> => {
  const measurement = change(record['measurement'] as Record<string, unknown>);
  return { ...record, measurement, inputsHash: hashOf(measurement) };
};
const problem = (record: unknown, fragment: string): void => {
  const problems = validateRecord(record);
  assert.ok(problems.some((p) => p.includes(fragment)), `${fragment} not in: ${problems.join(' | ')}`);
};

test('an agreement record binds the report to the ratings file by its full sha256 and to the bootstrap seed, and carries no run identity', () => {
  const record = agreementRecord();
  assert.deepEqual(validateRecord(record), []);
  assert.equal(record.kind, 'agreement');
  assert.deepEqual(record.measurement, { files: [{ role: 'ratings', sha256: sha256Hex(bytes(ratingsJson)) }], seeds: { bootstrap: { iterations: 50, seed: 4, alpha: 0.05 } } });
  // The result is the report itself: a reader holding the file recomputes the report and compares one hash.
  assert.deepEqual(record.result, agreement());
  assert.equal(record.resultHash, hashOf(agreement()));
  assert.equal(record.inputsHash, hashOf(record.measurement));
  assert.ok(!('identity' in record));
  // One ledger, one schema: it sits beside a gate record.
  const path = join(dir, 'ratings', 'ledger.jsonl');
  assert.deepEqual(appendRecord(path, record), { line: 1, recordHash: hashOf(record) });
  appendRecord(path, rec(1));
  appendRecord(path, driftRecord());
  assert.deepEqual(readLedger(path).map((r) => r.kind), ['agreement', 'gate', 'drift']);
  assert.deepEqual(readLedger(path)[0], record);
});

test('a drift record binds the old and the new anchor file, in that order whatever their hashes, with the seed and the flagged labels', () => {
  const record = driftRecord();
  assert.deepEqual(validateRecord(record), []);
  assert.deepEqual(record.measurement, {
    files: [{ role: 'anchor-old', sha256: sha256Hex(bytes(oldJson)) }, { role: 'anchor-new', sha256: sha256Hex(bytes(newJson)) }],
    seeds: { bootstrap: { iterations: 50, seed: 6, alpha: 0.05 } },
    flagLabels: ['y'],
  });
  assert.deepEqual(record.result, drift());
  assert.equal(record.inputsHash, hashOf(record.measurement));
  // The roles are swapped with the files: the binding of new-against-old is another binding.
  const swapped = makeRatingsRecord({ kind: 'drift', oldFile: bytes(newJson), newFile: bytes(oldJson), report: drift(), at: AT });
  assert.notEqual(swapped.inputsHash, record.inputsHash);
});

test('an agreement or drift record with a short or missing hash, another role, another order, or a run identity is refused', () => {
  const a = agreementRecord() as unknown as Record<string, unknown>;
  const d = driftRecord() as unknown as Record<string, unknown>;
  const files = (m: Record<string, unknown>): { role: string; sha256: string }[] => m['files'] as { role: string; sha256: string }[];
  problem(rebind(a, (m) => ({ ...m, files: [{ role: 'ratings', sha256: files(m)[0]?.sha256.slice(0, 12) }] })), 'record.measurement.files[0].sha256: must be the full sha256 of the file');
  problem(rebind(a, (m) => ({ ...m, files: [{ role: 'ratings', sha256: 'UNKNOWN' }] })), 'record.measurement.files[0].sha256');
  problem(rebind(a, (m) => ({ ...m, files: [{ role: 'run', sha256: files(m)[0]?.sha256 }] })), 'record.measurement.files: must be exactly [ratings]');
  problem(rebind(a, (m) => ({ ...m, files: [] })), 'record.measurement.files: must be exactly [ratings]');
  problem(rebind(a, (m) => ({ ...m, files: [...files(m), ...files(m)] })), 'record.measurement.files: must be exactly [ratings]');
  problem(rebind(d, (m) => ({ ...m, files: [...files(m)].reverse() })), 'record.measurement.files: must be exactly [anchor-old, anchor-new]');
  problem(rebind(d, (m) => ({ ...m, files: files(m).slice(0, 1) })), 'record.measurement.files: must be exactly [anchor-old, anchor-new]');
  problem(rebind(a, (m) => ({ ...m, planHash: 'a'.repeat(64) })), 'record.measurement.planHash: unknown field');
  problem(rebind(a, (m) => ({ ...m, flagLabels: ['y'] })), 'record.measurement.flagLabels: unknown field');
  const { measurement: _m, ...bare } = a;
  problem(bare, 'record.measurement: must be { files, seeds }');
  const { measurement: _dm, ...bareDrift } = d;
  problem(bareDrift, 'record.measurement: must be { files, seeds, flagLabels }');
  // A run identity on such a record is the earlier shape of v3: refused, with the pointer.
  problem({ ...a, identity: makeIdentity() }, 'record.identity: an agreement or drift record carries "measurement" (file hashes and seeds), not a run identity');
  const { measurement: _x, ...asRun } = a;
  problem({ ...asRun, identity: makeIdentity() }, 'record.measurement: must be { files, seeds }');
  problem({ ...a, inputsHash: 'f'.repeat(64) }, 'record.inputsHash: does not match hashOf(measurement)');
  problem({ ...a, resultHash: 'short' }, 'record.resultHash: must be a full sha256 hex');
  assert.throws(() => appendRecord(join(dir, 'never', 'ledger.jsonl'), { ...a, resultHash: 'short' } as never), (e: unknown) => e instanceof InputError && e.code === 'INVALID_LEDGER');
  assert.ok(!existsSync(join(dir, 'never')));
});

test('an agreement or drift record whose seed or flagged labels contradict the report it carries is refused', () => {
  const a = agreementRecord() as unknown as Record<string, unknown>;
  const d = driftRecord() as unknown as Record<string, unknown>;
  problem(rebind(a, (m) => ({ ...m, seeds: { bootstrap: { iterations: 50, seed: 5, alpha: 0.05 } } })), 'record.measurement.seeds.bootstrap: differs from result.bootstrap');
  problem(rebind(a, (m) => ({ ...m, seeds: { bootstrap: { iterations: 50, seed: -1, alpha: 0.05 } } })), 'record.measurement.seeds.bootstrap: must be { iterations, seed, alpha }');
  problem(rebind(a, (m) => ({ ...m, seeds: {} })), 'record.measurement.seeds.bootstrap: must be { iterations, seed, alpha }');
  problem(rebind(d, (m) => ({ ...m, flagLabels: ['x'] })), 'record.measurement.flagLabels: differs from result.flagLabels');
  problem(rebind(d, (m) => ({ ...m, flagLabels: [] })), 'record.measurement.flagLabels: must be a non-empty list of labels');
  // A report of the other kind under this kind's name.
  const result = d['result'] as Record<string, unknown>;
  problem({ ...a, result, resultHash: hashOf(result) }, 'record.result: must be the agreement report');
  const aResult = a['result'] as Record<string, unknown>;
  problem(rebind({ ...d, result: aResult, resultHash: hashOf(aResult) }, (m) => m), 'record.result: must be the drift report');
  // An interval of the report drawn under another seed than the report states.
  const edited = { ...aResult, kappaCI: { ...(aResult['kappaCI'] as Record<string, unknown>), seed: 9 } };
  problem({ ...a, result: edited, resultHash: hashOf(edited) }, 'record.result.kappaCI: its seed, iterations or alpha differ from result.bootstrap');
});

test('makeRatingsRecord refuses a report it cannot hash', () => {
  const broken = { ...agreement(), percentAgreement: Number.NaN };
  assert.throws(() => makeRatingsRecord({ kind: 'agreement', ratingsFile: bytes(ratingsJson), report: broken, at: AT }), (e: unknown) => e instanceof InputError && e.code === 'INVALID_LEDGER' && e.problems.some((p) => p.includes('cannot be hashed')));
});

// --- gate records: the inputs of the verdict are on the record, so it can be traced to the files and flags that gave it ---
const GATE_AT = new Date('2026-01-02T03:04:05.000Z');
const gateRecord = (inputs = gateInputs(), result: Record<string, unknown> = { exitCode: 0 }) => makeGateRecord({ inputs, result, at: GATE_AT });
/** The gate record with its inputs changed and inputsHash recomputed, so only the inputs' own problem is left. */
const reinput = (record: Record<string, unknown>, change: (i: Record<string, unknown>) => unknown): Record<string, unknown> => {
  const inputs = change(record['inputs'] as Record<string, unknown>);
  return { ...record, inputs, inputsHash: hashOf(inputs) };
};
/** The object without one key (a canonical hash has no undefined). */
const omit = (o: unknown, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(o as Record<string, unknown>).filter(([k]) => k !== key));
const REJUDGED = (): ReturnType<typeof gateInputs> => gateInputs({ baseline: makeJudgedIdentity(), candidate: makeJudgedIdentity(), rejudgeOf: makeJudgedIdentity({ judgeModelServed: 'judge-2025-01-01' }), bootstrap: { iterations: 100, seed: 5, alpha: 0.05 } });

test('a gate record carries its inputs: both identities, the bar hash, the waived fields, and the re-judge bootstrap', () => {
  const baseline = makeIdentity({ systemModelServed: 'model-x-2025-01-01' });
  const candidate = makeIdentity();
  const inputs = gateInputs({ baseline, candidate, barHash: hashOf('a bar'), allowDiffer: ['systemModelServed'] });
  const record = gateRecord(inputs);
  assert.deepEqual(Object.keys(record).sort(), ['at', 'identity', 'inputs', 'inputsHash', 'kind', 'result', 'resultHash', 'schema', 'tool']);
  assert.deepEqual(record.inputs, inputs);
  assert.deepEqual(record.identity, candidate);
  assert.equal(record.inputsHash, hashOf(inputs));
  assert.deepEqual(validateRecord(record), []);
  const rejudged = gateRecord(REJUDGED());
  assert.deepEqual(validateRecord(rejudged), []);
  assert.equal(rejudged.inputs.bootstrap?.seed, 5);
});

test('a gate record whose inputs are missing, extra or malformed is invalid, each problem named', () => {
  const record = gateRecord() as unknown as Record<string, unknown>;
  const { inputs: _inputs, ...without } = record;
  const shape = 'record.inputs: must be { baseline, candidate, barHash, allowDiffer }, with rejudgeOf and bootstrap for a gate against a re-judged baseline';
  problem(without, shape);
  problem({ ...record, inputs: [] }, shape);
  problem(reinput(record, (i) => ({ ...i, note: 'x' })), 'record.inputs.note: unknown field');
  problem(reinput(record, (i) => ({ ...i, baseline: omit(i['baseline'], 'seed') })), 'record.inputs.baseline.seed: missing');
  problem(reinput(record, (i) => ({ ...i, candidate: 'x' })), 'record.inputs.candidate: must be an object');
  problem(reinput(record, (i) => ({ ...i, barHash: 'abc' })), 'record.inputs.barHash: must be a full sha256');
});

test('a gate record lists the waived fields once each, in the order of the identity fields', () => {
  const record = gateRecord(gateInputs({ allowDiffer: ['systemModelServed', 'systemCallShapeHash'] })) as unknown as Record<string, unknown>;
  assert.deepEqual(validateRecord(record), []);
  const wording = 'record.inputs.allowDiffer: must list identity fields, each once, in the order of the identity\'s fields';
  problem(reinput(record, (i) => ({ ...i, allowDiffer: ['systemCallShapeHash', 'systemModelServed'] })), wording);
  problem(reinput(record, (i) => ({ ...i, allowDiffer: ['systemModelServed', 'systemModelServed'] })), wording);
  problem(reinput(record, (i) => ({ ...i, allowDiffer: ['colour'] })), wording);
  problem(reinput(record, (i) => ({ ...i, allowDiffer: 'systemModelServed' })), wording);
  problem(reinput(record, (i) => omit(i, 'allowDiffer')), wording);
});

test('a gate record against a re-judged baseline names that baseline and its bootstrap together, and waives no judge field', () => {
  const record = gateRecord(REJUDGED()) as unknown as Record<string, unknown>;
  problem(reinput(record, (i) => omit(i, 'bootstrap')), 'record.inputs: rejudgeOf and bootstrap come together');
  problem(reinput(record, (i) => omit(i, 'rejudgeOf')), 'record.inputs: rejudgeOf and bootstrap come together');
  problem(reinput(record, (i) => ({ ...i, rejudgeOf: omit(i['rejudgeOf'], 'seed') })), 'record.inputs.rejudgeOf.seed: missing');
  const shape = 'record.inputs.bootstrap: must be { iterations, seed, alpha } with a uint32 seed, a positive number of resamples and alpha in (0, 1)';
  for (const bad of [{ iterations: 0, seed: 5, alpha: 0.05 }, { iterations: 100, seed: -1, alpha: 0.05 }, { iterations: 100, seed: 5, alpha: 1 }, { iterations: 100, seed: 5 }, { iterations: 100, seed: 5, alpha: 0.05, extra: 1 }]) {
    problem(reinput(record, (i) => ({ ...i, bootstrap: bad })), shape);
  }
  problem(reinput(record, (i) => ({ ...i, allowDiffer: ['judgeModelServed'] })), 'record.inputs.allowDiffer: judgeModelServed cannot be allowed to differ on a gate');
  // Nor is it valid on a gate with no re-judged baseline: no gate waives a judge field.
  problem(reinput(gateRecord() as unknown as Record<string, unknown>, (i) => ({ ...i, allowDiffer: ['judgeModelRequested', 'judgeModelServed'] })), 'record.inputs.allowDiffer: judgeModelRequested, judgeModelServed cannot be allowed to differ on a gate');
  // Nor the draw count: the fold is worst-of-N, so a record of a gate that waived it is not a record of a gate.
  problem(reinput(gateRecord() as unknown as Record<string, unknown>, (i) => ({ ...i, allowDiffer: ['drawsPerCase'] })), 'record.inputs.allowDiffer: drawsPerCase cannot be allowed to differ on a gate');
});

test('a gate record agrees with itself: the identity is the candidate, inputsHash is the hash of the inputs, the re-judge seed is the result\'s', () => {
  const record = gateRecord() as unknown as Record<string, unknown>;
  problem({ ...record, identity: makeIdentity({ systemModelServed: 'model-y' }) }, 'record.identity: differs from record.inputs.candidate');
  problem({ ...record, inputs: { ...(record['inputs'] as object), allowDiffer: ['systemModelServed'] } }, 'record.inputsHash: does not match hashOf(inputs)');
  const control = { seed: 5, iterations: 100, alpha: 0.05 };
  const rejudged = gateRecord(REJUDGED(), { exitCode: 0, judgeControl: control }) as unknown as Record<string, unknown>;
  assert.deepEqual(validateRecord(rejudged), []);
  const refused = gateRecord(REJUDGED(), { exitCode: 0, judgeControl: { refused: 'MEASUREMENT_NOT_RUNNABLE', fields: [] } });
  assert.deepEqual(validateRecord(refused), []);
  const withControl = (result: Record<string, unknown>): Record<string, unknown> => ({ ...rejudged, result, resultHash: hashOf(result) });
  problem(withControl({ exitCode: 0, judgeControl: { ...control, seed: 6 } }), 'record.inputs.bootstrap: differs from result.judgeControl');
  problem(withControl({ exitCode: 0, judgeControl: { ...control, iterations: 99 } }), 'record.inputs.bootstrap: differs from result.judgeControl');
  // A judgeControl that is neither the refused form nor a full, numeric, matching seed is invalid, not skipped.
  const shape = 'record.result.judgeControl: must be { refused, fields } or { seed, iterations, alpha } as numbers';
  problem(withControl({ exitCode: 0, judgeControl: { seed: 6 } }), shape);
  problem(withControl({ exitCode: 0, judgeControl: 'x' }), shape);
  problem(withControl({ exitCode: 0, judgeControl: { seed: '6', iterations: 100, alpha: 0.05 } }), shape);
  problem(withControl({ exitCode: 0, judgeControl: { refused: 3, fields: [] } }), shape);
  // The refused form is exactly { refused, fields }: numbers beside it are a split that claims to be both.
  problem(withControl({ exitCode: 0, judgeControl: { refused: 'PACKET_MISMATCH', fields: [], judgeEffect: 0.3, systemEffect: 0 } }), shape);
  problem(withControl({ exitCode: 0, judgeControl: { refused: 'PACKET_MISMATCH' } }), shape);
  problem(withControl({ exitCode: 0, judgeControl: { refused: 'PACKET_MISMATCH', fields: [], seed: 5, iterations: 100, alpha: 0.05 } }), shape);
  problem(withControl({ exitCode: 0, judgeControl: { ...control, alpha: 0.1 } }), 'record.inputs.bootstrap: differs from result.judgeControl');
  const plain = gateRecord() as unknown as Record<string, unknown>;
  const plainResult = { exitCode: 0, judgeControl: control };
  problem({ ...plain, result: plainResult, resultHash: hashOf(plainResult) }, 'record.result.judgeControl: present, but record.inputs names no re-judged baseline');
});

test('makeGateRecord refuses inputs that do not validate, and a ledger line in the old gate shape is unreadable', () => {
  assert.throws(
    () => makeGateRecord({ inputs: gateInputs({ allowDiffer: ['systemModelServed', 'systemModelServed'] }), result: {} }),
    (e: unknown) => e instanceof InputError && e.code === 'INVALID_LEDGER' && e.problems.some((p) => p.includes('record.inputs.allowDiffer')),
  );
  // The same allowDiffer array handed to gateRuns, in any order, is stored in the one canonical order; a set has no order of its own.
  const swapped = makeGateRecord({ inputs: gateInputs({ allowDiffer: ['systemCallShapeHash', 'systemModelServed'] }), result: {}, at: GATE_AT });
  assert.deepEqual((swapped.inputs as { allowDiffer: string[] }).allowDiffer, ['systemModelServed', 'systemCallShapeHash']);
  assert.deepEqual(validateRecord(swapped), []);
  // Ordering is not coercion: a field named twice or a name that is no identity field is still refused.
  assert.throws(() => makeGateRecord({ inputs: gateInputs({ allowDiffer: ['colour', 'systemModelServed'] as never }), result: {} }), (e: unknown) => e instanceof InputError && e.code === 'INVALID_LEDGER');
  // Inputs a JavaScript caller left out are a refusal of the record, not a TypeError.
  for (const inputs of [undefined, null, 3, []]) {
    assert.throws(() => makeGateRecord({ inputs: inputs as never, result: {} }), (e: unknown) => e instanceof InputError && e.code === 'INVALID_LEDGER' && e.problems.some((p) => p.startsWith('record.inputs: must be')), String(inputs));
  }
  // The record of earlier builds: the candidate's identity and a hash of inputs that are not kept.
  const result = { exitCode: 0 };
  const old = { schema: 'anchorset.ledger/v3', at: GATE_AT.toISOString(), kind: 'gate', identity: makeIdentity(), inputsHash: hashOf({ n: 1 }), resultHash: hashOf(result), result, tool: { name: 'anchorset', version: '0.1.0' } };
  problem(old, 'record.inputs: must be { baseline, candidate, barHash, allowDiffer }');
  const path = join(dir, 'old-gate-shape.jsonl');
  writeFileSync(path, `${canonicalJson(old)}\n`);
  assert.throws(() => readLedger(path), (e: unknown) => e instanceof InputError && e.code === 'INVALID_LEDGER' && e.problems.every((p) => p.startsWith('line 1:')) && e.problems.some((p) => p.includes('record.inputs')));
  // The other kinds carry no inputs.
  problem({ ...(agreementRecord() as unknown as Record<string, unknown>), inputs: gateInputs() }, 'record.inputs: unknown field');
});
