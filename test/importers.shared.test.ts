import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { callShapeHash, NOT_SENT, sha256Hex, validateCallShape } from '../src/index.ts';
import { caseSetHash, parseRunArtifact, RUN_SCHEMA } from '../src/artifact.ts';
import { duplicateKeyProblem, hashOf, parseJsonText } from '../src/identity.ts';
import { callShapesFor, gradedAttempt, makeJudgedIdentity, ownStderr, PACKET, slot } from './helpers.ts';
import {
  agreeSkeleton,
  assertBarHasLabels,
  buildCases,
  checkForward,
  checkGraderConfig,
  graderAdmission,
  graderBaseUrlProblem,
  graderConfigProblems,
  GRADER_KEY_ENV_NAME,
  GRADER_LOOPBACK_HOSTS,
  illFormedLineRefusal,
  illFormedProblems,
  decodeUtf8,
  inputJsonText,
  isCount,
  isEntryPoint,
  parseJsonStrict,
  positiveIntFlag,
  runImporter,
  checkRecordSet,
  defineSkeleton,
  endpointProblem,
  GRADER_CONFIG_KEYS,
  GRADER_DEFAULTS,
  GRADER_NAME,
  IMPORT_EXIT_INTERNAL,
  READINGS,
  readUnderRule,
  readSlot,
  RECORD_SCHEMA_PREVIOUS,
  thinkingRepliesLine,
  IMPORT_FLAGS,
  ImportInputError,
  ImportRefusal,
  ImportUsageError,
  IMPORT_REFUSAL_CODES,
  judgeHarnessVersion,
  judgeStopOf,
  loadBar,
  noRecordRefusal,
  oneValue,
  parseCasesFile,
  parseCasesFileShape,
  parseJsonlSourceFile,
  templateProblem,
  READING_JSON_OBJECT,
  READING_JSON_OBJECT_OR_FENCE,
  readableUnderOtherRule,
  parseImporterFlags,
  parseFlagList,
  IMPORTER_FLAGS,
  parseRecord,
  parseSourceFile,
  problemField,
  RECORD_SCHEMA,
  renderSkeleton,
  skeletonFromTemplate,
  STOP_MAP,
  ungradedReason,
  ungradedRefusal,
  valueTypeProblems,
  writeRun,
} from '../examples/importers/shared.ts';
import { attemptsOf, NEXT_STEP_LINE, NO_RESPONSE, REASK_CEILING, REASK_REASONS, reaskProblems, reasksLine, slotLabel, successLines, TIMEOUT_MS_CEILING } from '../examples/importers/shared.ts';
import type { GraderRecord, RecordedSlot, SkeletonRow } from '../examples/importers/shared.ts';

// ---- builders (synthetic customer-support refund bot) ------------------------------------------------------------

const GRADER_SHA = sha256Hex('grader file');
const judgeShape = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'anchorset.callshape/v1',
  endpoint: 'http://127.0.0.1:8099/v1/messages',
  apiVersion: '2023-06-01',
  betaFlags: NOT_SENT,
  thinkingMode: NOT_SENT,
  thinkingBudgetTokens: NOT_SENT,
  effort: NOT_SENT,
  toolChoice: NOT_SENT,
  toolChoiceName: NOT_SENT,
  strictTools: NOT_SENT,
  parallelToolUse: NOT_SENT,
  temperature: 0.7,
  topP: NOT_SENT,
  topK: NOT_SENT,
  frequencyPenalty: NOT_SENT,
  presencePenalty: NOT_SENT,
  samplingSeed: NOT_SENT,
  maxOutputTokens: 256,
  stopSequences: NOT_SENT,
  responseFormat: NOT_SENT,
  contextPolicy: 'none',
  stream: NOT_SENT,
  timeoutMs: 30000,
  extras: {},
  ...over,
});

const ONE_OBJECT = 'one-json-object-boolean-pass/v1';
const OR_FENCE = 'one-json-object-boolean-pass-or-json-fence/v1';
const sentOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ system: NOT_SENT, user: sha256Hex('a'), thinking: NOT_SENT, output_config: NOT_SENT, ...over });

const record = (seq: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: RECORD_SCHEMA,
  grader: { name: 'anchorset-recording-grader', language: 'js', sha256: GRADER_SHA, runtime: 'node v24.0.0' },
  graderRunId: 'run-1',
  callSeq: seq,
  callId: `call-${seq}`,
  promptSha256: sha256Hex(`prompt ${seq}`),
  sent: { system: NOT_SENT, user: sha256Hex(`prompt ${seq}`), thinking: NOT_SENT, output_config: NOT_SENT },
  requestedModel: 'judge-alias',
  servedModel: 'judge-2026-01-01',
  responseId: `msg-${seq}`,
  stopReason: 'end_turn',
  contentTypes: ['text'],
  thinkingTokens: 0,
  usage: { input_tokens: 100, output_tokens: 20 },
  reply: '{"pass": true, "reason": "refund is allowed"}',
  callShape: judgeShape(),
  reask: { max: 0, earlier: [] },
  ...over,
});

const parsed = (seq: number, over: Record<string, unknown> = {}): GraderRecord => parseRecord(record(seq, over), 'rows[0].graderEvidence', 'promptfoo');

function refusal(fn: () => unknown): ImportRefusal {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ImportRefusal, `expected an ImportRefusal, got ${String(e)}`);
    return e;
  }
  assert.fail('expected a refusal');
}
const refuses = (code: string, fields: string[], fn: () => unknown): ImportRefusal => {
  const r = refusal(fn);
  assert.equal(r.code, code);
  assert.deepEqual([...r.fields], fields);
  assert.ok(r.message.startsWith(`${code}: `));
  return r;
};

// ---- the refusal type -----------------------------------------------------------------------------------------

test('ImportRefusal carries its code and fields, and there are twenty-two codes', () => {
  assert.equal(IMPORT_REFUSAL_CODES.length, 22);
  assert.equal(new Set(IMPORT_REFUSAL_CODES).size, 22);
  const r = new ImportRefusal('IMPORT_SHAPE', ['a.b'], 'a.b: expected string, found number');
  assert.equal(r.code, 'IMPORT_SHAPE');
  assert.deepEqual([...r.fields], ['a.b']);
  assert.equal(r.message, 'IMPORT_SHAPE: a.b: expected string, found number');
});

// ---- the source file: IMPORT_SHAPE -----------------------------------------------------------------------------

test('parseSourceFile returns the parsed JSON and the sha256 of the bytes', () => {
  const bytes = new TextEncoder().encode('{"a": 1}');
  const r = parseSourceFile(bytes, 'out.json', 'promptfoo');
  assert.deepEqual(r.json, { a: 1 });
  assert.equal(r.sha256, sha256Hex(bytes));
});

test('IMPORT_SHAPE: a zip file names the script', () => {
  const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
  const r = refuses('IMPORT_SHAPE', ['x.eval'], () => parseSourceFile(zip, 'x.eval', 'inspect'));
  assert.match(r.message, /examples\/importers\/inspect\/regrade\.py/);
});

test('IMPORT_SHAPE: a .jsonl file', () => {
  refuses('IMPORT_SHAPE', ['x.jsonl'], () => parseSourceFile(new TextEncoder().encode('{"a":1}\n'), 'x.jsonl', 'promptfoo'));
});

test('IMPORT_SHAPE: a bare NaN adds its own sentence; plain bad text does not', () => {
  const nan = refuses('IMPORT_SHAPE', ['log.json'], () => parseSourceFile(new TextEncoder().encode('{"value": NaN}'), 'log.json', 'inspect'));
  assert.match(nan.message, /bare NaN, which this tool writes for a grade it could not read; such a log cannot be imported/);
  const plain = refuses('IMPORT_SHAPE', ['log.json'], () => parseSourceFile(new TextEncoder().encode('not json'), 'log.json', 'inspect'));
  assert.doesNotMatch(plain.message, /bare NaN/);
});

