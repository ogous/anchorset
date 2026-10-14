import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { callShapeHash, hashOf, outputHashOf, packetHashOf, sha256Hex } from '../src/index.ts';
import { parseRunArtifact } from '../src/artifact.ts';
import { ImportRefusal, loadBar, NEXT_STEP_LINE, parseCasesFile } from '../examples/importers/shared.ts';
import type { ImportRefusalCode } from '../examples/importers/shared.ts';
import { buildInspectRun, main, MODEL_ARG_KEYS, strictGrade } from '../examples/importers/inspect/import.ts';
import { ownStderr } from './helpers.ts';

// ---- fixtures: written by the real tool; never edited, only copied in memory --------------------------------------

const root = join(import.meta.dirname, '..');
const dirOf = join(root, 'examples', 'importers', 'inspect');
const fx = (name: string): string => join(dirOf, 'fixtures', `${name}.json`);
const text = (name: string): string => readFileSync(fx(name), 'utf8');
type J = any; // a parsed log: the tests edit it freely
const log = (name: string): J => JSON.parse(text(name));
const barText = readFileSync(join(dirOf, 'bar.json'), 'utf8');
const casesText = readFileSync(join(dirOf, 'cases.json'), 'utf8');
const bar = loadBar(barText);
const stated = parseCasesFile(casesText, bar);

const bytesOf = (l: J): Uint8Array => Buffer.from(JSON.stringify(l), 'utf8');
const imp = (l: J, cases = stated, b = bar, name = 'log.json') => buildInspectRun(bytesOf(l), name, cases, b);

function refusal(code: ImportRefusalCode, fn: () => unknown): ImportRefusal {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ImportRefusal, `expected an ImportRefusal, got ${e instanceof Error ? e.stack : String(e)}`);
    assert.equal(e.code, code, e.message);
    assert.ok(e.fields.length > 0, 'a refusal names its fields');
    return e;
  }
  assert.fail(`expected ${code}, but the import went through`);
}

// ---- helpers that edit every copy of what the tool writes in several places ---------------------------------------

const SC = 'model_graded_qa';
const score = (s: J): J => s.scores[SC];
const modelEvent = (s: J): J => s.events.find((e: J) => e.event === 'model');
const scoreEvent = (s: J): J => s.events.find((e: J) => e.event === 'score');
const records = (s: J): J[] => [
  score(s).metadata.grading[1].metadata.graderEvidence,
  modelEvent(s).output.metadata.graderEvidence,
  modelEvent(s).output.choices[0].message.metadata.graderEvidence,
  scoreEvent(s).score.metadata.grading[1].metadata.graderEvidence,
];
/** Applies `fn` to the score's copy of the record and to each copy in the events. */
const eachRecord = (s: J, fn: (r: J) => void): void => records(s).forEach(fn);
/** Replaces every string that equals `from` in the sample by `to`. */
function swapString(v: J, from: string, to: string): J {
  if (typeof v === 'string') return v === from ? to : v;
  if (Array.isArray(v)) return v.map((x) => swapString(x, from, to));
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swapString(x, from, to)]));
  return v;
}
const swapIn = (l: J, i: number, from: string, to: string): void => {
  l.samples[i] = swapString(l.samples[i], from, to);
};

/** The independent, single-pass plain rendering of the logged template, written here independently of the importer's own renderer. */
function render(l: J, s: J): string {
  const o = l.eval.scorers[0].options;
  const v: Record<string, string> = { question: s.input, answer: s.output.completion, criterion: s.target, instructions: o.instructions };
  return (o.template as string).replace(/\{(question|answer|criterion|instructions)\}/g, (_m, n: string) => v[n] as string);
}
/** Sets the grader's prompt of one sample to `prompt`, in every copy, with the hashes the record carries. */
function setPrompt(s: J, prompt: string): void {
  score(s).metadata.grading[0].content = prompt;
  scoreEvent(s).score.metadata.grading[0].content = prompt;
  const sha = sha256Hex(prompt);
  eachRecord(s, (r) => {
    r.promptSha256 = sha;
    r.sent.user = sha;
  });
}
/** Restates one sample's question, answer or criterion everywhere it is written, and re-renders its prompt. */
function restate(l: J, i: number, over: { input?: string; target?: string; output?: string }): void {
  const s = l.samples[i];
  if (over.input !== undefined) s.input = over.input;
  if (over.target !== undefined) s.target = over.target;
  if (over.output !== undefined) {
    s.output.completion = over.output;
    s.output.choices[0].message.content = over.output;
    score(s).answer = over.output;
    scoreEvent(s).score.answer = over.output;
  }
  setPrompt(s, render(l, s));
}
/** Re-renders every sample's prompt under the log's current template and instructions. */
function rerenderAll(l: J): void {
  l.samples.forEach((s: J) => setPrompt(s, render(l, s)));
}
const indexOf = (l: J, id: string, epoch: number): number => l.samples.findIndex((s: J) => s.id === id && s.epoch === epoch);

// ---- the good path ------------------------------------------------------------------------------------------------

test('old and new judge fixtures import into a run the library parses; what is read, computed and unknown', () => {
  for (const [name, newLabelOfC3] of [['old-judge', 'C'], ['new-judge', 'I']] as const) {
    const l = log(name);
    const { run, summary } = imp(l);
    const parsed = parseRunArtifact(JSON.parse(JSON.stringify(run)));
    const id = parsed.identity;
    for (const f of ['systemModelRequested', 'systemModelServed', 'systemCallShapeHash', 'systemPromptHash', 'systemToolsHash', 'systemHarnessVersion', 'seed'] as const) assert.equal(id[f], 'UNKNOWN', f);
    assert.ok(Object.entries(parsed.callShapes.system as unknown as Record<string, unknown>).every(([k, v]) => k === 'schema' || v === 'UNKNOWN'));
    assert.equal(id.drawsPerCase, 3);
    assert.equal(id.barHash, hashOf(JSON.parse(barText)));
    const g = l.samples[0].scores[SC].metadata.grading[1].metadata.graderEvidence;
    assert.equal(id.judgeModelRequested, g.requestedModel);
    assert.equal(id.judgeModelServed, g.servedModel);
    assert.equal(id.judgeCallShapeHash, callShapeHash(g.callShape));
    assert.equal(id.judgeHarnessVersion, `inspect_ai 0.3.275; ${g.grader.name} python sha256:${g.grader.sha256}; ${g.grader.runtime}; max-reasks 0`);
    const o = l.eval.scorers[0].options;
    assert.equal(id.rubricHash, hashOf({ tool: 'inspect_ai', scorer: SC, instructions: o.instructions }));
    assert.equal(id.judgeDefinitionHash, hashOf({ tool: 'inspect_ai', version: '0.3.275', scorer: SC, template: o.template, tools: [], reading: 'last-line-grade-letter/v1' }));
    assert.equal(parsed.packetBasis, 'declared');
    assert.match(parsed.packetSource ?? '', /^computed at import from inspect_ai 0\.3\.275 log sha256:[0-9a-f]{64}: /);
    assert.equal(parsed.draws.length, 9);
    for (const d of parsed.draws) {
      const a = d.attempts[0] as J;
      assert.equal(a.kind, 'graded');
      assert.equal(a.systemStop, 'UNKNOWN');
      assert.equal(a.judgeStop, 'end');
      assert.equal(a.label, d.caseId === 'c3' ? newLabelOfC3 : 'C');
    }
    const s0 = l.samples[0];
    const first = parsed.draws.find((d) => d.caseId === 'c1' && d.drawIndex === 0)?.attempts[0] as J;
    assert.equal(first.outputHash, outputHashOf(s0.output.completion));
    assert.equal(first.packetHash, packetHashOf({ input: s0.input, target: s0.target }, s0.output.completion));
    assert.equal(summary.slots, 9);
    assert.equal(summary.judge.judgeModelRequested, g.requestedModel);
  }
});

test('the long-reply fixture imports: a 20,000-character reply stays whole in the score', () => {
  const l = log('long-reply');
  assert.ok(l.samples[0].scores[SC].metadata.grading[1].content.length > 20000);
  const { run } = imp(l);
  assert.equal(parseRunArtifact(JSON.parse(JSON.stringify(run))).identity.drawsPerCase, 1);
});

test('the short-targets fixture imports: a target of "4", an answer equal to its target, an answer that restates the question', () => {
  const l = log('short-targets');
  assert.deepEqual(l.samples.slice(0, 3).map((s: J) => [s.target, s.output.completion]), [['4', 'The answer is 4.'], ['Yes', 'Yes'], ['The reply restates the request.', 'Please refund my last order.']]);
  assert.equal(l.samples[2].input, l.samples[2].output.completion);
  const { run } = imp(l);
  parseRunArtifact(JSON.parse(JSON.stringify(run)));
});

test('determinism: the same bytes, cases and bar give the same output bytes, and the run holds no time and no path', () => {
  const a = JSON.stringify(imp(log('old-judge')).run);
  const b = JSON.stringify(imp(log('old-judge')).run);
  assert.equal(a, b);
  assert.ok(!/20\d\d-\d\d-\d\dT/.test(a), 'no timestamp');
  assert.ok(!a.includes(root) && !a.includes('/Users/') && !a.includes(tmpdir()), 'no path');
  for (const k of ['eval_id', 'run_id', 'task_id', 'uuid']) assert.ok(!a.includes(log('old-judge').eval[k] ?? 'no-such-value'), k);
});

test('a bare 0.0 in the tool\'s event and a 0 in the record are the same number', () => {
  const t = text('old-judge');
  assert.ok(t.includes('"temperature": 0.0') && t.includes('"temperature": 0,'), 'the fixture holds both spellings');
  imp(JSON.parse(t));
  const l = log('old-judge');
  modelEvent(l.samples[0]).config.temperature = 0.5;
  const r = refusal('IMPORT_EVIDENCE', () => imp(l));
  assert.match(r.message, /config\.temperature/);
});

test('strictGrade: the last non-empty line must be exactly "GRADE: " and one capital letter', () => {
  assert.equal(strictGrade('reasoning\n\nGRADE: C\n\n'), 'C');
  assert.equal(strictGrade('GRADE: P'), 'P');
  for (const bad of ['GRADE: C.', 'grade: C', 'GRADE: CI', 'GRADE:C', 'GRADE: c', 'GRADE: C \n', 'GRADE: C\nthanks', '', '\n\n']) assert.equal(strictGrade(bad), undefined, JSON.stringify(bad));
});

// ---- what is not JSON -------------------------------------------------------------------------------

