// The reader of a flow directory (examples/importers/skill-evals/flow.ts). Every refusal test copies the example flow
// into a temp directory, makes one edit there, reads it, and asserts the code and the named fields. The example flow is
// written by hand: synthetic customer-support refund-bot data only.
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { GAP, outputHashOf, sha256Hex } from '../src/index.ts';
import { ImportRefusal, ImportUsageError, loadBar, parseCasesFile } from '../examples/importers/shared.ts';
import type { CasesFile, ImportRefusalCode } from '../examples/importers/shared.ts';
import { FlowRefusal, hasNoStateFile, HEADER_COUNT_BOUND, readFlow, readFlowFiles, ROW_PROFILE, slotLabel, validateFlow, variantNameProblem, wholeReps, wholeRepSlots } from '../examples/importers/skill-evals/flow.ts';
import { slotLabel as sharedSlotLabel } from '../examples/importers/shared.ts';
import type { FlowFiles, FlowRead } from '../examples/importers/skill-evals/flow.ts';

const dir = join(import.meta.dirname, '..', 'examples', 'importers', 'skill-evals');
const exampleFlow = join(dir, 'example-flow');
const cases: CasesFile = parseCasesFile(readFileSync(join(dir, 'cases.json'), 'utf8'), loadBar(readFileSync(join(dir, 'bar.json'), 'utf8')));
/** One stated case: its slots at the largest declared rep count are within the bound. */
const oneCase: CasesFile = { 'bank-dispute': cases['bank-dispute'] as CasesFile[string] };
const work = mkdtempSync(join(tmpdir(), 'anchorset-skill-flow-'));
after(() => rmSync(work, { recursive: true, force: true }));

// ---- helpers --------------------------------------------------------------------------------------------------------