test('a score that holds the text of the internal NaN marker, beside a bare NaN elsewhere, does not make a sample ungraded: the refusal says only what is true', () => {
  // A bare NaN outside every sample's scores, and a score that is, as text, exactly what the reader writes in place of a NaN
  // (spelled in two ways, one of them with an escaped letter, so that no search for one spelling finds it). Neither sample
  // holds a bare NaN as its score, so none may be named as one.
  for (const mark of ['\\u0000anchorset: bare NaN', '\\u0000anchorset: bare \\u004eaN']) {
    const text = `{"note": NaN, "samples": [{"id": "c1", "epoch": 1, "scores": {"model_graded_qa": {"value": "${mark}"}}}]}`;
    const r = refuses('IMPORT_SHAPE', ['log.json'], () => parseSourceFile(new TextEncoder().encode(text), 'log.json', 'inspect'));
    assert.match(r.message, /bare NaN, which this tool writes for a grade it could not read; such a log cannot be imported/);
    assert.doesNotMatch(r.message, /as the score of this sample/);
  }
  // A real NaN as a score with a marker-like string beside it: which of the two is the NaN cannot be told, so no slot is named
  // (fail closed: the file is still refused whole, with the plain words).
  const both = '{"samples": [{"id": "c1", "epoch": 1, "scores": {"model_graded_qa": {"value": NaN}}}, {"id": "c2", "epoch": 1, "scores": {"model_graded_qa": {"value": "\\u0000anchorset: bare NaN"}}}]}';
  const r = refuses('IMPORT_SHAPE', ['log.json'], () => parseSourceFile(new TextEncoder().encode(both), 'log.json', 'inspect'));
  assert.doesNotMatch(r.message, /c1#0|c2#0/);
  // Without the marker's words the real thing still names its slot.
  const real = '{"samples": [{"id": "c1", "epoch": 1, "scores": {"model_graded_qa": {"value": NaN}}}]}';
  const named = refuses('IMPORT_UNGRADED', ['c1#0'], () => parseSourceFile(new TextEncoder().encode(real), 'log.json', 'inspect'));
  assert.match(named.message, /c1#0/);
});

// ---- the stop map ---------------------------------------------------------------------------------------------

test('the stop map is closed: end_turn maps to end, every other word has no mapping', () => {
  assert.deepEqual(STOP_MAP, { end_turn: 'end' });
  assert.equal(judgeStopOf('end_turn'), 'end');
  for (const w of ['max_tokens', 'refusal', 'stop_sequence', 'tool_use', 'pause_turn', 'end', 'toString', '__proto__', '']) assert.equal(judgeStopOf(w), undefined, w);
});

test('ungradedReason names a non-completing stop and non-text content in the record\'s words', () => {
  assert.equal(ungradedReason(parsed(1)), undefined);
  assert.match(ungradedReason(parsed(1, { stopReason: 'max_tokens' })) ?? '', /"max_tokens"/);
  assert.match(ungradedReason(parsed(1, { stopReason: 'tool_use' })) ?? '', /"tool_use"/);
  assert.match(ungradedReason(parsed(1, { contentTypes: ['text', 'text'] })) ?? '', /one text block/);
  assert.match(ungradedReason(parsed(1, { contentTypes: ['tool_use'] })) ?? '', /tool_use/);
  assert.match(ungradedReason(parsed(1, { contentTypes: [] })) ?? '', /one text block/);
});

test('IMPORT_UNGRADED lists every slot, with the keep-the-file message and no instruction to run again', () => {
  const r = refuses('IMPORT_UNGRADED', ['r1#0', 'r2#1'], () => {
    throw ungradedRefusal([
      { caseId: 'r1', draw: 0, reason: 'the judge stopped with "max_tokens"' },
      { caseId: 'r2', draw: 1, reason: 'graderError' },
    ]);
  });
  assert.match(r.message, /2 slot\(s\) hold no finished, readable grade/);
  assert.match(r.message, /r1#0 \(the judge stopped with "max_tokens"\)/);
  assert.match(r.message, /r2#1 \(graderError\)/);
  assert.match(r.message, /Nothing was written\. Keep this file/);
  assert.doesNotMatch(r.message, /run (it |the re-grade )?again/i);
});

// ---- the record: IMPORT_NO_RECORD and IMPORT_EVIDENCE --------------------------------------------------------------

test('a valid record parses and is returned unchanged', () => {
  const rec = record(1);
  assert.deepEqual(parseRecord(rec, 'p', 'promptfoo'), rec as unknown as GraderRecord);
});

test('IMPORT_NO_RECORD: no record, or a record of another schema; the message names the example grader of the tool', () => {
  for (const raw of [undefined, null, 'x', {}, record(1, { schema: 'example.grader-evidence/v8' })]) {
    const r = refuses('IMPORT_NO_RECORD', ['rows[3].graderEvidence'], () => parseRecord(raw, 'rows[3].graderEvidence', 'promptfoo'));
    assert.match(r.message, /examples\/importers\/promptfoo\/grader-provider\.cjs/);
  }
  const r = refuses('IMPORT_NO_RECORD', ['s'], () => {
    throw noRecordRefusal('inspect', 's');
  });
  assert.match(r.message, /examples\/importers\/inspect\/recording_grader\.py/);
});

test('IMPORT_EVIDENCE: a served model of UNKNOWN, in any spelling, names the field', () => {
  for (const v of ['UNKNOWN', 'unknown', 'Un-Known']) {
    refuses('IMPORT_EVIDENCE', ['p.servedModel'], () => parseRecord(record(1, { servedModel: v }), 'p', 'promptfoo'));
  }
});

test('IMPORT_EVIDENCE: a missing key and an unknown key', () => {
  const rec = record(1);
  delete rec['responseId'];
  refuses('IMPORT_EVIDENCE', ['p.responseId'], () => parseRecord(rec, 'p', 'promptfoo'));
  refuses('IMPORT_EVIDENCE', ['p.extra'], () => parseRecord(record(1, { extra: 1 }), 'p', 'promptfoo'));
});

test('IMPORT_EVIDENCE: a null in a judge field, at any depth', () => {
  refuses('IMPORT_EVIDENCE', ['p.stopReason'], () => parseRecord(record(1, { stopReason: null }), 'p', 'promptfoo'));
  const e = refusal(() => parseRecord(record(1, { callShape: judgeShape({ topP: null }) }), 'p', 'promptfoo'));
  assert.equal(e.code, 'IMPORT_EVIDENCE');
  assert.ok(e.fields.includes('p.callShape.topP'));
});

test('IMPORT_EVIDENCE: the value types of the record (non-finite number, integer beyond 2^53, bad callSeq)', () => {
  assert.ok(refusal(() => parseRecord(record(1, { callShape: judgeShape({ temperature: Infinity }) }), 'p', 'promptfoo')).fields.includes('p.callShape.temperature'));
  assert.ok(refusal(() => parseRecord(record(1, { callShape: judgeShape({ maxOutputTokens: 2 ** 53 }) }), 'p', 'promptfoo')).fields.includes('p.callShape.maxOutputTokens'));
  refuses('IMPORT_EVIDENCE', ['p.callSeq'], () => parseRecord(record(0), 'p', 'promptfoo'));
  refuses('IMPORT_EVIDENCE', ['p.callSeq'], () => parseRecord(record(1.5), 'p', 'promptfoo'));
});

test('IMPORT_EVIDENCE: hashes must be full sha256, and sent.system may be a hash or NOT_SENT only', () => {
  refuses('IMPORT_EVIDENCE', ['p.promptSha256'], () => parseRecord(record(1, { promptSha256: sha256Hex('x').slice(0, 12) }), 'p', 'promptfoo'));
  refuses('IMPORT_EVIDENCE', ['p.sent.user'], () => parseRecord(record(1, { sent: sentOf({ user: 'abc' }) }), 'p', 'promptfoo'));
  refuses('IMPORT_EVIDENCE', ['p.sent.system'], () => parseRecord(record(1, { sent: sentOf({ system: 'UNKNOWN' }) }), 'p', 'promptfoo'));
  assert.equal(parseRecord(record(1, { sent: sentOf({ system: sha256Hex('s') }) }), 'p', 'promptfoo').sent.system, sha256Hex('s'));
  refuses('IMPORT_EVIDENCE', ['p.grader.sha256'], () => parseRecord(record(1, { grader: { name: 'g', language: 'js', sha256: 'abc', runtime: 'node v24' } }), 'p', 'promptfoo'));
  refuses('IMPORT_EVIDENCE', ['p.grader.language'], () => parseRecord(record(1, { grader: { name: 'g', language: 'ruby', sha256: GRADER_SHA, runtime: 'node v24' } }), 'p', 'promptfoo'));
});

test('IMPORT_EVIDENCE: a call shape that does not validate, with a key removed or one key UNKNOWN', () => {
  const missing = judgeShape();
  delete missing['topK'];
  assert.ok(refusal(() => parseRecord(record(1, { callShape: missing }), 'p', 'promptfoo')).fields.includes('p.callShape.topK'));
  const gap = refuses('IMPORT_EVIDENCE', ['p.callShape'], () => parseRecord(record(1, { callShape: judgeShape({ topK: 'UNKNOWN' }) }), 'p', 'promptfoo'));
  assert.match(gap.message, /hashes to "UNKNOWN"/);
  // a call shape with every key UNKNOWN is valid for the library and still refused here
  refuses('IMPORT_EVIDENCE', ['p.callShape'], () => parseRecord(record(1, { callShape: judgeShape({ extras: 'UNKNOWN' }) }), 'p', 'promptfoo'));
});

test('IMPORT_EVIDENCE: an endpoint with user information, a query or a fragment', () => {
  for (const endpoint of ['http://user:pw@127.0.0.1:8099/v1/messages', 'http://user@127.0.0.1/v1/messages', 'http://127.0.0.1:8099/v1/messages?key=1', 'http://127.0.0.1:8099/v1/messages#x']) {
    refuses('IMPORT_EVIDENCE', ['p.callShape.endpoint'], () => parseRecord(record(1, { callShape: judgeShape({ endpoint }) }), 'p', 'promptfoo'));
  }
  assert.equal(endpointProblem('https://api.example.test/v1/messages'), undefined);
  assert.equal(endpointProblem('ftp://x/y'), 'is not http or https');
  assert.equal(endpointProblem(''), 'must be a non-empty string');
});

// ---- the record set: HIDDEN_CALLS, DUPLICATE_CALL, MIXED_IDENTITY ----------------------------------------------------

const slotsOf = (n: number, over: (i: number) => Record<string, unknown> = () => ({})): RecordedSlot[] =>
  Array.from({ length: n }, (_, i) => ({ caseId: `r${Math.floor(i / 3)}`, draw: i % 3, record: parsed(i + 1, over(i)) }));

test('checkRecordSet accepts one process, callSeq 1 to n each once (in any order), distinct ids', () => {
  const slots = slotsOf(9);
  checkRecordSet(slots);
  checkRecordSet([...slots].reverse());
});

test('IMPORT_HIDDEN_CALLS: a hole in callSeq (1,2,3,5,...)', () => {
  const r = refuses('IMPORT_HIDDEN_CALLS', ['callSeq'], () => checkRecordSet(slotsOf(5, (i) => ({ callSeq: i < 4 ? i + 1 : 6 }))));
  assert.match(r.message, /callSeq values are not 1 to 5, each once: 1, 2, 3, 4, 6/);
  assert.doesNotMatch(r.message, /grader calls for/);
});

test('a duplicated callSeq does not say "the records show 9 grader calls for 9 slots"; it lists the values', () => {
  const r = refuses('IMPORT_HIDDEN_CALLS', ['callSeq'], () => checkRecordSet(slotsOf(3, (i) => ({ callSeq: i === 2 ? 2 : i + 1 }))));
  assert.match(r.message, /callSeq values are not 1 to 3, each once: 1, 2, 2/);
});

test('IMPORT_HIDDEN_CALLS: a repeated callSeq, and a sequence that does not start at 1', () => {
  refuses('IMPORT_HIDDEN_CALLS', ['callSeq'], () => checkRecordSet(slotsOf(3, (i) => ({ callSeq: i === 2 ? 2 : i + 1 }))));
  refuses('IMPORT_HIDDEN_CALLS', ['callSeq'], () => checkRecordSet(slotsOf(3, (i) => ({ callSeq: i + 2 }))));
});

test('IMPORT_HIDDEN_CALLS: two grader processes', () => {
  const r = refuses('IMPORT_HIDDEN_CALLS', ['graderRunId'], () => checkRecordSet(slotsOf(3, (i) => ({ graderRunId: i === 2 ? 'run-2' : 'run-1' }))));
  assert.match(r.message, /two grader processes wrote this file/);
});

test('IMPORT_DUPLICATE_CALL: two slots share a callId, and two share a responseId', () => {
  refuses('IMPORT_DUPLICATE_CALL', ['r0#0', 'r0#1', 'r0#2'], () => checkRecordSet(slotsOf(3, () => ({ callId: 'same' }))));
  refuses('IMPORT_DUPLICATE_CALL', ['r0#1', 'r0#2'], () => checkRecordSet(slotsOf(3, (i) => ({ responseId: i === 0 ? 'msg-a' : 'msg-b' }))));
});

test('IMPORT_MIXED_IDENTITY: rows that disagree on a judge field, the call shape, or the grader file', () => {
  const alt = (i: number, over: Record<string, unknown>): Record<string, unknown> => (i === 1 ? over : {});
  refuses('IMPORT_MIXED_IDENTITY', ['servedModel'], () => checkRecordSet(slotsOf(3, (i) => alt(i, { servedModel: 'judge-2026-02-02' }))));
  refuses('IMPORT_MIXED_IDENTITY', ['requestedModel'], () => checkRecordSet(slotsOf(3, (i) => alt(i, { requestedModel: 'other-alias' }))));
  refuses('IMPORT_MIXED_IDENTITY', ['callShape'], () => checkRecordSet(slotsOf(3, (i) => alt(i, { callShape: judgeShape({ temperature: 0.2 }) }))));
  refuses('IMPORT_MIXED_IDENTITY', ['grader.sha256'], () => checkRecordSet(slotsOf(3, (i) => alt(i, { grader: { name: 'anchorset-recording-grader', language: 'js', sha256: sha256Hex('edited'), runtime: 'node v24.0.0' } }))));
  refuses('IMPORT_MIXED_IDENTITY', ['grader.runtime'], () => checkRecordSet(slotsOf(3, (i) => alt(i, { grader: { name: 'anchorset-recording-grader', language: 'js', sha256: GRADER_SHA, runtime: 'node v24.1.0' } }))));
});

test('oneValue returns the one value, by canonical JSON, and counts the distinct values otherwise', () => {
  assert.deepEqual(oneValue('f', [{ b: 1, a: 2 }, { a: 2, b: 1 }]), { b: 1, a: 2 });
  const r = refuses('IMPORT_MIXED_IDENTITY', ['f'], () => oneValue('f', ['x', 'y', 'z', 'x']));
  assert.match(r.message, /f: 3 distinct values/);
  refuses('IMPORT_MIXED_IDENTITY', ['f'], () => oneValue('f', []));
});

test('judgeHarnessVersion is built from the record only', () => {
  assert.equal(judgeHarnessVersion('promptfoo', '0.123.1', parsed(1)), `promptfoo 0.123.1; anchorset-recording-grader js sha256:${GRADER_SHA}; node v24.0.0; max-reasks 0`);
});

// ---- the skeleton rule -------------------------------------------------------------------------------

const comps = (output: string, rubric: string) => [
  { name: 'output', value: output },
  { name: 'rubric', value: rubric },
];
/** A grading prompt as the tool lays it out: a system message and a user message. */
const prompt = (output: string, rubric: string): string[] => [`You grade a support reply. Rubric: ${rubric}`, `Reply to grade: ${output}\nRespond with JSON.`];
const row = (label: string, output: string, rubric = 'the reply states the refund window'): SkeletonRow => ({ label, contents: prompt(output, rubric), components: comps(output, rubric) });

test('defineSkeleton replaces each component by a typed slot, and renders forward to the same text', () => {
  const r = row('r1#0', 'Refunds take 5 days.');
  const s = defineSkeleton(r.contents, r.components);
  assert.deepEqual(s, [
    ['You grade a support reply. Rubric: ', { slot: 'rubric' }, ''],
    ['Reply to grade: ', { slot: 'output' }, '\nRespond with JSON.'],
  ]);
  assert.deepEqual(renderSkeleton(s ?? [], { output: 'Refunds take 5 days.', rubric: 'the reply states the refund window' }), r.contents);
});

test('AB and BA give different skeletons', () => {
  const ab = defineSkeleton(['<<alpha>> then <<beta>>'], [{ name: 'a', value: 'alpha' }, { name: 'b', value: 'beta' }]);
  const ba = defineSkeleton(['<<beta>> then <<alpha>>'], [{ name: 'a', value: 'alpha' }, { name: 'b', value: 'beta' }]);
  assert.ok(ab !== undefined && ba !== undefined);
  assert.notDeepEqual(ab, ba);
  const rows: SkeletonRow[] = [
    { label: 'x#0', contents: ['<<alpha>> then <<beta>>'], components: [{ name: 'a', value: 'alpha' }, { name: 'b', value: 'beta' }] },
    { label: 'x#1', contents: ['<<beta>> then <<alpha>>'], components: [{ name: 'a', value: 'alpha' }, { name: 'b', value: 'beta' }] },
  ];
  refuses('IMPORT_PACKET', ['x#0', 'x#1'], () => agreeSkeleton(rows));
});

test('each condition of step 1 fails on its own construction', () => {
  const two = (a: string, b: string) => [{ name: 'a', value: a }, { name: 'b', value: b }];
  // an empty component
  assert.equal(defineSkeleton(['hello'], two('', 'hello')), undefined);
  // a component that does not occur
  assert.equal(defineSkeleton(['hello'], two('hello', 'zzz')), undefined);
  // a component that occurs twice (here also in the fixed text)
  assert.equal(defineSkeleton(['Yes or no? Yes', 'rubric text'], two('Yes', 'rubric text')), undefined);
  // an occurrence inside another component
  assert.equal(defineSkeleton(['say refund window now'], two('refund window', 'refund')), undefined);
  // overlapping occurrences
  assert.equal(defineSkeleton(['abcdef'], two('abcd', 'cdef')), undefined);
  // overlapping occurrences of one component count as more than one
  assert.equal(defineSkeleton(['aaa'], [{ name: 'a', value: 'aa' }]), undefined);
  // equal components occur twice
  assert.equal(defineSkeleton(['same same'], two('same', 'same')), undefined);
  // the holding case
  assert.notEqual(defineSkeleton(['left alpha mid beta right'], two('alpha', 'beta')), undefined);
  // occurrences in two different messages are counted over the whole list
  assert.equal(defineSkeleton(['one alpha', 'two alpha'], two('alpha', 'one')), undefined);
});

test('a file in which one row defines the skeleton and the others only render imports', () => {
  const rows = [row('r1#0', 'Refunds take 5 days.'), row('r1#1', 'Yes'), row('r2#0', 'Yes or no? Yes, the window is 30 days.')];
  // row r1#1 : "Yes" does not occur in the fixed text, but "Respond with JSON." contains no "Yes"; make a short output that does:
  const short = row('r3#0', 'e', 'the reply states the refund window');
  const skeleton = agreeSkeleton([...rows, short]);
  assert.equal(skeleton.length, 2);
  // the short output occurs several times in the fixed text, so that row cannot define a skeleton itself
  assert.equal(defineSkeleton(short.contents, short.components), undefined);
  checkForward(skeleton, [short]);
});

test('an answer that contains its target, a one-character target and an answer equal to its target render equal under a template', () => {
  const template = 'Question: {question}\nAnswer: {answer}\nCriterion: {criterion}\n{instructions}';
  const skeleton = skeletonFromTemplate(template, ['question', 'answer', 'criterion', 'instructions']);
  const make = (question: string, answer: string, criterion: string, instructions = 'Grade it.'): SkeletonRow => ({
    label: `${question}`,
    contents: [renderSkeleton(skeleton, { question, answer, criterion, instructions })[0] as string],
    components: [{ name: 'question', value: question }, { name: 'answer', value: answer }, { name: 'criterion', value: criterion }, { name: 'instructions', value: instructions }],
  });
  checkForward(skeleton, [
    make('How many days?', 'The answer is 4.', '4'),
    make('Window?', 'refund', 'refund'),
    make('Is it 7 days? Yes or no.', 'Is it 7 days? Yes or no.', 'no'),
    make('Q', '{answer}', '{criterion}'),
  ]);
});

test('single-pass rendering: a value that holds a slot name is not substituted again', () => {
  const s = skeletonFromTemplate('A: {answer} C: {criterion}', ['answer', 'criterion']);
  assert.deepEqual(renderSkeleton(s, { answer: '{criterion}', criterion: 'X' }), ['A: {criterion} C: X']);
  assert.deepEqual(skeletonFromTemplate('keeps {other} as text', ['answer']), [['keeps {other} as text']]);
});

test('IMPORT_PACKET: no row defines a skeleton, and the message says how often each component occurs', () => {
  // every output contains the rubric
  const rubric = 'refund window';
  const rows = ['r1#0', 'r1#1'].map((l) => row(l, `The ${rubric} is 30 days`, rubric));
  const r = refuses('IMPORT_PACKET', ['output', 'rubric'], () => agreeSkeleton(rows));
  assert.match(r.message, /no row fixes the prompt's skeleton: on every row output occurs 1 times; rubric occurs 2 times/);
});

test('IMPORT_PACKET: two rows define different skeletons', () => {
  const a = row('r1#0', 'Refunds take 5 days.');
  const b: SkeletonRow = { label: 'r1#1', contents: ['Different layout. Rubric: the reply states the refund window', 'Reply: Refunds take 6 days.'], components: comps('Refunds take 6 days.', 'the reply states the refund window') };
  const r = refuses('IMPORT_PACKET', ['r1#0', 'r1#1'], () => agreeSkeleton([a, b]));
  assert.match(r.message, /2 different skeletons/);
});

test('IMPORT_PACKET: a row whose rendering differs by one character, with its position; every such row is listed', () => {
  const good = row('r1#0', 'Refunds take 5 days.');
  const edited = row('r1#1', 'e');
  edited.contents = [edited.contents[0] as string, (edited.contents[1] as string).replace('Respond', 'Respons')];
  const edited2 = row('r2#0', 'e');
  edited2.contents = [(edited2.contents[0] as string).replace('Rubric', 'Rubrik'), edited2.contents[1] as string];
  const r = refuses('IMPORT_PACKET', ['r1#1', 'r2#0'], () => agreeSkeleton([good, edited, edited2]));
  const msg = r.message;
  assert.match(msg, /r1#1: the prompt differs from the skeleton filled with this row's parts, at message 1, position 24/);
  assert.match(msg, /r2#0: .* at message 0, position 32/);
});

test('IMPORT_PACKET: a row with another number of messages differs', () => {
  const good = row('r1#0', 'Refunds take 5 days.');
  const one = row('r1#1', 'e');
  one.contents = [(one.contents[0] as string) + (one.contents[1] as string)];
  const r = refuses('IMPORT_PACKET', ['r1#1'], () => agreeSkeleton([good, one]));
  assert.match(r.message, /message count 1, skeleton has 2/);
});

test('adversarial outputs (built here, not the experiments\' own): with one clean row each renders equal and imports; alone, the ones that cannot fix a skeleton refuse', () => {
  const rubric = 'the reply states the refund window';
  const base = row('base#0', 'Refunds take 5 days.', rubric);
  const cases: [string, string, 'imports' | 'refuses'][] = [
    ['an output that is the rubric', rubric, 'refuses'],
    ['an output that contains the rubric', `We say: ${rubric}.`, 'refuses'],
    ['an output that is a prefix of the rubric text', 'the reply states', 'refuses'],
    ['an output equal to a fragment of the fixed text', 'Respond with JSON.', 'refuses'],
    ['a short output that also occurs in the fixed text', 'e', 'refuses'],
    ['an empty output', '', 'refuses'],
    ['an output of "Yes"', 'Yes', 'imports'],
    ['an output with the layout text of the user message', 'Reply to grade: x', 'imports'],
  ];
  for (const [name, output, alone] of cases) {
    // the prompt is what the tool really rendered: the layout filled with this output
    const r = row('adv#0', output, rubric);
    assert.doesNotThrow(() => agreeSkeleton([base, r]), `${name}: with a clean row beside it`);
    if (alone === 'imports') assert.doesNotThrow(() => agreeSkeleton([r]), `${name}: alone`);
    else assert.equal(refusal(() => agreeSkeleton([r])).code, 'IMPORT_PACKET', `${name}: alone`);
  }
});

test('an output the tool changed when it rendered it again differs under the forward check', () => {
  const good = row('r1#0', 'Refunds take 5 days.');
  const json = row('r1#1', '{"a":1}');
  // the tool re-rendered the JSON text with spaces, so the prompt holds another text than the output
  json.contents = [json.contents[0] as string, 'Reply to grade: {"a": 1}\nRespond with JSON.'];
  refuses('IMPORT_PACKET', ['r1#1'], () => agreeSkeleton([good, json]));
});

// ---- cases.json, the bar, the roster --------------------------------------------------------------------------------

const BAR = { labels: ['fail', 'pass'], classes: { refunds: { direction: 'floor', minPassRate: 0.5 } }, knownFailures: [] };
const barText = JSON.stringify(BAR);

test('loadBar parses a bar and turns the library\'s problems into an input error', () => {
  assert.deepEqual(loadBar(barText).labels, ['fail', 'pass']);
  const e = (() => {
    try {
      loadBar('{"labels": []}');
    } catch (x) {
      return x;
    }
    return undefined;
  })();
  assert.ok(e instanceof ImportInputError);
  assert.ok(e.problems.some((p) => p.startsWith('bar.labels')));
  assert.throws(() => loadBar('{'), ImportInputError);
});

test('parseCasesFile returns the stated class and label per case', () => {
  const bar = loadBar(barText);
  assert.deepEqual(parseCasesFile('{"r1": {"klass": "refunds", "expect": "pass"}, "r2": {"klass": "refunds", "expect": "fail"}}', bar), {
    r1: { klass: 'refunds', expect: 'pass' },
    r2: { klass: 'refunds', expect: 'fail' },
  });
});

test('parseCasesFile is an input error (not a refusal) for each way a cases file does not validate, listing every problem', () => {
  const bar = loadBar(barText);
  const problemsOf = (text: string): readonly string[] => {
    try {
      parseCasesFile(text, bar);
    } catch (e) {
      assert.ok(e instanceof ImportInputError, String(e));
      return e.problems;
    }
    return assert.fail('expected an input error');
  };
  assert.match(problemsOf('[]').join(), /expected object, found array/);
  assert.match(problemsOf('{}').join(), /at least one case/);
  assert.match(problemsOf('{"r1": null}').join(), /expected object, found null/);
  assert.match(problemsOf('{"r1": {"klass": "refunds"}}').join(), /expect: must be a non-empty string/);
  assert.match(problemsOf('{"r1": {"klass": null, "expect": "pass"}}').join(), /null is not allowed/);
  assert.match(problemsOf('{"r1": {"klass": "other", "expect": "pass"}}').join(), /"other" is not a class of the bar/);
  assert.match(problemsOf('{"r1": {"klass": "refunds", "expect": "maybe"}}').join(), /"maybe" is not a label of the bar/);
  assert.match(problemsOf('{"r1": {"klass": "refunds", "expect": "pass", "note": "x"}}').join(), /note: unknown field/);
  assert.match(problemsOf('{"": {"klass": "refunds", "expect": "pass"}}').join(), /must not be empty/);
  assert.match(problemsOf('{"r1": {"klass": "x", "expect": "y"}, "r2": 1}').join(), /r2.*expected object/);
  assert.equal(problemsOf('{"r1": {"klass": "x", "expect": "y"}, "r2": 1}').length, 3);
  assert.match(problemsOf('{nope').join(), /cases: not JSON/);
  // a prototype-looking class name is not a class
  assert.match(problemsOf('{"r1": {"klass": "toString", "expect": "pass"}}').join(), /not a class of the bar/);
});

test('IMPORT_CASE_MISSING: a case of cases.json absent from the file, and a case in the file outside cases.json', () => {
  const bar = loadBar(barText);
  const cases = parseCasesFile('{"r1": {"klass": "refunds", "expect": "pass"}, "r2": {"klass": "refunds", "expect": "fail"}}', bar);
  const r = refuses('IMPORT_CASE_MISSING', ['r2'], () => buildCases(cases, new Map([['r1', 'in']])));
  assert.match(r.message, /in cases\.json but not in the file: r2/);
  const r2 = refuses('IMPORT_CASE_MISSING', ['r3'], () =>
    buildCases(cases, new Map([['r1', 'a'], ['r2', 'b'], ['r3', 'c']])));
  assert.match(r2.message, /in the file but not in cases\.json: r3/);
  const built = buildCases(cases, new Map<string, unknown>([['r2', { m: 'b' }], ['r1', 'a']]));
  assert.deepEqual(built, [
    { id: 'r1', klass: 'refunds', input: 'a', expect: 'pass' },
    { id: 'r2', klass: 'refunds', input: { m: 'b' }, expect: 'fail' },
  ]);
});

test('IMPORT_BAR: a label the importer writes that the bar lacks', () => {
  const bar = loadBar(barText);
  assertBarHasLabels(bar, ['pass', 'fail', 'pass']);
  const r = refuses('IMPORT_BAR', ['C'], () => assertBarHasLabels(bar, ['pass', 'C', 'C']));
  assert.match(r.message, /no label "C"/);
});

// ---- the writer -----------------------------------------------------------------------------------------------------

const wcases = [{ id: 'r1', klass: 'refunds', input: { question: 'Can I return it?' }, expect: 'pass' }];
function goodRun(label = 'pass'): Record<string, unknown> {
  const identity = makeJudgedIdentity({ caseSetHash: caseSetHash(wcases), drawsPerCase: 1, barHash: hashOf(BAR) });
  const run = {
    schema: RUN_SCHEMA,
    identity,
    callShapes: callShapesFor(identity),
    cases: wcases,
    draws: [slot('r1', 0, gradedAttempt(label, { judgeStop: 'end', packetHash: PACKET }))],
    packetBasis: 'declared',
    packetSource: 'computed at import from a test',
  };
  return run;
}
const scratch = (): string => mkdtempSync(join(tmpdir(), 'importers-shared-'));

test('writeRun writes the run after the parser accepts it, returns the sha256 of the bytes, and the file parses', () => {
  const out = join(scratch(), 'run.json');
  const bar = loadBar(barText);
  const w = writeRun(goodRun(), bar, out);
  const bytes = readFileSync(out);
  assert.equal(w.sha256, sha256Hex(bytes));
  assert.equal(w.sha256.length, 64);
  assert.equal(parseRunArtifact(JSON.parse(bytes.toString('utf8'))).schema, RUN_SCHEMA);
  assert.equal(callShapeHash(parseRunArtifact(JSON.parse(w.text)).callShapes.system), parseRunArtifact(JSON.parse(w.text)).identity.systemCallShapeHash);
});

test('writeRun is deterministic: the same run gives the same bytes, with no time and no path', () => {
  const dir = scratch();
  const bar = loadBar(barText);
  const a = writeRun(goodRun(), bar, join(dir, 'a.json'));
  const b = writeRun(goodRun(), bar, join(dir, 'b.json'));
  assert.equal(a.text, b.text);
  assert.equal(a.sha256, b.sha256);
  assert.ok(!a.text.includes(dir));
});

test('writeRun never overwrites --out: an existing file is a usage error and keeps its bytes', () => {
  const out = join(scratch(), 'run.json');
  writeFileSync(out, 'precious');
  assert.throws(() => writeRun(goodRun(), loadBar(barText), out), ImportUsageError);
  assert.equal(readFileSync(out, 'utf8'), 'precious');
});

test('IMPORT_SELF_CHECK: a run the parser rejects is refused with the parser\'s paths, and nothing is written', () => {
  const out = join(scratch(), 'run.json');
  const bad = goodRun();
  (bad['identity'] as Record<string, unknown>)['caseSetHash'] = sha256Hex('wrong');
  const r = refusal(() => writeRun(bad, loadBar(barText), out));
  assert.equal(r.code, 'IMPORT_SELF_CHECK');
  assert.deepEqual([...r.fields], ['artifact.identity.caseSetHash']);
  assert.equal(existsSync(out), false);
  const r2 = refusal(() => writeRun({ schema: 'nope' }, loadBar(barText), out));
  assert.equal(r2.code, 'IMPORT_SELF_CHECK');
  assert.ok(r2.fields.includes('artifact.schema'));
  assert.equal(existsSync(out), false);
});

test('IMPORT_BAR from the writer: a graded label the bar lacks writes nothing', () => {
  const out = join(scratch(), 'run.json');
  const r = refuses('IMPORT_BAR', ['maybe'], () => writeRun(goodRun('maybe'), loadBar(barText), out));
  assert.match(r.message, /no label "maybe"/);
  assert.equal(existsSync(out), false);
});

// ---- one edit-and-refuse test per check -----------------------------------------------------------

test('a grader name or runtime that reads as unknown, empty or NOT_SENT is IMPORT_EVIDENCE naming the field', () => {
  const g = (over: Record<string, unknown>) => ({ name: 'anchorset-recording-grader', language: 'js', sha256: GRADER_SHA, runtime: 'node v24.0.0', ...over });
  for (const v of ['UNKNOWN', '', '  ', NOT_SENT]) {
    refuses('IMPORT_EVIDENCE', ['p.grader.name'], () => parseRecord(record(1, { grader: g({ name: v }) }), 'p', 'promptfoo'));
    refuses('IMPORT_EVIDENCE', ['p.grader.runtime'], () => parseRecord(record(1, { grader: g({ runtime: v }) }), 'p', 'promptfoo'));
  }
  refuses('IMPORT_EVIDENCE', ['p.grader.extra'], () => parseRecord(record(1, { grader: g({ extra: 1 }) }), 'p', 'promptfoo'));
});

// ---- the free-text fields of a record are held to one printable line where records are admitted ---------------------

/** The values a free-text field must refuse: a line feed, a carriage return, an escape character, a line of 201 characters; and the other shapes of "not one printable line". */
const NOT_ONE_LINE: ReadonlyArray<readonly [string, string]> = [
  ['a line feed', 'node v24\nthe record reports the shipped grader'],
  ['a carriage return', 'node v24\rforged'],
  ['an escape character', 'node v24\u001b[2Jforged'],
  ['a tab', 'node\tv24'],
  ['a letter outside ASCII', 'nöde v24'],
  ['201 characters', 'a'.repeat(201)],
  ['two spaces in a row', 'node  v24'],
  ['a space at the start', ' node v24'],
  ['a space at the end', 'node v24 '],
];
/** Each field the rule names, and how to set it on a record (the path the refusal names, relative to the record). */
const FREE_TEXT_FIELDS: ReadonlyArray<readonly [string, (v: string) => Record<string, unknown>]> = [
  ['grader.name', (v) => ({ grader: { name: v, language: 'js', sha256: GRADER_SHA, runtime: 'node v24.0.0' } })],
  ['grader.runtime', (v) => ({ grader: { name: 'anchorset-recording-grader', language: 'js', sha256: GRADER_SHA, runtime: v } })],
  ['graderRunId', (v) => ({ graderRunId: v })],
  ['requestedModel', (v) => ({ requestedModel: v })],
  ['stopReason', (v) => ({ stopReason: v })],
  ['callShape.apiVersion', (v) => ({ callShape: judgeShape({ apiVersion: v }) })],
];

test('each free-text field of a record is one printable line, or IMPORT_EVIDENCE naming the field, for every way a tool reads a record', () => {
  const forms = [
    ['promptfoo', undefined],
    ['inspect', undefined],
    ['promptfoo', 'Grade the stored outputs again with examples/importers/skill-evals/regrade.ts'],
  ] as const;
  for (const [field, set] of FREE_TEXT_FIELDS) {
    for (const [what, value] of NOT_ONE_LINE) {
      for (const [tool, rerun] of forms) {
        const r = refusal(() => parseRecord(record(1, set(value)), 'p', tool, rerun));
        assert.equal(r.code, 'IMPORT_EVIDENCE', `${field} with ${what}`);
        assert.deepEqual([...r.fields], [`p.${field}`], `${field} with ${what}`);
        // the field's text is never echoed: a forged line cannot reach the terminal through the refusal either
        assert.equal(r.message.includes(value), false, `${field} with ${what}: the value is not echoed`);
      }
    }
  }
  // 200 characters and a plain value with single spaces are one printable line
  for (const [, set] of FREE_TEXT_FIELDS) {
    parseRecord(record(1, set('a'.repeat(200))), 'p', 'promptfoo');
    parseRecord(record(1, set('python 3.14.0')), 'p', 'inspect');
  }
});

test('a call shape that says a tool choice, a stop sequence, a format, a stream, thinking, an extra or a context was sent is IMPORT_EVIDENCE', () => {
  const sent: Record<string, unknown> = {
    toolChoice: 'any',
    toolChoiceName: 'x',
    strictTools: true,
    parallelToolUse: false,
    stopSequences: ['GRADE'],
    responseFormat: { kind: 'text' },
    stream: true,
    thinkingMode: 'adaptive',
    thinkingBudgetTokens: 1024,
    effort: 'high',
    betaFlags: ['x-beta'],
    topP: 0.9,
    topK: 5,
    frequencyPenalty: 0.1,
    presencePenalty: 0.1,
    samplingSeed: 7,
    contextPolicy: 'truncate-head',
    extras: { 'x.retry': 3 },
  };
  assert.equal(Object.keys(sent).length, 18);
  for (const [k, v] of Object.entries(sent)) {
    // The library's own call-shape rules tie toolChoiceName to a named tool choice and a thinking budget to a budgeted mode; each pair is set together.
    const over = k === 'toolChoiceName' ? { toolChoice: 'named', toolChoiceName: 'x' } : k === 'thinkingBudgetTokens' ? { thinkingMode: 'budgeted', thinkingBudgetTokens: 1024 } : { [k]: v };
    assert.deepEqual(validateCallShape(judgeShape(over), 's'), [], `${k}: the library accepts this shape, so only the importer's check can refuse it`);
    const r = refusal(() => parseRecord(record(1, { callShape: judgeShape(over) }), 'p', 'promptfoo'));
    assert.equal(r.code, 'IMPORT_EVIDENCE', k);
    assert.ok(r.fields.includes(`p.callShape.${k}`), `${k}: ${r.fields.join(', ')}`);
  }
  const one = refuses('IMPORT_EVIDENCE', ['p.callShape.stream'], () => parseRecord(record(1, { callShape: judgeShape({ stream: true }) }), 'p', 'promptfoo'));
  assert.match(one.message, /outside the one request/);
  // the keys a grader may set are free: temperature, maxOutputTokens, timeoutMs, apiVersion, endpoint
  parseRecord(record(1, { callShape: judgeShape({ temperature: 'NOT_SENT', maxOutputTokens: 9, timeoutMs: 5, apiVersion: '2024-01-01' }) }), 'p', 'promptfoo');
});

test('a record whose call shape states a deadline above 3600000 ms (one hour) is refused: the shipped graders refuse such a value before any call', () => {
  assert.equal(TIMEOUT_MS_CEILING, 3600000);
  parseRecord(record(1, { callShape: judgeShape({ timeoutMs: TIMEOUT_MS_CEILING }) }), 'p', 'promptfoo');
  parseRecord(record(1, { callShape: judgeShape({ timeoutMs: 1 }) }), 'p', 'inspect');
  // 2^31 ms and above is a deadline a JavaScript timer ran after 1 ms: a record that states it states a deadline no ask had.
  for (const timeoutMs of [3600001, 2 ** 31 - 1, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
    for (const tool of ['promptfoo', 'inspect'] as const) {
      const r = refuses('IMPORT_EVIDENCE', ['p.callShape.timeoutMs'], () => parseRecord(record(1, { callShape: judgeShape({ timeoutMs }) }), 'p', tool));
      assert.match(r.message, new RegExp(`p\\.callShape\\.timeoutMs: must be an integer from 1 to 3600000, the longest deadline the shipped graders take; found ${timeoutMs}`), `${tool} ${timeoutMs}`);
    }
  }
});

test('valueTypeProblems names a null, a non-finite number and an integer beyond 2^53, at any depth', () => {
  const out: string[] = [];
  valueTypeProblems({ a: null, b: [1, { c: 12345678901234567890 }], d: Infinity, e: 'x', f: 1.5 }, '/v', out);
  assert.deepEqual(out.map((p) => p.slice(0, p.indexOf(':'))), ['/v.a', '/v.b[1].c', '/v.d']);
});

test('a case id of __proto__ in cases.json is an input error, not a silently dropped case', () => {
  const bar = loadBar(barText);
  const text = '{"__proto__": {"klass": "refunds", "expect": "pass"}, "r1": {"klass": "refunds", "expect": "pass"}}';
  assert.throws(
    () => parseCasesFile(text, bar),
    (e: unknown) => e instanceof ImportInputError && e.problems.some((p) => p.includes('__proto__')),
  );
});

test('bytes that are not UTF-8, and a byte-order mark, are IMPORT_SHAPE; a plain file still parses', () => {
  const bad = Uint8Array.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
  const r = refuses('IMPORT_SHAPE', ['log.json'], () => parseSourceFile(bad, 'log.json', 'promptfoo'));
  assert.match(r.message, /UTF-8/);
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
  refuses('IMPORT_SHAPE', ['log.json'], () => parseSourceFile(bom, 'log.json', 'promptfoo'));
  assert.deepEqual(parseSourceFile(new TextEncoder().encode('{"a":"é"}'), 'log.json', 'promptfoo').json, { a: 'é' });
});

test('the bare-NaN sentence is added for an Inspect file only', () => {
  const bytes = new TextEncoder().encode('{"value": NaN}');
  assert.match(refuse2(() => parseSourceFile(bytes, 'f.json', 'inspect')), /bare NaN/);
  assert.doesNotMatch(refuse2(() => parseSourceFile(bytes, 'f.json', 'promptfoo')), /bare NaN/);
});
function refuse2(fn: () => unknown): string {
  return refusal(fn).message;
}

test('the field of a problem with no colon is the whole text, not the text minus its last character', () => {
  assert.equal(problemField('artifact.draws: bad'), 'artifact.draws');
  assert.equal(problemField('artifact.draws'), 'artifact.draws');
});

test('a write that fails is a usage error naming the code, never a raw error', () => {
  const out = join(scratch(), 'no-such-folder', 'run.json');
  assert.throws(
    () => writeRun(goodRun(), loadBar(barText), out),
    (e: unknown) => e instanceof ImportUsageError && /cannot write .*run\.json \(ENOENT\)/.test(e.message),
  );
  assert.equal(IMPORT_EXIT_INTERNAL, 70);
});

test('the one flag parser: four flags, each once, none empty, no value that is a flag', () => {
  const usage = 'usage: x';
  const good = ['--in', 'a', '--cases', 'b', '--bar', 'c', '--out', 'd'];
  assert.deepEqual(parseImporterFlags(good, usage), { '--in': 'a', '--cases': 'b', '--bar': 'c', '--out': 'd' });
  assert.deepEqual([...IMPORT_FLAGS], ['--in', '--cases', '--bar', '--out']);
  const usageErr = (argv: string[], re: RegExp): void =>
    assert.throws(() => parseImporterFlags(argv, usage), (e: unknown) => e instanceof ImportUsageError && re.test(e.message), argv.join(' '));
  usageErr([], /missing --in, --cases, --bar, --out/);
  usageErr([...good, '--grader', 'x'], /unknown argument "--grader"/);
  usageErr([...good, '--out', 'e'], /--out given twice/);
  usageErr(['--in', '', '--cases', 'b', '--bar', 'c', '--out', 'd'], /--in needs a value/);
  usageErr(['--in', 'a', '--cases', 'b', '--bar', 'c', '--out', ''], /--out needs a value/);
  usageErr(['--in', 'a', '--cases', 'b', '--bar', 'c', '--out'], /--out needs a value/);
  usageErr(['--in', '--cases', 'b', '--bar', 'c', '--out', 'd'], /--in needs a value/);
});

test('the flag parser takes the tool\'s own lists: required flags and optional flags, values by flag name', () => {
  const usage = 'usage: x';
  const err = (argv: string[], re: RegExp, req: readonly string[], opt?: readonly string[]): void =>
    assert.throws(() => parseFlagList(argv, usage, req, opt), (e: unknown) => e instanceof ImportUsageError && re.test(e.message), argv.join(' '));
  const req = ['--in', '--out', '--reading'];
  const opt = ['--select'];
  const base = ['--in', 'a', '--out', 'b', '--reading', 'r'];
  assert.deepEqual(parseFlagList(base, usage, req, opt), { '--in': 'a', '--out': 'b', '--reading': 'r' });
  // an optional flag present
  assert.deepEqual(parseFlagList([...base, '--select', '/x'], usage, req, opt), { '--in': 'a', '--out': 'b', '--reading': 'r', '--select': '/x' });
  // an optional flag absent is absent: no key, no default, no null
  const got = parseFlagList(base, usage, req, opt);
  assert.equal(Object.hasOwn(got, '--select'), false);
  assert.equal(Object.keys(got).length, 3);
  // the optional list may be left out
  assert.deepEqual(parseFlagList(['--in', 'a'], usage, ['--in']), { '--in': 'a' });
  // an optional flag repeated, or given with an empty value or a flag as value
  err([...base, '--select', '1', '--select', '2'], /--select given twice/, req, opt);
  err([...base, '--select', ''], /--select needs a value/, req, opt);
  err([...base, '--select'], /--select needs a value/, req, opt);
  err([...base, '--select', '--in'], /--select needs a value/, req, opt);
  // a missing required flag, an unknown flag, a repeated required flag, an empty value: as before
  err(['--in', 'a', '--out', 'b'], /missing --reading/, req, opt);
  err([...base, '--grader', 'x'], /unknown argument "--grader"/, req, opt);
  err([...base, '--select', '1', '--other', 'x'], /unknown argument "--other"/, req, opt);
  err([...base, '--reading', 'q'], /--reading given twice/, req, opt);
  err(['--in', 'a', '--out', 'b', '--reading', ''], /--reading needs a value/, req, opt);
  // a flag that is optional for one tool is unknown for another
  err([...base, '--select', '1'], /unknown argument "--select"/, req);
});

test('the importers\' own lists: promptfoo requires --reading and Inspect does not take it', () => {
  assert.deepEqual([...IMPORT_FLAGS], ['--in', '--cases', '--bar', '--out']);
  assert.deepEqual([...IMPORTER_FLAGS.promptfoo.required], ['--in', '--cases', '--bar', '--out', '--reading']);
  assert.deepEqual([...IMPORTER_FLAGS.promptfoo.optional], ['--grader-sha256']);
  assert.deepEqual([...IMPORTER_FLAGS.inspect.required], ['--in', '--cases', '--bar', '--out']);
  assert.deepEqual([...IMPORTER_FLAGS.inspect.optional], ['--grader-sha256']);
});

test('the shared key lists name the grader\'s defaults and settings for both tools', () => {
  assert.deepEqual(GRADER_DEFAULTS, { baseUrl: 'https://api.anthropic.com', apiVersion: '2023-06-01', timeoutMs: 60000 });
  assert.deepEqual([...GRADER_CONFIG_KEYS.promptfoo], ['model', 'max_tokens', 'temperature', 'baseUrl', 'timeoutMs', 'apiVersion', 'apiKeyEnv', 'thinking', 'effort', 'maxReasks']);
  assert.deepEqual([...GRADER_CONFIG_KEYS.inspect], ['timeout_ms', 'api_version', 'api_key_env', 'thinking', 'effort', 'max_reasks']);
  assert.equal(GRADER_NAME, 'anchorset-recording-grader');
});

// ---- both commands print the same shape for the same condition --------------------------------------------------

const importersDir = join(import.meta.dirname, '..', 'examples', 'importers');
const runCli = (tool: 'promptfoo' | 'inspect', ...args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const res = spawnSync(process.execPath, [join(importersDir, tool, 'import.ts'), ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: ownStderr(res.stderr) };
};
const toolFlags = (tool: 'promptfoo' | 'inspect', fixture: string, out: string): string[] => [
  '--in', join(importersDir, tool, 'fixtures', `${fixture}.json`),
  '--cases', join(importersDir, tool, 'cases.json'),
  '--bar', join(importersDir, tool, 'bar.json'),
  '--out', out,
  // promptfoo's importer is told the reading rule; Inspect's takes no such flag
  ...(tool === 'promptfoo' ? ['--reading', READINGS[0]] : []),
];
/** The flags without `--out` and its value. */
const withoutOut = (flags: string[]): string[] => flags.filter((_, i) => flags[i] !== '--out' && flags[i - 1] !== '--out');
/** A line with what legitimately differs between the tools (hashes, the tool's own name, the runtime) blanked out. */
const lineShape = (line: string): string =>
  line
    .replace(/[0-9a-f]{64}/g, '<sha>')
    .replace(/examples\/importers\/(promptfoo|inspect)\/import\.ts/g, '<importer>')
    .replace(/--in <(?:result|log)\.json>/g, '--in <source>')
    .replace(/ --reading <rule name>/, '')
    .replace(/\((?:all|the first) (?:four|five) required[^)]*\)/, '(all required)')
    .replace(/^(grader: \S+) .* (sha256:<sha>)$/, '$1 <language and runtime> $2')
    .replace(/^(REFUSED IMPORT_[A-Z_]+): .*$/, '$1: <message>')
    .replace(/^(fields: ).*$/, '$1<fields>')
    .replace(/^(\s*"(?:judgeModelRequested|judgeModelServed|judgeHarnessVersion)": ).*$/, '$1<value>')
    .replace(/^(\s*"drawsPerCase": ).*$/, '$1<n>');

test('both commands print the same lines, in the same shape, for a success and for each kind of failure', () => {
  const work = mkdtempSync(join(tmpdir(), 'anchorset-shape-'));
  const tools = ['promptfoo', 'inspect'] as const;
  const shapes = (run: (tool: (typeof tools)[number]) => { status: number | null; stdout: string; stderr: string }) => tools.map((t) => {
    const r = run(t);
    // promptfoo prints one line more, the rule it read under; the shape of everything else is the same
    return { status: r.status, out: r.stdout.split('\n').filter((l) => !l.startsWith('reading rule: ')).map(lineShape), err: r.stderr.split('\n').map(lineShape) };
  });
  const same = (label: string, got: ReturnType<typeof shapes>): void => {
    assert.deepEqual(got[0], got[1], `${label}: promptfoo and inspect differ`);
  };
  // a success: the plan fragment, the run's sha256, the grader line, the shipped-grader line, the system-side line
  const ok = shapes((t) => runCli(t, ...toolFlags(t, 'old-judge', join(work, `${t}-ok.json`))));
  same('success', ok);
  assert.equal(ok[0]?.status, 0);
  assert.ok(ok[0]?.out.some((l) => l.startsWith('run file sha256: ')));
  assert.ok(ok[0]?.out.some((l) => l === 'grader: anchorset-recording-grader <language and runtime> sha256:<sha>'));
  assert.ok(ok[0]?.out.some((l) => l === "the record reports the shipped grader's sha256" || l === 'the record does not match the shipped grader (name, language or sha256), or the shipped file could not be read'));
  assert.ok(!ok[0]?.out.some((l) => /python python/.test(l)), 'the language is not printed twice');
  assert.ok(ok[0]?.out.includes('replies with a thinking block: 0 of 9'));
  // the re-asks line is printed on every success, zero included, after the thinking line
  assert.ok(ok[0]?.out.includes('re-asks: 0 on 0 of 9 slots (truncated 0, timeout 0, transport 0, server-error 0, rate-limited 0); at most 0 per slot'));
  // the fixtures in which some replies thought: both tools print the same two count lines, last
  const thought = shapes((t) => runCli(t, ...toolFlags(t, 'thinking', join(work, `${t}-thinking.json`))));
  same('success with thinking replies', thought);
  assert.equal(thought[0]?.status, 0);
  assert.deepEqual(thought[0]?.out.filter((l) => l !== '').slice(-4, -2), ['replies with a thinking block: 6 of 9', 're-asks: 0 on 0 of 9 slots (truncated 0, timeout 0, transport 0, server-error 0, rate-limited 0); at most 0 per slot']);
  // the fixtures in which two slots were asked again: both tools print the same count, by reason, and the bound
  const reasked = shapes((t) => runCli(t, ...toolFlags(t, 'reask', join(work, `${t}-reask.json`))));
  same('success with re-asked slots', reasked);
  assert.equal(reasked[0]?.status, 0);
  assert.deepEqual(reasked[0]?.out.filter((l) => l !== '').slice(-4, -2), ['replies with a thinking block: 0 of 9', 're-asks: 2 on 2 of 9 slots (truncated 1, timeout 0, transport 0, server-error 1, rate-limited 0); at most 2 per slot']);
  // a refusal: a file the tool did not grade through the recording grader
  const refused = shapes((t) => runCli(t, ...toolFlags(t, 'plain', join(work, `${t}-plain.json`))));
  same('refusal', refused);
  assert.equal(refused[0]?.status, 2);
  assert.deepEqual(refused[0]?.err, ['REFUSED IMPORT_NO_RECORD: <message>', 'fields: <fields>', '']);
  // usage errors: an existing --out, a missing flag, an empty value, an unreadable file, an --out in a missing folder
  writeFileSync(join(work, 'exists.json'), 'keep');
  same('existing --out', shapes((t) => runCli(t, ...toolFlags(t, 'old-judge', join(work, 'exists.json')))));
  same('missing flag', shapes((t) => runCli(t, ...withoutOut(toolFlags(t, 'old-judge', join(work, 'x.json'))))));
  same('empty value', shapes((t) => runCli(t, ...toolFlags(t, 'old-judge', ''))));
  same('unreadable file', shapes((t) => runCli(t, ...toolFlags(t, 'old-judge', join(work, 'y.json')).map((a) => (a.endsWith('cases.json') ? join(work, 'none.json') : a)))));
  same('missing folder', shapes((t) => runCli(t, ...toolFlags(t, 'old-judge', join(work, 'no', 'such', 'z.json')))));
  same('unknown flag', shapes((t) => runCli(t, '--grader', 'x')));
  // an input error (exit 65): a bar that does not validate
  writeFileSync(join(work, 'bad-bar.json'), '{"labels":[],"classes":{}}');
  const badBar = shapes((t) => runCli(t, ...toolFlags(t, 'old-judge', join(work, `${t}-bb.json`)).map((a) => (a.endsWith('bar.json') ? join(work, 'bad-bar.json') : a))));
  same('bad bar', badBar);
  assert.equal(badBar[0]?.status, 65);
  // a source that is not an object: the root is path "/", never an empty field name
  writeFileSync(join(work, 'null.json'), 'null');
  const root = shapes((t) => runCli(t, ...toolFlags(t, 'old-judge', join(work, `${t}-null.json`)).map((a) => (a.endsWith('old-judge.json') ? join(work, 'null.json') : a))));
  assert.equal(root[0]?.status, 2);
  assert.equal(root[1]?.status, 2);
  for (const t of tools) {
    const r = runCli(t, ...toolFlags(t, 'old-judge', join(work, `${t}-null2.json`)).map((a) => (a.endsWith('old-judge.json') ? join(work, 'null.json') : a)));
    assert.doesNotMatch(r.stderr, /fields: \n|fields: $/m, `${t}: a null source names no empty field`);
  }
});

// ---- stated thinking and effort, thinking blocks, the reading rule -----------------------------------

test('the record is v7; a v6 record refuses with IMPORT_EVIDENCE and "re-grade with the current grader"; another schema is still IMPORT_NO_RECORD', () => {
  assert.equal(RECORD_SCHEMA, 'example.grader-evidence/v7');
  assert.equal(RECORD_SCHEMA_PREVIOUS, 'example.grader-evidence/v6');
  // A v6 record as the earlier grader wrote it, its cut ask with no sha256 and no length of the cut reply: refused by its version, nothing converted.
  const v6ask = without(without(cutAsk(1), 'replySha256'), 'replyUtf8Bytes');
  const v6 = reasked(2, 1, [v6ask], { schema: RECORD_SCHEMA_PREVIOUS });
  for (const tool of ['promptfoo', 'inspect'] as const) {
    const r6 = refuses('IMPORT_EVIDENCE', ['p.schema'], () => parseRecord(v6, 'p', tool));
    assert.match(r6.message, /p\.schema: this record is of version example\.grader-evidence\/v6, an earlier version than example\.grader-evidence\/v7; re-grade with the current grader \(examples\/importers\//);
    // A v6 record with no earlier ask is refused by its version all the same: nothing of an earlier version is converted.
    refuses('IMPORT_EVIDENCE', ['p.schema'], () => parseRecord(record(1, { schema: RECORD_SCHEMA_PREVIOUS }), 'p', tool));
  }
  // The same v6 record under the current schema string is not a v7 record: the two keys of its cut ask are missing.
  const relabelled = refuses('IMPORT_REASK', ['p.reask.earlier[0]'], () => parseRecord({ ...v6, schema: RECORD_SCHEMA }, 'p', 'promptfoo'));
  assert.match(relabelled.message, /not the form of a "truncated" ask; it lacks replySha256, replyUtf8Bytes/);
  // A v5 record, with no usage and no reask, under the current schema string: the two keys are missing.
  const v5 = record(1);
  delete v5['usage'];
  delete v5['reask'];
  refuses('IMPORT_EVIDENCE', ['p.usage', 'p.reask'], () => parseRecord(v5, 'p', 'promptfoo'));
  for (const old of ['example.grader-evidence/v3', 'example.grader-evidence/v4', 'example.grader-evidence/v5', 'example.grader-evidence/v6']) {
    const r = refuses('IMPORT_EVIDENCE', ['rows[0].graderEvidence.schema'], () => parseRecord(record(1, { schema: old }), 'rows[0].graderEvidence', 'promptfoo'));
    assert.match(r.message, /re-grade with the current grader/);
    assert.ok(r.message.includes(old), old);
  }
  for (const oldest of ['example.grader-evidence/v2', 'example.grader-evidence/v1']) {
    const r2 = refuses('IMPORT_EVIDENCE', ['p.schema'], () => parseRecord(record(1, { schema: oldest }), 'p', 'promptfoo'));
    assert.match(r2.message, /re-grade with the current grader/);
    assert.ok(r2.message.includes(oldest), oldest);
  }
  for (const odd of ['example.grader-evidence/v0', 'example.grader-evidence/v03', 'example.grader-evidence/v-1', 'example.grader-evidence/v1.5', 'example.grader-evidence/vx', 'x/example.grader-evidence/v2']) {
    refuses('IMPORT_NO_RECORD', ['p'], () => parseRecord(record(1, { schema: odd }), 'p', 'promptfoo'));
  }
  refuses('IMPORT_NO_RECORD', ['p'], () => parseRecord(record(1, { schema: 'example.grader-evidence/v8' }), 'p', 'promptfoo'));
  // one schema string for both graders: the same current and earlier versions for Inspect
  parseRecord(record(1), 'p', 'inspect');
  for (const old of ['example.grader-evidence/v2', 'example.grader-evidence/v3', 'example.grader-evidence/v4', 'example.grader-evidence/v5', 'example.grader-evidence/v6']) {
    const r3 = refuses('IMPORT_EVIDENCE', ['p.schema'], () => parseRecord(record(1, { schema: old }), 'p', 'inspect'));
    assert.match(r3.message, /re-grade with the current grader/);
  }
});

test('a record that holds reading: the promptfoo message points at --reading, the Inspect message at no flag', () => {
  const p = refuses('IMPORT_EVIDENCE', ['p.reading'], () => parseRecord(record(1, { reading: 'x' }), 'p', 'promptfoo'));
  assert.match(p.message, /--reading/);
  const i = refuses('IMPORT_EVIDENCE', ['p.reading'], () => parseRecord(record(1, { reading: 'x' }), 'p', 'inspect'));
  assert.doesNotMatch(i.message, /--reading/);
  assert.match(i.message, /no grader records one/);
});

test('thinkingTokens is a non-negative integer or "ABSENT", and it is required', () => {
  for (const v of [0, 1, 12, 4096]) assert.equal(parseRecord(record(1, { thinkingTokens: v }), 'p', 'promptfoo').thinkingTokens, v);
  assert.equal(parseRecord(record(1, { thinkingTokens: 'ABSENT' }), 'p', 'promptfoo').thinkingTokens, 'ABSENT');
  for (const v of [-1, 1.5, '7', 'absent', 'UNKNOWN', NOT_SENT, null, true, {}, 2 ** 53]) {
    assert.ok(refusal(() => parseRecord(record(1, { thinkingTokens: v }), 'p', 'promptfoo')).fields.includes('p.thinkingTokens'), String(v));
  }
  const rec = record(1);
  delete rec['thinkingTokens'];
  refuses('IMPORT_EVIDENCE', ['p.thinkingTokens'], () => parseRecord(rec, 'p', 'promptfoo'));
});

test('a record that holds reading is IMPORT_EVIDENCE naming it, with the words "re-grade with the current grader", for either tool and any value', () => {
  assert.deepEqual([...READINGS], [ONE_OBJECT, OR_FENCE]);
  for (const v of [...READINGS, '', 'lenient', null, 1]) {
    const r = refuses('IMPORT_EVIDENCE', ['p.reading'], () => parseRecord(record(1, { reading: v }), 'p', 'promptfoo'));
    assert.match(r.message, /re-grade with the current grader/);
    refuses('IMPORT_EVIDENCE', ['p.reading'], () => parseRecord(record(1, { reading: v }), 'p', 'inspect'));
  }
  assert.equal('reading' in parseRecord(record(1), 'p', 'promptfoo'), false);
});

test('content types: zero or more thinking or redacted_thinking blocks, then exactly one text block, last; nothing else is graded', () => {
  for (const ct of [['text'], ['thinking', 'text'], ['redacted_thinking', 'text'], ['thinking', 'thinking', 'text'], ['thinking', 'redacted_thinking', 'text']]) {
    assert.equal(ungradedReason(parsed(1, { contentTypes: ct })), undefined, JSON.stringify(ct));
  }
  for (const ct of [[], ['thinking'], ['redacted_thinking'], ['text', 'thinking'], ['text', 'text'], ['thinking', 'text', 'text'], ['thinking', 'text', 'thinking'], ['tool_use'], ['thinking', 'tool_use', 'text'], ['server_tool_use', 'text'], ['Thinking', 'text'], ['text ', 'text'], ['', 'text']]) {
    const why = ungradedReason(parsed(1, { contentTypes: ct }));
    assert.ok(why !== undefined, JSON.stringify(ct));
    assert.match(why, /one text block/);
  }
  // a stop at the budget still refuses, with or without a thinking block
  assert.match(ungradedReason(parsed(1, { contentTypes: ['thinking', 'text'], stopReason: 'max_tokens' })) ?? '', /"max_tokens"/);
});

test('call shape and sent: each stated form is admitted when the call shape says what was sent, and only then', () => {
  const forms: [unknown, Record<string, unknown>][] = [
    [NOT_SENT, { thinkingMode: NOT_SENT, thinkingBudgetTokens: NOT_SENT }],
    [{ type: 'adaptive' }, { thinkingMode: 'adaptive', thinkingBudgetTokens: NOT_SENT }],
    [{ type: 'between_tools' }, { thinkingMode: 'between-tools', thinkingBudgetTokens: NOT_SENT }],
    [{ type: 'disabled' }, { thinkingMode: 'off', thinkingBudgetTokens: NOT_SENT }],
    [{ type: 'enabled', budget_tokens: 2048 }, { thinkingMode: 'budgeted', thinkingBudgetTokens: 2048 }],
  ];
  for (const [thinking, shape] of forms) {
    const rec = parseRecord(record(1, { sent: sentOf({ thinking }), callShape: judgeShape(shape) }), 'p', 'promptfoo');
    assert.deepEqual(rec.sent.thinking, thinking);
  }
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    parseRecord(record(1, { sent: sentOf({ output_config: { effort } }), callShape: judgeShape({ effort }) }), 'p', 'promptfoo');
  }
  // both at once
  parseRecord(record(1, { sent: sentOf({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }), callShape: judgeShape({ thinkingMode: 'adaptive', effort: 'high' }) }), 'p', 'promptfoo');
});

test('call shape and sent: a call shape that differs from what was sent is IMPORT_EVIDENCE naming the key', () => {
  // the shape says adaptive thinking, the record says nothing was sent, and the reverse
  refuses('IMPORT_EVIDENCE', ['p.callShape.thinkingMode'], () => parseRecord(record(1, { callShape: judgeShape({ thinkingMode: 'adaptive' }) }), 'p', 'promptfoo'));
  refuses('IMPORT_EVIDENCE', ['p.callShape.thinkingMode'], () => parseRecord(record(1, { sent: sentOf({ thinking: { type: 'adaptive' } }) }), 'p', 'promptfoo'));
  // a different mode, a different budget, a budget with no budgeted mode
  refuses('IMPORT_EVIDENCE', ['p.callShape.thinkingMode'], () => parseRecord(record(1, { sent: sentOf({ thinking: { type: 'adaptive' } }), callShape: judgeShape({ thinkingMode: 'off' }) }), 'p', 'promptfoo'));
  refuses('IMPORT_EVIDENCE', ['p.callShape.thinkingBudgetTokens'], () => parseRecord(record(1, { sent: sentOf({ thinking: { type: 'enabled', budget_tokens: 2048 } }), callShape: judgeShape({ thinkingMode: 'budgeted', thinkingBudgetTokens: 1024 }) }), 'p', 'promptfoo'));
  // effort
  refuses('IMPORT_EVIDENCE', ['p.callShape.effort'], () => parseRecord(record(1, { callShape: judgeShape({ effort: 'high' }) }), 'p', 'promptfoo'));
  refuses('IMPORT_EVIDENCE', ['p.callShape.effort'], () => parseRecord(record(1, { sent: sentOf({ output_config: { effort: 'high' } }) }), 'p', 'promptfoo'));
  refuses('IMPORT_EVIDENCE', ['p.callShape.effort'], () => parseRecord(record(1, { sent: sentOf({ output_config: { effort: 'high' } }), callShape: judgeShape({ effort: 'low' }) }), 'p', 'promptfoo'));
});

test('sent holds the two request keys in the closed forms only; any other key or value is IMPORT_EVIDENCE', () => {
  const bad: [string, unknown][] = [
    ['thinking', { type: 'adaptive', display: 'summarized' }],
    ['thinking', { type: 'adaptive', zeta: 1 }],
    ['thinking', { type: 'disabled', typed: true }],
    ['thinking', { type: 'enabled' }],
    ['thinking', { type: 'enabled', budget_tokens: 0 }],
    ['thinking', { type: 'enabled', budget_tokens: 1.5 }],
    ['thinking', { type: 'enabled', budget_tokens: '2048' }],
    ['thinking', { type: 'disabled', budget_tokens: 2048 }],
    ['thinking', { type: 'adaptive', budget_tokens: 2048 }],
    ['thinking', { type: 'auto' }],
    ['thinking', { type: 'between-tools' }],
    ['thinking', {}],
    ['thinking', 'adaptive'],
    ['thinking', 'not_sent'],
    ['thinking', null],
    ['thinking', ['adaptive']],
    ['output_config', { effort: 'minimal' }],
    ['output_config', { effort: 'HIGH' }],
    ['output_config', { effort: 'high', format: 'json' }],
    ['output_config', { effort: NOT_SENT }],
    ['output_config', {}],
    ['output_config', 'high'],
    ['output_config', null],
  ];
  for (const [key, value] of bad) {
    const r = refusal(() => parseRecord(record(1, { sent: sentOf({ [key]: value }) }), 'p', 'promptfoo'));
    assert.equal(r.code, 'IMPORT_EVIDENCE', `${key} ${JSON.stringify(value)}`);
    assert.ok(r.fields.includes(`p.sent.${key}`), `${key} ${JSON.stringify(value)}: ${r.fields.join(', ')}`);
  }
  refuses('IMPORT_EVIDENCE', ['p.sent.stream'], () => parseRecord(record(1, { sent: sentOf({ stream: true }) }), 'p', 'promptfoo'));
  const missing = sentOf();
  delete missing['thinking'];
  refuses('IMPORT_EVIDENCE', ['p.sent.thinking'], () => parseRecord(record(1, { sent: missing }), 'p', 'promptfoo'));
  const noEffort = sentOf();
  delete noEffort['output_config'];
  refuses('IMPORT_EVIDENCE', ['p.sent.output_config'], () => parseRecord(record(1, { sent: noEffort }), 'p', 'promptfoo'));
});

test('the call-shape keys other than thinking and effort are still held to NOT_SENT', () => {
  // the stated settings do not open the hold for betaFlags, the temperature of thinking, tools and the rest
  refuses('IMPORT_EVIDENCE', ['p.callShape.betaFlags'], () => parseRecord(record(1, { sent: sentOf({ thinking: { type: 'adaptive' } }), callShape: judgeShape({ thinkingMode: 'adaptive', betaFlags: ['interleaved-thinking-2025-05-14'] }) }), 'p', 'promptfoo'));
  refuses('IMPORT_EVIDENCE', ['p.callShape.toolChoice'], () => parseRecord(record(1, { callShape: judgeShape({ toolChoice: 'any' }) }), 'p', 'promptfoo'));
});

test('thinkingRepliesLine counts the replies with a thinking block: "replies with a thinking block: <k> of <n>"', () => {
  const recs = [parsed(1), parsed(2, { contentTypes: ['thinking', 'text'] }), parsed(3, { contentTypes: ['redacted_thinking', 'text'] }), parsed(4)];
  assert.equal(thinkingRepliesLine(recs), 'replies with a thinking block: 2 of 4');
  assert.equal(thinkingRepliesLine([parsed(1)]), 'replies with a thinking block: 0 of 1');
  // a counter alone does not make a reply one that thought: the blocks are what is counted, and the two are not cross-checked
  assert.equal(thinkingRepliesLine([parsed(1, { thinkingTokens: 40 })]), 'replies with a thinking block: 0 of 1');
  assert.equal(parsed(1, { contentTypes: ['thinking', 'text'], thinkingTokens: 0 }).thinkingTokens, 0);
  assert.equal(parsed(1, { contentTypes: ['text'], thinkingTokens: 'ABSENT' }).thinkingTokens, 'ABSENT');
});

test('readSlot is the one reading of a slot: the record\'s stop and content first, then the reply under the stated rule, with the place and the words each caller prints', () => {
  // A finished reply that holds a verdict: the verdict, and nothing else.
  assert.deepEqual(readSlot(parsed(1, { reply: '{"pass": false, "reason": "r"}' }), ONE_OBJECT), { pass: false, reason: 'r' });
  // A stop that is not a finished reply: the reason of `ungradedReason`, at the record itself; the reply is not read.
  assert.deepEqual(readSlot(parsed(1, { stopReason: 'max_tokens', reply: '{"pass": true}' }), ONE_OBJECT), { at: '', why: 'the judge stopped with "max_tokens", not "end_turn"' });
  assert.equal((readSlot(parsed(1, { contentTypes: ['tool_use'] }), ONE_OBJECT) as { at: string }).at, '');
  // A finished reply with no verdict under the rule: at the reply, in the words that name the rule.
  assert.deepEqual(readSlot(parsed(1, { reply: 'prose' }), ONE_OBJECT), { at: '/reply', why: 'not exactly one JSON object with a boolean "pass", under the reading rule one-json-object-boolean-pass/v1 that was stated' });
  // A reply the other rule reads is named so, and nothing is chosen.
  const fencedReply = '```json\n{"pass": true}\n```';
  assert.deepEqual(readSlot(parsed(1, { reply: fencedReply }), ONE_OBJECT), { at: '/reply', why: 'not exactly one JSON object with a boolean "pass", under the reading rule one-json-object-boolean-pass/v1 that was stated; readable under one-json-object-boolean-pass-or-json-fence/v1; that rule is a different judge definition' });
  assert.deepEqual(readSlot(parsed(1, { reply: fencedReply }), OR_FENCE), { pass: true, reason: undefined });
  // A name that is not a rule is an error of the caller, never a reading.
  assert.throws(() => readSlot(parsed(1), 'lenient' as never), /unknown reading rule/);
});

test('readUnderRule, first rule: the trimmed reply is one JSON object with a boolean pass; nothing else', () => {
  const ok = readUnderRule(ONE_OBJECT, '  {"pass": true, "reason": "r"}\n');
  assert.deepEqual(ok, { pass: true, reason: 'r' });
  assert.deepEqual(readUnderRule(ONE_OBJECT, '{"pass":false}'), { pass: false, reason: undefined });
  for (const reply of ['', 'no', '{"pass": "true"}', '{"reason": "x"}', '[1]', 'x {"pass": true}', '{"pass": true} x', '{"pass": tr', '```json\n{"pass": true}\n```']) {
    assert.equal(typeof readUnderRule(ONE_OBJECT, reply), 'string', reply);
  }
});

test('readUnderRule, second rule: the same object bare or inside exactly one json fence, white space only outside it', () => {
  const obj = '{"pass": true, "reason": "r"}';
  const want = { pass: true, reason: 'r' };
  assert.deepEqual(readUnderRule(OR_FENCE, obj), want);
  assert.deepEqual(readUnderRule(OR_FENCE, `\n  ${obj}\n`), want);
  assert.deepEqual(readUnderRule(OR_FENCE, `\`\`\`json\n${obj}\n\`\`\``), want);
  assert.deepEqual(readUnderRule(OR_FENCE, `  \n\`\`\`json\n${obj}\n\`\`\`\n\n `), want);
  assert.deepEqual(readUnderRule(OR_FENCE, `\`\`\`json\n{\n  "pass": true,\n  "reason": "r"\n}\n\`\`\``), want);
  const refused: [string, string][] = [
    ['prose before', `Here it is:\n\`\`\`json\n${obj}\n\`\`\``],
    ['prose after', `\`\`\`json\n${obj}\n\`\`\`\nHope that helps.`],
    ['two fences', `\`\`\`json\n${obj}\n\`\`\`\n\`\`\`json\n${obj}\n\`\`\``],
    ['another tag', `\`\`\`JSON\n${obj}\n\`\`\``],
    ['another tag, js', `\`\`\`javascript\n${obj}\n\`\`\``],
    ['no tag', `\`\`\`\n${obj}\n\`\`\``],
    ['text after the object, inside the fence', `\`\`\`json\n${obj}\nthanks\n\`\`\``],
    ['text before the object, inside the fence', `\`\`\`json\nthe verdict\n${obj}\n\`\`\``],
    ['a space after the tag', `\`\`\`json \n${obj}\n\`\`\``],
    ['four backticks', `\`\`\`\`json\n${obj}\n\`\`\`\``],
    ['no closing fence', `\`\`\`json\n${obj}`],
    ['a closing fence with a tag', `\`\`\`json\n${obj}\n\`\`\`json`],
    ['tilde fence', `~~~json\n${obj}\n~~~`],
    ['an empty fence', '```json\n```'],
    ['a bare object then a fence', `${obj}\n\`\`\`json\n${obj}\n\`\`\``],
    ['a fenced non-object', '```json\n[1]\n```'],
    ['a string pass', '```json\n{"pass": "true"}\n```'],
  ];
  for (const [label, reply] of refused) assert.equal(typeof readUnderRule(OR_FENCE, reply), 'string', label);
  // a fenced reply under the first rule is refused
  assert.equal(typeof readUnderRule(ONE_OBJECT, `\`\`\`json\n${obj}\n\`\`\``), 'string');
});

test('readUnderRule is line-exact on the fence lines, and white space is the four JSON characters', () => {
  const obj = '{"pass": true, "reason": "r"}';
  const want = { pass: true, reason: 'r' };
  const fence = (open: string, close: string): string => `${open}\n${obj}\n${close}`;
  const refusedUnderBoth: [string, string][] = [
    ['a byte-order mark before a bare object', `﻿${obj}`],
    ['a no-break space before a bare object', ` ${obj}`],
    ['a no-break space after a bare object', `${obj} `],
  ];
  for (const [label, reply] of refusedUnderBoth) {
    assert.equal(typeof readUnderRule(OR_FENCE, reply), 'string', `second rule: ${label}`);
    assert.equal(typeof readUnderRule(ONE_OBJECT, reply), 'string', `first rule: ${label}`);
  }
  const refused: [string, string][] = [
    ['a closing fence with trailing spaces', fence('```json', '```   ')],
    ['a closing fence with a trailing tab', fence('```json', '```\t')],
    ['an opening fence indented by spaces', fence('  ```json', '```')],
    ['a closing fence indented by a space', fence('```json', ' ```')],
    ['a no-break space before the opening fence', fence(' ```json', '```')],
    ['a byte-order mark before the opening fence', fence('﻿```json', '```')],
    ['a no-break space after the closing fence', fence('```json', '``` ')],
    ['CRLF on every line', `\`\`\`json\r\n${obj}\r\n\`\`\``],
    ['an opening fence with a carriage return', fence('```json\r', '```')],
  ];
  for (const [label, reply] of refused) assert.equal(typeof readUnderRule(OR_FENCE, reply), 'string', label);
  const accepted: [string, string][] = [
    ['a bare object with ASCII white space', ` \t\r\n${obj}\n\r\t `],
    ['the exact fence', fence('```json', '```')],
    ['the fence with blank lines outside it', `\n \r\n${fence('```json', '```')}\n\n \t`],
    ['a carriage return before the closing fence only', `\`\`\`json\n${obj}\r\n\`\`\``],
  ];
  for (const [label, reply] of accepted) assert.deepEqual(readUnderRule(OR_FENCE, reply), want, label);
});

test('readUnderRule refuses a rule name it does not know, instead of reading under the first rule', () => {
  assert.throws(() => readUnderRule('other/v9' as never, '{"pass":true}'), /unknown reading rule/);
  assert.throws(() => readUnderRule('' as never, '{"pass":true}'), /unknown reading rule/);
});

// ---- additions asked by a third importer: the .jsonl source, the instruction text, the third harness component, ---
// ---- the cases shape alone, the template check, the two codes and the reading-rule names ---------------------------

const enc = (t: string): Uint8Array => new TextEncoder().encode(t);

test('three refusal codes are added, each last, and every earlier code keeps its place', () => {
  assert.deepEqual(IMPORT_REFUSAL_CODES.slice(0, 19), ['IMPORT_TOOL_VERSION', 'IMPORT_SHAPE', 'IMPORT_NO_RECORD', 'IMPORT_EVIDENCE', 'IMPORT_UNGRADED', 'IMPORT_LABEL_DISAGREES', 'IMPORT_MIXED_IDENTITY', 'IMPORT_HIDDEN_CALLS', 'IMPORT_DUPLICATE_CALL', 'IMPORT_CACHE', 'IMPORT_JUDGE_SELECTION', 'IMPORT_DERIVATION', 'IMPORT_PACKET', 'IMPORT_CASE_ID', 'IMPORT_CASE_MISSING', 'IMPORT_DRAW_COUNT', 'IMPORT_OUTPUTS_DIFFER', 'IMPORT_BAR', 'IMPORT_SELF_CHECK']);
  assert.deepEqual(IMPORT_REFUSAL_CODES.slice(19), ['IMPORT_OUTPUT_UNFINISHED', 'IMPORT_PATH', 'IMPORT_REASK']);
  assert.equal(new ImportRefusal('IMPORT_REASK', ['c'], 'c: a finished reply was asked again').code, 'IMPORT_REASK');
  assert.equal(new ImportRefusal('IMPORT_OUTPUT_UNFINISHED', ['a'], 'a: not a finished answer').code, 'IMPORT_OUTPUT_UNFINISHED');
  assert.equal(new ImportRefusal('IMPORT_PATH', ['b'], 'b: a symlink').code, 'IMPORT_PATH');
});

test('a .jsonl source with records is read line by line and returns its lines and the sha256 of the bytes', () => {
  const rec = record(1);
  const text = `${JSON.stringify({ header: true })}\n${JSON.stringify({ caseId: 'a', draw: 0, graderEvidence: rec })}\n`;
  const r = parseJsonlSourceFile(enc(text), 'regrade.jsonl');
  assert.equal(r.lines.length, 2);
  assert.deepEqual(r.lines[1], { caseId: 'a', draw: 0, graderEvidence: rec });
  assert.equal(r.sha256, sha256Hex(enc(text)));
  // a line that is itself a record counts as holding one
  assert.equal(parseJsonlSourceFile(enc(`${JSON.stringify(rec)}\n`), 'x.jsonl').lines.length, 1);
});

test('a plain results .jsonl, with no grader record on any line, is IMPORT_NO_RECORD, not a shape refusal', () => {
  const plain = `${JSON.stringify({ prompt_id: 'a', rep: 0, status: 'ok' })}\n${JSON.stringify({ prompt_id: 'b', rep: 0, status: 'ok' })}\n`;
  const r = refuses('IMPORT_NO_RECORD', ['results.jsonl'], () => parseJsonlSourceFile(enc(plain), 'results.jsonl'));
  assert.match(r.message, /examples\/importers\/promptfoo\/grader-provider\.cjs/);
  // an empty file and a file of non-record values are the same refusal
  refuses('IMPORT_NO_RECORD', ['e.jsonl'], () => parseJsonlSourceFile(enc(''), 'e.jsonl'));
  refuses('IMPORT_NO_RECORD', ['n.jsonl'], () => parseJsonlSourceFile(enc('1\n"x"\n'), 'n.jsonl'));
  // a row whose graderEvidence is not an object is not a record
  refuses('IMPORT_NO_RECORD', ['g.jsonl'], () => parseJsonlSourceFile(enc('{"graderEvidence": null}\n'), 'g.jsonl'));
  const custom = refuses('IMPORT_NO_RECORD', ['results.jsonl'], () => parseJsonlSourceFile(enc(plain), 'results.jsonl', 'Run the third tool again.'));
  assert.match(custom.message, /Run the third tool again\.$/);
  assert.doesNotMatch(custom.message, /grader-provider|promptfoo/);
});

test('a .jsonl that is not JSON lines is IMPORT_SHAPE: a torn or blank line, a missing final newline, bytes that are not UTF-8, a zip', () => {
  const ok = JSON.stringify({ graderEvidence: record(1) });
  refuses('IMPORT_SHAPE', ['t.jsonl'], () => parseJsonlSourceFile(enc(`${ok}\n{"a":`), 't.jsonl'));
  assert.match(refuses('IMPORT_SHAPE', ['t.jsonl'], () => parseJsonlSourceFile(enc(`${ok}`), 't.jsonl')).message, /does not end with a line feed/);
  assert.match(refuses('IMPORT_SHAPE', ['t.jsonl'], () => parseJsonlSourceFile(enc(`${ok}\n\n${ok}\n`), 't.jsonl')).message, /line 2 is empty/);
  refuses('IMPORT_SHAPE', ['t.jsonl'], () => parseJsonlSourceFile(Uint8Array.from([0xff, 0x0a]), 't.jsonl'));
  refuses('IMPORT_SHAPE', ['t.jsonl'], () => parseJsonlSourceFile(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1]), 't.jsonl'));
  refuses('IMPORT_SHAPE', ['t.jsonl'], () => parseJsonlSourceFile(enc(`\ufeff${ok}\n`), 't.jsonl'));
  const bad = refusal(() => parseJsonlSourceFile(enc(`${ok}\n{"a":\n`), 't.jsonl'));
  assert.match(bad.message, /line 2/);
});

test('parseSourceFile still refuses every .jsonl name with the same shape refusal and message', () => {
  const r = refuses('IMPORT_SHAPE', ['x.jsonl'], () => parseSourceFile(enc('{"a":1}\n'), 'x.jsonl', 'inspect'));
  assert.equal(r.message, 'IMPORT_SHAPE: x.jsonl: a .jsonl file has no runtime options or metadata and cannot be imported; use the inspect .json result file');
});

test('the template check takes its token names from the caller; with the four plain tokens its sentence is the one the Inspect importer printed', () => {
  const four = ['question', 'answer', 'criterion', 'instructions'];
  assert.equal(templateProblem('[Task]: {question} {answer} {criterion} {instructions}', four), undefined);
  assert.equal(templateProblem('no token at all', four), undefined);
  const sentence = 'a brace that is not one of the four plain tokens {question}, {answer}, {criterion}, {instructions} (a doubled brace, a format specification, a conversion, an index, or another name)';
  for (const t of ['{{question}}', '{question!r}', '{question:>5}', '{0}', '{other}', '{answer', 'answer}', '{}']) assert.equal(templateProblem(t, four), sentence, t);
  // another list of names: the sentence follows the list, and a name outside it is a problem
  const three = ['question', 'answer', 'criterion'];
  assert.equal(templateProblem('{question}{answer}{criterion}', three), undefined);
  assert.equal(templateProblem('{instructions}', three), 'a brace that is not one of the three plain tokens {question}, {answer}, {criterion} (a doubled brace, a format specification, a conversion, an index, or another name)');
  assert.equal(templateProblem('{y}', ['x']), 'a brace that is not the one plain token {x} (a doubled brace, a format specification, a conversion, an index, or another name)');
});

test('the template check refuses a token list it cannot trust, instead of checking against it', () => {
  for (const bad of [[], ['a b'], ['a}'], [''], ['a', 'a'], ['.*'], ['1a']]) assert.throws(() => templateProblem('{a}', bad), /token/, JSON.stringify(bad));
});

test('the cases shape alone needs no bar and checks the same shape; with a bar the combined check is unchanged', () => {
  const ok = '{"a": {"klass": "k1", "expect": "pass"}, "b": {"klass": "zzz", "expect": "nolabel"}}';
  assert.deepEqual(parseCasesFileShape(ok), { a: { klass: 'k1', expect: 'pass' }, b: { klass: 'zzz', expect: 'nolabel' } });
  const inputProblems = (fn: () => unknown): readonly string[] => {
    try {
      fn();
    } catch (e) {
      assert.ok(e instanceof ImportInputError);
      return e.problems;
    }
    return assert.fail('expected an input error');
  };
  for (const bad of ['not json', '[]', '{}', '{"": {"klass":"k","expect":"e"}}', '{"a": 1}', '{"a": {"klass":"k"}}', '{"a": {"klass":"k","expect":null}}', '{"a": {"klass":"","expect":"e"}}', '{"a": {"klass":"k","expect":"e","x":1}}', '{"__proto__": {"klass":"k","expect":"e"}}']) {
    assert.ok(inputProblems(() => parseCasesFileShape(bad)).length > 0, bad);
  }
  // with a bar, a class or a label outside it is still a problem, and the messages are the ones that were
  const bar = loadBar(JSON.stringify({ labels: ['pass', 'fail'], classes: { k1: { direction: 'floor', minPassRate: 0.8 } }, knownFailures: [] }));
  assert.deepEqual(inputProblems(() => parseCasesFile(ok, bar)), ['cases["b"].klass: "zzz" is not a class of the bar', 'cases["b"].expect: "nolabel" is not a label of the bar']);
  assert.deepEqual(inputProblems(() => parseCasesFileShape('{"a": {"klass":"k"}}')), ['cases["a"].expect: must be a non-empty string']);
  assert.deepEqual(inputProblems(() => parseCasesFile('{"a": {"klass":"k"}}', bar)), ['cases["a"].klass: "k" is not a class of the bar', 'cases["a"].expect: must be a non-empty string']);
});

test('noRecordRefusal and parseRecord take an instruction text that replaces the tool words; without it the text is the one that was', () => {
  const was = noRecordRefusal('promptfoo', 'w').message;
  assert.equal(was, "IMPORT_NO_RECORD: w: this file was not graded through the recording grader. This importer reads the recording grader's record of each call, and this file holds none. Grade the stored outputs again through examples/importers/promptfoo/grader-provider.cjs (see examples/importers/README.md)");
  assert.equal(noRecordRefusal('promptfoo', 'w', undefined).message, was);
  const own = noRecordRefusal('promptfoo', 'w', 'Run the re-grade script again.');
  assert.equal(own.message, "IMPORT_NO_RECORD: w: this file was not graded through the recording grader. This importer reads the recording grader's record of each call, and this file holds none. Run the re-grade script again.");
  const viaParse = refuses('IMPORT_NO_RECORD', ['w'], () => parseRecord({}, 'w', 'promptfoo', 'Run the re-grade script again.'));
  assert.equal(viaParse.message, own.message);
  const old = refuses('IMPORT_EVIDENCE', ['w.schema'], () => parseRecord({ schema: RECORD_SCHEMA_PREVIOUS }, 'w', 'promptfoo', 'Run the re-grade script again.'));
  assert.equal(old.message, `IMPORT_EVIDENCE: w.schema: this record is of version ${RECORD_SCHEMA_PREVIOUS}, an earlier version than ${RECORD_SCHEMA}; Run the re-grade script again.`);
  const oldDefault = refusal(() => parseRecord({ schema: RECORD_SCHEMA_PREVIOUS }, 'w', 'promptfoo'));
  assert.equal(oldDefault.message, `IMPORT_EVIDENCE: w.schema: this record is of version ${RECORD_SCHEMA_PREVIOUS}, an earlier version than ${RECORD_SCHEMA}; re-grade with the current grader (examples/importers/promptfoo/grader-provider.cjs, schema ${RECORD_SCHEMA})`);
  const reading = refuses('IMPORT_EVIDENCE', ['w.reading'], () => parseRecord({ ...record(1), reading: 'x' }, 'w', 'promptfoo', 'Run the re-grade script again.'));
  assert.doesNotMatch(reading.message, /--reading|grader-provider/);
  assert.match(reading.message, /Run the re-grade script again\.$/);
  for (const bad of ['', '   ', 5]) assert.throws(() => noRecordRefusal('promptfoo', 'w', bad as never), /instruction/);
  for (const bad of ['', '   ']) assert.throws(() => parseRecord({}, 'w', 'promptfoo', bad), /instruction/);
});

test('judgeHarnessVersion takes an optional third component, the sha256 of the list of script files, in the last position', () => {
  const rec = parsed(1);
  const base = `promptfoo 0.1; ${rec.grader.name} js sha256:${rec.grader.sha256}; ${rec.grader.runtime}; max-reasks 0`;
  assert.equal(judgeHarnessVersion('promptfoo', '0.1', rec), base);
  assert.equal(judgeHarnessVersion('promptfoo', '0.1', rec, undefined), base);
  const files = sha256Hex('script list');
  assert.equal(judgeHarnessVersion('promptfoo', '0.1', rec, files), `${base}; script-files sha256:${files}`);
  for (const bad of ['', 'abc', files.slice(0, 63), files.toUpperCase(), `${files}0`, 'UNKNOWN']) {
    const r = refuses('IMPORT_EVIDENCE', ['scriptFilesSha256'], () => judgeHarnessVersion('promptfoo', '0.1', rec, bad));
    assert.match(r.message, /scriptFilesSha256/);
  }
});

test('the two reading rules have named constants, in the order of READINGS, and readableUnderOtherRule is exported', () => {
  assert.equal(READING_JSON_OBJECT, 'one-json-object-boolean-pass/v1');
  assert.equal(READING_JSON_OBJECT_OR_FENCE, 'one-json-object-boolean-pass-or-json-fence/v1');
  assert.deepEqual([...READINGS], [READING_JSON_OBJECT, READING_JSON_OBJECT_OR_FENCE]);
  const fenced = '```json\n{"pass": true}\n```';
  assert.equal(readableUnderOtherRule(READING_JSON_OBJECT, fenced), `readable under ${READING_JSON_OBJECT_OR_FENCE}; that rule is a different judge definition`);
  assert.equal(readableUnderOtherRule(READING_JSON_OBJECT_OR_FENCE, fenced), undefined);
  assert.equal(readableUnderOtherRule(READING_JSON_OBJECT, 'nonsense'), undefined);
});


// ---- strict reading: a key given twice, a line's bytes, the decoders -----------------------------------------

const why = (text: string): string => {
  const r = parseJsonStrict(text);
  assert.ok('why' in r, `expected a refusal of ${text}`);
  return r.why;
};
const valueOf = (text: string): unknown => {
  const r = parseJsonStrict(text);
  assert.ok('value' in r, `expected ${text} to be read`);
  return r.value;
};

test('a JSON text with no key given twice reads as JSON.parse reads it', () => {
  for (const text of ['{}', '[]', '7', '"a"', 'true', '{"a":1,"b":{"a":2},"c":[{"a":3},{"a":4}]}', ' { "reply" : "ok" , "notes" : [ ] } ', '{"a":{"b":{"c":{}}},"b":1}']) {
    assert.deepEqual(valueOf(text), JSON.parse(text), text);
    assert.equal(duplicateKeyProblem(text), undefined, text);
  }
});

test('JSON.parse keeps the last of two equal keys; the strict reader refuses and names the key and the object', () => {
  assert.deepEqual(JSON.parse('{"status":"truncated","status":"ok"}'), { status: 'ok' });
  assert.equal(why('{"status":"truncated","status":"ok"}'), 'the key "status" is given twice in the top-level object');
  assert.match(why('{"a":1,"a":1}'), /the key "a" is given twice/);
  assert.match(why('{"graderEvidence":{"reply":"{\\"pass\\": true}","reply":"{\\"pass\\": false}"}}'), /^the key "reply" is given twice in the object at \/graderEvidence$/);
  assert.match(why('[{"role":"user"},{"role":"assistant","content":"a","content":"b"}]'), /^the key "content" is given twice in the object at \/1$/);
  assert.match(why('{"a":{"b":[0,{"c":1,"d":{},"c":2}]}}'), /^the key "c" is given twice in the object at \/a\/b\/1$/);
  assert.match(why('{"a/b":{"x":1,"x":2}}'), /in the object at \/a~1b$/);
  assert.match(why('{"a~b":{"x":1,"x":2}}'), /in the object at \/a~0b$/);
});

test('the same key in different objects is not a duplicate; the outer keys survive a nested object', () => {
  for (const text of ['{"a":{"x":1},"b":{"x":1}}', '[{"x":1},{"x":1}]', '{"x":{"x":{"x":1}}}']) assert.equal(duplicateKeyProblem(text), undefined, text);
  assert.match(why('{"x":{"y":1},"x":2}'), /the key "x" is given twice in the top-level object/);
  assert.match(why('{"a":[{"x":1}],"b":1,"a":2}'), /the key "a" is given twice in the top-level object/);
});

test('keys are compared as the texts they spell: an escape and a plain spelling are one key', () => {
  assert.match(why('{"a":1,"\\u0061":2}'), /the key "a" is given twice/);
  assert.match(why('{"\\u0041":1,"A":2}'), /the key "A" is given twice/);
  assert.match(why('{"a\\/b":1,"a/b":2}'), /the key "a\/b" is given twice/);
  assert.match(why('{"line\\nfeed":1,"line\\u000afeed":2}'), /is given twice/);
  assert.equal(duplicateKeyProblem('{"a":1,"A":2}'), undefined);
  assert.equal(duplicateKeyProblem('{"a":1,"a ":2}'), undefined);
  assert.equal(duplicateKeyProblem('{"\\\\u0061":1,"a":2}'), undefined);
});

test('a string value is never read as a key, whatever it holds', () => {
  for (const text of ['{"a":"\\"a\\":1,\\"a\\":2"}', '{"a":"{\\"b\\":1,\\"b\\":2}","b":1}', '{"a":"x\\\\","b":"a","c":","}', '{"a":["a","a",{"b":"a"}],"b":"a"}', '{"a":"}","b":"{","c":"]","d":"["}', '{"\\"":1,"\\\\":2,"\\\\\\"":3}']) {
    assert.equal(duplicateKeyProblem(text), undefined, text);
    assert.deepEqual(valueOf(text), JSON.parse(text), text);
  }
  assert.match(why('{"a\\"b":1,"a\\"b":2}'), /is given twice/);
  assert.match(why('{"a":"},{","a":2}'), /the key "a" is given twice/);
});

test('"__proto__" and "constructor" are keys like any other', () => {
  assert.equal(duplicateKeyProblem('{"__proto__":1,"constructor":2,"toString":3}'), undefined);
  assert.match(why('{"__proto__":1,"__proto__":2}'), /the key "__proto__" is given twice/);
});

test('a text that is not JSON is refused as not JSON, with the parser\'s words; the two reasons are told apart', () => {
  for (const text of ['', '{', '{"a":1,}', '{"a":1 "b":2}', 'NaN', "{'a':1}", '{"a":1}{"a":2}', '{"a":"\n"}']) assert.match(why(text), /^not JSON \(/, JSON.stringify(text));
  assert.equal(duplicateKeyProblem('{"a":1,"a'), 'the text is not JSON');
  assert.deepEqual(parseJsonStrict('{"a":1,"a":2}'), { why: 'the key "a" is given twice in the top-level object', notJson: false });
  const r = parseJsonStrict('{"a":');
  assert.ok('why' in r && r.notJson === true);
});

test('inputJsonText: a user\'s JSON file with a key twice, bad bytes or a byte-order mark is invalid input; not JSON is left to the file\'s own parser', () => {
  const good = '{ "bank-dispute": { "klass": "refund_safety", "expect": "pass" } }\n';
  assert.equal(inputJsonText('cases', Buffer.from(good)), good);
  assert.throws(() => inputJsonText('cases', Buffer.from('{"a":{},"a":{}}')), (e: unknown) => e instanceof ImportInputError && e.message === 'INVALID_INPUT: cases: the key "a" is given twice in the top-level object');
  assert.throws(() => inputJsonText('cases', Buffer.from([0x7b, 0xff, 0x7d])), (e: unknown) => e instanceof ImportInputError && e.message === 'INVALID_INPUT: cases: the bytes are not UTF-8 text');
  assert.throws(() => inputJsonText('bar', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(good)])), (e: unknown) => e instanceof ImportInputError && e.message === 'INVALID_INPUT: bar: the file starts with a byte-order mark');
  assert.equal(inputJsonText('cases', Buffer.from('{"a":')), '{"a":');
});

test('the one decoder: UTF-8 with no byte-order mark, nothing replaced', () => {
  assert.deepEqual(decodeUtf8(Buffer.from('refund é \u{1f600}', 'utf8')), { text: 'refund é \u{1f600}' });
  assert.deepEqual(decodeUtf8(new Uint8Array(0)), { text: '' });
  assert.deepEqual(decodeUtf8(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')])), { why: 'the file starts with a byte-order mark' });
  assert.deepEqual(decodeUtf8(Buffer.from([0x7b, 0xff, 0x7d])), { why: 'the bytes are not UTF-8 text' });
  assert.deepEqual(decodeUtf8(Buffer.from([0xed, 0xa0, 0x80])), { why: 'the bytes are not UTF-8 text' });
});

test('the one count, and the one count reader of a flag', () => {
  for (const v of [1, 2, 9007199254740991]) assert.equal(isCount(v), true, String(v));
  for (const v of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '2', null, undefined, [2]]) assert.equal(isCount(v), false, String(v));
  assert.equal(positiveIntFlag('--reps', '2', 'usage: x'), 2);
  for (const text of ['0', '-1', '+1', '02', '2.0', '1e3', ' 2', '2 ', 'two', '', '0x10', '9007199254740993']) {
    assert.throws(() => positiveIntFlag('--reps', text, 'usage: x'), (e: unknown) => e instanceof ImportUsageError && e.message === `USAGE: --reps must be a positive integer, found ${JSON.stringify(text)}. usage: x`, text);
  }
});

test('a source file with a key given twice is IMPORT_SHAPE naming the file, for both tools; valid files read as before', () => {
  for (const tool of ['promptfoo', 'inspect'] as const) {
    const r = refuses('IMPORT_SHAPE', ['log.json'], () => parseSourceFile(enc('{"status":"error","a":{"x":1,"x":2}}'), 'log.json', tool));
    assert.equal(r.message, 'IMPORT_SHAPE: log.json: the key "x" is given twice in the object at /a');
  }
  assert.deepEqual(parseSourceFile(enc('{"a":{"x":1},"b":{"x":2}}'), 'log.json', 'inspect').json, { a: { x: 1 }, b: { x: 2 } });
  // The bare NaN of the Inspect path keeps its own refusal and words, ahead of the duplicate-key scan.
  assert.match(refuse2(() => parseSourceFile(enc('{"a":NaN,"a":1}'), 'log.json', 'inspect')), /not JSON .*bare NaN/);
});

test('a JSON-lines source with a key given twice on a line is IMPORT_SHAPE naming the line', () => {
  const ok = JSON.stringify({ graderEvidence: record(1) });
  const r = refuses('IMPORT_SHAPE', ['t.jsonl:2'], () => parseJsonlSourceFile(enc(`${ok}\n{"status":"truncated","status":"ok"}\n`), 't.jsonl'));
  assert.equal(r.message, 'IMPORT_SHAPE: t.jsonl:2: the key "status" is given twice in the top-level object');
  const many = refuses('IMPORT_SHAPE', ['t.jsonl:1', 't.jsonl:3'], () => parseJsonlSourceFile(enc(`{"a":1,"a":2}\n${ok}\n{"b":{"c":1,"c":2}}\n`), 't.jsonl'));
  assert.equal(many.message, 'IMPORT_SHAPE: t.jsonl:1: the key "a" is given twice in the top-level object; t.jsonl:3: the key "c" is given twice in the object at /b');
  refuses('IMPORT_SHAPE', ['t.jsonl:1'], () => parseJsonlSourceFile(enc(`${ok.slice(0, -1)},"graderEvidence":{}}\n`), 't.jsonl'));
});

test('a JSON-lines source refuses a carriage return and leading white space, naming the line', () => {
  const ok = JSON.stringify({ graderEvidence: record(1) });
  assert.equal(refuse2(() => parseJsonlSourceFile(enc(`${ok}\r\n${ok}\r\n`), 't.jsonl')), 'IMPORT_SHAPE: t.jsonl:1: the line ends with a carriage return; every line ends with a line feed alone');
  assert.match(refuse2(() => parseJsonlSourceFile(enc(`${ok}\n${ok}\r\n`), 't.jsonl')), /t\.jsonl:2: the line ends with a carriage return/);
  assert.equal(refuse2(() => parseJsonlSourceFile(enc(`${ok}\n  ${ok}\n`), 't.jsonl')), 'IMPORT_SHAPE: t.jsonl:2: the line starts with white space; a line starts with its JSON value');
  assert.match(refuse2(() => parseJsonlSourceFile(enc(`\t${ok}\n`), 't.jsonl')), /t\.jsonl:1: the line starts with white space/);
  assert.match(refuse2(() => parseJsonlSourceFile(enc(`${ok}\n \n`), 't.jsonl')), /t\.jsonl:2: the line starts with white space/);
  assert.equal(parseJsonlSourceFile(enc(`${ok}\n${ok}\n`), 't.jsonl').lines.length, 2);
});

test('the cases parser and the bar loader refuse a key given twice as an input error', () => {
  const bar = loadBar(barText);
  assert.throws(() => parseCasesFile('{"a":{"klass":"refund_policy","expect":"pass"},"a":{"klass":"refund_policy","expect":"fail"}}', bar), (e: unknown) => e instanceof ImportInputError && e.message === 'INVALID_INPUT: cases: the key "a" is given twice in the top-level object');
  assert.throws(() => parseCasesFileShape('{"a":{"klass":"k","klass":"j","expect":"pass"}}'), (e: unknown) => e instanceof ImportInputError && /^INVALID_INPUT: cases: the key "klass" is given twice in the object at \/a$/.test(e.message));
  assert.throws(() => loadBar('{"labels":["fail","pass"],"labels":["pass"]}'), (e: unknown) => e instanceof ImportInputError && e.message === 'INVALID_INPUT: bar: the key "labels" is given twice in the top-level object');
  assert.throws(() => parseCasesFile('{', bar), (e: unknown) => e instanceof ImportInputError && /^INVALID_INPUT: cases: not JSON \(/.test(e.message));
  assert.throws(() => loadBar('{'), (e: unknown) => e instanceof ImportInputError && /^INVALID_INPUT: bar: not JSON \(/.test(e.message));
});

test('runImporter decodes the cases file and the bar strictly: bytes that are not UTF-8 or a byte-order mark are exit 65', () => {
  const dir = scratch();
  const put = (name: string, data: Uint8Array | string): string => {
    const p = join(dir, name);
    writeFileSync(p, data);
    return p;
  };
  const inPath = put('in.json', '{}');
  const casesGood = '{"a":{"klass":"refund_policy","expect":"pass"}}';
  const spec = { tool: 'promptfoo' as const, usage: 'usage', graderPath: join(dir, 'none'), convert: () => assert.fail('must not convert') };
  const bom = (t: string): Uint8Array => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(t)]);
  const bad = Uint8Array.from([0x7b, 0xff, 0x7d]);
  const cases: [string, Uint8Array | string, string, Uint8Array | string, RegExp][] = [
    ['bar bom', bom(barText), 'cases', casesGood, /bar: the file starts with a byte-order mark/],
    ['bar bytes', bad, 'cases', casesGood, /bar: the bytes are not UTF-8 text/],
    ['cases bom', barText, 'cases', bom(casesGood), /cases: the file starts with a byte-order mark/],
    ['cases bytes', barText, 'cases', bad, /cases: the bytes are not UTF-8 text/],
  ];
  let n = 0;
  for (const [label, barData, , casesData, re] of cases) {
    n += 1;
    const err: string[] = [];
    const code = runImporter(['--in', inPath, '--cases', put(`c${n}.json`, casesData), '--bar', put(`b${n}.json`, barData), '--out', join(dir, `o${n}.json`)], { out: () => undefined, err: (s) => err.push(s) }, spec);
    assert.equal(code, 65, label);
    assert.match(err.join('\n'), re, label);
    assert.equal(existsSync(join(dir, `o${n}.json`)), false, label);
  }
  // A key given twice in either file is the same input error.
  const e1: string[] = [];
  assert.equal(runImporter(['--in', inPath, '--cases', put('cd.json', '{"a":{"klass":"refund_policy","expect":"pass"},"a":{}}'), '--bar', put('bd.json', barText), '--out', join(dir, 'od.json')], { out: () => undefined, err: (s) => e1.push(s) }, spec), 65);
  assert.match(e1.join('\n'), /cases: the key "a" is given twice/);
  const e2: string[] = [];
  assert.equal(runImporter(['--in', inPath, '--cases', put('ce.json', casesGood), '--bar', put('be.json', '{"labels":[],"labels":[]}'), '--out', join(dir, 'oe.json')], { out: () => undefined, err: (s) => e2.push(s) }, spec), 65);
  assert.match(e2.join('\n'), /bar: the key "labels" is given twice/);
});

// ---- checkGraderConfig: one function for the grader's settings -------------------------------------------------

const matching = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ model: 'judge-alias', max_tokens: 256, temperature: 0.7, timeoutMs: 30000, thinking: NOT_SENT, effort: NOT_SENT, maxReasks: 0, baseUrl: 'http://127.0.0.1:8099', ...over });

test('checkGraderConfig accepts settings equal to the record, and names every difference under the prefix it is given', () => {
  const rec = parsed(1);
  checkGraderConfig(matching(), rec, '/config/x');
  const r = refusal(() => checkGraderConfig(matching({ model: 'other', max_tokens: 9, extra: 1, baseUrl: 'http://127.0.0.1:1' }), rec, '/pre/fix'));
  assert.equal(r.code, 'IMPORT_EVIDENCE');
  assert.deepEqual([...r.fields], ['/pre/fix/extra', '/pre/fix/model', '/pre/fix/max_tokens', '/pre/fix/baseUrl']);
  assert.match(r.message, /\/pre\/fix\/model: "other" but the record says "judge-alias"/);
  assert.match(r.message, /\/pre\/fix\/extra: not a setting the grader sends/);
  assert.match(r.message, /\/pre\/fix\/baseUrl: posts to "http:\/\/127\.0\.0\.1:1\/v1\/messages" but the record says "http:\/\/127\.0\.0\.1:8099\/v1\/messages"/);
  const noThinking = matching();
  delete noThinking['thinking'];
  assert.match(refusal(() => checkGraderConfig(noThinking, rec, '/p')).message, /^IMPORT_EVIDENCE: \/p\/thinking: /);
});

// ---- isEntryPoint ----------------------------------------------------------------------------------------------------------

test('isEntryPoint is true for the module run as the script, through a symlink too, and false otherwise', () => {
  const dir = scratch();
  const file = join(dir, 'mod.ts');
  writeFileSync(file, '');
  const link = join(dir, 'link.ts');
  symlinkSync(file, link);
  assert.equal(isEntryPoint(pathToFileURL(file).href, file), true);
  assert.equal(isEntryPoint(pathToFileURL(file).href, link), true);
  assert.equal(isEntryPoint(pathToFileURL(file).href, join(dir, 'other.ts')), false);
  assert.equal(isEntryPoint(pathToFileURL(file).href, undefined), false);
});

// ---- ungradedRefusal: the document pointer -----------------------------------------------------------------------

test('ungradedRefusal names the document only, no section; a caller\'s own closing text replaces the closing sentence', () => {
  const slots = [{ caseId: 'r1', draw: 0, reason: 'graderError' }];
  const d = ungradedRefusal(slots);
  assert.match(d.message, /\(docs\/IMPORTERS\.md\)$/);
  assert.doesNotMatch(d.message, /section|§/i);
  const own = ungradedRefusal(slots, 'Fix the flow and run the re-grade again.');
  assert.match(own.message, /r1#0 \(graderError\)\. Nothing was written\. Fix the flow and run the re-grade again\.$/);
  assert.doesNotMatch(own.message, /IMPORTERS\.md|Keep this file/);
  assert.throws(() => ungradedRefusal(slots, '  '), /instruction text/);
});

// ---- checkGraderConfig: a null or a wrong type is a value, not "not set" -------------------

/** A record whose call shape holds the grader's defaults, so that a setting read as "not set" would agree with it. */
const defaultsRecord = (): GraderRecord => parsed(1, { callShape: judgeShape({ timeoutMs: GRADER_DEFAULTS.timeoutMs, apiVersion: GRADER_DEFAULTS.apiVersion, endpoint: `${GRADER_DEFAULTS.baseUrl}/v1/messages` }) });
/** The settings that agree with that record with every optional key absent. */
const bare = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ model: 'judge-alias', max_tokens: 256, temperature: 0.7, thinking: NOT_SENT, effort: NOT_SENT, maxReasks: 0, ...over });

test('an absent optional setting is the grader\'s default; a null or a value of another type is never read as that default', () => {
  const rec = defaultsRecord();
  // Absent: the default, which is what the record shows.
  checkGraderConfig(bare(), rec, '/c');
  checkGraderConfig(bare({ timeoutMs: 60000, apiVersion: '2023-06-01', baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'JUDGE_KEY' }), rec, '/c');
  // The cases, one by one: each was read as the default, and the shipped grader refuses each.
  const one = (over: Record<string, unknown>, field: string, words: RegExp): void => {
    const r = refusal(() => checkGraderConfig(bare(over), rec, '/c'));
    assert.equal(r.code, 'IMPORT_EVIDENCE', JSON.stringify(over));
    assert.deepEqual([...r.fields], [`/c/${field}`], JSON.stringify(over));
    assert.match(r.message, words, JSON.stringify(over));
  };
  one({ timeoutMs: null }, 'timeoutMs', /^IMPORT_EVIDENCE: \/c\/timeoutMs: null but the record says 60000$/);
  one({ timeoutMs: '60000' }, 'timeoutMs', /\/c\/timeoutMs: "60000" but the record says 60000/);
  one({ timeoutMs: false }, 'timeoutMs', /\/c\/timeoutMs: false but the record says 60000/);
  one({ apiVersion: null }, 'apiVersion', /^IMPORT_EVIDENCE: \/c\/apiVersion: null but the record says "2023-06-01"$/);
  one({ apiVersion: 20230601 }, 'apiVersion', /\/c\/apiVersion: 20230601 but the record says/);
  one({ baseUrl: 42 }, 'baseUrl', /^IMPORT_EVIDENCE: \/c\/baseUrl: must be a non-empty string; the grader refuses such a base URL$/);
  one({ baseUrl: null }, 'baseUrl', /\/c\/baseUrl: must be a non-empty string/);
  one({ baseUrl: '' }, 'baseUrl', /\/c\/baseUrl: must be a non-empty string/);
  one({ baseUrl: ['https://api.anthropic.com'] }, 'baseUrl', /\/c\/baseUrl: must be a non-empty string/);
  // These three post to the very endpoint the record names: the comparison of endpoints alone passes them.
  one({ baseUrl: 'https://user:secret@api.anthropic.com' }, 'baseUrl', /\/c\/baseUrl: holds user information; the grader refuses such a base URL$/);
  one({ baseUrl: 'https://user@api.anthropic.com' }, 'baseUrl', /\/c\/baseUrl: holds user information/);
  one({ baseUrl: 'https://api.anthropic.com?debug=1' }, 'baseUrl', /\/c\/baseUrl: holds a query or a fragment/);
  one({ baseUrl: 'https://api.anthropic.com/?' }, 'baseUrl', /\/c\/baseUrl: holds a query or a fragment/);
  one({ baseUrl: 'https://api.anthropic.com#x' }, 'baseUrl', /\/c\/baseUrl: holds a query or a fragment/);
  one({ baseUrl: 'https://api.anthropic.com/#' }, 'baseUrl', /\/c\/baseUrl: holds a query or a fragment/);
  // So do these two: a URL reads a backslash as a slash and drops white space at its ends. The grader refuses both.
  one({ baseUrl: 'https://api.anthropic.com\\' }, 'baseUrl', /^IMPORT_EVIDENCE: \/c\/baseUrl: holds white space, an "@" or a backslash; the grader refuses such a base URL$/);
  one({ baseUrl: ' https://api.anthropic.com' }, 'baseUrl', /\/c\/baseUrl: holds white space, an "@" or a backslash/);
  assert.match(refusal(() => checkGraderConfig(bare(), parsed(1, { callShape: judgeShape({ timeoutMs: 60000, endpoint: 'http://api.example.test/v1/messages' }) }), '/c')).message, /\/c\/baseUrl: posts to "https:/);
  one({ baseUrl: 'http://api.anthropic.com' }, 'baseUrl', /\/c\/baseUrl: is plain http to a host that is not 127\.0\.0\.1 or \[::1\]; the grader refuses such a base URL$/);
  one({ baseUrl: 'not a url' }, 'baseUrl', /\/c\/baseUrl: is not a URL/);
  one({ baseUrl: 'ftp://api.anthropic.com' }, 'baseUrl', /\/c\/baseUrl: is not http or https/);
  one({ apiKeyEnv: null }, 'apiKeyEnv', /^IMPORT_EVIDENCE: \/c\/apiKeyEnv: not the name of an environment variable \(letters, digits and underscores, not opening with a digit\); the value is not shown$/);
  one({ apiKeyEnv: 7 }, 'apiKeyEnv', /\/c\/apiKeyEnv: not the name of an environment variable/);
  one({ apiKeyEnv: '' }, 'apiKeyEnv', /\/c\/apiKeyEnv: not the name of an environment variable/);
  one({ apiKeyEnv: 'sk-example-0123456789-not-a-real-key' }, 'apiKeyEnv', /\/c\/apiKeyEnv: not the name of an environment variable/);
  // The other settings were already compared as values.
  one({ temperature: null }, 'temperature', /\/c\/temperature: /);
  one({ temperature: '0.7' }, 'temperature', /\/c\/temperature: /);
  one({ model: null }, 'model', /\/c\/model: null but the record says "judge-alias"/);
  one({ max_tokens: null }, 'max_tokens', /\/c\/max_tokens: null but the record says 256/);
  one({ max_tokens: '256' }, 'max_tokens', /\/c\/max_tokens: "256" but the record says 256/);
  one({ thinking: null }, 'thinking', /\/c\/thinking: null but the record says it sent "NOT_SENT"/);
  one({ effort: null }, 'effort', /\/c\/effort: null but the record says "NOT_SENT"/);
  // Neither a URL nor a key's variable is echoed: either may hold a credential.
  for (const over of [{ baseUrl: 'https://user:secret@api.anthropic.com' }, { apiKeyEnv: 'sk-secret-0123' }]) {
    assert.doesNotMatch(refusal(() => checkGraderConfig(bare(over), rec, '/c')).message, /secret/);
  }
  // A record whose endpoint is not the default: an absent base URL is still the default, and differs.
  assert.match(refusal(() => checkGraderConfig(bare({ timeoutMs: 30000 }), parsed(1), '/c')).message, /\/c\/baseUrl: posts to "https:\/\/api\.anthropic\.com\/v1\/messages" but the record says "http:\/\/127\.0\.0\.1:8099\/v1\/messages"/);
  // The list and the refusal are one: every problem, each with its setting.
  const many = graderConfigProblems(bare({ timeoutMs: null, baseUrl: 42, apiKeyEnv: null }), rec, '/c');
  assert.deepEqual(many.map(problemField), ['/c/timeoutMs', '/c/apiKeyEnv', '/c/baseUrl']);
  assert.deepEqual(graderConfigProblems(bare(), rec, '/c'), []);
});

test('the base URL rule is the shipped graders\': an address a URL parser leaves as written; no white space, "@" or backslash anywhere; plain http to the literal addresses 127.0.0.1 and [::1] only, and not to the name localhost', () => {
  for (const url of ['https://api.anthropic.com', 'https://api.anthropic.com/', 'https://api.anthropic.com/base/', 'http://127.0.0.1:8099', 'http://127.0.0.1:18765', 'https://localhost', 'https://localhost:8443/p', 'http://[::1]:1', 'http://[::1]:18765',
    'https://gateway.example/anthropic', 'https://api.example.test:8443/Base/v2', 'https://1.2.3.4', 'https://a-b.c1.example.test', 'http://127.0.0.1', 'https://[::1]:8443']) {
    assert.equal(graderBaseUrlProblem(url), undefined, url);
  }
  // An address a URL parser would write in another way, in one wording: upper case, a closing dot, an empty label, a
  // host that reads as a number, a percent escape or a letter outside ASCII in the host, IPv6 in any form but [::1],
  // the scheme's own port, an empty port, port 0 and a port out of range, a control character.
  for (const url of ['HTTPS://API.EXAMPLE.TEST', 'Https://api.example.test', 'https://API.example.test', 'http://LOCALHOST:1', 'https://api.example.test.', 'http://localhost.:1', 'https://a..test', 'https://-a.test',
    'https://a-.test', 'https://a_b.test', 'https://xn--bcher-kva.test', 'http://127.1:1', 'http://0x7f.0.0.1:1', 'http://2130706433:1', 'http://127.0.0.01:1', 'http://0177.0.0.1:1', 'https://1.2.3', 'https://1.2.3.4.5',
    'https://1.2.3.256', 'https://1.2.3.4.', 'https://example.123', 'https://%68.test', 'https://b\u00fccher.test', 'https://[0:0:0:0:0:0:0:1]', 'http://[0:0:0:0:0:0:0:1]:1', 'https://[::1]x', 'https://[::]', 'https://[::2]',
    'https://[2001:db8::1]', 'https://[::ffff:127.0.0.1]', 'https://[fe80::1%25en0]', 'https://[0::1]', 'https://api.example.test:443', 'http://127.0.0.1:80', 'http://localhost:80', 'https://api.example.test:',
    'https://api.example.test:0', 'https://api.example.test:080', 'https://api.example.test:65536', 'https://api.example.test:1:2', 'https://api.example.test:+1', 'https://h\u0000', 'https://h\u007f', 'https://h\u0001/x']) {
    // One the platform's parser cannot read at all is named as endpointProblem names it; every other one in the one wording.
    assert.equal(graderBaseUrlProblem(url), endpointProblem(url) ?? 'is not written in its plain form', JSON.stringify(url));
  }
  for (const url of ['HTTPS://API.EXAMPLE.TEST', 'https://api.example.test.', 'http://127.1:1', 'https://1.2.3', 'https://%68.test', 'https://[0:0:0:0:0:0:0:1]', 'https://api.example.test:443', 'https://api.example.test:0']) {
    assert.equal(graderBaseUrlProblem(url), 'is not written in its plain form', url);
  }
  // The path keeps its own words, and so does an address that is no scheme, "//", host and path.
  for (const url of ['https://api.example.test/a/../b', 'https://api.example.test/a%20b', 'https://api.example.test//a', 'https://api.example.test/caf\u00e9']) assert.equal(graderBaseUrlProblem(url), 'has a path that is not plain segments', url);
  for (const url of ['https:api.example.test', 'https:/api.example.test']) assert.equal(graderBaseUrlProblem(url), 'is not a URL', url);
  // Plain http is for the two literal addresses. The name localhost is whatever the machine's resolver says it is: refused over plain http, taken over https.
  for (const url of ['http://api.example.test', 'http://127.0.0.2:1', 'http://localhost', 'http://localhost:1', 'http://localhost:18765', 'http://localhost:18765/p', 'http://localhost.localdomain:1', 'http://ip6-localhost:1']) {
    assert.equal(graderBaseUrlProblem(url), 'is plain http to a host that is not 127.0.0.1 or [::1]', url);
  }
  for (const url of ['https://api.example.test/a b', ' https://api.example.test', 'https://api.example.test ', 'https://api.example.test/a@b', 'https://api.example.test\\x', 'https://api.example.test/\t', 'https://api.example.test\n',
    'https://api.example.test\r\n', 'https://api.example.test\u000b', 'https://api.example.test\u000c']) {
    assert.equal(graderBaseUrlProblem(url), 'holds white space, an "@" or a backslash', JSON.stringify(url));
  }
  // What endpointProblem names, it names in the same words.
  for (const url of [7, null, undefined, '', 'https://u:p@h', 'https://h?x', 'https://h#x', 'ftp://h', 'h']) assert.equal(graderBaseUrlProblem(url), endpointProblem(url), String(url));
  assert.deepEqual([...GRADER_LOOPBACK_HOSTS], ['127.0.0.1', '[::1]']);
  assert.equal(GRADER_KEY_ENV_NAME.source, '^[A-Za-z_][A-Za-z0-9_]*$');
  // The two constants are the grader file's own, and so are the three forms of the host and the port, in both graders.
  const grader = readFileSync(join(import.meta.dirname, '..', 'examples', 'importers', 'promptfoo', 'grader-provider.cjs'), 'utf8');
  const shared = readFileSync(join(import.meta.dirname, '..', 'examples', 'importers', 'shared.ts'), 'utf8');
  const inspectGrader = readFileSync(join(import.meta.dirname, '..', 'examples', 'importers', 'inspect', 'recording_grader.py'), 'utf8');
  assert.ok(grader.includes("const LOOPBACK = new Set(['127.0.0.1', '[::1]']);"));
  assert.ok(inspectGrader.includes('LOOPBACK = {"127.0.0.1", "[::1]"}'));
  for (const text of [grader, inspectGrader, shared]) assert.ok(!text.includes("'localhost', '127.0.0.1'") && !text.includes('"localhost", "127.0.0.1"'));
  for (const [name, form, python] of [['HOST_LABEL', '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?', false], ['IPV4_PART', '(0|[1-9][0-9]{0,2})', '0|[1-9][0-9]{0,2}'], ['PORT_FORM', '[1-9][0-9]{0,4}', false]] as const) {
    assert.ok(grader.includes(`const ${name} = /^${form}$/;`), name);
    assert.ok(shared.includes(`const GRADER_${name} = /^${form}$/;`), name);
    // In Python the form is matched whole (fullmatch), so it is written with no anchors.
    assert.ok(inspectGrader.includes(`${name} = re.compile(r"${python === false ? form : python}")`), name);
  }
  assert.ok(grader.includes('const KEY_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;'));
});

// ---- the two source readers: one decoder, one strict reader, no unpaired surrogate ----------------------

const HIGH = '\ud800';
const LOW = '\udc00';
/** A JSON text that spells the string with escapes: the bytes of the file are plain ASCII. */
const escaped = (v: unknown): string => {
  const text = JSON.stringify(v);
  assert.ok(text.isWellFormed());
  return text;
};

test('parseSourceFile refuses an unpaired surrogate anywhere in the file, in a value or a key, as IMPORT_SHAPE with every JSON path', () => {
  const file = { results: { results: [{ response: { output: `refund approved ${HIGH}` } }, { vars: { [`k${LOW}`]: 'x' } }] }, meta: [`${LOW}${HIGH}`, 'fine 😀'] };
  for (const tool of ['promptfoo', 'inspect'] as const) {
    const r = refuses('IMPORT_SHAPE', ['$.results.results[0].response.output', '$.results.results[1].vars', '$.meta[0]'], () => parseSourceFile(enc(escaped(file)), 'log.json', tool));
    assert.match(r.message, /^IMPORT_SHAPE: log\.json: \$\.results\.results\[0\]\.response\.output: holds an unpaired surrogate/);
    assert.match(r.message, /log\.json: \$\.results\.results\[1\]\.vars: the object key "k\\udc00" holds an unpaired surrogate/);
    // The message can be printed: the surrogate is written as an escape.
    assert.ok(r.message.isWellFormed());
  }
  // A paired surrogate and the replacement character are text.
  assert.deepEqual(parseSourceFile(enc(escaped({ a: '😀 �' })), 'log.json', 'promptfoo').json, { a: '😀 �' });
  assert.deepEqual(illFormedProblems({ a: ['😀', { b: 1 }] }), []);
  assert.deepEqual(illFormedProblems({ a: [HIGH] }).map(problemField), ['$.a[0]']);
});

test('the source file is read by the one decoder and the one strict reader: a byte-order mark by name, and a text nested too deep', () => {
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
  // The same words as for a cases file: the mark is not handed to the parser in one reader and named in another.
  assert.equal(refuses('IMPORT_SHAPE', ['log.json'], () => parseSourceFile(bom, 'log.json', 'promptfoo')).message, 'IMPORT_SHAPE: log.json: the file starts with a byte-order mark');
  assert.throws(() => inputJsonText('cases', Buffer.from(bom)), (e: unknown) => e instanceof ImportInputError && e.message === 'INVALID_INPUT: cases: the file starts with a byte-order mark');
  assert.equal(refuses('IMPORT_SHAPE', ['t.jsonl'], () => parseJsonlSourceFile(Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0x0a]), 't.jsonl')).message, 'IMPORT_SHAPE: t.jsonl: the file starts with a byte-order mark');
  const bad = Uint8Array.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
  assert.equal(refuses('IMPORT_SHAPE', ['log.json'], () => parseSourceFile(bad, 'log.json', 'inspect')).message, 'IMPORT_SHAPE: log.json: the bytes are not UTF-8 text');
  // JSON lines: a byte that is not UTF-8 inside a string of a line that is otherwise good. A lenient decoder would
  // put U+FFFD there and read the line.
  const ok = JSON.stringify({ graderEvidence: record(1) });
  const line = Buffer.from(`${ok}\n`);
  line[line.indexOf('judge-alias')] = 0xff;
  assert.equal(JSON.parse(line.toString('utf8')).graderEvidence.requestedModel, '�udge-alias');
  assert.equal(refuses('IMPORT_SHAPE', ['t.jsonl'], () => parseJsonlSourceFile(line, 't.jsonl')).message, 'IMPORT_SHAPE: t.jsonl: the bytes are not UTF-8 text');
  // Depth: the library's rule, in every JSON text an importer reads.
  const deep = (n: number): string => `${'['.repeat(n)}${']'.repeat(n)}`;
  assert.deepEqual(parseJsonStrict(`{"a":${deep(127)}}`), { value: JSON.parse(`{"a":${deep(127)}}`) });
  for (const n of [128, 5000, 200_000]) {
    assert.deepEqual(parseJsonStrict(`{"a":${deep(n)}}`), { why: 'objects and lists are nested more than 128 deep', notJson: false });
    for (const tool of ['promptfoo', 'inspect'] as const) {
      assert.equal(refuses('IMPORT_SHAPE', ['log.json'], () => parseSourceFile(enc(`{"zz":${deep(n)}}`), 'log.json', tool)).message, 'IMPORT_SHAPE: log.json: objects and lists are nested more than 128 deep');
    }
    assert.equal(refuses('IMPORT_SHAPE', ['t.jsonl:2'], () => parseJsonlSourceFile(enc(`${ok}\n{"zz":${deep(n)}}\n`), 't.jsonl')).message, 'IMPORT_SHAPE: t.jsonl:2: objects and lists are nested more than 128 deep');
    assert.throws(() => inputJsonText('bar', Buffer.from(`{"zz":${deep(n)}}`)), (e: unknown) => e instanceof ImportInputError && e.message === 'INVALID_INPUT: bar: objects and lists are nested more than 128 deep');
    assert.throws(() => loadBar(`{"zz":${deep(n)}}`), (e: unknown) => e instanceof ImportInputError && e.message === 'INVALID_INPUT: bar: objects and lists are nested more than 128 deep');
    assert.throws(() => parseCasesFileShape(`{"c1":${deep(n)}}`), (e: unknown) => e instanceof ImportInputError && e.message === 'INVALID_INPUT: cases: objects and lists are nested more than 128 deep');
  }
  // A bare NaN in an Inspect log keeps its sentence, and only when the text is not JSON.
  assert.match(refusal(() => parseSourceFile(enc('{"value": NaN}'), 'f.json', 'inspect')).message, /not JSON \(.*\); the file holds a bare NaN/);
  assert.doesNotMatch(refusal(() => parseSourceFile(enc('{"a":"NaN ok","b":1,"b":2}'), 'f.json', 'inspect')).message, /bare NaN/);
});

test('parseJsonlSourceFile refuses a line with an unpaired surrogate, naming each line; a caller that names it more closely is handed the lines and the refusal', () => {
  const ok = JSON.stringify({ graderEvidence: record(1) });
  const text = `${ok}\n${escaped({ storedOutput: `ok ${HIGH}`, [`k${LOW}`]: 1 })}\n${ok}\n${escaped({ parts: { answer: HIGH } })}\n`;
  const r = refuses('IMPORT_SHAPE', ['t.jsonl:2', 't.jsonl:4'], () => parseJsonlSourceFile(enc(text), 't.jsonl'));
  assert.match(r.message, /^IMPORT_SHAPE: t\.jsonl:2: \$\.storedOutput: holds an unpaired surrogate/);
  assert.match(r.message, /t\.jsonl:2: \$: the object key "k\\udc00" holds an unpaired surrogate/);
  assert.match(r.message, /t\.jsonl:4: \$\.parts\.answer: holds an unpaired surrogate/);
  assert.ok(r.message.isWellFormed());
  // It is refused before the file is said to hold no record.
  refuses('IMPORT_SHAPE', ['t.jsonl:1'], () => parseJsonlSourceFile(enc(`${escaped({ a: HIGH })}\n`), 't.jsonl'));
  // The caller's part: the lines come back, and the refusal for them is the same one.
  const left = parseJsonlSourceFile(enc(text), 't.jsonl', undefined, 'refused by the caller');
  assert.equal(left.lines.length, 4);
  const own = illFormedLineRefusal(left.lines, 't.jsonl');
  assert.ok(own instanceof ImportRefusal);
  assert.deepEqual([own.code, [...own.fields], own.message], [r.code, [...r.fields], r.message]);
  assert.equal(illFormedLineRefusal([JSON.parse(ok), { a: '😀' }], 't.jsonl'), undefined);
  // A file with no such text reads as before, with either word.
  assert.deepEqual(parseJsonlSourceFile(enc(`${ok}\n`), 't.jsonl', undefined, 'refused by the caller').lines, parseJsonlSourceFile(enc(`${ok}\n`), 't.jsonl').lines);
});

test('runImporter reads the bar and the cases file through inputJsonText: a file nested too deep is exit 65, and no error of the reader is exit 70', () => {
  const dir = scratch();
  const deep = `${'['.repeat(200_000)}${']'.repeat(200_000)}`;
  const barText = JSON.stringify({ labels: ['fail', 'pass'], classes: { refund_policy: { direction: 'floor', minPassRate: 0 } }, knownFailures: [] });
  const casesText = '{"a":{"klass":"refund_policy","expect":"pass"}}';
  const put = (name: string, text: string): string => {
    writeFileSync(join(dir, name), text);
    return join(dir, name);
  };
  const spec = { tool: 'promptfoo' as const, usage: 'usage', graderPath: join(dir, 'none'), convert: (): never => { throw new Error('the conversion must not be reached'); } };
  const inPath = put('in.json', '{}');
  for (const [name, bar, cases, words] of [
    ['a deep bar', `{"zz":${deep}}`, casesText, /^INVALID_INPUT: bar: objects and lists are nested more than 128 deep$/],
    ['a deep cases file', barText, `{"a":${deep}}`, /^INVALID_INPUT: cases: objects and lists are nested more than 128 deep$/],
  ] as const) {
    const err: string[] = [];
    const code = runImporter(['--in', inPath, '--cases', put('c.json', cases), '--bar', put('b.json', bar), '--out', join(dir, 'o.json')], { out: () => undefined, err: (s) => err.push(s) }, spec);
    assert.deepEqual([code, err.length], [65, 1], name);
    assert.match(err[0] as string, words, name);
    assert.equal(existsSync(join(dir, 'o.json')), false, name);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The bounded, recorded re-ask: record v7, IMPORT_REASK, the set checks, the attempts, the line, the harness string
// ---------------------------------------------------------------------------------------------------------------

/** An earlier ask whose reply was cut at the output cap, as a grader writes it. */
const cutAsk = (seq: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  reason: 'truncated', callSeq: seq, callId: `call-${seq}`, httpStatus: 200, responseId: `msg-${seq}`, servedModel: 'judge-2026-01-01', stopReason: 'max_tokens', contentTypes: ['text'], thinkingTokens: 604,
  usage: { input_tokens: 100, output_tokens: 1024 }, replySha256: CUT_TEXT_SHA, replyUtf8Bytes: 4, ...over,
});
/** The sha256 of the four bytes `{"pa`: the text of the cut reply of every `cutAsk`. */
const CUT_TEXT_SHA = sha256Hex('{"pa');
/** An earlier ask that got no reply. */
const noReplyAsk = (seq: number, reason: string, httpStatus: unknown, over: Record<string, unknown> = {}): Record<string, unknown> => ({ reason, callSeq: seq, callId: `call-${seq}`, httpStatus, detail: 'the grader\'s own words', ...over });
/** A record whose last ask is `seq` and whose earlier asks are given, under a bound of `max`. */
const reasked = (seq: number, max: number, earlier: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> => record(seq, { reask: { max, earlier }, ...over });
const parsedReask = (seq: number, max: number, earlier: unknown[], over: Record<string, unknown> = {}): GraderRecord => parseRecord(reasked(seq, max, earlier, over), 'p', 'promptfoo');
const without = (o: Record<string, unknown>, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

test('a record with every kind of earlier ask parses and is returned unchanged', () => {
  const raw = reasked(5, 3, [noReplyAsk(1, 'timeout', NO_RESPONSE), noReplyAsk(2, 'server-error', 529), cutAsk(4)]);
  const rec = parseRecord(raw, 'p', 'promptfoo');
  assert.deepEqual(rec, raw);
  assert.equal(rec.reask.earlier.length, 3);
  for (const tool of ['promptfoo', 'inspect'] as const) {
    parseRecord(reasked(2, 1, [noReplyAsk(1, 'transport', NO_RESPONSE)]), 'p', tool);
    parseRecord(reasked(2, 1, [noReplyAsk(1, 'rate-limited', 429)]), 'p', tool);
    for (const status of [500, 503, 529, 599]) parseRecord(reasked(2, 1, [noReplyAsk(1, 'server-error', status)]), 'p', tool);
    parseRecord(reasked(2, 2, [cutAsk(1, { thinkingTokens: 'ABSENT', usage: 'ABSENT', contentTypes: ['thinking', 'text'] })]), 'p', tool);
  }
  for (const max of [0, 1, 2, 3]) assert.equal(parseRecord(reasked(1, max, []), 'p', 'promptfoo').reask.max, max);
});

test('parseRecord names every problem of reask and usage', () => {
  const ev = (fields: string[], raw: Record<string, unknown>): ImportRefusal => refuses('IMPORT_EVIDENCE', fields, () => parseRecord(raw, 'p', 'promptfoo'));
  // usage
  ev(['p.usage'], without(record(1), 'usage'));
  for (const bad of [{ input_tokens: 1 }, { output_tokens: 1 }, { input_tokens: -1, output_tokens: 1 }, { input_tokens: 1.5, output_tokens: 1 }, { input_tokens: '1', output_tokens: 1 }, { input_tokens: 1, output_tokens: 1, cache: 0 }, 'absent', 'UNKNOWN', NOT_SENT, 0, [], true, {}]) {
    assert.ok(refusal(() => parseRecord(record(1, { usage: bad }), 'p', 'promptfoo')).fields.includes('p.usage'), JSON.stringify(bad));
  }
  assert.deepEqual([...refusal(() => parseRecord(record(1, { usage: null }), 'p', 'promptfoo')).fields], ['p.usage']);
  assert.equal(parseRecord(record(1, { usage: 'ABSENT' }), 'p', 'promptfoo').usage, 'ABSENT');
  assert.deepEqual(parseRecord(record(1, { usage: { input_tokens: 0, output_tokens: 0 } }), 'p', 'promptfoo').usage, { input_tokens: 0, output_tokens: 0 });
  // reask: a missing key, a wrong type, an unknown key
  ev(['p.reask'], without(record(1), 'reask'));
  for (const bad of ['x', 3, [], true]) ev(['p.reask'], record(1, { reask: bad }));
  ev(['p.reask.max'], record(1, { reask: { earlier: [] } }));
  ev(['p.reask.earlier'], record(1, { reask: { max: 0 } }));
  ev(['p.reask.best'], record(1, { reask: { max: 0, earlier: [], best: 1 } }));
  // a bound out of range
  for (const bad of [-1, 4, 1.5, '2', true, 100, 2 ** 53]) ev(['p.reask.max'], record(1, { reask: { max: bad, earlier: [] } }));
  assert.equal(REASK_CEILING, 3);
  for (const bad of ['x', {}, 1]) ev(['p.reask.earlier'], record(1, { reask: { max: 1, earlier: bad } }));
  for (const bad of ['x', 1, [], true]) ev(['p.reask.earlier[0]'], reasked(2, 1, [bad]));
  // an unknown key in an earlier ask, and one of the four keys both forms hold missing
  ev(['p.reask.earlier[0].reply'], reasked(2, 1, [cutAsk(1, { reply: '{"pass": true}' })]));
  ev(['p.reask.earlier[0].text'], reasked(2, 1, [noReplyAsk(1, 'timeout', NO_RESPONSE, { text: 'x' })]));
  for (const k of ['reason', 'callSeq', 'callId', 'httpStatus']) ev([`p.reask.earlier[0].${k}`], reasked(2, 1, [without(cutAsk(1), k)]));
  // the type of every key of an earlier ask
  const typed: [string, unknown][] = [
    ['reason', 5], ['callSeq', 0], ['callSeq', 1.5], ['callSeq', '1'], ['callId', ''], ['callId', 'UNKNOWN'], ['httpStatus', '200'], ['httpStatus', 'no_response'], ['httpStatus', 1.5], ['httpStatus', true],
    ['responseId', ''], ['responseId', 7], ['servedModel', 'unknown'], ['stopReason', ''], ['contentTypes', 'text'], ['contentTypes', [1]], ['thinkingTokens', -1], ['thinkingTokens', 'absent'],
    ['usage', { input_tokens: 1 }], ['usage', 'absent'],
    // the sha256 and the length of the cut reply
    ['replySha256', 'abc'], ['replySha256', 5], ['replySha256', CUT_TEXT_SHA.toUpperCase()], ['replySha256', `sha256:${CUT_TEXT_SHA}`], ['replyUtf8Bytes', -1], ['replyUtf8Bytes', 1.5], ['replyUtf8Bytes', '4'], ['replyUtf8Bytes', 2 ** 53],
    // an id or a served model with a line feed, a space, a control character, a character outside ASCII, or too long
    ['callId', 'a\nb'], ['callId', 'x'.repeat(201)], ['responseId', 'msg 1'], ['responseId', 'msg-1\r'], ['responseId', 'é'], ['servedModel', 'm\u0001'], ['servedModel', 'm\tx'], ['servedModel', 'judge\nforged line'],
  ];
  for (const [k, v] of typed) assert.deepEqual([...refusal(() => parseRecord(reasked(2, 1, [cutAsk(1, { [k]: v })]), 'p', 'promptfoo')).fields], [`p.reask.earlier[0].${k}`], `${k} ${JSON.stringify(v)}`);
  for (const bad of ['', 5, {}]) ev(['p.reask.earlier[0].detail'], reasked(2, 1, [noReplyAsk(1, 'timeout', NO_RESPONSE, { detail: bad })]));
  // a null, at any depth of the two new keys
  for (const raw of [record(1, { reask: null }), record(1, { reask: { max: null, earlier: [] } }), reasked(2, 1, [null]), reasked(2, 1, [cutAsk(1, { responseId: null })]), reasked(2, 1, [cutAsk(1, { usage: { input_tokens: null, output_tokens: 1 } })])]) {
    const r = refusal(() => parseRecord(raw, 'p', 'promptfoo'));
    assert.equal(r.code, 'IMPORT_EVIDENCE');
    assert.match(r.message, /null is not allowed/);
  }
  // every problem is named in one refusal, not the first only
  const many = refusal(() => parseRecord(record(1, { usage: 5, reask: { max: 9, earlier: [cutAsk(1, { extra: 1, callSeq: 0 })] } }), 'p', 'promptfoo'));
  assert.deepEqual([...many.fields], ['p.usage', 'p.reask.max', 'p.reask.earlier[0].extra', 'p.reask.earlier[0].callSeq']);
});

test('IMPORT_REASK: an earlier ask that finished (end_turn)', () => {
  for (const stop of ['end_turn', 'refusal', 'stop_sequence', 'tool_use', 'pause_turn', 'MAX_TOKENS', 'max_tokens ']) {
    const r = refuses('IMPORT_REASK', ['p.reask.earlier[0].stopReason'], () => parseRecord(reasked(2, 1, [cutAsk(1, { stopReason: stop })]), 'p', 'promptfoo'));
    assert.match(r.message, /a reply that was not cut at the output cap was asked again/, stop);
    assert.match(r.message, /grade again with the shipped grader, and do not edit result files$/, stop);
  }
  // a reason outside the five: the library's other reasons for a judge attempt that measured nothing are never written
  for (const reason of ['parse-failure', 'client-error', 'content-filter', 'end_turn', 'finished', '', 'Truncated']) {
    const r = refuses('IMPORT_REASK', ['p.reask.earlier[0].reason'], () => parseRecord(reasked(2, 1, [cutAsk(1, { reason })]), 'p', 'promptfoo'));
    assert.match(r.message, /is not one of the reasons a slot is asked again for \(timeout, transport, server-error, rate-limited, truncated\); a finished reply is never asked again/, reason);
  }
  // for either tool
  refuses('IMPORT_REASK', ['p.reask.earlier[0].stopReason'], () => parseRecord(reasked(2, 1, [cutAsk(1, { stopReason: 'end_turn' })]), 'p', 'inspect'));
  assert.deepEqual([...REASK_REASONS], ['timeout', 'transport', 'server-error', 'rate-limited', 'truncated']);
});

test('IMPORT_REASK: more earlier asks than the bound', () => {
  const r = refuses('IMPORT_REASK', ['p.reask.earlier'], () => parseRecord(reasked(3, 1, [cutAsk(1), cutAsk(2)]), 'p', 'promptfoo'));
  assert.match(r.message, /2 earlier ask\(s\), more than the bound of 1 re-ask\(s\) the record states/);
  refuses('IMPORT_REASK', ['p.reask.earlier'], () => parseRecord(reasked(2, 0, [cutAsk(1)]), 'p', 'promptfoo'));
  refuses('IMPORT_REASK', ['p.reask.earlier'], () => parseRecord(reasked(5, 3, [cutAsk(1), cutAsk(2), cutAsk(3), cutAsk(4)]), 'p', 'promptfoo'));
  // exactly the bound is admitted
  parseRecord(reasked(4, 3, [cutAsk(1), cutAsk(2), cutAsk(3)]), 'p', 'promptfoo');
  parseRecord(reasked(2, 1, [cutAsk(1)]), 'p', 'promptfoo');
});

test('IMPORT_REASK: reason and status disagree', () => {
  const at = ['p.reask.earlier[0].httpStatus'];
  const one = (ask: Record<string, unknown>): ImportRefusal => refuses('IMPORT_REASK', at, () => parseRecord(reasked(2, 1, [ask]), 'p', 'promptfoo'));
  // server-error with 200, 499, 600, 429 or no response
  for (const status of [200, 499, 600, 429, 400, NO_RESPONSE]) assert.match(one(noReplyAsk(1, 'server-error', status)).message, /a server error is a status from 500 to 599/, String(status));
  // rate-limited with 500, 200 or no response
  for (const status of [500, 200, 529, 430, NO_RESPONSE]) assert.match(one(noReplyAsk(1, 'rate-limited', status)).message, /a rate limit is the status 429/, String(status));
  // timeout or transport with a status
  for (const reason of ['timeout', 'transport']) for (const status of [200, 500, 429, 0]) assert.match(one(noReplyAsk(1, reason, status)).message, /an ask that got no response has "NO_RESPONSE"/, `${reason} ${status}`);
  // truncated with another status
  for (const status of [201, 500, NO_RESPONSE]) assert.match(one(cutAsk(1, { httpStatus: status })).message, /a cut reply is a status 200/, String(status));
  // truncated with no response id: not the form of a cut ask
  const noId = refuses('IMPORT_REASK', ['p.reask.earlier[0]'], () => parseRecord(reasked(2, 1, [without(cutAsk(1), 'responseId')]), 'p', 'promptfoo'));
  assert.match(noId.message, /not the form of a "truncated" ask; it lacks responseId/);
  // each key of the cut form is required of a cut ask, and a cut ask holds no detail
  for (const k of ['servedModel', 'stopReason', 'contentTypes', 'thinkingTokens', 'usage', 'replySha256', 'replyUtf8Bytes']) {
    const r = refuses('IMPORT_REASK', ['p.reask.earlier[0]'], () => parseRecord(reasked(2, 1, [without(cutAsk(1), k)]), 'p', 'promptfoo'));
    assert.match(r.message, new RegExp(`not the form of a "truncated" ask; it lacks ${k}`), k);
  }
  assert.match(refuses('IMPORT_REASK', ['p.reask.earlier[0]'], () => parseRecord(reasked(2, 1, [cutAsk(1, { detail: 'x' })]), 'p', 'promptfoo')).message, /it holds detail/);
  // an ask that got no reply holds no response id, no served model, no stop, and its detail is required
  for (const k of ['responseId', 'servedModel', 'stopReason', 'contentTypes', 'thinkingTokens', 'usage', 'replySha256', 'replyUtf8Bytes']) {
    const r = refuses('IMPORT_REASK', ['p.reask.earlier[0]'], () => parseRecord(reasked(2, 1, [{ ...noReplyAsk(1, 'server-error', 529), [k]: cutAsk(1)[k] }]), 'p', 'promptfoo'));
    assert.match(r.message, new RegExp(`not the form of a "server-error" ask; it holds ${k}`), k);
  }
  assert.match(refuses('IMPORT_REASK', ['p.reask.earlier[0]'], () => parseRecord(reasked(2, 1, [without(noReplyAsk(1, 'timeout', NO_RESPONSE), 'detail')]), 'p', 'promptfoo')).message, /it lacks detail/);
  // every broken rule of a record is named in one refusal
  const all = refusal(() => parseRecord(reasked(3, 1, [noReplyAsk(2, 'timeout', 500), cutAsk(1, { stopReason: 'end_turn' })]), 'p', 'promptfoo'));
  assert.equal(all.code, 'IMPORT_REASK');
  assert.deepEqual([...all.fields], ['p.reask.earlier', 'p.reask.earlier[0].httpStatus', 'p.reask.earlier[1].stopReason', 'p.reask.earlier[1].callSeq']);
});

test('IMPORT_REASK: callSeq does not rise through a slot\'s asks', () => {
  const r = refuses('IMPORT_REASK', ['p.reask.earlier[1].callSeq'], () => parseRecord(reasked(5, 2, [cutAsk(3), cutAsk(2)]), 'p', 'promptfoo'));
  assert.match(r.message, /p\.reask\.earlier\[1\]\.callSeq: 2 does not rise above the ask before it \(3\)/);
  refuses('IMPORT_REASK', ['p.reask.earlier[1].callSeq'], () => parseRecord(reasked(5, 2, [cutAsk(3), cutAsk(3, { callId: 'other', responseId: 'other' })]), 'p', 'promptfoo'));
  // the last ask's number is above every earlier one
  const last = refuses('IMPORT_REASK', ['p.callSeq'], () => parseRecord(reasked(1, 1, [cutAsk(2)]), 'p', 'promptfoo'));
  assert.match(last.message, /p\.callSeq: the last ask's 1 does not rise above the earlier ask before it \(2\)/);
  refuses('IMPORT_REASK', ['p.callSeq'], () => parseRecord(reasked(2, 1, [cutAsk(2, { callId: 'other', responseId: 'other' })]), 'p', 'promptfoo'));
  // rising with holes is this record's own business no further: the file-wide check finds a hole
  parseRecord(reasked(9, 2, [cutAsk(2), cutAsk(5)]), 'p', 'promptfoo');
  assert.deepEqual(reaskProblems(parsedReask(9, 2, [cutAsk(2), cutAsk(5)]), 'p'), []);
});

test('callSeq over every ask is 1 to slots plus re-asks; a hole is IMPORT_HIDDEN_CALLS', () => {
  // three slots, five asks: slot 0 asked three times (1, 2, 3), slot 1 once (4), slot 2 twice (5 and... 6)
  const slots = (seqs: [number[], number][]): RecordedSlot[] => seqs.map(([earlier, last], i) => ({ caseId: 'r0', draw: i, record: parsedReask(last, 3, earlier.map((q) => cutAsk(q))) }));
  checkRecordSet(slots([[[1, 2], 3], [[], 4], [[5], 6]]));
  checkRecordSet(slots([[[5], 6], [[], 4], [[1, 2], 3]]));
  // interleaved asks of concurrent slots are admitted: only the set of numbers is checked here
  checkRecordSet(slots([[[1, 3], 5], [[], 2], [[4], 6]]));
  // a hole among the earlier asks: an ask nobody recorded
  const hole = refuses('IMPORT_HIDDEN_CALLS', ['callSeq'], () => checkRecordSet(slots([[[1, 3], 4], [[], 5], [[6], 7]])));
  assert.match(hole.message, /callSeq: callSeq values over every ask \(3 slot\(s\) and 3 recorded re-ask\(s\)\) are not 1 to 6, each once: 1, 3, 4, 5, 6, 7/);
  // the slots alone run 1 to 3, and the earlier asks are counted too: this file would have passed a check of last asks only
  refuses('IMPORT_HIDDEN_CALLS', ['callSeq'], () => checkRecordSet([{ caseId: 'r0', draw: 0, record: parsedReask(1, 3, []) }, { caseId: 'r0', draw: 1, record: parsedReask(2, 3, []) }, { caseId: 'r0', draw: 2, record: parsedReask(9, 3, [cutAsk(7)]) }]));
  // a number used twice, by an earlier ask of one slot and the last ask of another
  refuses('IMPORT_HIDDEN_CALLS', ['callSeq'], () => checkRecordSet(slots([[[1], 2], [[], 2], [[], 3]]).map((s, i) => (i === 1 ? { ...s, record: { ...s.record, callId: 'x', responseId: 'x' } } : s))));
  // a sequence that does not start at 1
  refuses('IMPORT_HIDDEN_CALLS', ['callSeq'], () => checkRecordSet(slots([[[2], 3], [[], 4], [[], 5]])));
  // without re-asks the message is the one that was
  assert.match(refuses('IMPORT_HIDDEN_CALLS', ['callSeq'], () => checkRecordSet(slotsOf(3, (i) => ({ callSeq: i + 2 })))).message, /^IMPORT_HIDDEN_CALLS: callSeq: callSeq values are not 1 to 3, each once: 2, 3, 4$/);
});

test('an id shared by an earlier ask and any other ask is IMPORT_DUPLICATE_CALL', () => {
  const slot = (draw: number, rec: GraderRecord): RecordedSlot => ({ caseId: 'r0', draw, record: rec });
  // a call id shared by an earlier ask and the last ask of another slot
  const a = refuses('IMPORT_DUPLICATE_CALL', ['r0#0', 'r0#1'], () => checkRecordSet([slot(0, parsedReask(2, 1, [cutAsk(1, { callId: 'call-3' })])), slot(1, parsedReask(3, 1, []))]));
  assert.match(a.message, /callId: shared by slots r0#0 \(ask 1\) and r0#1/);
  // a response id shared by an earlier ask and the last ask of another slot
  const b = refuses('IMPORT_DUPLICATE_CALL', ['r0#0', 'r0#1'], () => checkRecordSet([slot(0, parsedReask(2, 1, [cutAsk(1, { responseId: 'msg-3' })])), slot(1, parsedReask(3, 1, []))]));
  assert.match(b.message, /responseId: shared by slots r0#0 \(ask 1\) and r0#1/);
  // by two earlier asks of two slots
  refuses('IMPORT_DUPLICATE_CALL', ['r0#0', 'r0#1'], () => checkRecordSet([slot(0, parsedReask(2, 1, [cutAsk(1, { responseId: 'same' })])), slot(1, parsedReask(4, 1, [cutAsk(3, { responseId: 'same' })]))]));
  // within one slot: an earlier ask and the slot's own last ask (the same reply recorded twice)
  const c = refuses('IMPORT_DUPLICATE_CALL', ['r0#0'], () => checkRecordSet([slot(0, parsedReask(2, 1, [cutAsk(1, { responseId: 'msg-2' })]))]));
  assert.match(c.message, /responseId: shared by slots r0#0 \(ask 1\) and r0#0/);
  refuses('IMPORT_DUPLICATE_CALL', ['r0#0'], () => checkRecordSet([slot(0, parsedReask(3, 2, [noReplyAsk(1, 'timeout', NO_RESPONSE, { callId: 'one' }), noReplyAsk(2, 'server-error', 500, { callId: 'one' })]))]));
  // an ask that got no response has no response id: two of them share nothing
  checkRecordSet([slot(0, parsedReask(3, 2, [noReplyAsk(1, 'timeout', NO_RESPONSE), noReplyAsk(2, 'transport', NO_RESPONSE)]))]);
});

test('two bounds in one file, or a cut ask served by another model id, is IMPORT_MIXED_IDENTITY', () => {
  const slot = (draw: number, rec: GraderRecord): RecordedSlot => ({ caseId: 'r0', draw, record: rec });
  const two = refuses('IMPORT_MIXED_IDENTITY', ['reask.max'], () => checkRecordSet([slot(0, parsedReask(1, 0, [])), slot(1, parsedReask(2, 2, []))]));
  assert.match(two.message, /reask\.max: 2 distinct values/);
  // a cut ask served by another model than the file's one served model
  const other = refuses('IMPORT_MIXED_IDENTITY', ['servedModel'], () => checkRecordSet([slot(0, parsedReask(2, 1, [cutAsk(1, { servedModel: 'judge-2026-02-02' })])), slot(1, parsedReask(3, 1, []))]));
  assert.match(other.message, /servedModel: 2 distinct values/);
  // and when the file is one slot: its own cut ask against its own last ask
  refuses('IMPORT_MIXED_IDENTITY', ['servedModel'], () => checkRecordSet([slot(0, parsedReask(2, 1, [cutAsk(1, { servedModel: 'judge-2026-02-02' })]))]));
  checkRecordSet([slot(0, parsedReask(2, 1, [cutAsk(1)])), slot(1, parsedReask(3, 1, []))]);
});

test('attemptsOf: two earlier asks give three attempts that the library\'s parser accepts', () => {
  const rec = parsedReask(3, 2, [noReplyAsk(1, 'server-error', 529, { callId: 'id-a', detail: 'TEXT-OF-THE-GRADER' }), cutAsk(2, { callId: 'id-b' })]);
  const output = sha256Hex('judged output');
  const graded = { kind: 'graded', label: 'pass', outputHash: output, systemStop: 'UNKNOWN', judgeStop: 'end', packetHash: PACKET } as const;
  const attempts = attemptsOf(rec, graded);
  assert.deepEqual(attempts, [
    { kind: 'unmeasured', role: 'judge', reason: 'server-error', detail: 'judge ask 1 of 3: no reply (server-error), status 529; callSeq 1, call id id-a', outputHash: output, systemStop: 'UNKNOWN', packetHash: PACKET },
    {
      kind: 'unmeasured', role: 'judge', reason: 'truncated',
      detail: `judge ask 2 of 3: the reply was cut at the output cap (stop "max_tokens"), status 200, response msg-2, served model judge-2026-01-01; callSeq 2, call id id-b; usage input 100 output 1024; thinking tokens 604; cut reply sha256:${CUT_TEXT_SHA} (4 UTF-8 bytes)`,
      outputHash: output, systemStop: 'UNKNOWN', packetHash: PACKET,
    },
    graded,
  ]);
  // The grader's own free text is not copied into the run.
  assert.ok(!JSON.stringify(attempts).includes('TEXT-OF-THE-GRADER'));
  // The graded attempt is last, and is the object handed in.
  assert.equal(attempts.at(-1), graded);
  // A slot that was asked once gives the one graded attempt.
  assert.deepEqual(attemptsOf(parsed(1), graded), [graded]);
  // Every reason, in the order asked; a usage and a counter the response did not state are said as ABSENT.
  const every = attemptsOf(parsedReask(4, 3, [noReplyAsk(1, 'timeout', NO_RESPONSE), noReplyAsk(2, 'transport', NO_RESPONSE), cutAsk(3, { usage: 'ABSENT', thinkingTokens: 'ABSENT' })]), graded);
  assert.deepEqual(every.map((a) => (a.kind === 'unmeasured' ? a.reason : a.kind)), ['timeout', 'transport', 'truncated', 'graded']);
  assert.equal((every[0] as { detail: string }).detail, 'judge ask 1 of 4: no reply (timeout), status NO_RESPONSE; callSeq 1, call id call-1');
  assert.ok((every[2] as { detail: string }).detail.endsWith(`; usage ABSENT; thinking tokens ABSENT; cut reply sha256:${CUT_TEXT_SHA} (4 UTF-8 bytes)`));
  // Equal bytes in give equal bytes out.
  assert.equal(JSON.stringify(attemptsOf(rec, graded)), JSON.stringify(attemptsOf(JSON.parse(JSON.stringify(rec)) as GraderRecord, { ...graded })));

  // The library's own parser accepts the run: a judge attempt that measured nothing, twice, then the graded one.
  const identity = makeJudgedIdentity({ caseSetHash: caseSetHash(wcases), drawsPerCase: 1, barHash: hashOf(BAR) });
  const run = { schema: RUN_SCHEMA, identity, callShapes: callShapesFor(identity), cases: wcases, draws: [{ caseId: 'r1', drawIndex: 0, attempts }], packetBasis: 'declared', packetSource: 'computed at import from a test' };
  const read = parseRunArtifact(JSON.parse(JSON.stringify(run)));
  assert.deepEqual(read.draws[0]?.attempts.map((a) => a.kind), ['unmeasured', 'unmeasured', 'graded']);
  const out = join(scratch(), 'reask-run.json');
  writeRun(run, loadBar(barText), out);
  assert.ok(existsSync(out));
  // The parser refuses the same list with the graded attempt anywhere but last: a slot's outcome is its last attempt.
  assert.throws(() => parseRunArtifact(JSON.parse(JSON.stringify({ ...run, draws: [{ caseId: 'r1', drawIndex: 0, attempts: [attempts[2], attempts[0]] }] }))));
});

test('judgeHarnessVersion states the bound, before the script-files component', () => {
  const files = sha256Hex('script list');
  for (const max of [0, 1, 2, 3]) {
    const rec = parsedReask(1, max, []);
    const base = `tool 1.0; ${rec.grader.name} js sha256:${rec.grader.sha256}; ${rec.grader.runtime}; max-reasks ${max}`;
    assert.equal(judgeHarnessVersion('tool', '1.0', rec), base);
    assert.equal(judgeHarnessVersion('tool', '1.0', rec, files), `${base}; script-files sha256:${files}`);
  }
  // two bounds are two strings, whatever else is equal; the re-asks a slot happened to need are not in the string
  assert.notEqual(judgeHarnessVersion('tool', '1.0', parsedReask(1, 1, [])), judgeHarnessVersion('tool', '1.0', parsedReask(1, 2, [])));
  assert.equal(judgeHarnessVersion('tool', '1.0', parsedReask(2, 2, [cutAsk(1)])), judgeHarnessVersion('tool', '1.0', parsedReask(1, 2, [])));
});

test('the re-asks line, with counts and with zeros', () => {
  assert.equal(reasksLine([parsed(1), parsed(2), parsed(3)]), 're-asks: 0 on 0 of 3 slots (truncated 0, timeout 0, transport 0, server-error 0, rate-limited 0); at most 0 per slot');
  const recs = [
    parsedReask(4, 3, [cutAsk(1), noReplyAsk(2, 'timeout', NO_RESPONSE), noReplyAsk(3, 'server-error', 500)]),
    parsedReask(5, 3, []),
    parsedReask(7, 3, [noReplyAsk(6, 'rate-limited', 429)]),
    parsedReask(10, 3, [noReplyAsk(8, 'transport', NO_RESPONSE), cutAsk(9)]),
  ];
  assert.equal(reasksLine(recs), 're-asks: 6 on 3 of 4 slots (truncated 2, timeout 1, transport 1, server-error 1, rate-limited 1); at most 3 per slot');
  assert.equal(reasksLine([parsedReask(1, 2, [])]), 're-asks: 0 on 0 of 1 slots (truncated 0, timeout 0, transport 0, server-error 0, rate-limited 0); at most 2 per slot');
  // two bounds are never summed up as one
  refuses('IMPORT_MIXED_IDENTITY', ['reask.max'], () => reasksLine([parsedReask(1, 1, []), parsedReask(2, 2, [])]));
  // the thinking line counts last asks only: a cut ask that thought is not a reply that thought
  assert.equal(thinkingRepliesLine([parsedReask(2, 1, [cutAsk(1, { contentTypes: ['thinking', 'text'] })])]), 'replies with a thinking block: 0 of 1');
  // on every success, after the thinking line and before the reading rule
  const summary = { judge: {}, barHash: 'b', caseSetHash: 'c', drawsPerCase: 3, grader: { name: 'n', language: 'js', runtime: 'node v1', sha256: 's' }, thinkingReplies: 'THINKING', reasks: 'REASKS' };
  assert.deepEqual(successLines('promptfoo', { ...summary, readingRule: 'RULE' }, 'h', undefined).slice(-5, -2), ['THINKING', 'REASKS', 'reading rule: RULE']);
  assert.deepEqual(successLines('inspect', summary, 'h', undefined).slice(-4, -2), ['THINKING', 'REASKS']);
});

test('the last two lines of a success are the run file\'s sha256 and one next-step line that says where it goes; lines an importer adds come before them', () => {
  const summary = { judge: {}, barHash: 'b', caseSetHash: 'c', drawsPerCase: 3, grader: { name: 'n', language: 'js', runtime: 'node v1', sha256: 's' }, thinkingReplies: 'THINKING', reasks: 'REASKS' };
  for (const tool of ['promptfoo', 'inspect'] as const) {
    const lines = successLines(tool, { ...summary, readingRule: 'RULE' }, 'abc123', undefined, ['EXTRA 1', 'EXTRA 2']);
    assert.deepEqual(lines.slice(-5), ['reading rule: RULE', 'EXTRA 1', 'EXTRA 2', 'run file sha256: abc123', NEXT_STEP_LINE]);
    // The sha256 is printed once (the plan fragment holds it in a JSON object, not as the sha256 line).
    assert.equal(lines.filter((l) => l.startsWith('run file sha256: ')).length, 1);
  }
  assert.match(NEXT_STEP_LINE, /^next: .*systems\.<name>\.old or \.new.*judge-change/);
  assert.ok(!NEXT_STEP_LINE.includes('\n'));
});

test('a stated bound that differs from the record is IMPORT_EVIDENCE', () => {
  const rec = parsedReask(1, 2, []);
  checkGraderConfig(matching({ maxReasks: 2 }), rec, '/c');
  for (const stated of [0, 1, 3, '2', 2.5, null, true]) {
    const r = refuses('IMPORT_EVIDENCE', ['/c/maxReasks'], () => checkGraderConfig(matching({ maxReasks: stated }), rec, '/c'));
    assert.match(r.message, /\/c\/maxReasks: .* but the record says the bound was 2 re-ask\(s\)/, JSON.stringify(stated));
  }
  // the bound has no default: a configuration without it is not the one of the grader that wrote the record, even for 0
  const absent = matching();
  delete absent['maxReasks'];
  assert.equal(refuses('IMPORT_EVIDENCE', ['/c/maxReasks'], () => checkGraderConfig(absent, parsed(1), '/c')).message, 'IMPORT_EVIDENCE: /c/maxReasks: "not set" but the record says the bound was 0 re-ask(s)');
  assert.deepEqual(graderConfigProblems(matching(), parsed(1), '/c'), []);
});

test('ungradedReason: a slot whose every ask was cut says how many asks, and that the bound is used up', () => {
  assert.equal(ungradedReason(parsedReask(2, 1, [cutAsk(1)], { stopReason: 'max_tokens' })), 'the judge\'s reply was cut at the output cap on each of 2 asks; the bound of 1 re-asks is used up');
  assert.equal(ungradedReason(parsedReask(4, 3, [cutAsk(1), cutAsk(2), cutAsk(3)], { stopReason: 'max_tokens' })), 'the judge\'s reply was cut at the output cap on each of 4 asks; the bound of 3 re-asks is used up');
  // a slot that was asked once and cut reads as it did
  assert.equal(ungradedReason(parsedReask(1, 0, [], { stopReason: 'max_tokens' })), 'the judge stopped with "max_tokens", not "end_turn"');
  assert.equal(ungradedReason(parsedReask(1, 2, [], { stopReason: 'max_tokens' })), 'the judge stopped with "max_tokens", not "end_turn"');
  // not every earlier ask was a cut: the words do not say "each"
  assert.equal(ungradedReason(parsedReask(3, 2, [noReplyAsk(1, 'server-error', 500), cutAsk(2)], { stopReason: 'max_tokens' })), 'the judge\'s reply was cut at the output cap on the last of 3 asks (2 cut, 1 with no reply); the record states a bound of 2 re-asks');
  // a re-asked slot that finished is graded; one that finished with another stop, or with unreadable content, is not
  assert.equal(ungradedReason(parsedReask(2, 1, [cutAsk(1)])), undefined);
  assert.equal(ungradedReason(parsedReask(2, 1, [cutAsk(1)], { stopReason: 'refusal' })), 'the judge stopped with "refusal", not "end_turn"');
  assert.match(ungradedReason(parsedReask(2, 1, [cutAsk(1)], { contentTypes: ['tool_use'] })) ?? '', /tool_use/);
});

// ---------------------------------------------------------------------------------------------------------------
// Cases found after the first build
// ---------------------------------------------------------------------------------------------------------------

test('a status of an earlier ask is an integer: a fraction, in range or not, is IMPORT_EVIDENCE, never a server error or a rate limit', () => {
  for (const [reason, status] of [['server-error', 503.5], ['server-error', 500.5], ['server-error', 599.9], ['rate-limited', 429.5], ['timeout', 0.5]] as const) {
    const r = refuses('IMPORT_EVIDENCE', ['p.reask.earlier[0].httpStatus'], () => parseRecord(reasked(2, 1, [noReplyAsk(1, reason, status)]), 'p', 'promptfoo'));
    assert.match(r.message, /p\.reask\.earlier\[0\]\.httpStatus: must be an integer status, or "NO_RESPONSE" for an ask that got no response/, `${reason} ${status}`);
  }
  refuses('IMPORT_EVIDENCE', ['p.reask.earlier[0].httpStatus'], () => parseRecord(reasked(2, 1, [cutAsk(1, { httpStatus: 200.5 })]), 'p', 'promptfoo'));
  // the whole numbers are taken
  parseRecord(reasked(2, 1, [noReplyAsk(1, 'server-error', 503)]), 'p', 'promptfoo');
  parseRecord(reasked(2, 1, [noReplyAsk(1, 'rate-limited', 429)]), 'p', 'promptfoo');
});

test('a call id, a response id and a served model are visible ASCII with no space: a line feed or a control character cannot reach a detail text or a report', () => {
  const form = /must be 1 to 200 visible ASCII characters with no space \(no control character, no line feed\)/;
  // the last ask's own three
  for (const k of ['callId', 'responseId', 'servedModel']) {
    for (const bad of ['a\nb', 'a b', 'a\tb', 'a\rb', 'a\u0000b', 'a\u007fb', 'a\u0085b', 'é', 'x'.repeat(201), 'ok\nREFUSED forged: line']) {
      const r = refuses('IMPORT_EVIDENCE', [`p.${k}`], () => parseRecord(record(1, { [k]: bad }), 'p', 'promptfoo'));
      assert.match(r.message, form, `${k} ${JSON.stringify(bad)}`);
    }
    assert.equal((parseRecord(record(1, { [k]: 'x'.repeat(200) }), 'p', 'promptfoo') as unknown as Record<string, unknown>)[k], 'x'.repeat(200));
    assert.equal((parseRecord(record(1, { [k]: 'msg_01AbC-9.z:~/+=' }), 'p', 'inspect') as unknown as Record<string, unknown>)[k], 'msg_01AbC-9.z:~/+=');
  }
  // an earlier ask's: what `attemptsOf` copies into a detail
  for (const [k, ask] of [['callId', cutAsk(1, { callId: 'id\nforged' })], ['responseId', cutAsk(1, { responseId: 'msg\nforged' })], ['servedModel', cutAsk(1, { servedModel: 'm\nforged' })], ['callId', noReplyAsk(1, 'timeout', NO_RESPONSE, { callId: 'id\nforged' })]] as const) {
    const r = refuses('IMPORT_EVIDENCE', [`p.reask.earlier[0].${k}`], () => parseRecord(reasked(2, 1, [ask]), 'p', 'promptfoo'));
    assert.match(r.message, form, k);
  }
  // so no detail text of an imported run holds a line feed or a control character
  const graded = { kind: 'graded', label: 'pass', outputHash: sha256Hex('o'), systemStop: 'UNKNOWN', judgeStop: 'end', packetHash: PACKET } as const;
  for (const a of attemptsOf(parsedReask(4, 3, [noReplyAsk(1, 'timeout', NO_RESPONSE, { detail: 'a grader text\nwith a line feed' }), noReplyAsk(2, 'server-error', 529), cutAsk(3)]), graded)) {
    if (a.kind === 'unmeasured') assert.match(a.detail ?? '', /^[\x20-\x7e]+$/);
  }
});

test('a cut ask states the sha256 and the UTF-8 length of the cut reply, and the two cannot contradict each other', () => {
  const empty = sha256Hex('');
  assert.equal(empty, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  // no bytes and the hash of no bytes; some bytes and another hash
  parseRecord(reasked(2, 1, [cutAsk(1, { replySha256: empty, replyUtf8Bytes: 0 })]), 'p', 'promptfoo');
  assert.equal((parsedReask(2, 1, [cutAsk(1)]).reask.earlier[0] as { replySha256: string }).replySha256, CUT_TEXT_SHA);
  // no bytes with the hash of some text; some bytes with the hash of no text
  for (const over of [{ replyUtf8Bytes: 0 }, { replySha256: empty }, { replySha256: empty, replyUtf8Bytes: 1 }]) {
    const r = refuses('IMPORT_REASK', ['p.reask.earlier[0].replySha256'], () => parseRecord(reasked(2, 1, [cutAsk(1, over)]), 'p', 'inspect'));
    assert.match(r.message, /contradict each other; a cut reply of 0 bytes, and no other, has the sha256 of the empty text/, JSON.stringify(over));
  }
  // an ask that got no reply states neither
  assert.deepEqual(Object.keys(noReplyAsk(1, 'timeout', NO_RESPONSE)).sort(), ['callId', 'callSeq', 'detail', 'httpStatus', 'reason']);
});

test('a reply is read through the strict reader: a key given twice, nesting beyond the depth and an unpaired surrogate are "not a verdict" under either rule', () => {
  const not = 'not exactly one JSON object with a boolean "pass"';
  const deep = (n: number): string => `${'['.repeat(n)}${']'.repeat(n)}`;
  // The plain parser keeps the last of two equal keys and says nothing: these two replies would read as fail and as pass.
  assert.deepEqual(JSON.parse('{"pass":true,"pass":false}'), { pass: false });
  assert.deepEqual(JSON.parse('{"pass":false,"pass":true}'), { pass: true });
  const replies = [
    '{"pass":true,"pass":false}',
    '{"pass":false,"pass":true}',
    '{"pass":true,"pass":true}',
    '{"pass":true,"reason":"a","reason":"b"}',
    '{"pass":true,"detail":{"a":1,"a":2}}',
    '{"pass":true,"p\\u0061ss":false}',
    `{"pass":true,"reason":${deep(128)}}`,
    '{"pass":true,"reason":"\\ud800"}',
    '{"pass":true,"\\udc00":1}',
  ];
  for (const rule of READINGS) {
    for (const reply of replies) {
      assert.equal(readUnderRule(rule, reply), not, `${rule} ${reply.slice(0, 60)}`);
      assert.equal(readUnderRule(rule, ` \n${reply}\n`), not, `${rule} ${reply.slice(0, 60)}`);
    }
  }
  for (const reply of replies) {
    assert.equal(readUnderRule(OR_FENCE, `\`\`\`json\n${reply}\n\`\`\``), not, reply.slice(0, 60));
    // and no rule is offered as the one that would read it
    assert.equal(readableUnderOtherRule(ONE_OBJECT, `\`\`\`json\n${reply}\n\`\`\``), undefined, reply.slice(0, 60));
    assert.equal(readableUnderOtherRule(OR_FENCE, reply), undefined, reply.slice(0, 60));
  }
  // What is still a verdict: one key each, nesting within the depth, a paired surrogate.
  assert.deepEqual(readUnderRule(ONE_OBJECT, `{"pass":true,"reason":${deep(127)}}`), { pass: true, reason: JSON.parse(deep(127)) });
  assert.deepEqual(readUnderRule(ONE_OBJECT, '{"pass":false,"reason":"\\ud83d\\ude00"}'), { pass: false, reason: '\u{1f600}' });
  assert.deepEqual(readUnderRule(ONE_OBJECT, '{"pass":true,"a":{"pass":false}}'), { pass: true, reason: undefined });
});

test('parseJsonStrict is the library\'s parseJsonText under the importers\' words: the same texts are values, and "not JSON (<the parser\'s message>)" is kept', () => {
  const deep = (n: number): string => `${'['.repeat(n)}${']'.repeat(n)}`;
  const texts = ['{"a":1}', '[]', '1', '"x"', 'null', '', '{', '{"a":', 'NaN', '{"a":1,"a":2}', '[{"k":1,"k":1}]', deep(128), deep(129), `{"a":${deep(128)}}`, '\ufeff{}', '{"a":1}x'];
  for (const text of texts) {
    const lib = parseJsonText(text);
    const own = parseJsonStrict(text);
    assert.equal('json' in lib, 'value' in own, JSON.stringify(text.slice(0, 20)));
    if ('json' in lib && 'value' in own) assert.deepEqual(own.value, lib.json);
    if ('problem' in lib && 'why' in own) {
      assert.equal(own.notJson, lib.notJson);
      assert.equal(own.why, lib.notJson ? `not JSON (${lib.problem.replace(/^invalid JSON: /, '')})` : lib.problem);
    }
  }
  // the pinned words of each kind
  let parserSays = '';
  try {
    JSON.parse('{"a":');
  } catch (e) {
    parserSays = (e as Error).message;
  }
  assert.deepEqual(parseJsonStrict('{"a":'), { why: `not JSON (${parserSays})`, notJson: true });
  assert.deepEqual(parseJsonStrict(deep(129)), { why: 'objects and lists are nested more than 128 deep', notJson: false });
  assert.deepEqual(parseJsonStrict('{"a":1,"a":2}'), { why: 'the key "a" is given twice in the top-level object', notJson: false });
  // depth is named before a key given twice, as the library names it
  assert.deepEqual(parseJsonStrict(`{"a":1,"a":${deep(128)}}`), { why: 'objects and lists are nested more than 128 deep', notJson: false });
});

test('positiveIntFlag with a bound: a count beyond it is a usage error that names the flag and the bound; without one no count is too large', () => {
  assert.equal(positiveIntFlag('--draws', '100000', 'usage: x', 100000), 100000);
  assert.equal(positiveIntFlag('--draws', '1', 'usage: x', 1), 1);
  for (const text of ['100001', '4294967296', '9007199254740991']) {
    assert.throws(() => positiveIntFlag('--draws', text, 'usage: x', 100000), (e: unknown) => e instanceof ImportUsageError && e.message === `USAGE: --draws must be at most 100000, found ${text}. usage: x`, text);
  }
  // a text that is not a count is said as that, with or without a bound
  for (const text of ['0', '2.5', '1e3', '9007199254740993']) {
    assert.throws(() => positiveIntFlag('--draws', text, 'usage: x', 100000), (e: unknown) => e instanceof ImportUsageError && e.message === `USAGE: --draws must be a positive integer, found ${JSON.stringify(text)}. usage: x`, text);
  }
  assert.equal(positiveIntFlag('--max-tokens', '4294967296', 'usage: x'), 4294967296);
});

test('valueTypeProblems names a hole of a list, which JSON would write as a null', () => {
  const out: string[] = [];
  // eslint-disable-next-line no-sparse-arrays
  valueTypeProblems({ a: [1, , 3], b: [undefined] }, 'v', out);
  assert.deepEqual(out, ['v.a[1]: unsupported value type', 'v.b[0]: unsupported value type']);
  assert.equal(JSON.stringify({ a: [1, , 3] }), '{"a":[1,null,3]}');
});

test('slotLabel is the one way a slot is named: <case>#<draw>, and the case alone for a draw that could not be read', () => {
  assert.equal(slotLabel('faulty-headphones', 2), 'faulty-headphones#2');
  assert.equal(slotLabel('r0', 0), 'r0#0');
  assert.equal(slotLabel('3 row(s) fewer', -1), '3 row(s) fewer');
});

// ---- a reader that closed its end of the pipe ----------------------------------------------------------------------------
// The contract (docs/IMPORTERS.md) is that an importer script never exits 1: that is the library's verdict "regression".
// A reader that closes the pipe (`... | head -n 1`) used to end the script on an unhandled EPIPE with exit 1.

/** Runs a script with its stdout and stderr read ends destroyed at once, so every write meets a closed pipe; resolves to the exit code. */
function runWithClosedPipes(args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.destroy();
    child.stderr.destroy();
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
}
test('every importer script keeps its own exit code when the reader of its stderr has gone: a usage error is 64, never 1', async () => {
  for (const script of ['promptfoo/import.ts', 'inspect/import.ts', 'skill-evals/import.ts', 'skill-evals/check.ts', 'skill-evals/regrade.ts']) {
    assert.equal(await runWithClosedPipes([join(importersDir, script)]), 64, script);
  }
});

test('an importer that wrote its run file keeps exit 0 when the reader of its stdout has gone, and the file is whole', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'importer-epipe-'));
  const out = join(dir, 'run.json');
  const p = join(importersDir, 'promptfoo');
  const code = await runWithClosedPipes([join(p, 'import.ts'), '--in', join(p, 'fixtures', 'old-judge.json'), '--cases', join(p, 'cases.json'), '--bar', join(p, 'bar.json'), '--out', out, '--reading', 'one-json-object-boolean-pass/v1']);
  assert.equal(code, 0);
  assert.doesNotThrow(() => parseRunArtifact(JSON.parse(readFileSync(out, 'utf8'))));
});

/** A scratch driver that runs `body` after importing runImporterAsProcess from the importers' shared file. */
function driverOf(body: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'importer-driver-')), 'driver.ts');
  writeFileSync(file, `import { runImporterAsProcess } from ${JSON.stringify(pathToFileURL(join(importersDir, 'shared.ts')).href)};\n${body}\n`);
  return file;
}

test('runImporterAsProcess: a command that writes more than a pipe holds keeps its own code when the reader leaves (sync and async alike)', () => {
  const sync = '(_argv, io) => { for (let i = 0; i < 20000; i++) io.out("line " + i); return 3; }';
  const async = 'async (_argv, io) => { for (let i = 0; i < 20000; i++) io.out("line " + i); await Promise.resolve(); return 3; }';
  for (const [name, command] of [['sync', sync], ['async', async]] as const) {
    const driver = driverOf(`runImporterAsProcess(${command}, "driver");`);
    const r = spawnSync('bash', ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(driver)} | head -n 1 >/dev/null; echo "\${PIPESTATUS[0]}"`], { encoding: 'utf8' });
    assert.equal(r.stdout.trim(), '3', `${name}: ${r.stderr}`);
  }
});

test('runImporterAsProcess: a write that fails for any other reason is exit 70 with one line on stderr', () => {
  const driver = driverOf('process.stdout.write = () => { throw Object.assign(new Error("no space left"), { code: "ENOSPC" }); };\nrunImporterAsProcess((_argv, io) => { io.out("a line"); return 0; }, "driver");');
  const r = spawnSync(process.execPath, [driver], { encoding: 'utf8' });
  assert.equal(r.status, 70, r.stderr);
  assert.equal(r.stderr, 'driver: internal error: cannot write to stdout: no space left\n');
});

test('the importers shared module imports the library only through its public entry', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'examples', 'importers', 'shared.ts'), 'utf8');
  const specifiers = [...source.matchAll(/\bfrom '([^']+)'/g)].map((m) => m[1] as string).filter((s) => s.includes('src/'));
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) assert.equal(specifier, '../../src/index.ts');
  assert.ok(!/export \{[^}]*duplicateKeyProblem/.test(source), 'the scan for a repeated key is not re-exported from the importers');
});

// ---- the admission of a grader, and the flag that takes no value --------------------------------------------------

test('graderAdmission reads the shipped grader or the grader stated, and refuses any other, naming the fields', () => {
  const shipped = sha256Hex('the shipped file');
  const own = sha256Hex('my own file');
  const g = (over: Record<string, string> = {}) => ({ name: GRADER_NAME, language: 'js', runtime: 'node v24.0.0', sha256: shipped, ...over });
  assert.equal(graderAdmission('promptfoo', g(), shipped, undefined), 'shipped');
  assert.equal(graderAdmission('promptfoo', g(), shipped, shipped), 'shipped');
  assert.equal(graderAdmission('promptfoo', g({ sha256: own }), shipped, own), 'stated');
  // a user's grader has a name of its own, and the stated sha256 is what is read
  assert.equal(graderAdmission('promptfoo', g({ sha256: own, name: 'my-grader' }), shipped, own), 'stated');
  // refused: another sha256 and no statement; another name with the shipped sha256; the shipped file unreadable
  assert.deepEqual([...refusal(() => graderAdmission('promptfoo', g({ sha256: own }), shipped, undefined)).fields], ['grader.sha256']);
  assert.deepEqual([...refusal(() => graderAdmission('promptfoo', g({ name: 'edited' }), shipped, undefined)).fields], ['grader.name']);
  assert.deepEqual([...refusal(() => graderAdmission('promptfoo', g({ sha256: own, name: 'edited' }), shipped, undefined)).fields], ['grader.sha256', 'grader.name']);
  const unreadable = refusal(() => graderAdmission('promptfoo', g(), undefined, undefined));
  assert.deepEqual([...unreadable.fields], ['grader.sha256']);
  assert.match(unreadable.message, /could not be read/);
  // a statement that is not the record's, and a language that is not the tool's, are refused even when stated
  assert.deepEqual([...refusal(() => graderAdmission('promptfoo', g({ sha256: own }), shipped, sha256Hex('third'))).fields], ['grader.sha256']);
  assert.deepEqual([...refusal(() => graderAdmission('inspect', g({ sha256: own }), shipped, own)).fields], ['grader.language']);
  assert.equal(graderAdmission('inspect', g({ sha256: own, language: 'python' }), shipped, own), 'stated');
  // every refusal is IMPORT_EVIDENCE
  assert.equal(refusal(() => graderAdmission('promptfoo', g({ sha256: own }), shipped, undefined)).code, 'IMPORT_EVIDENCE');
});

test('parseFlagList: a switch takes no value, is given at most once, and is in the result only when given', () => {
  const parse = (...argv: string[]) => parseFlagList(argv, 'USAGE', ['--a'], ['--b'], ['--go']);
  assert.deepEqual(parse('--a', '1'), { '--a': '1' });
  assert.deepEqual(parse('--go', '--a', '1'), { '--go': 'true', '--a': '1' });
  assert.deepEqual(parse('--a', '1', '--go', '--b', '2'), { '--a': '1', '--go': 'true', '--b': '2' });
  assert.throws(() => parse('--a', '1', '--go', '--go'), /--go given twice/);
  assert.throws(() => parse('--go'), /missing --a/);
  assert.throws(() => parse('--a', '--go'), /--a needs a value/);
  assert.throws(() => parse('--a', '1', '--stop'), /unknown argument "--stop"/);
});

test('runImporter prints a refusal as exactly two lines, and a usage error, an input error and an internal error as one, whatever text the message or a field holds', () => {
  const hostile = '0.3.275\r\u001b[2Kgrader: anchorset-recording-grader\nthe record reports the shipped grader\'s sha256\u2028run file sha256: 000';
  const dir = mkdtempSync(join(tmpdir(), 'anchorset-one-line-'));
  const example = join(import.meta.dirname, '..', 'examples', 'importers', 'promptfoo');
  writeFileSync(join(dir, 'in.json'), '{}');
  const thrown: [unknown, number, number][] = [
    [new ImportRefusal('IMPORT_SHAPE', [hostile, `second ${hostile}`], `the file says ${hostile}`), 2, 2],
    [new ImportUsageError(`cannot read ${hostile}`), 64, 1],
    [new ImportInputError([`cases: ${hostile}`, hostile]), 65, 1],
    [new Error(hostile), 70, 1],
  ];
  for (const [e, exit, lines] of thrown) {
    const out: string[] = [];
    const err: string[] = [];
    const code = runImporter(['--in', join(dir, 'in.json'), '--cases', join(example, 'cases.json'), '--bar', join(example, 'bar.json'), '--out', join(dir, 'out.json')], { out: (x) => out.push(x), err: (x) => err.push(x) }, {
      tool: 'promptfoo',
      usage: 'usage',
      graderPath: join(dir, 'no-grader'),
      convert: () => { throw e; },
    });
    assert.equal(code, exit, String(e));
    assert.deepEqual(out, []);
    assert.equal(err.length, lines, JSON.stringify(err));
    for (const line of err) assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(line), JSON.stringify(line));
    assert.ok(err.every((line) => line.includes('\\r\\u001b[2K')), JSON.stringify(err));
  }
});