test('a bare NaN in the score of a sample is IMPORT_UNGRADED naming that slot, in the words of a refused re-grade', () => {
  const t = text('old-judge');
  assert.ok(t.includes('"value": "C"'));
  const edited = t.replace('"value": "C"', '"value": NaN');
  const r = refusal('IMPORT_UNGRADED', () => buildInspectRun(Buffer.from(edited), 'log.json', stated, bar));
  assert.deepEqual([...r.fields], ['c1#0']);
  assert.match(r.message, /^IMPORT_UNGRADED: 1 slot\(s\) hold no finished, readable grade: c1#0 \(the log holds a bare NaN as the score of this sample, which the tool writes for a grade it could not read\)\. Nothing was written\. Keep this file: /);
  assert.match(r.message, /a further re-grade is a new experiment that reports this one \(docs\/IMPORTERS\.md\)$/);
});

test('a bare NaN that no sample holds, and a file that is not JSON for another reason as well, keep the IMPORT_SHAPE words', () => {
  const elsewhere = text('old-judge').replace('{', '{"note": NaN,');
  const r = refusal('IMPORT_SHAPE', () => buildInspectRun(Buffer.from(elsewhere), 'log.json', stated, bar));
  assert.match(r.message, /the file holds a bare NaN, which this tool writes for a grade it could not read; such a log cannot be imported/);
  assert.match(r.message, /not JSON/);
  // A bare NaN inside a string is text, not a NaN: it changes nothing.
  assert.doesNotThrow(() => JSON.parse(text('old-judge').replace('"value": "C"', '"value": "NaN"')));
  // A bare NaN in a sample that still holds its score is not that sample's grade: the refusal does not say it is.
  const inSample = text('old-judge').replace(/("samples": \[\s*\{)/, '$1"note": NaN,');
  assert.notEqual(inSample, text('old-judge'));
  const own = refusal('IMPORT_SHAPE', () => buildInspectRun(Buffer.from(inSample), 'log.json', stated, bar));
  assert.deepEqual(own.fields, ['log.json']);
  assert.match(own.message, /the file holds a bare NaN, which this tool writes for a grade it could not read; such a log cannot be imported/);
  assert.doesNotMatch(own.message, /as the score of this sample/);
});

test('the two logs the tool really wrote for a cut reply and for a reply with no grade line both refuse as ungraded slots, naming them', () => {
  for (const name of ['truncated', 'no-verdict']) {
    const real = readFileSync(join(dirOf, 'bad-fixtures', `${name}.json`));
    assert.ok(real.includes('NaN'), `${name}: the tool wrote a bare NaN`);
    const r = refusal('IMPORT_UNGRADED', () => buildInspectRun(real, `${name}.json`, stated, bar));
    assert.ok(r.fields.length > 0 && r.fields.every((f) => /^c\d#\d$/.test(f)), r.fields.join(', '));
    assert.match(r.message, /the log holds a bare NaN as the score of this sample/);
    const out = join(tmpdir(), `inspect-bad-${name}-${process.pid}.json`);
    const res = spawnSync(process.execPath, [join(dirOf, 'import.ts'), '--in', join(dirOf, 'bad-fixtures', `${name}.json`), '--cases', join(dirOf, 'cases.json'), '--bar', join(dirOf, 'bar.json'), '--out', out], { encoding: 'utf8' });
    assert.equal(res.status, 2, res.stderr);
    assert.match(ownStderr(res.stderr), /^REFUSED IMPORT_UNGRADED: /);
    assert.equal(existsSync(out), false);
  }
});

test('IMPORT_SHAPE: text that is not JSON, a .jsonl name, and a log whose samples are not an array', () => {
  refusal('IMPORT_SHAPE', () => buildInspectRun(Buffer.from('{"version": 2,'), 'log.json', stated, bar));
  refusal('IMPORT_SHAPE', () => buildInspectRun(bytesOf(log('old-judge')), 'log.jsonl', stated, bar));
  const l = log('old-judge');
  l.samples = { not: 'an array' };
  const r = refusal('IMPORT_SHAPE', () => imp(l));
  assert.deepEqual(r.fields, ['/samples']);
  assert.match(r.message, /\/samples: expected array, found object/);
});

test('the packed log format is refused, and the message names the script', () => {
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('not really a zip')]);
  const r = refusal('IMPORT_SHAPE', () => buildInspectRun(zip, 'run.eval', stated, bar));
  assert.match(r.message, /packed log format/);
  assert.match(r.message, /examples\/importers\/inspect\/regrade\.py/);
  const byName = refusal('IMPORT_SHAPE', () => buildInspectRun(bytesOf(log('old-judge')), 'run.eval', stated, bar));
  assert.match(byName.message, /regrade\.py/);
  assert.match(byName.message, /inspect log convert/);
});

// ---- versions, status, scorer ------------------------------------------------------------------------------------

test('IMPORT_TOOL_VERSION: another log version, another tool version, or none', () => {
  let l = log('old-judge');
  l.version = 3;
  assert.match(refusal('IMPORT_TOOL_VERSION', () => imp(l)).message, /tested on inspect_ai 0\.3\.275 \(format 2\); the file says inspect_ai 0\.3\.275, format 3/);
  l = log('old-judge');
  l.eval.packages.inspect_ai = '0.3.276';
  assert.match(refusal('IMPORT_TOOL_VERSION', () => imp(l)).message, /0\.3\.276/);
  l = log('old-judge');
  delete l.eval.packages;
  refusal('IMPORT_TOOL_VERSION', () => imp(l));
  l = log('old-judge');
  delete l.version;
  refusal('IMPORT_TOOL_VERSION', () => imp(l));
});

test('IMPORT_JUDGE_SELECTION: two scorers, another scorer, a suffixed score key, another scorer span', () => {
  let l = log('old-judge');
  l.eval.scorers.push(structuredClone(l.eval.scorers[0]));
  assert.deepEqual(refusal('IMPORT_JUDGE_SELECTION', () => imp(l)).fields, ['/eval/scorers']);
  l = log('old-judge');
  l.eval.scorers[0].name = 'model_graded_fact';
  assert.deepEqual(refusal('IMPORT_JUDGE_SELECTION', () => imp(l)).fields, ['/eval/scorers/0/name']);
  l = log('old-judge');
  l.samples[4].scores[`${SC}1`] = structuredClone(l.samples[4].scores[SC]);
  assert.deepEqual(refusal('IMPORT_JUDGE_SELECTION', () => imp(l)).fields, ['/samples/4/scores']);
  l = log('old-judge');
  delete l.samples[4].scores[SC];
  l.samples[4].scores[`${SC}1`] = structuredClone(log('old-judge').samples[4].scores[SC]);
  refusal('IMPORT_JUDGE_SELECTION', () => imp(l));
  l = log('old-judge');
  scoreEvent(l.samples[2]).span_id = 'x';
  const span = l.samples[2].events.find((e: J) => e.event === 'span_begin' && e.type === 'scorer');
  span.name = 'other_scorer';
  assert.match(refusal('IMPORT_JUDGE_SELECTION', () => imp(l)).message, /other_scorer/);
});

// ---- IMPORT_NO_RECORD ---------------------------------------------------------------------------------------

test('the plain fixture (the built-in grader) is refused with a message that names the example grader', () => {
  const r = refusal('IMPORT_NO_RECORD', () => imp(log('plain')));
  assert.match(r.message, /not graded through the recording grader/);
  assert.match(r.message, /examples\/importers\/inspect\/recording_grader\.py/);
});

test('IMPORT_NO_RECORD: a record of another schema on every sample', () => {
  const l = log('old-judge');
  l.samples.forEach((s: J) => {
    score(s).metadata.grading[1].metadata.graderEvidence.schema = 'example.grader-evidence/v8';
  });
  refusal('IMPORT_NO_RECORD', () => imp(l));
});

// ---- IMPORT_EVIDENCE ---------------------------------------------------------------------------------------------

test('a served id of UNKNOWN, a call shape with a key removed, a call shape with a key UNKNOWN', () => {
  let l = log('old-judge');
  eachRecord(l.samples[1], (r) => {
    r.servedModel = 'UNKNOWN';
  });
  assert.ok(refusal('IMPORT_EVIDENCE', () => imp(l)).fields.some((f) => f.endsWith('.servedModel')));
  l = log('old-judge');
  eachRecord(l.samples[1], (r) => {
    delete r.callShape.topK;
  });
  assert.match(refusal('IMPORT_EVIDENCE', () => imp(l)).message, /topK/);
  l = log('old-judge');
  eachRecord(l.samples[1], (r) => {
    r.callShape.timeoutMs = 'UNKNOWN';
  });
  refusal('IMPORT_EVIDENCE', () => imp(l));
});

test('an endpoint with user information, and one with a query', () => {
  for (const endpoint of ['http://user:secret@127.0.0.1:18765/v1/messages', 'http://127.0.0.1:18765/v1/messages?key=abc']) {
    const l = log('old-judge');
    eachRecord(l.samples[0], (r) => {
      r.callShape.endpoint = endpoint;
    });
    assert.match(refusal('IMPORT_EVIDENCE', () => imp(l)).message, /callShape\.endpoint/);
  }
});

test('IMPORT_EVIDENCE: the cross-checks against what the tool wrote itself', () => {
  const mutate = (name: string, edit: (l: J) => void, pattern: RegExp): void => {
    const l = log('old-judge');
    edit(l);
    assert.match(refusal('IMPORT_EVIDENCE', () => imp(l)).message, pattern, name);
  };
  mutate('options.model names another model', (l) => { l.eval.scorers[0].options.model.model = 'recording/other'; }, /options\/model/);
  mutate('options.model as a plain string naming another model', (l) => { l.eval.scorers[0].options.model = 'recording/other'; }, /options\/model/);
  mutate('model_args holds an undocumented key', (l) => { l.eval.scorers[0].options.model.model_args = { api_key: 'x' }; }, /model_args/);
  mutate('the event names another model', (l) => { modelEvent(l.samples[3]).model = 'recording/other'; }, /output|model is/);
  mutate('the event serves another model', (l) => { modelEvent(l.samples[3]).output.model = 'another-served'; }, /output\.model/);
  mutate('ev.tools is not empty', (l) => { modelEvent(l.samples[3]).tools = [{ name: 't' }]; }, /tools/);
  mutate('ev.tool_choice is not none', (l) => { modelEvent(l.samples[3]).tool_choice = 'auto'; }, /tool_choice/);
  mutate('a setting in ev.config the record does not hold', (l) => { modelEvent(l.samples[3]).config.top_p = 0.9; }, /config\.top_p/);
  mutate('max_tokens differs', (l) => { modelEvent(l.samples[3]).config.max_tokens = 999; }, /max_tokens/);
  mutate('the event message id is not the response id', (l) => { modelEvent(l.samples[3]).output.choices[0].message.id = 'msg_other'; }, /message id/);
  mutate('the event holds another record', (l) => { modelEvent(l.samples[3]).output.metadata.graderEvidence.callId = 'other'; }, /different grader record/);
  mutate('the score event differs from the score', (l) => { scoreEvent(l.samples[3]).score.value = 'I'; }, /score event/);
  mutate('the prompt sha differs from the record', (l) => { eachRecord(l.samples[3], (r) => { r.promptSha256 = sha256Hex('other'); }); }, /promptSha256/);
  mutate('the record says a system text was sent', (l) => { eachRecord(l.samples[3], (r) => { r.sent.system = sha256Hex('s'); }); }, /system text/);
  mutate('the reply message differs from the record', (l) => { score(l.samples[3]).metadata.grading[1].content = 'Another reply.\n\nGRADE: C'; }, /reply message differs/);
  mutate('the grader is not the Python one', (l) => { l.samples.forEach((s: J) => { score(s).metadata.grading[1].metadata.graderEvidence.grader.language = 'js'; }); }, /language/);
  mutate('one sample has no record while the others have one', (l) => { delete score(l.samples[5]).metadata.grading[1].metadata.graderEvidence; }, /carry no grader record/);
});

// ---- IMPORT_UNGRADED ---------------------------------------------------------------------------------------------

test('a stop reason of max_tokens refuses, the tool\'s grade is left in place and is not written', () => {
  const l = log('old-judge');
  eachRecord(l.samples[2], (r) => {
    r.stopReason = 'max_tokens';
  });
  assert.equal(score(l.samples[2]).value, 'C');
  const r = refusal('IMPORT_UNGRADED', () => imp(l));
  assert.deepEqual(r.fields, ['c3#0']);
  assert.match(r.message, /max_tokens/);
  assert.match(r.message, /Nothing was written/);
});

test('every other stop word, and content that is not thinking blocks then one text block, refuses', () => {
  for (const stop of ['refusal', 'stop_sequence', 'tool_use', 'pause_turn', 'strange']) {
    const l = log('old-judge');
    eachRecord(l.samples[0], (r) => { r.stopReason = stop; });
    assert.match(refusal('IMPORT_UNGRADED', () => imp(l)).message, new RegExp(stop));
  }
  const l = log('old-judge');
  eachRecord(l.samples[0], (r) => { r.contentTypes = ['text', 'thinking']; });
  assert.match(refusal('IMPORT_UNGRADED', () => imp(l)).message, /content of type/);
});

test('the refusal lists every such slot, not the first', () => {
  const l = log('old-judge');
  for (const i of [0, 4, 8]) eachRecord(l.samples[i], (r) => { r.stopReason = 'max_tokens'; });
  assert.deepEqual(refusal('IMPORT_UNGRADED', () => imp(l)).fields, ['c1#0', 'c2#1', 'c3#2']);
});

test('status success with one sample holding an error and no scores', () => {
  const l = log('old-judge');
  l.samples[5].error = { message: 'the grader failed', traceback: '' };
  l.samples[5].scores = {};
  const r = refusal('IMPORT_UNGRADED', () => imp(l));
  assert.deepEqual(r.fields, ['c3#1']);
  assert.match(r.message, /the sample has an error/);
});

test('IMPORT_UNGRADED: a status other than success, a retried sample, a reply with no strict reading, a model event with an error', () => {
  let l = log('old-judge');
  l.status = 'error';
  assert.deepEqual(refusal('IMPORT_UNGRADED', () => imp(l)).fields, ['/status']);
  l = log('old-judge');
  l.samples[1].error_retries = [{ message: 'retry' }];
  assert.match(refusal('IMPORT_UNGRADED', () => imp(l)).message, /retried/);
  l = log('old-judge');
  swapIn(l, 6, score(l.samples[6]).metadata.grading[1].content, 'The answer is fine.\n\nGRADE: C and more');
  assert.match(refusal('IMPORT_UNGRADED', () => imp(l)).message, /no strict reading/);
  l = log('old-judge');
  modelEvent(l.samples[7]).error = { message: 'x' };
  assert.match(refusal('IMPORT_UNGRADED', () => imp(l)).message, /holds an error/);
  l = log('old-judge');
  l.samples[7].events = l.samples[7].events.filter((e: J) => !(e.event === 'span_begin' && e.type === 'scorer'));
  assert.match(refusal('IMPORT_UNGRADED', () => imp(l)).message, /no scorer span/);
});

test('IMPORT_LABEL_DISAGREES: the reply says C and the tool wrote I', () => {
  const l = log('old-judge');
  score(l.samples[2]).value = 'I';
  const r = refusal('IMPORT_LABEL_DISAGREES', () => imp(l));
  assert.match(r.message, /c3#0: the reply says C, the tool wrote I/);
});

// ---- the record over the whole file ------------------------------------------------------------------------------

test('callSeq with a hole, and two grader run ids', () => {
  let l = log('old-judge');
  l.samples.slice(4).forEach((s: J) => eachRecord(s, (r) => { r.callSeq += 1; }));
  assert.deepEqual(refusal('IMPORT_HIDDEN_CALLS', () => imp(l)).fields, ['callSeq']);
  l = log('old-judge');
  eachRecord(l.samples[8], (r) => { r.graderRunId = 'another-process'; });
  const r = refusal('IMPORT_HIDDEN_CALLS', () => imp(l));
  assert.match(r.message, /two grader processes wrote this file/);
});

test('IMPORT_DUPLICATE_CALL: two slots share a call id; two share a response id', () => {
  for (const field of ['callId', 'responseId']) {
    const l = log('old-judge');
    eachRecord(l.samples[1], (r) => { r[field] = l.samples[0].scores[SC].metadata.grading[1].metadata.graderEvidence[field]; });
    const r = refusal('IMPORT_DUPLICATE_CALL', () => imp(l));
    assert.match(r.message, new RegExp(field));
  }
});

test('IMPORT_MIXED_IDENTITY: one slot graded by another judge model', () => {
  const l = log('old-judge');
  eachRecord(l.samples[3], (r) => { r.requestedModel = 'fake-judge-other'; });
  assert.deepEqual(refusal('IMPORT_MIXED_IDENTITY', () => imp(l)).fields, ['requestedModel']);
});

test('a second model event with an error in the score span', () => {
  const l = log('old-judge');
  const s = l.samples[2];
  const at = s.events.findIndex((e: J) => e.event === 'model');
  const second = structuredClone(s.events[at]);
  second.error = { message: 'the first call failed' };
  s.events.splice(at, 0, second);
  assert.match(refusal('IMPORT_DUPLICATE_CALL', () => imp(l)).message, /2 model events/);
});

test('a second score event in the span; then a second, separate and individually valid scorer span', () => {
  let l = log('old-judge');
  let s = l.samples[2];
  s.events.splice(s.events.findIndex((e: J) => e.event === 'score'), 0, structuredClone(scoreEvent(s)));
  assert.match(refusal('IMPORT_DUPLICATE_CALL', () => imp(l)).message, /2 score events/);

  l = log('old-judge');
  s = l.samples[2];
  const begin = s.events.find((e: J) => e.event === 'span_begin' && e.type === 'scorer');
  const second: J[] = [structuredClone(begin), structuredClone(modelEvent(s)), structuredClone(scoreEvent(s)), structuredClone(s.events.find((e: J) => e.event === 'span_end' && e.id === begin.id))];
  for (const e of second) {
    if (e.event === 'span_begin') e.id = 'span-two';
    if (e.event === 'span_end') e.id = 'span-two';
    e.span_id = 'span-two';
  }
  s.events.push(...second);
  assert.match(refusal('IMPORT_DUPLICATE_CALL', () => imp(l)).message, /2 scorer spans/);
});

test('a cache key on the grader\'s model event', () => {
  const l = log('old-judge');
  modelEvent(l.samples[4]).cache = 'read';
  assert.match(refusal('IMPORT_CACHE', () => imp(l)).message, /cache/);
});

// ---- the scorer's options ----------------------------------------------------------------------------------------

test('a grade_pattern, partial_credit, include_history, an unknown option, or no template or instructions', () => {
  for (const [key, value] of [['grade_pattern', '(.*)'], ['partial_credit', true], ['include_history', true], ['anything', 1]] as const) {
    const l = log('old-judge');
    l.eval.scorers[0].options[key] = value;
    assert.deepEqual(refusal('IMPORT_DERIVATION', () => imp(l)).fields, [`/eval/scorers/0/options/${key}`]);
  }
  for (const key of ['template', 'instructions']) {
    const l = log('old-judge');
    delete l.eval.scorers[0].options[key];
    assert.deepEqual(refusal('IMPORT_DERIVATION', () => imp(l)).fields, [`/eval/scorers/0/options/${key}`]);
  }
});

// ---- IMPORT_PACKET: what the judge was shown ---------------------------------------------------------------------

test('one character of one prompt edited', () => {
  const l = log('old-judge');
  const s = l.samples[3];
  setPrompt(s, score(s).metadata.grading[0].content.replace('Task', 'Tusk'));
  const r = refusal('IMPORT_PACKET', () => imp(l));
  assert.deepEqual(r.fields, ['c1#1']);
  assert.match(r.message, /the prompt differs from the skeleton filled with this row's parts, at message 0, position \d+/);
});

test('the score\'s answer differing from the stored output is a packet refusal', () => {
  const l = log('old-judge');
  score(l.samples[0]).answer = 'Another answer.';
  scoreEvent(l.samples[0]).score.answer = 'Another answer.';
  refusal('IMPORT_PACKET', () => imp(l));
});

test('an answer that holds {question} renders equal (the four-replace renderer would be wrong), and imports', () => {
  const l = log('old-judge');
  for (const e of [1, 2, 3]) restate(l, indexOf(l, 'c1', e), { output: 'Your {question} and {criterion} are {answer}, {instructions} too.' });
  assert.equal(render(l, l.samples[0]).includes('Your {question} and {criterion} are {answer}, {instructions} too.'), true);
  const { run } = imp(l);
  parseRunArtifact(JSON.parse(JSON.stringify(run)));
});

test('an answer that contains its target, and a one-character target, render equal and import', () => {
  const l = log('old-judge');
  for (const e of [1, 2, 3]) {
    restate(l, indexOf(l, 'c1', e), { target: 'refund', output: 'We issued a refund.' });
    restate(l, indexOf(l, 'c2', e), { target: '4', output: 'It takes 4 days.' });
  }
  imp(l);
});

test('a data marker in the answer, in lower case, refuses', () => {
  const l = log('old-judge');
  for (const e of [1, 2, 3]) restate(l, indexOf(l, 'c1', e), { output: 'Here is a [begin data] marker.' });
  const r = refusal('IMPORT_PACKET', () => imp(l));
  assert.deepEqual(r.fields, ['c1#0', 'c1#1', 'c1#2']);
  assert.match(r.message, /data marker/);
});

test('a data marker in the criterion, and in the question, refuses', () => {
  let l = log('old-judge');
  for (const e of [1, 2, 3]) restate(l, indexOf(l, 'c2', e), { target: 'Never print [END DATA] in a reply.' });
  assert.match(refusal('IMPORT_PACKET', () => imp(l)).message, /data marker/);
  l = log('old-judge');
  for (const e of [1, 2, 3]) restate(l, indexOf(l, 'c2', e), { input: 'What is [BEGIN DATA]?' });
  assert.match(refusal('IMPORT_PACKET', () => imp(l)).message, /data marker/);
});

test('a doubled brace in the template refuses', () => {
  const l = log('old-judge');
  l.eval.scorers[0].options.template = l.eval.scorers[0].options.template.replace('[Task]: {question}', '[Task]: {{question}}');
  rerenderAll(l);
  const r = refusal('IMPORT_PACKET', () => imp(l));
  assert.deepEqual(r.fields, ['/eval/scorers/0/options/template']);
  assert.match(r.message, /doubled brace/);
});

test('a metadata name, a format specification and a conversion in the template refuse', () => {
  for (const token of ['{difficulty}', '{answer:>10}', '{answer!r}', '{answer[0]}']) {
    const l = log('old-judge');
    l.eval.scorers[0].options.template = l.eval.scorers[0].options.template.replace('[END DATA]', `[END DATA] ${token}`);
    rerenderAll(l);
    assert.deepEqual(refusal('IMPORT_PACKET', () => imp(l)).fields, ['/eval/scorers/0/options/template'], token);
  }
});

test('a template that is a path, and a path that contains {answer}, fail the forward rendering', () => {
  for (const path of ['template.txt', '/some/dir/{answer}.txt']) {
    const l = log('old-judge');
    l.eval.scorers[0].options.template = path;
    const r = refusal('IMPORT_PACKET', () => imp(l));
    assert.match(r.message, /the prompt differs from the skeleton filled with this row's parts/);
  }
});

test('instructions are substituted as they are: a brace and a data marker in them are not scanned', () => {
  const l = log('old-judge');
  l.eval.scorers[0].options.instructions += '\nUse {curly} words and [BEGIN DATA] markers freely. $& $1\n';
  rerenderAll(l);
  imp(l);
});

// ---- IMPORT_BAR, case ids, roster, draws, outputs ----------------------------------------------------------------

test('a label the bar does not have refuses (here the bar lacks "I", which the new judge wrote)', () => {
  const noI = loadBar(JSON.stringify({ labels: ['X', 'C'], classes: { refund_policy: { direction: 'floor', minPassRate: 0.5 } }, knownFailures: [] }));
  const cases = parseCasesFile(casesText, noI);
  assert.deepEqual(refusal('IMPORT_BAR', () => imp(log('new-judge'), cases, noI)).fields, ['I']);
});

test('a reply ending GRADE: P is scored P by the tool, and the bar\'s labels refuse it', () => {
  const l = log('old-judge');
  const reply: string = score(l.samples[0]).metadata.grading[1].content;
  swapIn(l, 0, reply, reply.replace('GRADE: C', 'GRADE: P'));
  swapIn(l, 0, 'C', 'P');
  assert.equal(score(l.samples[0]).value, 'P');
  assert.deepEqual(refusal('IMPORT_BAR', () => imp(l)).fields, ['P']);
});

test('a list of targets is a shape refusal; a float id is a case-id refusal', () => {
  let l = log('old-judge');
  l.samples[0].target = ['a', 'b'];
  assert.deepEqual(refusal('IMPORT_SHAPE', () => imp(l)).fields, ['/samples/0/target']);
  l = log('old-judge');
  l.samples[0].id = 1.5;
  assert.deepEqual(refusal('IMPORT_CASE_ID', () => imp(l)).fields, ['/samples/0/id']);
});

test('IMPORT_CASE_ID: an empty id, a boolean id, ids equal as strings, inputs that differ within a case', () => {
  for (const bad of ['', true, null]) {
    const l = log('old-judge');
    l.samples[0].id = bad;
    refusal('IMPORT_CASE_ID', () => imp(l));
  }
  let l = log('old-judge');
  l.samples.forEach((s: J) => { if (s.id === 'c1') s.id = '7'; });
  l.samples[0].id = 7;
  const cases = parseCasesFile(JSON.stringify({ 7: { klass: 'refund_policy', expect: 'C' }, c2: { klass: 'refund_policy', expect: 'C' }, c3: { klass: 'refund_policy', expect: 'C' } }), bar);
  assert.match(refusal('IMPORT_CASE_ID', () => imp(l, cases)).message, /equal as strings/);
  l = log('old-judge');
  restate(l, indexOf(l, 'c1', 2), { input: 'A different question.' });
  assert.match(refusal('IMPORT_CASE_ID', () => imp(l)).message, /differs between its epochs/);
});

test('an integer id is the case id as a string', () => {
  const l = log('old-judge');
  l.samples.forEach((s: J) => { if (s.id === 'c1') s.id = 7; });
  const cases = parseCasesFile(JSON.stringify({ 7: { klass: 'refund_policy', expect: 'C' }, c2: { klass: 'refund_policy', expect: 'C' }, c3: { klass: 'refund_policy', expect: 'C' } }), bar);
  const { run } = imp(l, cases);
  assert.ok((run['cases'] as J[]).some((c) => c.id === '7'));
});

test('IMPORT_CASE_MISSING: a case of cases.json absent from the log, and a case in the log that cases.json lacks', () => {
  const extra = parseCasesFile(JSON.stringify({ ...JSON.parse(casesText), c4: { klass: 'refund_policy', expect: 'C' } }), bar);
  assert.deepEqual(refusal('IMPORT_CASE_MISSING', () => imp(log('old-judge'), extra)).fields, ['c4']);
  const fewer = parseCasesFile(JSON.stringify({ c1: { klass: 'refund_policy', expect: 'C' }, c2: { klass: 'refund_policy', expect: 'C' } }), bar);
  assert.deepEqual(refusal('IMPORT_CASE_MISSING', () => imp(log('old-judge'), fewer)).fields, ['c3']);
});

test('IMPORT_DRAW_COUNT: a missing epoch, a repeated epoch, a repeat count that is not the epochs found, no repeat count', () => {
  let l = log('old-judge');
  l.samples.splice(indexOf(l, 'c3', 3), 1);
  assert.deepEqual(refusal('IMPORT_DRAW_COUNT', () => imp(l)).fields, ['c3']);
  l = log('old-judge');
  l.samples[indexOf(l, 'c2', 3)].epoch = 2;
  assert.match(refusal('IMPORT_DRAW_COUNT', () => imp(l)).message, /c2: 3 of 3/);
  l = log('old-judge');
  l.eval.config.epochs = 4;
  assert.deepEqual(refusal('IMPORT_DRAW_COUNT', () => imp(l)).fields, ['c1', 'c2', 'c3']);
  l = log('old-judge');
  delete l.eval.config.epochs;
  assert.deepEqual(refusal('IMPORT_DRAW_COUNT', () => imp(l)).fields, ['/eval/config/epochs']);
});

test('IMPORT_OUTPUTS_DIFFER: the draws of one case hold different outputs', () => {
  const l = log('old-judge');
  restate(l, indexOf(l, 'c1', 2), { output: 'A different stored output.' });
  const r = refusal('IMPORT_OUTPUTS_DIFFER', () => imp(l));
  assert.deepEqual(r.fields, ['c1']);
  assert.match(r.message, /2 distinct outputs/);
});

// ---- a log or a sample the tool marks invalidated -----------------------------------------------------------------

test('an invalidated log refuses, and so does a sample with an invalidation; false and null are fine', () => {
  let l = log('old-judge');
  assert.equal(l.invalidated, false);
  l.invalidated = true;
  assert.deepEqual(refusal('IMPORT_UNGRADED', () => imp(l)).fields, ['/invalidated']);
  l = log('old-judge');
  l.invalidated = 'yes';
  refusal('IMPORT_UNGRADED', () => imp(l));
  l = log('old-judge');
  l.samples[2].invalidation = { timestamp: '2026-01-01T00:00:00Z', author: 'a', reason: 'r' };
  l.samples[5].invalidation = {};
  const r = refusal('IMPORT_UNGRADED', () => imp(l));
  const label = (i: number): string => `${l.samples[i].id}#${l.samples[i].epoch - 1}`;
  assert.deepEqual([...r.fields].sort(), [label(2), label(5)].sort());
  assert.match(r.message, /invalidation/);
  l = log('old-judge');
  l.samples[2].invalidation = null;
  imp(l);
});

// ---- one edit-and-refuse test for each check of the recorded events ---------------------------------------

test('a scorer message list of three, and a prompt message whose role is not user', () => {
  let l = log('old-judge');
  score(l.samples[3]).metadata.grading.push(structuredClone(score(l.samples[3]).metadata.grading[1]));
  const r = refusal('IMPORT_SHAPE', () => imp(l));
  assert.deepEqual(r.fields, [`/samples/3/scores/${SC}/metadata/grading`]);
  assert.match(r.message, /expected 2 messages/);
  l = log('old-judge');
  score(l.samples[3]).metadata.grading[0].role = 'assistant';
  const r2 = refusal('IMPORT_SHAPE', () => imp(l));
  assert.deepEqual(r2.fields, [`/samples/3/scores/${SC}/metadata/grading/0/role`]);
});

test('the stored output holds exactly one choice, and its content is its completion', () => {
  let l = log('old-judge');
  l.samples[3].output.choices.push(structuredClone(l.samples[3].output.choices[0]));
  const r = refusal('IMPORT_SHAPE', () => imp(l));
  assert.deepEqual(r.fields, ['/samples/3/output/choices']);
  assert.match(r.message, /exactly one choice/);
  l = log('old-judge');
  l.samples[3].output.completion = 'A completion that is not the message content.';
  const r2 = refusal('IMPORT_SHAPE', () => imp(l));
  assert.deepEqual(r2.fields, ['/samples/3/output/completion']);
  assert.match(r2.message, /differs from the output message's content/);
});

test('the record\'s sent.user alone, the reply message\'s model alone and its id alone each refuse', () => {
  let l = log('old-judge');
  eachRecord(l.samples[3], (r) => {
    r.sent.user = sha256Hex('some other message');
  });
  let r = refusal('IMPORT_EVIDENCE', () => imp(l));
  assert.ok(r.fields.some((f) => f.endsWith('.sent.user')), r.fields.join());
  l = log('old-judge');
  score(l.samples[3]).metadata.grading[1].model = 'a-model-the-record-does-not-name';
  r = refusal('IMPORT_EVIDENCE', () => imp(l));
  assert.deepEqual(r.fields, [`/samples/3/scores/${SC}/metadata/grading/1`]);
  assert.match(r.message, /model or id differs/);
  l = log('old-judge');
  score(l.samples[3]).metadata.grading[1].id = 'an-id-the-record-does-not-hold';
  r = refusal('IMPORT_EVIDENCE', () => imp(l));
  assert.deepEqual(r.fields, [`/samples/3/scores/${SC}/metadata/grading/1`]);
  assert.match(r.message, /model or id differs/);
});

test('a scorer span with no model event, and a score event outside the scorer span', () => {
  let l = log('old-judge');
  modelEvent(l.samples[3]).span_id = 'not-the-scorer-span';
  let r = refusal('IMPORT_UNGRADED', () => imp(l));
  assert.deepEqual(r.fields, ['c1#1']);
  assert.match(r.message, /holds no model event/);
  l = log('old-judge');
  scoreEvent(l.samples[3]).span_id = 'not-the-scorer-span';
  r = refusal('IMPORT_UNGRADED', () => imp(l));
  assert.deepEqual(r.fields, ['c1#1']);
  assert.match(r.message, /holds no score event/);
});

test('the model event\'s reply, its stop_reason and its temperature when the record says not sent, and the score event\'s grading messages', () => {
  const evidence = (name: string, edit: (l: J) => void, pattern: RegExp, at = 3): void => {
    const l = log('old-judge');
    edit(l);
    const r = refusal('IMPORT_EVIDENCE', () => imp(l));
    assert.deepEqual(r.fields, [`/samples/${at}/events`], name);
    assert.match(r.message, pattern, name);
  };
  evidence('the event reply differs from the record', (l) => { modelEvent(l.samples[3]).output.choices[0].message.content = 'Another reply.\n\nGRADE: C'; }, /(^|[:;] )the reply message differs from the record(;|$)/);
  evidence('the event stop_reason is not stop', (l) => { modelEvent(l.samples[3]).output.choices[0].stop_reason = 'max_tokens'; }, /stop_reason is "max_tokens", not "stop"/);
  evidence('the event sets a temperature the record says was not sent', (l) => { l.samples.forEach((s: J) => eachRecord(s, (r) => { r.callShape.temperature = 'NOT_SENT'; })); }, /config\.temperature is set, the record says it was not sent/, 0);
  evidence('the score event\'s grading messages differ', (l) => { scoreEvent(l.samples[3]).score.metadata.grading[0].content += ' '; }, /grading messages differ/);
});

// ---- fields the tool writes about the call that were not read -----------------------------------------------

test('the reply message must be an assistant message, the two messages hold only the tool\'s keys, and the model event shows no retry', () => {
  let l = log('old-judge');
  score(l.samples[3]).metadata.grading[1].role = 'user';
  const r = refusal('IMPORT_SHAPE', () => imp(l));
  assert.deepEqual(r.fields, [`/samples/3/scores/${SC}/metadata/grading/1/role`]);
  l = log('old-judge');
  score(l.samples[3]).metadata.grading[0].tool_calls = [];
  assert.deepEqual(refusal('IMPORT_SHAPE', () => imp(l)).fields, [`/samples/3/scores/${SC}/metadata/grading/0/tool_calls`]);
  l = log('old-judge');
  score(l.samples[3]).metadata.grading[1].tool_calls = [];
  assert.deepEqual(refusal('IMPORT_SHAPE', () => imp(l)).fields, [`/samples/3/scores/${SC}/metadata/grading/1/tool_calls`]);
  for (const retries of [1, 2]) {
    l = log('old-judge');
    modelEvent(l.samples[3]).retries = retries;
    const d = refusal('IMPORT_DUPLICATE_CALL', () => imp(l));
    assert.match(d.message, /retries/);
  }
  l = log('old-judge');
  modelEvent(l.samples[3]).pending = true;
  refusal('IMPORT_UNGRADED', () => imp(l));
  for (const ok of [undefined, null, 0]) {
    l = log('old-judge');
    if (ok !== undefined) modelEvent(l.samples[3]).retries = ok;
    imp(l);
  }
});

// ---- the root of the source is named '/' --------------------------------------------------------------------

test('a source that is [] or null refuses with the root path "/" as its field', () => {
  for (const root of [[], null, 'text', 3]) {
    const r = refusal('IMPORT_SHAPE', () => buildInspectRun(Buffer.from(JSON.stringify(root)), 'log.json', stated, bar));
    assert.deepEqual(r.fields, ['/']);
    assert.match(r.message, /^IMPORT_SHAPE: \/: expected object/);
  }
});

// ---- the grader's allowed model arguments are the importer's --------------------------------------------------

test('the importer\'s list of the grader\'s model arguments is the grader file\'s own', () => {
  const py = readFileSync(join(dirOf, 'recording_grader.py'), 'utf8');
  const m = /^ALLOWED_MODEL_ARGS = \{([^}]*)\}/m.exec(py);
  assert.ok(m, 'the grader holds ALLOWED_MODEL_ARGS');
  const inGrader = [...(m[1] as string).matchAll(/"([a-z_]+)"/g)].map((x) => x[1] as string).sort();
  assert.deepEqual([...MODEL_ARG_KEYS].sort(), inGrader);
});

// ---- the grader's deadline wording -----------------------------------------------------------------------------

test('the grader file says its deadline covers the call once a socket exists, and the connect is checked', () => {
  const py = readFileSync(join(dirOf, 'recording_grader.py'), 'utf8');
  assert.ok(!py.includes('The deadline covers the whole call'));
  assert.match(py, /conn\.connect\(\)\n\s+if state\["fired"\] or time\.monotonic\(\) - start >= timeout_s:\n\s+raise _deadline\(timeout_ms\)/);
  // The text of a passed deadline gives the stated milliseconds as an integer: no float format is in it.
  assert.match(py, /return _Deadline\(f"grader: the call passed its deadline of \{timeout_ms\} ms"\)/);
  assert.ok(!py.includes(':g} ms'));
});

// ---- attachments ---------------------------------------------------------------------------------------

test('an event string that is an attachment reference imports when its entry is present, and refuses when it is not', () => {
  const l = log('old-judge');
  const s = l.samples[1];
  const reply: string = modelEvent(s).output.choices[0].message.content;
  modelEvent(s).output.choices[0].message.content = 'attachment://feedfacefeedfacefeedfacefeedface';
  s.attachments['feedfacefeedfacefeedfacefeedface'] = reply;
  imp(l);
  delete s.attachments['feedfacefeedfacefeedfacefeedface'];
  const r = refusal('IMPORT_SHAPE', () => imp(l));
  assert.match(r.message, /no entry among the sample's attachments/);
});

test('an attachment reference inside a score refuses, even with its entry present', () => {
  const l = log('old-judge');
  const s = l.samples[1];
  s.attachments.abc = score(s).explanation;
  score(s).explanation = 'attachment://abc';
  assert.match(refusal('IMPORT_SHAPE', () => imp(l)).message, /does not resolve/);
});

// ---- the command -------------------------------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'inspect-import-'));
after(() => rmSync(work, { recursive: true, force: true }));
const cli = (...args: string[]) => {
  const r = spawnSync(process.execPath, [join(dirOf, 'import.ts'), ...args], { encoding: 'utf8' });
  return { ...r, stderr: ownStderr(r.stderr) };
};
const flags = (name: string, out: string) => ['--in', fx(name), '--cases', join(dirOf, 'cases.json'), '--bar', join(dirOf, 'bar.json'), '--out', out];

test('the command writes a run the library parses, prints the plan fragment, and is deterministic across processes', () => {
  const a = join(work, 'a.json');
  const b = join(work, 'b.json');
  const r1 = cli(...flags('old-judge', a));
  const r2 = cli(...flags('old-judge', b));
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(readFileSync(a, 'utf8'), readFileSync(b, 'utf8'));
  assert.equal(r1.stdout, r2.stdout);
  const written = readFileSync(a, 'utf8');
  const parsed = parseRunArtifact(JSON.parse(written));
  const lines = r1.stdout.trimEnd().split('\n');
  const end = lines.findIndex((l) => l === '}');
  const fragment = JSON.parse(lines.slice(0, end + 1).join('\n'));
  assert.deepEqual(Object.keys(fragment), ['barHash', 'caseSetHash', 'drawsPerCase', 'judge', 'systems']);
  assert.deepEqual(fragment.systems, { '<system name>': { '<old or new>': sha256Hex(written) } });
  assert.deepEqual(Object.keys(fragment.judge), ['judgeDefinitionHash', 'judgeModelRequested', 'judgeModelServed', 'judgeCallShapeHash', 'judgeHarnessVersion', 'rubricHash']);
  assert.equal(fragment.caseSetHash, parsed.identity.caseSetHash);
  assert.equal(fragment.judge.rubricHash, parsed.identity.rubricHash);
  assert.match(lines[end + 1] ?? '', /^grader: anchorset-recording-grader python [\d.]+ sha256:[0-9a-f]{64}$/);
  const shipped = sha256Hex(readFileSync(join(dirOf, 'recording_grader.py')));
  const recorded = log('old-judge').samples[0].scores[SC].metadata.grading[1].metadata.graderEvidence.grader.sha256;
  assert.equal(lines[end + 2], shipped === recorded ? "the record reports the shipped grader's sha256" : 'the record does not match the shipped grader (name, language or sha256), or the shipped file could not be read');
  assert.equal(lines[end + 3], 'system side and seed: UNKNOWN (this run can enter judge-change only under "system-side-not-compared"; `gate` refuses it)');
  // The sha256 line and the next-step line come last.
  assert.deepEqual(lines.slice(-2), [`run file sha256: ${sha256Hex(written)}`, NEXT_STEP_LINE]);
  assert.ok(!written.includes(work) && !written.includes(root));
});

test('exit 2 and no output file for a refused log; the refusal names the code, the fields and the message', () => {
  const out = join(work, 'plain-out.json');
  const r = cli(...flags('plain', out));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^REFUSED IMPORT_NO_RECORD: .*graderEvidence: this file was not graded[^\n]*\nfields: .*graderEvidence\n$/);
  assert.equal(existsSync(out), false);
  assert.equal(r.stdout, '');
});

test('exit 64: a missing flag, an unknown flag, a flag with no value, an existing --out; nothing is overwritten', () => {
  const ok = flags('old-judge', join(work, 'u.json'));
  assert.equal(cli(...ok.slice(0, 6)).status, 64);
  assert.equal(cli(...ok, '--extra', 'x').status, 64);
  assert.equal(cli(...ok.slice(0, 7)).status, 64);
  assert.equal(cli(...ok.slice(0, 7), '--bar').status, 64);
  assert.equal(cli('--in', fx('old-judge'), '--cases', 'no-such-cases.json', '--bar', join(dirOf, 'bar.json'), '--out', join(work, 'v.json')).status, 64);
  const existing = join(work, 'exists.json');
  writeFileSync(existing, 'keep me');
  const r = cli(...flags('old-judge', existing));
  assert.equal(r.status, 64);
  assert.match(r.stderr, /never overwrites/);
  assert.equal(readFileSync(existing, 'utf8'), 'keep me');
});

test('an empty flag value and an --out in a missing folder are usage errors (64), and nothing is written', () => {
  const ok = flags('old-judge', join(work, 'f2.json'));
  for (const flag of ['--out', '--in', '--cases', '--bar']) {
    const args = [...ok];
    args[args.indexOf(flag) + 1] = '';
    const r = cli(...args);
    assert.equal(r.status, 64, `${flag}: ${r.stderr}`);
    assert.match(r.stderr, /^USAGE: /);
    assert.ok(!/at .*\.ts:\d+/.test(r.stderr), 'no stack trace');
  }
  const nodir = join(work, 'no-such-folder', 'x.json');
  const r = cli(...flags('old-judge', nodir));
  assert.equal(r.status, 64, r.stderr);
  assert.match(r.stderr, /^USAGE: cannot write .*ENOENT/);
  assert.ok(!/at .*\.ts:\d+/.test(r.stderr), 'no stack trace');
  assert.equal(r.stdout, '');
});

test('an unexpected error is "internal error: <message>" with exit 70, never 1 and never a stack trace', () => {
  const out = join(work, 'f2-internal.json');
  const errs: string[] = [];
  const code = main(flags('old-judge', out), {
    out: () => {
      throw new Error('boom');
    },
    err: (m) => errs.push(m),
  });
  assert.equal(code, 70);
  assert.deepEqual(errs, ['internal error: boom']);
  const nonError: string[] = [];
  assert.equal(main(flags('old-judge', join(work, 'f2-internal2.json')), { out: () => { throw 'a string'; }, err: (m) => nonError.push(m) }), 70);
  assert.deepEqual(nonError, ['internal error: a string']);
});

test('exit 65: a cases file with a class the bar lacks, and a bar that does not validate; not refusals', () => {
  const badCases = join(work, 'bad-cases.json');
  writeFileSync(badCases, JSON.stringify({ c1: { klass: 'no_such_class', expect: 'C' } }));
  const r = cli('--in', fx('old-judge'), '--cases', badCases, '--bar', join(dirOf, 'bar.json'), '--out', join(work, 'w.json'));
  assert.equal(r.status, 65);
  assert.match(r.stderr, /not a class of the bar/);
  const badBar = join(work, 'bad-bar.json');
  writeFileSync(badBar, JSON.stringify({ labels: [], classes: {} }));
  assert.equal(cli('--in', fx('old-judge'), '--cases', join(dirOf, 'cases.json'), '--bar', badBar, '--out', join(work, 'x.json')).status, 65);
  assert.equal(existsSync(join(work, 'w.json')) || existsSync(join(work, 'x.json')), false);
});

// ---- what the importer may import --------------------------------------------------------------------------------

test('the importer imports only from ../shared.ts, the library\'s entry and Node built-ins', () => {
  const src = readFileSync(join(dirOf, 'import.ts'), 'utf8');
  const specifiers = [...src.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gms)].map((m) => m[1] as string);
  assert.ok(specifiers.length >= 4);
  for (const s of specifiers) assert.ok(s === '../shared.ts' || s === '../../../src/index.ts' || s.startsWith('node:'), `unexpected import ${s}`);
  assert.ok(!/\bimport\s*\(/.test(src) && !/\brequire\s*\(/.test(src), 'no dynamic import');
  assert.ok(!/\bfetch\s*\(|node:http|node:net|node:child_process/.test(src), 'no network, no process');
});

test('a refusal prints text of the file on one line each: a carriage return, an escape sequence and a line feed in the tool version are written as escapes, and stderr holds exactly two lines', () => {
  const l = log('old-judge');
  l.eval.packages.inspect_ai = '0.3.275\r\u001b[2Kgrader: anchorset-recording-grader\nthe record reports the shipped grader\'s sha256\u2028run file sha256: 000';
  const dir = mkdtempSync(join(tmpdir(), 'anchorset-in-line-'));
  const err: string[] = [];
  const out: string[] = [];
  try {
    writeFileSync(join(dir, 'in.json'), JSON.stringify(l));
    const code = main(['--in', join(dir, 'in.json'), '--cases', join(dirOf, 'cases.json'), '--bar', join(dirOf, 'bar.json'), '--out', join(dir, 'out.json')], { out: (x) => out.push(x), err: (x) => err.push(x) });
    assert.equal(code, 2);
    assert.equal(existsSync(join(dir, 'out.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(out, []);
  assert.match(err[0] ?? '', /^REFUSED IMPORT_TOOL_VERSION: /);
  assert.match(err[1] ?? '', /^fields: /);
  assert.equal(err.length, 2, JSON.stringify(err));
  for (const line of err) assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(line), JSON.stringify(line));
  assert.ok(err.some((line) => line.includes('\\r\\u001b[2K') && line.includes('\\n') && line.includes('\\u2028')), JSON.stringify(err));
});

// ---- thinking blocks, stated thinking and effort ----------------------------------------------------------------

const modelArgs = (l: J): J => l.eval.scorers[0].options.model.model_args;
const countLine = (out: string): string => out.split('\n').find((x) => x.startsWith('replies with a thinking block: ')) ?? 'NO LINE';

function viaMain(l: J): { code: number; out: string; err: string } {
  const dir = mkdtempSync(join(tmpdir(), 'anchorset-in-think-'));
  try {
    writeFileSync(join(dir, 'in.json'), JSON.stringify(l));
    const out: string[] = [];
    const err: string[] = [];
    const code = main(['--in', join(dir, 'in.json'), '--cases', join(dirOf, 'cases.json'), '--bar', join(dirOf, 'bar.json'), '--out', join(dir, 'out.json')], { out: (x) => out.push(x), err: (x) => err.push(x) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('thinking fixture: some replies thought and some did not; it imports, the grade is read from the text block, and the count line is printed', () => {
  const l = log('thinking');
  const types = l.samples.map((s: J) => records(s)[0].contentTypes.join('+'));
  const k = types.filter((t: string) => t === 'thinking+text').length;
  assert.ok(k > 0 && k < types.length, types.join(' '));
  const r = viaMain(l);
  assert.equal(r.code, 0, r.err);
  assert.equal(countLine(r.out), `replies with a thinking block: ${k} of ${types.length}`);
  // the log's grading message stays a string: the text block's text
  for (const s of l.samples) assert.equal(typeof score(s).metadata.grading[1].content, 'string');
  assert.ok(!text('thinking').includes('fake-signature'));
  const { run } = imp(l);
  for (const d of (run as J).draws) assert.equal(d.attempts[0].judgeStop, 'end');
});

test('thinking fixture: the stated settings are in the model arguments, the record and the call shape, and the call shape moves the identity', () => {
  const l = log('thinking');
  assert.deepEqual(modelArgs(l).thinking, { type: 'adaptive' });
  assert.equal(modelArgs(l).effort, 'high');
  const rec = records(l.samples[0])[0];
  assert.deepEqual(rec.sent.thinking, { type: 'adaptive' });
  assert.deepEqual(rec.sent.output_config, { effort: 'high' });
  assert.equal(rec.callShape.thinkingMode, 'adaptive');
  assert.equal(rec.callShape.effort, 'high');
  const a = parseRunArtifact(JSON.parse(JSON.stringify(imp(log('old-judge')).run))).identity;
  const b = parseRunArtifact(JSON.parse(JSON.stringify(imp(l).run))).identity;
  assert.notEqual(a.judgeCallShapeHash, b.judgeCallShapeHash);
});

test('the count line counts the blocks, in any number, and not the counter; the counter "ABSENT" and a counter with no block import', () => {
  const l = log('old-judge');
  eachRecord(l.samples[0], (r) => { r.contentTypes = ['thinking', 'text']; });
  eachRecord(l.samples[1], (r) => { r.contentTypes = ['redacted_thinking', 'thinking', 'text']; r.thinkingTokens = 'ABSENT'; });
  eachRecord(l.samples[2], (r) => { r.thinkingTokens = 77; });
  const r = viaMain(l);
  assert.equal(r.code, 0, r.err);
  assert.equal(countLine(r.out), `replies with a thinking block: 2 of ${l.samples.length}`);
  assert.equal(countLine(viaMain(log('old-judge')).out), `replies with a thinking block: 0 of ${l.samples.length}`);
});

test('a thinking block does not carry the grade: only the text block is read, and a reply with no grade line in it still refuses', () => {
  const l = log('thinking');
  const i = l.samples.findIndex((s: J) => records(s)[0].contentTypes[0] === 'thinking');
  const bad = 'I think it is fine. GRADE: C is my view, but not on the last line.\nthanks';
  eachRecord(l.samples[i], (r) => { r.reply = bad; });
  l.samples[i].scores[SC].metadata.grading[1].content = bad;
  l.samples[i].events.forEach((e: J) => { if (e.event === 'score') e.score.metadata.grading[1].content = bad; });
  assert.equal(refusal('IMPORT_UNGRADED', () => imp(l)).fields.length >= 1, true);
});

test('content of a thinking reply that is not thinking blocks then one text block refuses, naming the slot', () => {
  for (const types of [['thinking'], ['text', 'text'], ['thinking', 'text', 'thinking'], ['tool_use'], ['thinking', 'tool_use', 'text'], []]) {
    const l = log('thinking');
    eachRecord(l.samples[0], (r) => { r.contentTypes = types; });
    const e = refusal('IMPORT_UNGRADED', () => imp(l));
    assert.deepEqual(e.fields, ['c1#0'], JSON.stringify(types));
  }
});

test('a record of the previous version is IMPORT_EVIDENCE and says to re-grade with the current grader', () => {
  const l = log('old-judge');
  l.samples.forEach((s: J) => eachRecord(s, (r) => { r.schema = 'example.grader-evidence/v4'; }));
  const e = refusal('IMPORT_EVIDENCE', () => imp(l));
  assert.match(e.message, /re-grade with the current grader/);
});

test('a record of the version before (v6), its cut ask without the sha256 and the length of the cut reply, is IMPORT_EVIDENCE and says to re-grade', () => {
  const l = log('reask');
  l.samples.forEach((s: J) => eachRecord(s, (r) => {
    r.schema = 'example.grader-evidence/v6';
    for (const a of r.reask.earlier) {
      delete a.replySha256;
      delete a.replyUtf8Bytes;
    }
  }));
  const e = refusal('IMPORT_EVIDENCE', () => imp(l));
  assert.match(e.message, /this record is of version example\.grader-evidence\/v6, an earlier version than example\.grader-evidence\/v7; re-grade with the current grader \(examples\/importers\/inspect\/recording_grader\.py, schema example\.grader-evidence\/v7\)/);
  l.samples.forEach((s: J) => eachRecord(s, (r) => { r.schema = 'example.grader-evidence/v7'; }));
  assert.match(refusal('IMPORT_REASK', () => imp(l)).message, /not the form of a "truncated" ask; it lacks replySha256, replyUtf8Bytes/);
});

test('the record\'s usage must be the usage in the tool\'s own model event: a changed counter on either side is IMPORT_EVIDENCE', () => {
  // As the tool wrote it: the event's usage is the record's, with their sum.
  const ok = log('old-judge');
  for (const s of ok.samples) {
    const u = recordOf(s).usage;
    assert.deepEqual(modelEvent(s).output.usage, { input_tokens: u.input_tokens, output_tokens: u.output_tokens, total_tokens: u.input_tokens + u.output_tokens });
  }
  imp(ok);
  // The record's counters changed, on the score and on the event alike (so the two records stay equal), and the tool's copy left as it was.
  for (const [key, delta] of [['input_tokens', 1], ['output_tokens', 1], ['output_tokens', -1]] as const) {
    const l = log('old-judge');
    eachRecord(l.samples[0], (r) => { r.usage[key] += delta; });
    const e = refusal('IMPORT_EVIDENCE', () => imp(l));
    assert.match(e.message, /output\.usage is \{"input_tokens":\d+,"output_tokens":\d+,"total_tokens":\d+\}, the record says input \d+ and output \d+ \(total \d+\)/, key);
    assert.deepEqual(e.fields, ['/samples/0/events']);
  }
  // The tool's copy changed, the record left as it was: each of its three numbers.
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
    const l = log('old-judge');
    modelEvent(l.samples[0]).output.usage[key] += 1;
    assert.match(refusal('IMPORT_EVIDENCE', () => imp(l)).message, /output\.usage is /, key);
  }
  // The tool's copy is not there, or is not an object.
  for (const bad of [undefined, null, 120, 'ABSENT', []]) {
    const l = log('old-judge');
    if (bad === undefined) delete modelEvent(l.samples[0]).output.usage;
    else modelEvent(l.samples[0]).output.usage = bad;
    assert.match(refusal('IMPORT_EVIDENCE', () => imp(l)).message, /output\.usage is .*, the record says input/, JSON.stringify(bad));
  }
  // A record that states no usage stands beside an event that holds none: with one, it refuses; with none or a null, it imports.
  const absent = (): J => {
    const l = log('old-judge');
    l.samples.forEach((s: J) => eachRecord(s, (r) => { r.usage = 'ABSENT'; }));
    return l;
  };
  assert.match(refusal('IMPORT_EVIDENCE', () => imp(absent())).message, /output\.usage is set, the record says the response stated no usage/);
  for (const none of ['deleted', 'null']) {
    const l = absent();
    for (const s of l.samples) {
      if (none === 'deleted') delete modelEvent(s).output.usage;
      else modelEvent(s).output.usage = null;
    }
    imp(l);
  }
  // On a re-asked slot the tool's copy is the LAST ask's usage, which is the record's own; the cut ask's usage is in the record only.
  const re = log('reask');
  for (const s of reaskedSamples(re)) {
    const u = recordOf(s).usage;
    assert.deepEqual([modelEvent(s).output.usage.input_tokens, modelEvent(s).output.usage.output_tokens], [u.input_tokens, u.output_tokens]);
  }
  imp(re);
});

test('a record of the second-previous version (v2) is IMPORT_EVIDENCE, not no record', () => {
  const l = log('old-judge');
  l.samples.forEach((s: J) => eachRecord(s, (r) => { r.schema = 'example.grader-evidence/v2'; }));
  const e = refusal('IMPORT_EVIDENCE', () => imp(l));
  assert.match(e.message, /re-grade with the current grader/);
});

test('a record that names a reading rule is refused: Inspect reads the grade line by the tool\'s own rule', () => {
  const l = log('old-judge');
  l.samples.forEach((s: J) => eachRecord(s, (r) => { r.reading = 'one-json-object-boolean-pass/v1'; }));
  const e = refusal('IMPORT_EVIDENCE', () => imp(l));
  assert.match(e.fields.join(' '), /\.reading/);
  assert.doesNotMatch(e.message, /--reading/, 'the Inspect importer takes no such flag');
});

test('the model arguments must show the thinking and effort the record shows: missing, or different, is IMPORT_EVIDENCE naming the argument', () => {
  for (const key of ['thinking', 'effort']) {
    const a = log('thinking');
    delete modelArgs(a)[key];
    assert.match(refusal('IMPORT_EVIDENCE', () => imp(a)).fields.join(' '), new RegExp(`model_args/${key}`), `${key} missing`);
  }
  const b = log('thinking');
  modelArgs(b).thinking = { type: 'disabled' };
  assert.match(refusal('IMPORT_EVIDENCE', () => imp(b)).fields.join(' '), /model_args\/thinking/);
  const c = log('thinking');
  modelArgs(c).effort = 'low';
  assert.match(refusal('IMPORT_EVIDENCE', () => imp(c)).fields.join(' '), /model_args\/effort/);
  const d = log('old-judge');
  modelArgs(d).thinking = { type: 'adaptive' };
  assert.match(refusal('IMPORT_EVIDENCE', () => imp(d)).fields.join(' '), /model_args\/thinking/);
  const e = log('old-judge');
  e.eval.scorers[0].options.model = 'recording/fake-judge-old';
  assert.match(refusal('IMPORT_EVIDENCE', () => imp(e)).fields.join(' '), /model_args/);
});

test('a null model argument is printed as null, not as "not set"', () => {
  const l = log('thinking');
  modelArgs(l).thinking = null;
  const e = refusal('IMPORT_EVIDENCE', () => imp(l));
  assert.match(e.message, /model_args\/thinking: null but the record says/);
  assert.doesNotMatch(e.message, /not set/);
});

test('a key given twice in the log is IMPORT_SHAPE (exit 2); in the cases file or the bar it is exit 65; a bare NaN keeps its own words', () => {
  const put = (name: string, data: string): string => {
    const p = join(work, name);
    writeFileSync(p, data);
    return p;
  };
  const go = (log: string, cases: string, bar: string, tag: string) => cli('--in', put(`${tag}-in.json`, log), '--cases', put(`${tag}-cases.json`, cases), '--bar', put(`${tag}-bar.json`, bar), '--out', join(work, `${tag}-out.json`));
  const a = go(text('old-judge').replace('{', '{"status":"x",'), casesText, barText, 'dupa');
  assert.equal(a.status, 2, a.stderr);
  assert.match(a.stderr, /REFUSED IMPORT_SHAPE: .*: the key "status" is given twice in the top-level object/);
  const b = go(text('old-judge'), casesText.replace('{', '{"c1":{"klass":"x","expect":"y"},'), barText, 'dupb');
  assert.equal(b.status, 65, b.stderr);
  assert.match(b.stderr, /cases: the key "c1" is given twice/);
  const c = go(text('old-judge'), casesText, barText.replace('{', '{"labels":[],'), 'dupc');
  assert.equal(c.status, 65, c.stderr);
  assert.match(c.stderr, /bar: the key "labels" is given twice/);
  const nan = go('{"a":NaN,"a":1}', casesText, barText, 'dupd');
  assert.equal(nan.status, 2);
  assert.match(nan.stderr, /not JSON .*bare NaN/);
  assert.equal(existsSync(join(work, 'dupa-out.json')) || existsSync(join(work, 'dupb-out.json')) || existsSync(join(work, 'dupc-out.json')), false);
});

// ---- a file somebody crafted: an unpaired surrogate, and a text nested without end -----------------

test('an unpaired surrogate anywhere in the log is IMPORT_SHAPE with its JSON path (exit 2), never an internal error', () => {
  // JSON.stringify writes an unpaired surrogate as an escape: the bytes of each file below are plain text.
  const places: [string, (l: J) => void, string][] = [
    ['a stored output', (l) => { l.samples[0].output.completion += '\ud800'; }, '$.samples[0].output.completion'],
    ['a question', (l) => { l.samples[1].input = `\udc00${l.samples[1].input}`; }, '$.samples[1].input'],
    ['an object key', (l) => { l.samples[0].metadata['k\ud800'] = 1; }, '$.samples[0].metadata'],
    ['a text no check reads', (l) => { l.eval.note = '\udc00\ud800'; }, '$.eval.note'],
    ['an attachment', (l) => { l.samples[2].attachments['k'] = 'a\ud83d'; }, '$.samples[2].attachments.k'],
  ];
  for (const [name, edit, path] of places) {
    const l = log('old-judge');
    edit(l);
    assert.ok(Buffer.from(bytesOf(l)).toString('utf8').isWellFormed(), name);
    const r = refusal('IMPORT_SHAPE', () => imp(l));
    assert.deepEqual([...r.fields], [path], name);
    assert.ok(r.message.startsWith(`IMPORT_SHAPE: log.json: ${path}: `) && /holds an unpaired surrogate/.test(r.message), r.message);
    const cli = viaMain(l);
    assert.equal(cli.code, 2, `${name}: ${cli.err}`);
    assert.match(cli.err, /^REFUSED IMPORT_SHAPE: /);
    assert.doesNotMatch(cli.err, /internal error/);
  }
});

test('a log, a cases file or a bar nested 5,000 or 200,000 deep is refused or invalid input (exit 2 or 65), never exit 70', () => {
  const put = (name: string, data: string): string => {
    const p = join(work, name);
    writeFileSync(p, data);
    return p;
  };
  const go = (logText: string, cases: string, barData: string, tag: string) => cli('--in', put(`${tag}-in.json`, logText), '--cases', put(`${tag}-cases.json`, cases), '--bar', put(`${tag}-bar.json`, barData), '--out', join(work, `${tag}-out.json`));
  for (const depth of [5000, 200_000]) {
    const deep = `${'['.repeat(depth)}${']'.repeat(depth)}`;
    const a = go(text('old-judge').replace(/^\{/, `{"zz":${deep},`), casesText, barText, `deep-a-${depth}`);
    assert.equal(a.status, 2, a.stderr.slice(0, 200));
    assert.match(a.stderr, /^REFUSED IMPORT_SHAPE: .*: objects and lists are nested more than 128 deep$/m);
    // Where the tool's file may hold any JSON: the metadata of a sample, and an attachment.
    const l = log('old-judge');
    l.samples[0].metadata = { extra: 'PLACE' };
    const b = go(JSON.stringify(l).replace('"PLACE"', deep), casesText, barText, `deep-b-${depth}`);
    assert.equal(b.status, 2, b.stderr.slice(0, 200));
    assert.match(b.stderr, /nested more than 128 deep/);
    const c = go(text('old-judge'), `{"zz":${deep}}`, barText, `deep-c-${depth}`);
    assert.equal(c.status, 65, c.stderr.slice(0, 200));
    assert.match(c.stderr, /^INVALID_INPUT: cases: objects and lists are nested more than 128 deep$/m);
    const d = go(text('old-judge'), casesText, barText.replace(/^\{/, `{"zz":${deep},`), `deep-d-${depth}`);
    assert.equal(d.status, 65, d.stderr.slice(0, 200));
    assert.match(d.stderr, /^INVALID_INPUT: bar: objects and lists are nested more than 128 deep$/m);
  }
});

// ---- the bounded, recorded re-ask -------------------------------------------------------------------------------------

const REASK_LINE = 're-asks: 2 on 2 of 9 slots (truncated 1, timeout 0, transport 0, server-error 1, rate-limited 0); at most 2 per slot';
const recordOf = (s: J): J => score(s).metadata.grading[1].metadata.graderEvidence;
const reaskedSamples = (l: J): J[] => l.samples.filter((s: J) => recordOf(s).reask.earlier.length > 0);
function cliOn(l: J | Buffer): { status: number | null; stdout: string; stderr: string; outPath: string } {
  const folder = mkdtempSync(join(tmpdir(), 'anchorset-inspect-reask-'));
  const inPath = join(folder, 'log.json');
  const outPath = join(folder, 'run.json');
  writeFileSync(inPath, Buffer.isBuffer(l) ? l : JSON.stringify(l));
  const res = spawnSync(process.execPath, [join(dirOf, 'import.ts'), '--in', inPath, '--cases', join(dirOf, 'cases.json'), '--bar', join(dirOf, 'bar.json'), '--out', outPath], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: ownStderr(res.stderr), outPath };
}

test('fixtures/reask.json imports', () => {
  const l = log('reask');
  // What the tool wrote under a bound of 2: one slot of case 1 was cut once and one slot of case 2 got a 529 once.
  const asked = reaskedSamples(l).map((s: J) => [String(s.id), recordOf(s).reask.earlier.map((a: J) => a.reason)]).sort();
  assert.deepEqual(asked, [['c1', ['truncated']], ['c2', ['server-error']]]);
  assert.ok(l.samples.every((s: J) => recordOf(s).reask.max === 2 && recordOf(s).schema === 'example.grader-evidence/v7'));
  assert.equal(l.eval.scorers[0].options.model.model_args.max_reasks, 2);
  // One model event per slot, whatever the number of asks, and no retry of the tool's own.
  for (const s of l.samples) {
    assert.equal(s.events.filter((e: J) => e.event === 'model').length, 1);
    assert.deepEqual(s.error_retries, []);
    assert.ok(modelEvent(s).retries === undefined || modelEvent(s).retries === null || modelEvent(s).retries === 0);
  }
  const seqs = l.samples.flatMap((s: J) => [...recordOf(s).reask.earlier.map((a: J) => a.callSeq), recordOf(s).callSeq]).sort((a: number, b: number) => a - b);
  assert.deepEqual(seqs, Array.from({ length: 11 }, (_, i) => i + 1));
  const { run, summary } = imp(l);
  assert.equal(summary.reasks, REASK_LINE);
  const parsedRun = parseRunArtifact(JSON.parse(JSON.stringify(run)));
  const shapes = parsedRun.draws.map((d) => d.attempts.map((a) => (a.kind === 'unmeasured' ? `${a.kind} ${a.role} ${a.reason}` : a.kind)).join(', '));
  assert.equal(shapes.filter((s) => s === 'unmeasured judge truncated, graded').length, 1);
  assert.equal(shapes.filter((s) => s === 'unmeasured judge server-error, graded').length, 1);
  assert.equal(shapes.filter((s) => s === 'graded').length, 7);
  for (const d of parsedRun.draws) {
    const last = d.attempts.at(-1);
    assert.ok(last !== undefined && last.kind === 'graded');
    for (const a of d.attempts.slice(0, -1)) assert.ok(a.kind === 'unmeasured' && a.role === 'judge' && a.outputHash === last.outputHash && a.packetHash === last.packetHash && a.systemStop === 'UNKNOWN');
  }
  assert.match(parsedRun.identity.judgeHarnessVersion, /; python 3\.\d+\.\d+; max-reasks 2$/);
  // The command prints the two count lines, then the sha256 line and the next-step line, and the same bytes import to the same run bytes.
  const a = cliOn(readFileSync(join(dirOf, 'fixtures', 'reask.json')));
  const b = cliOn(readFileSync(join(dirOf, 'fixtures', 'reask.json')));
  assert.equal(a.status, 0, a.stderr);
  assert.deepEqual(a.stdout.trimEnd().split('\n').slice(-4, -2), ['replies with a thinking block: 0 of 9', REASK_LINE]);
  assert.equal(readFileSync(a.outPath, 'utf8'), readFileSync(b.outPath, 'utf8'));
});

test('bad-fixtures/reask-exhausted.json is refused', () => {
  const bytes = readFileSync(join(dirOf, 'bad-fixtures', 'reask-exhausted.json'));
  // Under a bound of 1 both asks of one slot were cut: the tool writes a bare NaN for that grade, as for any cut reply.
  assert.match(bytes.toString('utf8'), /"value": NaN/);
  assert.throws(() => JSON.parse(bytes.toString('utf8')));
  const e = refusal('IMPORT_UNGRADED', () => buildInspectRun(bytes, 'reask-exhausted.json', stated, bar));
  assert.match(e.message, /the log holds a bare NaN as the score of this sample, which the tool writes for a grade it could not read/);
  // The record of that slot is in the file, with both asks: the last cut, and one earlier ask, cut too.
  const cut = [...bytes.toString('utf8').matchAll(/"stopReason": "max_tokens"/g)].length;
  assert.ok(cut >= 2, String(cut));
  const res = cliOn(bytes);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /^REFUSED IMPORT_UNGRADED: /);
  assert.equal(existsSync(res.outPath), false);
});

test('an earlier ask edited to end_turn is IMPORT_REASK', () => {
  const l = log('reask');
  const s = reaskedSamples(l).find((x: J) => recordOf(x).reask.earlier[0].reason === 'truncated');
  eachRecord(s, (r) => { r.reask.earlier[0].stopReason = 'end_turn'; });
  const e = refusal('IMPORT_REASK', () => imp(l));
  assert.match(e.message, /a reply that was not cut at the output cap was asked again/);
  const res = cliOn(l);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /^REFUSED IMPORT_REASK: /);
  assert.equal(existsSync(res.outPath), false);
});

test('a stated bound that differs from the record is IMPORT_EVIDENCE, and so is a log that states none', () => {
  const l = log('reask');
  l.eval.scorers[0].options.model.model_args.max_reasks = 3;
  const e = refusal('IMPORT_EVIDENCE', () => imp(l));
  assert.deepEqual([...e.fields], ['/eval/scorers/0/options/model/model_args/max_reasks']);
  assert.match(e.message, /max_reasks: 3 but the record says the bound was 2 re-ask\(s\)/);
  const none = log('old-judge');
  delete none.eval.scorers[0].options.model.model_args.max_reasks;
  assert.match(refusal('IMPORT_EVIDENCE', () => imp(none)).message, /max_reasks: "not set" but the record says the bound was 0 re-ask\(s\)/);
  // A generation setting that would have the tool retry behind the record is not a setting of the grader.
  const retry = log('old-judge');
  retry.eval.scorers[0].options.model.model_args.max_retries = 2;
  assert.deepEqual([...refusal('IMPORT_EVIDENCE', () => imp(retry)).fields], ['/eval/scorers/0/options/model/model_args/max_retries']);
});

test('a model event that shows retries is still IMPORT_DUPLICATE_CALL; a sample with error retries is still IMPORT_UNGRADED', () => {
  // On the re-asked fixture too: the grader's own recorded asks are not the tool's retries, and the tool's are still refused.
  const a = log('reask');
  modelEvent(reaskedSamples(a)[0]).retries = 1;
  assert.match(refusal('IMPORT_DUPLICATE_CALL', () => imp(a)).message, /the model event shows 1 retries; the tool called the model more than once for this grade/);
  const b = log('reask');
  reaskedSamples(b)[0].error_retries = [{ message: 'retry' }];
  assert.match(refusal('IMPORT_UNGRADED', () => imp(b)).message, /the sample was retried by the tool \(1 error retries\)/);
  const c = log('old-judge');
  modelEvent(c.samples[0]).retries = 2;
  refusal('IMPORT_DUPLICATE_CALL', () => imp(c));
});

// ---- regrade.py without inspect_ai ------------------------------------------------------------------------------------

/** The first Python of 3.10 or later on this machine (regrade.py's annotations need it), or undefined. */
function pythonForRegrade(): string | undefined {
  return ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python'].find((p) => {
    const v = spawnSync(p, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)']);
    return v.status === 0;
  });
}

test('regrade.py: ANTHROPIC_BASE_URL set with a --base-url that differs from it is a usage error before any file or call, naming the variable and never its value; the same address stated, an empty variable and --check are not', (t) => {
  const py = pythonForRegrade();
  if (py === undefined) {
    t.skip('no Python 3.10 or later on this machine');
    return;
  }
  const driver = 'import runpy, sys; sys.modules["inspect_ai"] = None; sys.exit(runpy.run_path(%PATH%, run_name="not_main")["main"](sys.argv[1:]))';
  const script = join(dirOf, 'regrade.py');
  const gateway = 'https://gateway.invalid/private-path';
  const runWith = (args: string[], value: string) => spawnSync(py, ['-c', driver.replace('%PATH%', JSON.stringify(script)), ...args], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', ANTHROPIC_BASE_URL: value } });
  const run = ['--log', 'no-such-log.json', '--epochs', '1', '--judge-model', 'm', '--max-tokens', '16', '--out-dir', 'o', '--thinking', 'NOT_SENT', '--effort', 'NOT_SENT', '--max-reasks', '0'];
  // --base-url is required, so a run without it is a usage error of its own, whatever the variable says
  const unstated = runWith(run, gateway);
  assert.equal(unstated.status, 64, unstated.stderr);
  assert.match(unstated.stderr, /^usage error: a run needs \['--base-url'\]/);
  for (const args of [[...run, '--base-url', 'http://127.0.0.1:18765'], [...run, '--base-url', 'https://api.anthropic.com']]) {
    const r = runWith(args, gateway);
    assert.equal(r.status, 64, r.stderr);
    assert.match(r.stderr, /^usage error: the environment variable ANTHROPIC_BASE_URL is set, and this grader never reads it/);
    assert.ok(!r.stderr.includes('private-path') && !r.stderr.includes('gateway.invalid'), 'the value is not printed');
  }
  // Not refused for the variable: the same address stated, an empty variable, and a check (which makes no call). These go on to the
  // import of the tool, which is blocked here, so they end on the install line instead.
  for (const [args, value] of [[[...run, '--base-url', gateway], gateway], [[...run, '--base-url', 'http://127.0.0.1:18765'], ''], [['--log', 'no-such-log.json', '--epochs', '1', '--check'], gateway]] as const) {
    const r = runWith([...args], value);
    assert.equal(r.status, 64, r.stderr);
    assert.match(r.stderr, /pip install inspect_ai==0\.3\.275/);
  }
});

test('regrade.py on a Python older than 3.10: exit 64 and a line naming the version needed, never a traceback', (t) => {
  const old = ['python3.9', 'python3.8', 'python3'].find((p) => spawnSync(p, ['-c', 'import sys; sys.exit(0 if sys.version_info < (3, 10) else 1)']).status === 0);
  if (old === undefined) {
    t.skip('no Python older than 3.10 on this machine');
    return;
  }
  const r = spawnSync(old, [join(dirOf, 'regrade.py'), '--log', 'no-such-log.json', '--epochs', '1', '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 64, r.stderr);
  assert.match(r.stderr, /Python 3\.10 or later/);
  assert.doesNotMatch(r.stderr, /Traceback/);
});

test('regrade.py with inspect_ai missing: exit 64 and the install line, never a traceback (--check and a run alike)', (t) => {
  const py = pythonForRegrade();
  if (py === undefined) {
    t.skip('no Python 3.10 or later on this machine');
    return;
  }
  // `sys.modules[name] = None` makes `import inspect_ai` raise ModuleNotFoundError whether or not the package is installed.
  const driver = 'import runpy, sys; sys.modules["inspect_ai"] = None; sys.exit(runpy.run_path(%PATH%, run_name="not_main")["main"](sys.argv[1:]))';
  const script = join(dirOf, 'regrade.py');
  const run = (args: string[]) => spawnSync(py, ['-c', driver.replace('%PATH%', JSON.stringify(script)), ...args], { encoding: 'utf8' });
  for (const args of [
    ['--log', 'no-such-log.json', '--epochs', '1', '--check'],
    ['--log', 'no-such-log.json', '--epochs', '1', '--judge-model', 'm', '--max-tokens', '16', '--out-dir', 'o', '--thinking', 'NOT_SENT', '--effort', 'NOT_SENT', '--max-reasks', '0', '--base-url', 'http://127.0.0.1:18765'],
  ]) {
    const r = run(args);
    assert.equal(r.status, 64, r.stderr);
    assert.match(r.stderr, /pip install inspect_ai==0\.3\.275/);
    assert.doesNotMatch(r.stderr, /Traceback/);
  }
});

// ---- the free-text fields of a record are one printable line --------------------------------------------------

test('a free-text field of a record that is not one printable line is IMPORT_EVIDENCE naming the field, not printed', () => {
  const values: ReadonlyArray<readonly [string, string]> = [
    ['a line feed', 'python 3.14\nthe record reports the shipped grader'],
    ['a carriage return', 'python 3.14\rforged'],
    ['an escape character', 'python 3.14\u001b[2Jforged'],
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
      const l = log('old-judge');
      eachRecord(l.samples[0], (r) => edit(r, value));
      const e = refusal('IMPORT_EVIDENCE', () => imp(l));
      assert.ok(e.fields.some((f) => f.endsWith(`.${field}`)), `${field} with ${what}: ${e.fields.join(' | ')}`);
      assert.equal(e.message.includes(value), false, `${field} with ${what}: the value is not echoed`);
    }
  }
});

// ---- a record from a grader that is not the shipped one ------------------------------------------------------

test('a log whose records name another grader file is refused by default, and read as that grader\'s account when its sha256 is stated', () => {
  const other = sha256Hex('another recording grader');
  const l = log('old-judge');
  l.samples.forEach((s: J) => eachRecord(s, (r) => { r.grader.sha256 = other; }));
  const inPath = join(work, 'other-grader.json');
  writeFileSync(inPath, JSON.stringify(l));
  const refused = cli('--in', inPath, '--cases', join(dirOf, 'cases.json'), '--bar', join(dirOf, 'bar.json'), '--out', join(work, 'other-1.json'));
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /^REFUSED IMPORT_EVIDENCE: grader\.sha256: the record is not from the shipped grader \(examples\/importers\/inspect\/recording_grader\.py\)/);
  assert.match(refused.stderr, /state its file's sha256 with --grader-sha256/);
  assert.equal(existsSync(join(work, 'other-1.json')), false, 'a refusal writes nothing');
  const stated = cli('--in', inPath, '--cases', join(dirOf, 'cases.json'), '--bar', join(dirOf, 'bar.json'), '--out', join(work, 'other-2.json'), '--grader-sha256', other);
  assert.equal(stated.status, 0, stated.stderr);
  assert.match(stated.stdout, /^the record reports the grader sha256 you stated with --grader-sha256, which is not the shipped grader/m);
  const wrong = cli('--in', inPath, '--cases', join(dirOf, 'cases.json'), '--bar', join(dirOf, 'bar.json'), '--out', join(work, 'other-3.json'), '--grader-sha256', sha256Hex('a third'));
  assert.equal(wrong.status, 2, wrong.stderr);
  const usage = cli('--in', inPath, '--cases', join(dirOf, 'cases.json'), '--bar', join(dirOf, 'bar.json'), '--out', join(work, 'other-4.json'), '--grader-sha256', 'not-a-hash');
  assert.equal(usage.status, 64, usage.stderr);
});

// ---- the base URL, the deadline, the API version and the key variable are compared with the record -----------

test('an edit of the scorer model\'s base URL, deadline or API version is IMPORT_EVIDENCE naming the setting, and a value equal to the record\'s default is read as the default', () => {
  const edits: ReadonlyArray<readonly [string, (m: J) => void, string]> = [
    ['base_url', (m) => { m.base_url = 'http://127.0.0.1:18766'; }, '/eval/scorers/0/options/model/base_url'],
    ['timeout_ms', (m) => { m.model_args.timeout_ms = 1234; }, '/eval/scorers/0/options/model/model_args/timeout_ms'],
    ['api_version', (m) => { m.model_args.api_version = '2024-01-01'; }, '/eval/scorers/0/options/model/model_args/api_version'],
    ['api_key_env', (m) => { m.model_args.api_key_env = 'NOT A NAME'; }, '/eval/scorers/0/options/model/model_args/api_key_env'],
  ];
  for (const [name, edit, field] of edits) {
    const l = log('old-judge');
    edit(l.eval.scorers[0].options.model);
    const e = refusal('IMPORT_EVIDENCE', () => imp(l));
    assert.ok(e.fields.includes(field), `${name}: ${e.fields.join(' | ')}`);
    assert.match(e.message, new RegExp(`${field.replace(/[/]/g, '\\/')}: `), name);
  }
  // a base URL the grader would not take at all is named as that, and is not echoed
  const l = log('old-judge');
  l.eval.scorers[0].options.model.base_url = 'http://user:secret-word@127.0.0.1:18765';
  const e = refusal('IMPORT_EVIDENCE', () => imp(l));
  assert.ok(e.fields.includes('/eval/scorers/0/options/model/base_url'));
  assert.equal(e.message.includes('secret-word'), false);
  // a setting stated at the record's own value is the same as the record
  const same = log('old-judge');
  const cs = same.samples[0].scores[SC].metadata.grading[1].metadata.graderEvidence.callShape;
  same.eval.scorers[0].options.model.model_args.timeout_ms = cs.timeoutMs;
  same.eval.scorers[0].options.model.model_args.api_version = cs.apiVersion;
  imp(same);
});