// A row and a trace are the source's own loose JSON; the edits below are by key, so the tests use an untyped view.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
let counter = 0;
/** A fresh copy of the example flow; returns its path. */
function copy(): string {
  counter += 1;
  const to = join(work, `flow-${counter}`);
  cpSync(exampleFlow, to, { recursive: true });
  return to;
}
const resultsPath = (flow: string, variant = 'baseline'): string => join(flow, variant, 'results.jsonl');
const errorsPath = (flow: string): string => join(flow, 'baseline', 'errors.jsonl');
const tracePath = (flow: string, id: string, rep: number): string => join(flow, 'baseline', 'traces', `${id}_rep${rep}.json`);
const statePath = (flow: string): string => join(flow, '_state.json');
const rowsOf = (flow: string): J[] => readFileSync(resultsPath(flow), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
const writeRows = (flow: string, rows: readonly J[]): void => writeFileSync(resultsPath(flow), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
/** Edits the rows of a copy in place; `edit` may change, drop or add rows. */
function editRows(flow: string, edit: (rows: J[]) => J[] | void): void {
  const rows = rowsOf(flow);
  writeRows(flow, edit(rows) ?? rows);
}
const rowOf = (rows: J[], id: string, rep: number): J => {
  const r = rows.find((x) => x.prompt_id === id && x.rep === rep);
  assert.ok(r, `no row ${id}#${rep}`);
  return r;
};
function editTrace(flow: string, id: string, rep: number, edit: (turns: J[]) => J | void): void {
  const turns: J[] = JSON.parse(readFileSync(tracePath(flow, id, rep), 'utf8'));
  writeFileSync(tracePath(flow, id, rep), `${JSON.stringify(edit(turns) ?? turns, null, 2)}\n`);
}
function editState(flow: string, edit: (state: J) => void): void {
  const state: J = JSON.parse(readFileSync(statePath(flow), 'utf8'));
  edit(state);
  writeFileSync(statePath(flow), `${JSON.stringify(state, null, 2)}\n`);
}

const read = (flow: string, over: { variant?: string; cases?: CasesFile; reps?: number } = {}): FlowRead => readFlow(flow, over.variant ?? 'baseline', over.cases ?? cases, over.reps ?? 2);

/** Reads a flow that must be refused; asserts the refusal's code and that every expected field is named. */
function refuse(flow: string, code: ImportRefusalCode, fields: readonly string[], over: { variant?: string; cases?: CasesFile; reps?: number } = {}): FlowRefusal {
  let caught: unknown;
  try {
    read(flow, over);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof FlowRefusal, `expected ${code}, but the flow was read or threw ${String(caught)}`);
  assert.ok(caught instanceof ImportRefusal, 'a flow refusal is an import refusal');
  assert.equal(caught.code, code, caught.message);
  assert.deepEqual([...caught.fields].sort(), [...fields].sort(), caught.message);
  assert.equal(caught.problems.length > 0, true);
  return caught;
}

/**
 * Reads a flow that must be READ (nothing in it refuses the flow whatever rep is graded), then takes one rep, which
 * must be refused as not whole; asserts the refusal's code and that exactly the expected fields are named.
 */
function refuseRep(flow: string, rep: number, code: ImportRefusalCode, fields: readonly string[], over: { variant?: string; cases?: CasesFile; reps?: number } = {}): FlowRefusal {
  const got = read(flow, over);
  let caught: unknown;
  try {
    wholeRepSlots(got, rep);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof FlowRefusal, `expected ${code} for rep ${rep}, but the rep was handed on or threw ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  assert.deepEqual([...caught.fields].sort(), [...fields].sort(), caught.message);
  assert.match(caught.message, new RegExp(`problem\\(s\\) in rep ${rep} of the flow, which is not whole`));
  return caught;
}

const SLOTS = ['bank-dispute#0', 'bank-dispute#1', 'clearance-organiser#0', 'clearance-organiser#1', 'faulty-headphones#0', 'faulty-headphones#1'];
const label = (s: { caseId: string; draw: number }): string => `${s.caseId}#${s.draw}`;

// ---- the good path --------------------------------------------------------------------------------------------------

test('the example flow reads: six slots in case-then-rep order, the two file hashes, one superseded error line', () => {
  const got = read(exampleFlow);
  assert.equal(got.variant, 'baseline');
  assert.equal(got.reps, 2);
  assert.equal(got.rowProfile, ROW_PROFILE);
  assert.equal(ROW_PROFILE, 'skill-evals/1');
  // The rows are on disk in the order faulty-headphones#0, bank-dispute#0, clearance-organiser#1, ...; the slots are sorted.
  assert.deepEqual(got.slots.map(label), SLOTS);
  // shasum -a 256 examples/importers/skill-evals/example-flow/baseline/results.jsonl
  assert.equal(got.resultsSha256, '3e2f58c097b50bf3b33416809f2c883fcb00c9e4134051ac21f7656367b245ec');
  // shasum -a 256 examples/importers/skill-evals/example-flow/_state.json
  assert.equal(got.stateSha256, 'cba1a721c135db10ed25ac4866e309861557eeefdb5ba98803cb7df06d4a34a7');
  const s = got.slots[0];
  assert.ok(s);
  assert.equal(s.prompt, 'Order A-09977, the standing desk. If the 420 USD is not back on my card by Friday I will dispute the charge with my bank.');
  assert.equal(s.answer, '{"action":"hand_off","reply":"I have passed order A-09977 to a colleague, who will write to you about the standing desk. I cannot decide this request myself, and I am not able to promise a date."}');
  // printf '%s' '<the answer above>' | shasum -a 256 : the hash is over the whole assistant turn, as stored.
  assert.equal(s.storedOutputSha256, 'f112bfc9f483891ead9b17c6c1dfbf701f99672fcdfd9899f4a5d79ff4095906');
  // shasum -a 256 examples/importers/skill-evals/example-flow/baseline/traces/bank-dispute_rep0.json : the file's bytes.
  assert.equal(s.traceSha256, 'c5a03b836026321480e717273a99851e89b2b7578940829c7f710710d1859dc1');
  for (const slot of got.slots) {
    assert.equal(slot.storedOutputSha256, sha256Hex(slot.answer));
    assert.equal(slot.traceSha256, sha256Hex(readFileSync(tracePath(exampleFlow, slot.caseId, slot.draw))));
    assert.deepEqual(Object.keys(slot).sort(), ['answer', 'caseId', 'draw', 'prompt', 'storedOutputSha256', 'traceSha256']);
  }
  // errors.jsonl line 1 is a failed first attempt at bank-dispute#1; the row for that slot was written after it.
  assert.deepEqual(got.superseded, [{ caseId: 'bank-dispute', draw: 1, line: 1 }]);
  assert.deepEqual(got.unusedTraces, []);
  // Both reps are whole, and the cases file names every case of the flow.
  assert.deepEqual(got.notWhole, []);
  assert.deepEqual(wholeReps(got), [0, 1]);
  assert.deepEqual(got.excluded, []);
  assert.equal(hasNoStateFile(got), false);
  assert.deepEqual(wholeRepSlots(got, 0).map(label), ['bank-dispute#0', 'clearance-organiser#0', 'faulty-headphones#0']);
  assert.deepEqual(wholeRepSlots(got, 1).map(label), ['bank-dispute#1', 'clearance-organiser#1', 'faulty-headphones#1']);
  // A rep that is not one of the declared reps is the caller's mistake, never an empty list of slots.
  for (const k of [2, -1, 0.5, Number.NaN]) assert.throws(() => wholeRepSlots(got, k), ImportUsageError);
  assert.equal(JSON.stringify(got).includes('null'), false, 'no null in what the reader returns');
});

test('each rep of a case is a fresh system output: two reps of one case hold different outputs and both are read (a rep is not a repeated grade of one output)', () => {
  const got = read(exampleFlow);
  for (const id of Object.keys(cases)) {
    const [a, b] = got.slots.filter((s) => s.caseId === id);
    assert.ok(a && b);
    assert.equal(a.prompt, b.prompt);
    assert.notEqual(a.answer, b.answer);
    assert.notEqual(a.storedOutputSha256, b.storedOutputSha256);
  }
});

test('two reps with the same output are accepted too', () => {
  const flow = copy();
  const first = JSON.parse(readFileSync(tracePath(flow, 'bank-dispute', 0), 'utf8'));
  editTrace(flow, 'bank-dispute', 1, () => first);
  const got = read(flow);
  assert.equal(got.slots[0]?.storedOutputSha256, got.slots[1]?.storedOutputSha256);
});

test('rows arrive in any order: every permutation tried gives the same slots, and only the file hash changes', () => {
  const base = read(exampleFlow);
  const orders: ((rows: J[]) => J[])[] = [(r) => [...r].reverse(), (r) => [...r].sort((a, b) => b.rep - a.rep), (r) => [...r.slice(3), ...r.slice(0, 3)]];
  for (const order of orders) {
    const flow = copy();
    editRows(flow, order);
    const got = read(flow);
    assert.deepEqual(got.slots, base.slots);
    assert.deepEqual(got.superseded, base.superseded);
    assert.notEqual(got.resultsSha256, base.resultsSha256);
  }
});

test('every key outside the five of the profile is ignored, present or absent', () => {
  const flow = copy();
  editRows(flow, (rows) => {
    for (const r of rows) {
      for (const k of ['tags', 'meta', 'model', 'usage', 'latency_s', 'grade', 'explanation', 'attachments']) delete r[k];
    }
    Object.assign(rows[0], { judge_model: 'example-judge-model', judge_usage: {}, reply_words: 31, grade: 'not even an object', anything: [1, 2] });
  });
  assert.deepEqual(read(flow).slots, read(exampleFlow).slots);
});

test('the pure validation runs on files held in memory, with no file system', () => {
  const files = readFlowFiles(exampleFlow, 'baseline');
  assert.deepEqual(validateFlow(files, 'baseline', cases, 2), read(exampleFlow));
  const noTrace: FlowFiles = { ...files, traces: new Map([...files.traces].filter(([name]) => name !== 'bank-dispute_rep1.json')) };
  assert.throws(() => validateFlow(noTrace, 'baseline', cases, 2), (e: unknown) => e instanceof FlowRefusal && e.fields.join() === 'bank-dispute#1');
});

test('a flow with no errors.jsonl reads, with no superseded line', () => {
  const flow = copy();
  rmSync(errorsPath(flow));
  assert.deepEqual(read(flow).superseded, []);
});

test('a trace file no row names is listed as unused and not refused', () => {
  const flow = copy();
  writeFileSync(join(flow, 'baseline', 'traces', 'old-case_rep0.json'), '[]\n');
  assert.deepEqual(read(flow).unusedTraces, ['old-case_rep0.json']);
});

// ---- the declared rep count -----------------------------------------------------------------------------------------

test('the declared rep count must be a positive integer: a usage error, not a refusal', () => {
  for (const reps of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
    assert.throws(() => read(exampleFlow, { reps }), ImportUsageError, String(reps));
  }
});

test('the pure validation holds the declared rep count itself, whoever calls it: a count that is not a positive integer is a usage error before any file is looked at', () => {
  const files = readFlowFiles(exampleFlow, 'baseline');
  for (const reps of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    assert.throws(() => validateFlow(files, 'baseline', cases, reps), (e: unknown) => e instanceof ImportUsageError && e.message === `USAGE: --reps must be a positive integer, found ${String(reps)}`, String(reps));
  }
  // Before anything else: files that would be refused are not reached.
  const none: FlowFiles = { flowDir: 'missing', variantDir: 'missing', tracesDir: 'missing', state: 'missing', results: 'missing', errors: 'missing', traces: new Map() };
  assert.throws(() => validateFlow(none, 'not a variant', cases, 0), ImportUsageError);
  assert.throws(() => validateFlow(none, 'baseline', cases, 2), FlowRefusal);
});

test('a flow directory that does not exist is a usage error', () => {
  assert.throws(() => read(join(work, 'no-such-flow')), ImportUsageError);
});

// ---- row 2: the variant name, symlinks, paths that leave the flow ---------------------------------------------------

test('a variant not named baseline or v<N> is refused before anything is read', () => {
  for (const name of ['', 'v0', 'v01', 'V1', 'Baseline', 'candidate', 'baseline/', '../baseline', 'baseline/../baseline', 'v1/..', '.', 'v-1', 'v1.0', ' v1']) {
    assert.notEqual(variantNameProblem(name), undefined, JSON.stringify(name));
    // The flow given does not exist: the name is refused without a look at the disk.
    assert.throws(() => readFlow(join(work, 'no-such-flow'), name, cases, 2), (e: unknown) => e instanceof FlowRefusal && e.code === 'IMPORT_PATH' && e.fields.join() === 'variant', JSON.stringify(name));
  }
  for (const name of ['baseline', 'v1', 'v2', 'v10', 'v123']) assert.equal(variantNameProblem(name), undefined, name);
});

test('a variant named v<N> reads as baseline does', () => {
  const flow = copy();
  renameSync(join(flow, 'baseline'), join(flow, 'v2'));
  const got = read(flow, { variant: 'v2' });
  assert.equal(got.variant, 'v2');
  assert.deepEqual(got.slots, read(exampleFlow).slots);
});

test('a variant directory that is not there is refused', () => {
  refuse(copy(), 'IMPORT_SHAPE', ['v1'], { variant: 'v1' });
});

test('a flow path that is a symlink is refused, with or without a trailing separator', () => {
  const flow = copy();
  const link = join(work, `link-${counter}`);
  symlinkSync(flow, link, 'dir');
  refuse(link, 'IMPORT_PATH', ['flow']);
  refuse(`${link}/`, 'IMPORT_PATH', ['flow']);
});

test('a flow path whose last segment is "." or ".." is refused: the look would be at a directory behind a symlink, never at the link', () => {
  const flow = copy();
  const link = join(work, `link-dot-${counter}`);
  symlinkSync(flow, link, 'dir');
  // Through the link: each of these reads the flow's files when the path is followed.
  for (const path of [`${link}/.`, `${link}/./`, `${link}/.//`, `${link}/./.`, `${link}/baseline/..`, `${link}/baseline/../`]) {
    const r = refuse(path, 'IMPORT_PATH', ['flow']);
    assert.match(r.message, /flow: the flow path ends in "\.\.?"; name the flow directory itself, so that a symlink at the end of the path is seen and not followed/, path);
  }
  // The same last segments on a path with no symlink in it are refused too: the rule is on the path as typed.
  for (const path of [`${flow}/.`, `${flow}/baseline/..`, '.', '..', './', '../']) refuse(path, 'IMPORT_PATH', ['flow']);
  // Before any look at the disk: a path that is not there is refused by its last segment, not as a missing flow.
  refuse(`${work}/no-such-flow/.`, 'IMPORT_PATH', ['flow']);
  // A name that only holds dots, and a hidden directory, are names like any other.
  const dotted = join(work, `...${counter}`);
  cpSync(exampleFlow, dotted, { recursive: true });
  assert.equal(read(dotted).slots.length, 6);
});

test('a symlinked variant directory, traces directory, results file or state file is refused', () => {
  const targets: [string, string, boolean][] = [
    ['baseline', 'baseline', true],
    ['baseline/traces', 'baseline/traces', true],
    ['baseline/results.jsonl', 'baseline/results.jsonl', false],
    ['baseline/errors.jsonl', 'baseline/errors.jsonl', false],
    ['_state.json', '_state.json', false],
  ];
  for (const [rel, field, isDir] of targets) {
    const flow = copy();
    const moved = join(work, `moved-${counter}`);
    renameSync(join(flow, rel), moved);
    symlinkSync(moved, join(flow, rel), isDir ? 'dir' : 'file');
    const r = refuse(flow, 'IMPORT_PATH', [field]);
    assert.match(r.message, /symlink/);
  }
});

test('a symlinked trace is refused, naming the slot, even when it points at a good trace inside the flow', () => {
  const flow = copy();
  rmSync(tracePath(flow, 'faulty-headphones', 1));
  symlinkSync(tracePath(flow, 'faulty-headphones', 0), tracePath(flow, 'faulty-headphones', 1), 'file');
  const r = refuse(flow, 'IMPORT_PATH', ['faulty-headphones#1']);
  assert.match(r.message, /symlink/);
});

test('a trace path that is a directory is refused', () => {
  const flow = copy();
  rmSync(tracePath(flow, 'faulty-headphones', 1));
  mkdirSync(tracePath(flow, 'faulty-headphones', 1));
  refuse(flow, 'IMPORT_SHAPE', ['faulty-headphones#1']);
});

test('a prompt_id that is not path-safe would name a trace outside the flow: refused', () => {
  for (const id of ['../../outside', 'a/b', 'a\\b', 'case 1', 'x'.repeat(130)]) {
    const flow = copy();
    editRows(flow, (rows) => {
      rowOf(rows, 'bank-dispute', 0).prompt_id = id;
    });
    // The line is refused. (Its slot then holds no row, which is said of rep 0 and is not part of this refusal.)
    const r = refuse(flow, 'IMPORT_CASE_ID', ['baseline/results.jsonl:2']);
    assert.match(r.message, /path-safe/);
  }
});

// ---- row 3: the keys of the profile -----------------------------------------------------------------------------------

for (const key of ['prompt_id', 'rep', 'prompt', 'status', 'stop_reason']) {
  test(`a row lacking ${key} is refused: outside the profile`, () => {
    const flow = copy();
    editRows(flow, (rows) => {
      delete rowOf(rows, 'clearance-organiser', 1)[key];
    });
    // The row is line 3 of the file. Without its id or rep the slot cannot be named, and the line is.
    const unnamed = key === 'prompt_id' || key === 'rep';
    const r = refuse(flow, key === 'prompt_id' ? 'IMPORT_CASE_ID' : 'IMPORT_SHAPE', unnamed ? ['baseline/results.jsonl:3'] : ['clearance-organiser#1']);
    assert.match(r.message, new RegExp(`baseline/results\\.jsonl:3: ${key}: missing`));
    assert.match(r.message, /skill-evals\/1/);
  });
}

test('a required key of the wrong type is refused', () => {
  const wrong: [string, unknown][] = [
    ['prompt_id', 7],
    ['prompt_id', ''],
    ['prompt_id', null],
    ['rep', '0'],
    ['rep', 0.5],
    ['rep', -1],
    ['rep', null],
    ['prompt', { text: 'a ticket' }],
    ['prompt', ''],
    ['prompt', null],
    ['status', true],
    ['status', null],
    ['stop_reason', 3],
    ['stop_reason', null],
  ];
  for (const [key, value] of wrong) {
    const flow = copy();
    editRows(flow, (rows) => {
      rowOf(rows, 'faulty-headphones', 0)[key] = value;
    });
    const unnamed = key === 'prompt_id' || key === 'rep';
    const r = refuse(flow, key === 'prompt_id' ? 'IMPORT_CASE_ID' : 'IMPORT_SHAPE', unnamed ? ['baseline/results.jsonl:1'] : ['faulty-headphones#0']);
    assert.match(r.message, new RegExp(`baseline/results\\.jsonl:1: ${key}: `), `${key} = ${JSON.stringify(value)}`);
  }
});

for (const spelling of ['id', 'case_id']) {
  test(`a case id spelled ${spelling} is refused, and the message names prompt_id`, () => {
    const flow = copy();
    editRows(flow, (rows) => {
      const r = rowOf(rows, 'faulty-headphones', 0);
      r[spelling] = r.prompt_id;
      delete r.prompt_id;
    });
    const r = refuse(flow, 'IMPORT_CASE_ID', ['baseline/results.jsonl:1']);
    assert.match(r.message, new RegExp(`the case id is spelled "${spelling}"`));
    assert.match(r.message, /prompt_id/);
  });

  test(`a row that holds ${spelling} beside prompt_id is refused: two spellings of one id`, () => {
    const flow = copy();
    editRows(flow, (rows) => {
      rowOf(rows, 'faulty-headphones', 0)[spelling] = 'another-id';
    });
    refuse(flow, 'IMPORT_CASE_ID', ['faulty-headphones#0']);
  });
}

test('a line that is not a JSON object is refused: a torn last line, an array, a number', () => {
  for (const line of ['{"prompt_id":"faulty-headphones","rep":1,"prom', '[]', '7', 'null']) {
    const flow = copy();
    appendFileSync(resultsPath(flow), `${line}\n`);
    const r = refuse(flow, 'IMPORT_SHAPE', ['baseline/results.jsonl:7']);
    assert.match(r.message, /baseline\/results\.jsonl:7/);
  }
});

test('a source file must be UTF-8 with no byte-order mark', () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const edits: [string, (flow: string) => string, string][] = [
    ['results', (f) => resultsPath(f), 'baseline/results.jsonl'],
    ['state', (f) => statePath(f), '_state.json'],
    ['errors', (f) => errorsPath(f), 'baseline/errors.jsonl'],
    ['trace', (f) => tracePath(f, 'bank-dispute', 0), 'bank-dispute#0'],
  ];
  for (const [name, pathOf, field] of edits) {
    const marked = copy();
    writeFileSync(pathOf(marked), Buffer.concat([bom, readFileSync(pathOf(marked))]));
    assert.match(refuse(marked, 'IMPORT_SHAPE', [field]).message, /byte-order mark/, name);
    const broken = copy();
    // 0xff is never a byte of UTF-8 text.
    writeFileSync(pathOf(broken), Buffer.concat([readFileSync(pathOf(broken)), Buffer.from([0xff])]));
    assert.match(refuse(broken, 'IMPORT_SHAPE', [field]).message, /not UTF-8/, name);
  }
});

test('an empty results.jsonl, or one that is missing, is refused', () => {
  const empty = copy();
  writeFileSync(resultsPath(empty), '');
  refuse(empty, 'IMPORT_SHAPE', ['baseline/results.jsonl']);
  const gone = copy();
  rmSync(resultsPath(gone));
  refuse(gone, 'IMPORT_SHAPE', ['baseline/results.jsonl']);
});

// ---- row 4: attachments -------------------------------------------------------------------------------------------------

test('a row with non-empty attachments is refused: the judge would see less than the system saw', () => {
  for (const value of [['receipt.pdf'], [{ path: 'photo.png' }], null, 'receipt.pdf', {}]) {
    const flow = copy();
    editRows(flow, (rows) => {
      rowOf(rows, 'bank-dispute', 1).attachments = value;
    });
    const r = refuse(flow, 'IMPORT_PACKET', ['bank-dispute#1']);
    assert.match(r.message, /the judge would see less than the system saw/, JSON.stringify(value));
  }
});

// ---- row 5: status and stop_reason ---------------------------------------------------------------------------------------

test('a status other than ok, or a stop_reason other than end_turn, makes its rep not whole: that rep refuses when it is taken, every such slot listed, and the other rep is handed on', () => {
  const flow = copy();
  editRows(flow, (rows) => {
    Object.assign(rowOf(rows, 'bank-dispute', 0), { status: 'truncated', stop_reason: 'max_tokens' });
    // The source writes "ok" for every stop but max_tokens, a refusal included: the stop is read as well.
    rowOf(rows, 'clearance-organiser', 0).stop_reason = 'refusal';
    rowOf(rows, 'faulty-headphones', 0).stop_reason = 'tool_use';
  });
  // The flow reads: nothing here refuses it whatever rep is graded.
  const got = read(flow);
  assert.deepEqual(got.notWhole.map((r) => r.rep), [0]);
  assert.deepEqual(wholeReps(got), [1]);
  // Rep 1 is whole and is handed on; the unfinished slots of rep 0 are not slots at all.
  assert.deepEqual(wholeRepSlots(got, 1).map(label), ['bank-dispute#1', 'clearance-organiser#1', 'faulty-headphones#1']);
  assert.deepEqual(got.slots.map(label), ['bank-dispute#1', 'clearance-organiser#1', 'faulty-headphones#1']);
  // Rep 0 is refused when it is the one taken.
  const r = refuseRep(flow, 0, 'IMPORT_OUTPUT_UNFINISHED', ['bank-dispute#0', 'clearance-organiser#0', 'faulty-headphones#0']);
  assert.match(r.message, /status "truncated"/);
  assert.match(r.message, /stop_reason "max_tokens"/);
  assert.match(r.message, /stop_reason "refusal"/);
  assert.match(r.message, /not a finished answer/);
  assert.match(r.message, /leave it out of cases\.json/);
  assert.equal(r.problems.length, 4);
  // One unfinished slot in the other rep too: no rep is whole, and each refuses with its own slots only.
  editRows(flow, (rows) => {
    rowOf(rows, 'faulty-headphones', 1).status = 'error';
  });
  assert.deepEqual(wholeReps(read(flow)), []);
  refuseRep(flow, 1, 'IMPORT_OUTPUT_UNFINISHED', ['faulty-headphones#1']);
  refuseRep(flow, 0, 'IMPORT_OUTPUT_UNFINISHED', ['bank-dispute#0', 'clearance-organiser#0', 'faulty-headphones#0']);
});

test('the trace of a row that is not a finished answer is not read: the row is what makes its rep not whole', () => {
  const flow = copy();
  editRows(flow, (rows) => {
    rowOf(rows, 'bank-dispute', 1).stop_reason = 'max_tokens';
  });
  rmSync(tracePath(flow, 'bank-dispute', 1));
  assert.deepEqual(wholeReps(read(flow)), [0]);
  // The same missing trace under a finished row refuses the flow, in whatever rep it is.
  const finished = copy();
  rmSync(tracePath(finished, 'bank-dispute', 1));
  refuse(finished, 'IMPORT_SHAPE', ['bank-dispute#1']);
});

test('an unfinished row of a stated case beyond the declared reps refuses the flow: it is no slot of any rep', () => {
  const flow = copy();
  editState(flow, (s) => {
    delete s.reps;
  });
  rmSync(errorsPath(flow));
  editRows(flow, (rows) => {
    rowOf(rows, 'bank-dispute', 1).stop_reason = 'max_tokens';
  });
  const r = refuse(flow, 'IMPORT_OUTPUT_UNFINISHED', ['bank-dispute#1', 'clearance-organiser#1', 'faulty-headphones#1'], { reps: 1 });
  assert.deepEqual(r.problems.map((p) => p.code), ['IMPORT_OUTPUT_UNFINISHED', 'IMPORT_DRAW_COUNT', 'IMPORT_DRAW_COUNT', 'IMPORT_DRAW_COUNT']);
});

// ---- row 6: the roster times the reps -------------------------------------------------------------------------------------

test('an expected slot with no row makes its rep not whole: that rep refuses, the other is handed on', () => {
  const flow = copy();
  editRows(flow, (rows) => rows.filter((r) => !(r.prompt_id === 'clearance-organiser' && r.rep === 0)));
  const got = read(flow);
  assert.deepEqual(wholeReps(got), [1]);
  assert.equal(wholeRepSlots(got, 1).length, 3);
  const r = refuseRep(flow, 0, 'IMPORT_DRAW_COUNT', ['clearance-organiser#0']);
  assert.match(r.message, /no row/);
  assert.match(r.message, /leave it out of cases\.json/);
});

test('the last rep missing on every case: that rep is not whole, each slot listed; completeness rests on the declared count', () => {
  const flow = copy();
  editRows(flow, (rows) => rows.filter((r) => r.rep === 0));
  editState(flow, (s) => {
    delete s.reps;
  });
  // Nothing in the flow now says two reps were meant; only the declaration does. Rep 0 is whole, rep 1 is not.
  assert.deepEqual(wholeReps(read(flow)), [0]);
  refuseRep(flow, 1, 'IMPORT_DRAW_COUNT', ['bank-dispute#1', 'clearance-organiser#1', 'faulty-headphones#1']);
  // Declared as one rep, the rows are complete, but errors.jsonl still records a failed attempt at a second rep:
  // an error line of a stated case for a rep beyond the declared ones is refused, so the early stop is seen even then.
  const beyond = refuse(flow, 'IMPORT_CASE_MISSING', ['baseline/errors.jsonl:1'], { reps: 1 });
  assert.match(beyond.message, /a rep beyond the declared count 1/);
  // With no such line, the same flow declared as one rep is a complete one-rep flow.
  rmSync(errorsPath(flow));
  assert.deepEqual(read(flow, { reps: 1 }).slots.map(label), ['bank-dispute#0', 'clearance-organiser#0', 'faulty-headphones#0']);
  assert.deepEqual(wholeReps(read(flow, { reps: 1 })), [0]);
  // Declared as three reps, it lacks reps 1 and 2 on every case.
  assert.deepEqual(read(flow, { reps: 3 }).notWhole.map((r) => [r.rep, r.problems.length]), [[1, 3], [2, 3]]);
  // And the untouched example, declared as three reps, is refused whole: its state file says two.
  const r = refuse(exampleFlow, 'IMPORT_DRAW_COUNT', ['_state.json'], { reps: 3 });
  assert.equal(r.problems.length, 1);
});

test('a row for a rep beyond the declared count is refused', () => {
  const flow = copy();
  editState(flow, (s) => {
    delete s.reps;
  });
  rmSync(errorsPath(flow));
  refuse(flow, 'IMPORT_DRAW_COUNT', ['bank-dispute#1', 'clearance-organiser#1', 'faulty-headphones#1'], { reps: 1 });
});

test('the same slot twice is refused, with both lines named', () => {
  const flow = copy();
  editRows(flow, (rows) => [...rows, { ...rowOf(rows, 'bank-dispute', 0) }]);
  const r = refuse(flow, 'IMPORT_DRAW_COUNT', ['bank-dispute#0']);
  assert.match(r.message, /lines 2 and 7/);
});

test('a row for a case that is not in the cases file is listed as an excluded case, not refused; its trace is not read', () => {
  const flow = copy();
  // No trace is written for the new rows: a trace that was read would refuse them as missing.
  editRows(flow, (rows) => [...rows, { ...rowOf(rows, 'bank-dispute', 0), prompt_id: 'late-parcel' }, { ...rowOf(rows, 'bank-dispute', 1), prompt_id: 'late-parcel', stop_reason: 'max_tokens' }]);
  const got = read(flow);
  assert.deepEqual(got.excluded, [{ caseId: 'late-parcel', rows: [{ line: 7, rep: 0, finished: true }, { line: 8, rep: 1, finished: false }], errorLines: [] }]);
  // Nothing else moves: the same slots, both reps whole.
  assert.deepEqual(got.slots, read(exampleFlow).slots);
  assert.deepEqual(got.notWhole, []);
  assert.equal(got.slots.some((s) => s.caseId === 'late-parcel'), false);
});

test('the cases file is the declaration: a case of the flow that is left out of it is excluded with all its rows, and the rest reads', () => {
  const fewer: CasesFile = { ...cases };
  delete fewer['clearance-organiser'];
  const got = read(exampleFlow, { cases: fewer });
  assert.deepEqual(got.excluded, [{ caseId: 'clearance-organiser', rows: [{ line: 3, rep: 1, finished: true }, { line: 5, rep: 0, finished: true }], errorLines: [] }]);
  assert.deepEqual(got.slots.map(label), ['bank-dispute#0', 'bank-dispute#1', 'faulty-headphones#0', 'faulty-headphones#1']);
  assert.deepEqual(wholeReps(got), [0, 1]);
});

test('excluded cases are listed by case id, whatever the order of the lines; a slot of one twice, or beyond the declared reps, is listed too', () => {
  const flow = copy();
  editRows(flow, (rows) => {
    const base = rowOf(rows, 'bank-dispute', 0);
    return [{ ...base, prompt_id: 'zebra-rug' }, ...rows, { ...base, prompt_id: 'alpaca-scarf', rep: 5 }, { ...base, prompt_id: 'zebra-rug' }];
  });
  assert.deepEqual(read(flow).excluded, [
    { caseId: 'alpaca-scarf', rows: [{ line: 8, rep: 5, finished: true }], errorLines: [] },
    { caseId: 'zebra-rug', rows: [{ line: 1, rep: 0, finished: true }, { line: 9, rep: 0, finished: true }], errorLines: [] },
  ]);
});

test('a row of an excluded case must still read under the row profile: an id that is not path-safe, a missing key or attachments refuse', () => {
  const edits: [string, (r: J) => void, ImportRefusalCode, string][] = [
    ['an id that is not path-safe', (r) => { r.prompt_id = 'late parcel'; }, 'IMPORT_CASE_ID', 'baseline/results.jsonl:7'],
    ['no status', (r) => { delete r.status; }, 'IMPORT_SHAPE', 'late-parcel#0'],
    ['an empty prompt', (r) => { r.prompt = ''; }, 'IMPORT_SHAPE', 'late-parcel#0'],
    ['attachments', (r) => { r.attachments = ['receipt.pdf']; }, 'IMPORT_PACKET', 'late-parcel#0'],
  ];
  for (const [what, edit, code, field] of edits) {
    const flow = copy();
    editRows(flow, (rows) => {
      const added = { ...rowOf(rows, 'bank-dispute', 0), prompt_id: 'late-parcel' };
      edit(added);
      return [...rows, added];
    });
    assert.ok(refuse(flow, code, [field]), what);
  }
});

// ---- row 7: the rep count of the state file ---------------------------------------------------------------------------------

test('a rep count in _state.json that differs from the declared one is refused', () => {
  const flow = copy();
  editState(flow, (s) => {
    s.reps = 3;
  });
  const r = refuse(flow, 'IMPORT_DRAW_COUNT', ['_state.json']);
  assert.match(r.message, /_state\.json: reps is 3, the declared count is 2/);
});

test('a rep count in _state.json that is not a positive integer is refused; a state file with none is accepted', () => {
  for (const value of ['2', 2.5, 0, null, [2]]) {
    const flow = copy();
    editState(flow, (s) => {
      s.reps = value;
    });
    // Said as what it is: a value that is no count, not a count that differs from the declared one.
    assert.match(refuse(flow, 'IMPORT_DRAW_COUNT', ['_state.json']).message, /_state\.json: reps is .+, not a positive integer; the declared count is 2$/, JSON.stringify(value));
  }
  // A count that differs is said as that.
  const three = copy();
  editState(three, (s) => {
    s.reps = 3;
  });
  assert.doesNotMatch(refuse(three, 'IMPORT_DRAW_COUNT', ['_state.json']).message, /not a positive integer/);
  const none = copy();
  editState(none, (s) => {
    delete s.reps;
  });
  assert.equal(read(none).slots.length, 6);
});

test('harness_sha of _state.json is 64 lowercase hexadecimal characters; without the key it is the gap marker; any other value is refused, and never printed raw', () => {
  // The example flow's _state.json holds 64 zeros: an example value. Its form is held; what it is the hash of is never checked.
  assert.equal(read(exampleFlow).harnessSha, '0'.repeat(64));
  const hex = sha256Hex('a harness');
  const other = copy();
  editState(other, (s) => {
    s.harness_sha = hex;
  });
  assert.equal(read(other).harnessSha, hex);
  const none = copy();
  editState(none, (s) => {
    delete s.harness_sha;
  });
  assert.equal(read(none).harnessSha, 'UNKNOWN');
  const forged = `${hex}\nREFUSED forged: a line of a report\n/Users/someone/flow`;
  for (const value of [null, 7, '', '  ', 'UNKNOWN', 'unknown', ['a'], 'sha256:abc123 (runner and listed files)', `sha256:${hex}`, hex.toUpperCase(), hex.slice(1), `${hex}0`, `${hex}\n`, ` ${hex}`, hex.slice(0, 40), `${hex.slice(0, 63)}g`, forged]) {
    const flow = copy();
    editState(flow, (s) => {
      s.harness_sha = value;
    });
    const r = refuse(flow, 'IMPORT_SHAPE', ['_state.json']);
    assert.match(r.message, /_state\.json: harness_sha is .*, not 64 lowercase hexadecimal characters; leave the key out when there is none/, JSON.stringify(value));
    // What is shown of the value is its JSON, cut short: no line feed of the value reaches the message.
    assert.ok(!r.message.includes('\n'), JSON.stringify(value));
    assert.ok(!r.message.includes('/Users/someone'), JSON.stringify(value));
  }
});

test('a missing _state.json is accepted: its sha256 and harness_sha are the explicit gap marker, never an empty text', () => {
  const gone = copy();
  rmSync(statePath(gone));
  const got = read(gone);
  assert.equal(got.stateSha256, GAP);
  assert.equal(got.stateSha256, 'UNKNOWN');
  assert.equal(got.harnessSha, GAP);
  assert.equal(hasNoStateFile(got), true);
  // Everything else is as with the file.
  const base = read(exampleFlow);
  assert.deepEqual(got.slots, base.slots);
  assert.equal(got.resultsSha256, base.resultsSha256);
  assert.deepEqual(wholeReps(got), [0, 1]);
  assert.equal(JSON.stringify(got).includes('null'), false);
  // With no file, nothing contradicts the declared count: declared as three, rep 2 is listed as not whole.
  assert.deepEqual(wholeReps(read(gone, { reps: 3 })), [0, 1]);
});

test('a _state.json that is there and is not a JSON object, is a symlink (dangling or not) or is a directory still refuses', () => {
  for (const text of ['[]', '{"reps": 2', '2', '']) {
    const flow = copy();
    writeFileSync(statePath(flow), text);
    refuse(flow, 'IMPORT_SHAPE', ['_state.json']);
  }
  const dangling = copy();
  rmSync(statePath(dangling));
  symlinkSync(join(dangling, 'no-such-file.json'), statePath(dangling));
  refuse(dangling, 'IMPORT_PATH', ['_state.json']);
  const linked = copy();
  renameSync(statePath(linked), join(linked, 'state-elsewhere.json'));
  symlinkSync(join(linked, 'state-elsewhere.json'), statePath(linked));
  refuse(linked, 'IMPORT_PATH', ['_state.json']);
  const folder = copy();
  rmSync(statePath(folder));
  mkdirSync(statePath(folder));
  refuse(folder, 'IMPORT_SHAPE', ['_state.json']);
});

// ---- row 8: the trace --------------------------------------------------------------------------------------------------------

test('a row with no trace is refused, naming the slot', () => {
  const flow = copy();
  rmSync(tracePath(flow, 'clearance-organiser', 1));
  const r = refuse(flow, 'IMPORT_SHAPE', ['clearance-organiser#1']);
  assert.match(r.message, /baseline\/traces\/clearance-organiser_rep1\.json: no trace/);
});

test('a flow with no traces directory is refused once, not once per slot', () => {
  const flow = copy();
  rmSync(join(flow, 'baseline', 'traces'), { recursive: true });
  assert.equal(refuse(flow, 'IMPORT_SHAPE', ['baseline/traces']).problems.length, 1);
});

test('a trace that is not exactly [system?, user, assistant] is refused', () => {
  const shapes: [string, (t: J[]) => J][] = [
    ['not a list', (t) => ({ turns: t })],
    ['no turn', () => []],
    ['one turn', (t) => [t[2]]],
    ['two assistants', (t) => [t[0], t[1], t[2], t[2]]],
    ['a second exchange', (t) => [t[1], t[2], t[1], t[2]]],
    ['assistant before user', (t) => [t[0], t[2], t[1]]],
    ['system last', (t) => [t[1], t[2], t[0]]],
    ['two systems', (t) => [t[0], t[0], t[1], t[2]]],
    ['user only after system', (t) => [t[0], t[1]]],
    ['a turn that is not an object', (t) => [t[0], t[1], 'the reply']],
    ['a turn with no role', (t) => [t[0], t[1], { content: t[2].content }]],
  ];
  for (const [name, edit] of shapes) {
    const flow = copy();
    editTrace(flow, 'faulty-headphones', 0, edit);
    const r = refuse(flow, 'IMPORT_SHAPE', ['faulty-headphones#0']);
    assert.match(r.message, /\[system\?, user, assistant\]/, name);
  }
});

test('a trace with no system turn is accepted', () => {
  const flow = copy();
  editTrace(flow, 'faulty-headphones', 0, (t) => [t[1], t[2]]);
  assert.equal(read(flow).slots.length, 6);
});

test('a trace turn whose content is not a non-empty string is refused', () => {
  // Turn 0 is the system turn: its content must still be a string. Turns 1 and 2 are the question and the stored output.
  for (const [turn, value] of [[2, [{ type: 'text', text: 'a reply' }]], [2, null], [2, ''], [1, 7], [1, ''], [0, { text: 'rules' }], [0, null], [0, 7]] as [number, unknown][]) {
    const flow = copy();
    editTrace(flow, 'faulty-headphones', 0, (t) => {
      t[turn].content = value;
    });
    const r = refuse(flow, 'IMPORT_SHAPE', ['faulty-headphones#0']);
    assert.match(r.message, new RegExp(`turn ${turn}: content`));
  }
  // With no system turn, turn 0 is the user turn: its empty content refuses.
  const noSystem = copy();
  editTrace(noSystem, 'faulty-headphones', 0, (t) => [{ ...t[1], content: '' }, t[2]]);
  assert.match(refuse(noSystem, 'IMPORT_SHAPE', ['faulty-headphones#0']).message, /turn 0: content: the text is empty/);
});

test('an empty content on the system turn is accepted: the system turn is not used', () => {
  const flow = copy();
  editTrace(flow, 'faulty-headphones', 0, (t) => {
    assert.equal(t[0].role, 'system');
    t[0].content = '';
  });
  const got = read(flow);
  const base = read(exampleFlow);
  assert.deepEqual(got.slots.map(label), SLOTS);
  // The slot differs from the example's in its trace's bytes only.
  const [slot, was] = [got.slots[4], base.slots[4]];
  assert.ok(slot && was);
  assert.equal(label(slot), 'faulty-headphones#0');
  assert.deepEqual({ ...slot, traceSha256: '' }, { ...was, traceSha256: '' });
  assert.notEqual(slot.traceSha256, was.traceSha256);
  // A turn that says "system" out of place gets no such allowance: the order refuses it.
  const misplaced = copy();
  editTrace(misplaced, 'faulty-headphones', 0, (t) => [t[1], { role: 'system', content: '' }, t[2]]);
  refuse(misplaced, 'IMPORT_SHAPE', ['faulty-headphones#0']);
});

test('a trace turn with thinking, with attachments, with a tool role or with an unknown key is refused', () => {
  const edits: [string, ImportRefusalCode, (t: J[]) => J | void, RegExp][] = [
    ['thinking', 'IMPORT_PACKET', (t) => void (t[2].thinking = 'The order is within the window.'), /thinking/],
    ['empty thinking', 'IMPORT_PACKET', (t) => void (t[2].thinking = ''), /thinking/],
    ['attachments', 'IMPORT_PACKET', (t) => void (t[1].attachments = ['photo.png']), /attachments/],
    ['tool role', 'IMPORT_PACKET', (t) => [t[0], t[1], { role: 'tool', content: '{"order":"A-10492"}' }, t[2]], /role "tool"/],
    ['tool role in a three-turn list', 'IMPORT_PACKET', (t) => [t[1], { role: 'tool', content: 'x' }, t[2]], /role "tool"/],
    ['unknown key', 'IMPORT_SHAPE', (t) => void (t[2].tool_calls = []), /tool_calls/],
  ];
  for (const [name, code, edit, words] of edits) {
    const flow = copy();
    editTrace(flow, 'clearance-organiser', 0, edit);
    assert.match(refuse(flow, code, ['clearance-organiser#0']).message, words, name);
  }
});

test('a trace turn whose name is not a string is refused', () => {
  for (const value of [7, ['customer'], { first: 'customer' }, true]) {
    const flow = copy();
    editTrace(flow, 'clearance-organiser', 1, (t) => {
      t[1].name = value;
    });
    const r = refuse(flow, 'IMPORT_SHAPE', ['clearance-organiser#1']);
    assert.match(r.message, /baseline\/traces\/clearance-organiser_rep1\.json: turn 1: name: expected string, found (number|array|object|boolean)$/, JSON.stringify(value));
  }
});

test('a trace turn with a name, or with empty attachments, is accepted', () => {
  const flow = copy();
  editTrace(flow, 'clearance-organiser', 0, (t) => {
    t[1].name = 'customer';
    t[1].attachments = [];
  });
  assert.equal(read(flow).slots.length, 6);
});

test('a trace that is not JSON is refused', () => {
  const flow = copy();
  writeFileSync(tracePath(flow, 'bank-dispute', 1), '[{"role": "user"');
  assert.match(refuse(flow, 'IMPORT_SHAPE', ['bank-dispute#1']).message, /not JSON/);
});

// ---- row 9: the trace's user turn against the row's prompt ---------------------------------------------------------------------

test("a trace whose user content differs from the row's prompt is refused", () => {
  const inTrace = copy();
  editTrace(inTrace, 'bank-dispute', 0, (t) => {
    t[1].content = `${t[1].content} `;
  });
  assert.match(refuse(inTrace, 'IMPORT_PACKET', ['bank-dispute#0']).message, /differs from the row's prompt/);
  const inRow = copy();
  editRows(inRow, (rows) => {
    rowOf(rows, 'bank-dispute', 0).prompt = 'Order A-09977. Where is my money?';
  });
  refuse(inRow, 'IMPORT_PACKET', ['bank-dispute#0']);
});

// ---- row 10: a cases id that matches no prompt_id ------------------------------------------------------------------------------

test("a cases.json id that matches no prompt_id is refused, and the message says ids are the row's prompt_id", () => {
  const more: CasesFile = { ...cases, 'Bank dispute (original id)': { klass: 'refund_safety', expect: 'pass' } };
  const r = refuse(exampleFlow, 'IMPORT_CASE_MISSING', ['Bank dispute (original id)'], { cases: more });
  assert.match(r.message, /no row holds this id/);
  assert.match(r.message, /a case id is the row's prompt_id \(the path-safe id\), never meta\.original_id/);
  assert.match(r.message, /leave it out of cases\.json/);
  // One problem for the case, not one per rep.
  assert.equal(r.problems.length, 1);
});

test('a case of the cases file whose every attempt failed (error lines, no row) refuses the flow and names the lines; left out of the cases file, it is listed as excluded', () => {
  const flow = copy();
  editRows(flow, (rows) => rows.filter((r) => r.prompt_id !== 'clearance-organiser'));
  for (const k of [0, 1]) rmSync(tracePath(flow, 'clearance-organiser', k));
  appendFileSync(errorsPath(flow), `${JSON.stringify({ prompt_id: 'clearance-organiser', rep: 0, error: 'example: timed out' })}\n${JSON.stringify({ prompt_id: 'clearance-organiser', rep: 1, error: 'example: timed out' })}\n`);
  const r = refuse(flow, 'IMPORT_CASE_MISSING', ['clearance-organiser']);
  assert.match(r.message, /errors\.jsonl line 2, 3 records failed attempts at it/);
  assert.equal(r.problems.length, 1);
  const fewer: CasesFile = { ...cases };
  delete fewer['clearance-organiser'];
  const got = read(flow, { cases: fewer });
  assert.deepEqual(got.excluded, [{ caseId: 'clearance-organiser', rows: [], errorLines: [2, 3] }]);
  assert.deepEqual(wholeReps(got), [0, 1]);
  // The failed attempts of an excluded case are not superseded lines: no row of a stated slot replaced them.
  assert.deepEqual(got.superseded, [{ caseId: 'bank-dispute', draw: 1, line: 1 }]);
});

// ---- errors.jsonl ----------------------------------------------------------------------------------------------------------------

test('a crash-and-resume flow: error lines for slots that later got a row are listed in file order, never refused', () => {
  const flow = copy();
  // The run failed twice on one slot and once on another, crashed, and was resumed; the resume wrote the rows.
  writeFileSync(
    errorsPath(flow),
    [
      { prompt_id: 'faulty-headphones', rep: 1, failure_class: 'error', error: 'example: timed out', retries: 2 },
      { prompt_id: 'bank-dispute', rep: 1, failure_class: 'error', error: 'example: timed out', retries: 2 },
      { prompt_id: 'faulty-headphones', rep: 1, failure_class: 'error', error: 'example: timed out again', retries: 2 },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n\n',
  );
  const got = read(flow);
  assert.deepEqual(got.superseded, [
    { caseId: 'faulty-headphones', draw: 1, line: 1 },
    { caseId: 'bank-dispute', draw: 1, line: 2 },
    { caseId: 'faulty-headphones', draw: 1, line: 3 },
  ]);
  assert.deepEqual(got.slots, read(exampleFlow).slots);
});

test('an error line for a slot with no row is not superseded: the slot makes its rep not whole, and the line is named', () => {
  const flow = copy();
  editRows(flow, (rows) => rows.filter((r) => !(r.prompt_id === 'bank-dispute' && r.rep === 1)));
  const got = read(flow);
  assert.deepEqual(got.superseded, []);
  assert.deepEqual(wholeReps(got), [0]);
  const r = refuseRep(flow, 1, 'IMPORT_DRAW_COUNT', ['bank-dispute#1']);
  assert.match(r.message, /errors\.jsonl line 1 records a failed attempt/);
});

test('an error line that cannot be read, or that names a rep of a stated case beyond the declared ones, is refused; one of a case outside the cases file is listed', () => {
  const unreadable = copy();
  appendFileSync(errorsPath(unreadable), '{"prompt_id":"bank-dispute"}\nnot json\n');
  refuse(unreadable, 'IMPORT_SHAPE', ['baseline/errors.jsonl:2', 'baseline/errors.jsonl:3']);
  const outside = copy();
  appendFileSync(errorsPath(outside), `${JSON.stringify({ prompt_id: 'late-parcel', rep: 0 })}\n${JSON.stringify({ prompt_id: 'bank-dispute', rep: 2 })}\n`);
  // Only the line of the stated case refuses.
  refuse(outside, 'IMPORT_CASE_MISSING', ['baseline/errors.jsonl:3']);
  const listed = copy();
  appendFileSync(errorsPath(listed), `${JSON.stringify({ prompt_id: 'late-parcel', rep: 0 })}\n${JSON.stringify({ prompt_id: 'late-parcel', rep: 7 })}\n`);
  const got = read(listed);
  assert.deepEqual(got.excluded, [{ caseId: 'late-parcel', rows: [], errorLines: [2, 3] }]);
  assert.deepEqual(got.superseded, [{ caseId: 'bank-dispute', draw: 1, line: 1 }]);
  // The id of an excluded case goes into a re-grade file's header: one that is not path-safe refuses.
  for (const id of ['../outside', 'late parcel', '']) {
    const unsafe = copy();
    appendFileSync(errorsPath(unsafe), `${JSON.stringify({ prompt_id: id, rep: 0 })}\n`);
    assert.match(refuse(unsafe, 'IMPORT_CASE_ID', ['baseline/errors.jsonl:2']).message, /path-safe/);
  }
});

// ---- every problem at once -------------------------------------------------------------------------------------------------------

test('a refusal lists every offending slot of every rule; its code is that of the first problem', () => {
  const flow = copy();
  editRows(flow, (rows) => {
    rowOf(rows, 'bank-dispute', 0).attachments = ['receipt.pdf'];
    rowOf(rows, 'clearance-organiser', 1).prompt = '';
  });
  rmSync(tracePath(flow, 'faulty-headphones', 1));
  editState(flow, (s) => {
    s.harness_sha = 'not a hash';
  });
  const r = refuse(flow, 'IMPORT_SHAPE', ['_state.json', 'bank-dispute#0', 'clearance-organiser#1', 'faulty-headphones#1']);
  assert.deepEqual(
    r.problems.map((p) => p.code),
    ['IMPORT_SHAPE', 'IMPORT_PACKET', 'IMPORT_SHAPE', 'IMPORT_SHAPE'],
  );
  for (const p of r.problems) assert.ok(r.message.includes(p.message), p.message);
});

test('a _state.json whose rep count is not the declared one refuses the flow before any slot of the declared reps is looked for', () => {
  const flow = copy();
  editRows(flow, (rows) => {
    rowOf(rows, 'bank-dispute', 0).attachments = ['receipt.pdf'];
    // A stated case with no row at all, and a slot of another with no row: both are counted against the declared reps.
    return rows.filter((r) => r.prompt_id !== 'clearance-organiser' && !(r.prompt_id === 'faulty-headphones' && r.rep === 1));
  });
  rmSync(tracePath(flow, 'faulty-headphones', 0));
  editState(flow, (s) => {
    s.reps = 5;
  });
  // What was found before the count is named: the state file and the row. Nothing counted against the declared reps
  // is (the case with no row, the missing slot), and no trace is read.
  const r = refuse(flow, 'IMPORT_DRAW_COUNT', ['_state.json', 'bank-dispute#0']);
  assert.deepEqual(r.problems.map((p) => p.code), ['IMPORT_DRAW_COUNT', 'IMPORT_PACKET']);
  assert.match(r.message, /_state\.json: reps is 5, the declared count is 2/);
  // The same flow with the declared count the state file states gets past that point: the case with no row is named.
  assert.ok(refuse(flow, 'IMPORT_PACKET', ['bank-dispute#0', 'clearance-organiser', 'faulty-headphones#0'], { reps: 5 }).problems.some((p) => p.code === 'IMPORT_CASE_MISSING'));
  // A rep count of the state file that is not a count is refused at the same point.
  const odd = copy();
  editRows(odd, (rows) => rows.filter((r) => r.prompt_id !== 'clearance-organiser'));
  editState(odd, (s) => {
    s.reps = '2';
  });
  refuse(odd, 'IMPORT_DRAW_COUNT', ['_state.json']);
  // The largest declared count (with one stated case, so that its slots are within the bound too), against a flow that
  // states 2: refused at once, with no long loop over the declared reps.
  const t0 = Date.now();
  refuse(exampleFlow, 'IMPORT_DRAW_COUNT', ['_state.json'], { reps: HEADER_COUNT_BOUND, cases: oneCase });
  assert.ok(Date.now() - t0 < 2000, `the refusal took ${Date.now() - t0} ms`);
});

test('the declared rep count is at most the bound: a larger one is a usage error, in the reader and in the pure validation, before any file is looked at', () => {
  assert.equal(HEADER_COUNT_BOUND, 100000);
  const none: FlowFiles = { flowDir: 'missing', variantDir: 'missing', tracesDir: 'missing', state: 'missing', results: 'missing', errors: 'missing', traces: new Map() };
  for (const reps of [100001, 4294967296, 2 ** 40, Number.MAX_SAFE_INTEGER]) {
    const said = (e: unknown): boolean => e instanceof ImportUsageError && e.message === `USAGE: --reps must be at most 100000, found ${reps}`;
    assert.throws(() => read(exampleFlow, { reps }), said, String(reps));
    assert.throws(() => validateFlow(none, 'baseline', cases, reps), said, String(reps));
    assert.throws(() => readFlow(join(work, 'no-such-flow'), 'baseline', cases, reps), said, String(reps));
  }
  // The bound itself is a count this path takes (with one stated case): the flow is read, and its state file's own
  // count refuses it.
  assert.throws(() => read(exampleFlow, { reps: HEADER_COUNT_BOUND, cases: oneCase }), FlowRefusal);
});

test('the slots of the flow (the cases of the cases file times the declared reps) are at most the bound: more is a usage error, in the reader and in the pure validation, before any file is looked at or any slot is listed', () => {
  const none: FlowFiles = { flowDir: 'missing', variantDir: 'missing', tracesDir: 'missing', state: 'missing', results: 'missing', errors: 'missing', traces: new Map() };
  // A flow with no state file, so that nothing but the declaration sets the count: without the bound, every missing slot
  // of reps 2 to 50000 of the two stated cases would be looked for and listed as a problem of its rep.
  const flow = copy();
  rmSync(statePath(flow));
  const two: CasesFile = { 'bank-dispute': cases['bank-dispute'] as CasesFile[string], 'clearance-organiser': cases['clearance-organiser'] as CasesFile[string] };
  // 300 cases and 100000 reps would run out of memory before the slot count was looked at.
  const many: CasesFile = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`case-${String(i).padStart(3, '0')}`, cases['bank-dispute'] as CasesFile[string]]));
  for (const [stated, reps, slots] of [[two, 50001, 100002], [many, HEADER_COUNT_BOUND, 30000000], [cases, 33334, 100002], [many, 334, 100200]] as const) {
    const n = Object.keys(stated).length;
    const said = (e: unknown): boolean => e instanceof ImportUsageError && e.message === `USAGE: ${n} case(s) of the cases file x ${reps} declared rep(s) is ${slots} slots of the flow, more than the 100000 this path takes`;
    const t0 = Date.now();
    assert.throws(() => read(flow, { reps, cases: stated }), said, `${n} x ${reps}`);
    assert.throws(() => read(exampleFlow, { reps, cases: stated }), said, `${n} x ${reps}`);
    assert.throws(() => validateFlow(none, 'baseline', stated, reps), said, `${n} x ${reps}`);
    assert.throws(() => readFlow(join(work, 'no-such-flow'), 'baseline', stated, reps), said, `${n} x ${reps}`);
    assert.ok(Date.now() - t0 < 2000, `${n} x ${reps}: refused in ${Date.now() - t0} ms`);
  }
  // At the bound the slots are taken: the flow is read, and the missing reps are listed by rep, not refused.
  const at = read(flow, { reps: 50000, cases: two });
  assert.deepEqual(wholeReps(at), [0, 1]);
  assert.equal(at.notWhole.length, 49998);
  assert.equal(at.notWhole.reduce((sum, r) => sum + r.problems.length, 0), 99996);
  assert.equal(validateFlow(readFlowFiles(flow, 'baseline'), 'baseline', two, 50000).notWhole.length, 49998);
});

test('an error line names its slot by a string prompt_id and an integer rep from 0: each other form is refused on its own line', () => {
  const bad: unknown[] = [
    { prompt_id: 7, rep: 0 },
    { prompt_id: 'bank-dispute', rep: -1 },
    { prompt_id: 'bank-dispute', rep: 1.5 },
    { prompt_id: 'bank-dispute', rep: '0' },
    { prompt_id: 'bank-dispute', rep: 2 ** 53 },
    { rep: 0 },
    ['bank-dispute', 0],
    'bank-dispute#0',
    7,
  ];
  for (const line of bad) {
    const flow = copy();
    appendFileSync(errorsPath(flow), `${JSON.stringify(line)}\n`);
    const r = refuse(flow, 'IMPORT_SHAPE', ['baseline/errors.jsonl:2']);
    assert.match(r.message, /baseline\/errors\.jsonl:2: not an object with a string prompt_id and an integer rep; which slot failed cannot be read/, JSON.stringify(line));
  }
  // The smallest rep is 0, and it is read.
  const ok = copy();
  appendFileSync(errorsPath(ok), `${JSON.stringify({ prompt_id: 'bank-dispute', rep: 0 })}\n`);
  assert.deepEqual(read(ok).superseded, [{ caseId: 'bank-dispute', draw: 1, line: 1 }, { caseId: 'bank-dispute', draw: 0, line: 2 }]);
});

test('a superseded line is an error line of a STATED slot that holds a row: one of an excluded case that holds a row is not one, nor is one of a stated slot with no row', () => {
  const flow = copy();
  // An excluded case with a row and a failed attempt at the same slot before it.
  appendFileSync(resultsPath(flow), `${JSON.stringify({ prompt_id: 'late-parcel', rep: 0, prompt: 'Where is my parcel?', status: 'ok', stop_reason: 'end_turn' })}\n`);
  appendFileSync(errorsPath(flow), `${JSON.stringify({ prompt_id: 'late-parcel', rep: 0, error: 'example: timed out' })}\n`);
  const got = read(flow);
  assert.deepEqual(got.excluded, [{ caseId: 'late-parcel', rows: [{ line: 7, rep: 0, finished: true }], errorLines: [2] }]);
  assert.deepEqual(got.superseded, [{ caseId: 'bank-dispute', draw: 1, line: 1 }]);
  // The same line of a stated slot that holds a row is one.
  const stated = copy();
  appendFileSync(errorsPath(stated), `${JSON.stringify({ prompt_id: 'faulty-headphones', rep: 0, error: 'example: timed out' })}\n`);
  assert.deepEqual(read(stated).superseded, [{ caseId: 'bank-dispute', draw: 1, line: 1 }, { caseId: 'faulty-headphones', draw: 0, line: 2 }]);
  // And of a stated slot with no row it is not: the slot is named where its rep is listed as not whole.
  editRows(stated, (rows) => rows.filter((r) => !(r.prompt_id === 'faulty-headphones' && r.rep === 0)));
  assert.deepEqual(read(stated).superseded, [{ caseId: 'bank-dispute', draw: 1, line: 1 }]);
});

test('the flow reader names a slot by the shared module\'s one function', () => {
  assert.equal(slotLabel, sharedSlotLabel);
  assert.equal(slotLabel('bank-dispute', 1), 'bank-dispute#1');
});

test('what refuses the flow is kept apart from what makes a rep not whole: the first is thrown, and the second is not in it', () => {
  const flow = copy();
  editRows(flow, (rows) => {
    rowOf(rows, 'faulty-headphones', 0).status = 'truncated';
    rowOf(rows, 'bank-dispute', 0).attachments = ['receipt.pdf'];
    return rows.filter((r) => !(r.prompt_id === 'clearance-organiser' && r.rep === 0));
  });
  // The attachments refuse the flow; the unfinished slot and the missing slot are of rep 0 and are not named here.
  refuse(flow, 'IMPORT_PACKET', ['bank-dispute#0']);
  editRows(flow, (rows) => {
    delete rowOf(rows, 'bank-dispute', 0).attachments;
  });
  const r = refuseRep(flow, 0, 'IMPORT_OUTPUT_UNFINISHED', ['faulty-headphones#0', 'clearance-organiser#0']);
  assert.deepEqual(r.problems.map((p) => p.code), ['IMPORT_OUTPUT_UNFINISHED', 'IMPORT_DRAW_COUNT']);
});

test('reading a flow writes nothing into it', () => {
  const flow = copy();
  const listing = (): string[] => (readdirSync(flow, { recursive: true }) as string[]).sort();
  const before = listing();
  read(flow);
  assert.throws(() => read(flow, { reps: 3 }), FlowRefusal);
  assert.deepEqual(listing(), before);
});

// ---- an unpaired surrogate: two different texts would share one hash -------------------------------------------------------------

test('a stored output or a question that holds an unpaired surrogate is refused by the reader, with the file and the field named: the library has no hash for such a text', () => {
  // Why: written as UTF-8, both texts become the same bytes, so the library throws a TypeError for either and takes no hash.
  // The reader refuses first, as a FlowRefusal (the `refuse` helper asserts the type, the code and the slots).
  for (const text of ['refund \ud800', 'refund \udc00']) assert.throws(() => outputHashOf(text), (e: unknown) => e instanceof TypeError && /holds an unpaired surrogate/.test(e.message));
  for (const lone of ['\ud800', '\udfff']) {
    const answer = copy();
    editTrace(answer, 'faulty-headphones', 1, (t) => {
      t[2].content = `${t[2].content}${lone}`;
    });
    // On disk the text is a JSON escape, in a file that is valid UTF-8.
    assert.match(readFileSync(tracePath(answer, 'faulty-headphones', 1), 'utf8'), /\\ud[8f][0f][0f]/);
    const r = refuse(answer, 'IMPORT_SHAPE', ['faulty-headphones#1']);
    assert.match(r.message, /baseline\/traces\/faulty-headphones_rep1\.json: turn 2: content: the text holds an unpaired surrogate/);
  }
  // The question: on the row and, equal to it, in the user turn of the trace.
  const question = copy();
  editRows(question, (rows) => {
    rowOf(rows, 'bank-dispute', 0).prompt += '\ud83d';
  });
  editTrace(question, 'bank-dispute', 0, (t) => {
    t[1].content += '\ud83d';
  });
  const q = refuse(question, 'IMPORT_SHAPE', ['bank-dispute#0']);
  assert.match(q.message, /baseline\/results\.jsonl:\d+: prompt: the text holds an unpaired surrogate/);
  // A whole pair is a character like any other.
  const pair = copy();
  editTrace(pair, 'faulty-headphones', 1, (t) => {
    t[2].content = `${t[2].content}😀`;
  });
  assert.equal(read(pair).slots.length, 6);
});

// ---- a key given twice: the plain parser keeps the last and says nothing --------------------------------------------------------

test('a row with a key given twice is refused: a first status "truncated" and a second "ok" would read as a finished answer', () => {
  const flow = copy();
  const lines = readFileSync(resultsPath(flow), 'utf8').split('\n');
  const first = JSON.parse(lines[0] as string) as J;
  lines[0] = (lines[0] as string).replace(/^\{/, '{"status":"truncated",');
  // What the plain parser makes of the line: a finished row.
  assert.equal((JSON.parse(lines[0]) as J).status, 'ok');
  writeFileSync(resultsPath(flow), lines.join('\n'));
  assert.equal(typeof first.prompt_id, 'string');
  const r = refuse(flow, 'IMPORT_SHAPE', ['baseline/results.jsonl:1']);
  assert.match(r.message, /baseline\/results\.jsonl:1: the key "status" is given twice in the top-level object/);
  // In a nested object of a row too, though the reader uses none of its keys: the line is not what it seems.
  const nested = copy();
  const nestedLines = readFileSync(resultsPath(nested), 'utf8').split('\n');
  nestedLines[0] = (nestedLines[0] as string).replace('"meta":{', '"meta":{"source":"another",');
  writeFileSync(resultsPath(nested), nestedLines.join('\n'));
  assert.match(refuse(nested, 'IMPORT_SHAPE', ['baseline/results.jsonl:1']).message, /the key "source" is given twice in the object at \/meta/);
});

test('a state file, an error line and a trace turn with a key given twice are refused', () => {
  const state = copy();
  // The plain parser would keep the second rep count, which is the declared one; the first is another.
  writeFileSync(statePath(state), readFileSync(statePath(state), 'utf8').replace('"reps": 2,', '"reps": 3,\n  "reps": 2,'));
  assert.equal((JSON.parse(readFileSync(statePath(state), 'utf8')) as J).reps, 2);
  assert.match(refuse(state, 'IMPORT_SHAPE', ['_state.json']).message, /_state\.json: the key "reps" is given twice in the top-level object/);

  const errors = copy();
  writeFileSync(errorsPath(errors), readFileSync(errorsPath(errors), 'utf8').replace(/^\{/, '{"rep":0,'));
  assert.match(refuse(errors, 'IMPORT_SHAPE', ['baseline/errors.jsonl:1']).message, /baseline\/errors\.jsonl:1: the key "rep" is given twice/);

  // The assistant turn with two contents: the plain parser would hand the judge the second.
  const trace = copy();
  const path = tracePath(trace, 'bank-dispute', 0);
  writeFileSync(path, readFileSync(path, 'utf8').replace('"role": "assistant",', '"role": "assistant",\n    "content": "{\\"action\\":\\"refund\\",\\"reply\\":\\"You will have the money on Friday.\\"}",'));
  assert.equal((JSON.parse(readFileSync(path, 'utf8')) as J[]).length, 3);
  assert.match(refuse(trace, 'IMPORT_SHAPE', ['bank-dispute#0']).message, /baseline\/traces\/bank-dispute_rep0\.json: the key "content" is given twice in the object at \/2/);
  // A key spelled with an escape is the same key.
  const escaped = copy();
  const escapedPath = tracePath(escaped, 'bank-dispute', 0);
  writeFileSync(escapedPath, readFileSync(escapedPath, 'utf8').replace('"role": "assistant",', '"role": "assistant",\n    "\\u0072ole": "user",'));
  assert.match(refuse(escaped, 'IMPORT_SHAPE', ['bank-dispute#0']).message, /the key "role" is given twice in the object at \/2/);
});
