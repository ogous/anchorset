// The re-grade script of the third importer (examples/importers/skill-evals/regrade.ts): what it writes, in which
// order it calls the grader, and every refusal. The grader is a stub handed in through `deps`: no test makes a call,
// opens a socket or needs a key. Each refusal is made on a temp copy of the hand-written example flow.
// Synthetic customer-support refund-bot data only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, test } from 'node:test';
import { NOT_SENT, sha256Hex } from '../src/index.ts';
import { IMPORT_EXIT, IMPORT_EXIT_INTERNAL, READING_JSON_OBJECT, READING_JSON_OBJECT_OR_FENCE } from '../examples/importers/shared.ts';
import { GRADER_FILE, loadGraderClass, openExclusive, OPTIONAL_FLAGS, parseRegradeFlags, REGRADE_SCHEMA, REQUIRED_FLAGS, runRegrade, SCRIPT, SCRIPT_FILES, USAGE } from '../examples/importers/skill-evals/regrade.ts';
import type { Grader, GraderConfig, RegradeDeps } from '../examples/importers/skill-evals/regrade.ts';
import { startFakeEndpoint } from '../examples/importers/fake-endpoint.ts';
import type { FakeEndpointOptions } from '../examples/importers/fake-endpoint.ts';
import { main as importMain } from '../examples/importers/skill-evals/import.ts';

const root = join(import.meta.dirname, '..');
const dir = join(root, 'examples', 'importers', 'skill-evals');
const exampleFlow = join(dir, 'example-flow');
const casesPath = join(dir, 'cases.json');
const templatePath = join(dir, 'template.txt');
const criterionPath = join(dir, 'criterion.txt');
const systemPath = join(dir, 'system.txt');
const work = mkdtempSync(join(tmpdir(), 'anchorset-skill-regrade-'));
after(() => rmSync(work, { recursive: true, force: true }));

// A made-up text in the form of a key. It is in the environment handed to the script, and must never reach the file.
const KEY = 'sk-example-0123456789-not-a-real-key';
const RUN_ID = '00000000-0000-4000-8000-000000000001';
// The stub grader makes no call; the address is only what the script states and the record shows.
const BASE_URL = 'http://127.0.0.1:18765';
const STARTED = '2000-01-01T00:00:00.000Z';
// The fixed order of the rows: case id, then draw (the base flags grade source rep 0 twice).
const ORDER = ['bank-dispute#0', 'bank-dispute#1', 'clearance-organiser#0', 'clearance-organiser#1', 'faulty-headphones#0', 'faulty-headphones#1'];

let counter = 0;
function copyFlow(): string {
  counter += 1;
  const to = join(work, `flow-${counter}`);
  cpSync(exampleFlow, to, { recursive: true });
  return to;
}
function tempFile(name: string, text: string): string {
  counter += 1;
  const path = join(work, `${counter}-${name}`);
  writeFileSync(path, text);
  return path;
}
function freshOut(): string {
  counter += 1;
  return join(work, `regrade-${counter}.jsonl`);
}

type Obj = Record<string, unknown>;
type StubOptions = {
  /** The 1-based call that throws, with its message. */
  throwOn?: { call: number; message: string; cause?: unknown };
  /** What `callApi` resolves to on the given 1-based call, in place of a well-formed result. */
  resultOn?: { call: number; result: unknown };
  /** The content types of the reply of a call (1-based); `['text']` when the function is absent. */
  contentTypes?: (call: number) => string[] | undefined;
  /** How many cut asks the record of a call (1-based) holds before its last ask; none when the function is absent. */
  earlier?: (call: number) => number;
  /** The raw stop reason of the last ask of a call (1-based); "end_turn" when the function is absent. */
  stopReason?: (call: number) => string;
  /** The reply text of a call (1-based); a verdict object when the function is absent. */
  reply?: (call: number) => string;
  /** The factory itself throws: a configuration the grader refuses. */
  refuseConfig?: string;
  /** The grader's `preflight` throws this. */
  preflightError?: string;
};
type Stub = { factory: (config: GraderConfig) => Grader; configs: GraderConfig[]; prompts: string[]; preflights: number };

const THINKING_MODES: Record<string, string> = { adaptive: 'adaptive', between_tools: 'between-tools', disabled: 'off', enabled: 'budgeted' };

/** A grader that returns a record the importer accepts, in the shape of the real one, without any call. */
function stubGrader(o: StubOptions = {}): Stub {
  const configs: GraderConfig[] = [];
  const prompts: string[] = [];
  let ask = 0;
  const stub: Stub = { factory: undefined as never, configs, prompts, preflights: 0 };
  stub.factory = (config: GraderConfig): Grader => {
    configs.push(config);
    if (o.refuseConfig !== undefined) throw new Error(o.refuseConfig);
    return {
      preflight: () => {
        stub.preflights += 1;
        if (o.preflightError !== undefined) throw new Error(o.preflightError);
      },
      callApi: async (prompt: string) => {
        prompts.push(prompt);
        const seq = prompts.length;
        if (o.throwOn?.call === seq) throw o.throwOn.cause === undefined ? new Error(o.throwOn.message) : new TypeError(o.throwOn.message, { cause: o.throwOn.cause });
        if (o.resultOn?.call === seq) return o.resultOn.result as { output?: unknown; metadata?: unknown };
        const list = JSON.parse(prompt) as { role: string; content: string }[];
        const user = list[list.length - 1]?.content ?? '';
        const reply = o.reply === undefined ? '{"pass": true, "reason": "The reply follows the rules."}' : o.reply(seq);
        const types = o.contentTypes === undefined ? ['text'] : o.contentTypes(seq);
        const openai = config.wire === 'openai-responses/v1';
        const thinking = config.thinking ?? NOT_SENT;
        const mode = thinking === NOT_SENT ? NOT_SENT : (THINKING_MODES[String((thinking as Obj)['type'])] ?? 'adaptive');
        const budget = thinking !== NOT_SENT && (thinking as Obj)['type'] === 'enabled' ? (thinking as Obj)['budget_tokens'] : NOT_SENT;
        const cuts = o.earlier === undefined ? 0 : o.earlier(seq);
        const earlier = Array.from({ length: cuts }, () => {
          ask += 1;
          return {
            reason: 'truncated', callSeq: ask, callId: `00000000-0000-4000-8000-${String(ask).padStart(12, '0')}`, httpStatus: 200, responseId: `msg_cut_${ask}`, servedModel: config.model,
            ...(openai ? { stopReason: 'incomplete', incompleteReason: 'max_output_tokens', contentTypes: ['reasoning'] } : { stopReason: 'max_tokens', contentTypes: ['text'] }),
            thinkingTokens: 'ABSENT', usage: 'ABSENT', replySha256: sha256Hex(`cut ${ask}`), replyUtf8Bytes: 7,
          };
        });
        ask += 1;
        const graderEvidence: Obj = {
          schema: 'example.grader-evidence/v8',
          wire: config.wire,
          grader: { name: 'anchorset-recording-grader', language: 'js', sha256: 'a'.repeat(64), runtime: 'node v0.0.0' },
          graderRunId: '00000000-0000-4000-8000-00000000aaaa',
          callSeq: ask,
          callId: `00000000-0000-4000-8000-${String(ask).padStart(12, '0')}`,
          promptSha256: sha256Hex(prompt),
          sent: {
            system: list.length === 2 ? sha256Hex(list[0]?.content ?? '') : 'NOT_SENT',
            user: sha256Hex(user),
            ...(openai
              ? { reasoning: config.effort === NOT_SENT ? NOT_SENT : { effort: config.effort }, text: config.verbosity === NOT_SENT || config.verbosity === undefined ? NOT_SENT : { verbosity: config.verbosity }, store: false, truncation: 'disabled' }
              : { thinking, output_config: config.effort === NOT_SENT ? NOT_SENT : { effort: config.effort } }),
          },
          requestedModel: config.model,
          servedModel: config.model,
          responseId: `msg_${seq}`,
          stopReason: o.stopReason === undefined ? (openai ? 'completed' : 'end_turn') : o.stopReason(seq),
          ...(openai ? { incompleteReason: o.stopReason === undefined || o.stopReason(seq) === 'completed' ? 'ABSENT' : 'max_output_tokens' } : {}),
          contentTypes: types === undefined ? [] : openai ? types.map((t) => (t === 'text' ? 'message/output_text' : t === 'thinking' ? 'reasoning' : t)) : types,
          thinkingTokens: 'ABSENT',
          usage: 'ABSENT',
          reply,
          callShape: {
            schema: 'anchorset.callshape/v1',
            endpoint: `${config.baseUrl.replace(/\/+$/, '')}${openai ? '/responses' : '/v1/messages'}`,
            apiVersion: openai ? NOT_SENT : (config.apiVersion ?? '2023-06-01'),
            betaFlags: NOT_SENT,
            thinkingMode: openai ? NOT_SENT : mode,
            thinkingBudgetTokens: openai ? NOT_SENT : budget,
            effort: config.effort,
            toolChoice: NOT_SENT,
            toolChoiceName: NOT_SENT,
            strictTools: NOT_SENT,
            parallelToolUse: NOT_SENT,
            temperature: config.temperature ?? NOT_SENT,
            topP: NOT_SENT,
            topK: NOT_SENT,
            frequencyPenalty: NOT_SENT,
            presencePenalty: NOT_SENT,
            samplingSeed: NOT_SENT,
            maxOutputTokens: openai ? config.max_output_tokens : config.max_tokens,
            stopSequences: NOT_SENT,
            responseFormat: NOT_SENT,
            contextPolicy: 'none',
            stream: NOT_SENT,
            timeoutMs: config.timeoutMs ?? 60000,
            extras: openai ? { 'openai.store': false, ...(config.verbosity === undefined || config.verbosity === NOT_SENT ? {} : { 'openai.verbosity': config.verbosity }) } : {},
          },
          reask: { max: config.maxReasks, earlier },
        };
        // A record that holds no contentTypes list: the key is taken out (the importer refuses such a record).
        if (types === undefined) delete graderEvidence['contentTypes'];
        return { output: reply, metadata: { graderEvidence } };
      },
    };
  };
  return stub;
}

type Cli = { code: number; out: string; err: string; stub: Stub; outPath: string };
type RunOptions = { flags?: Record<string, string | undefined>; stub?: StubOptions; env?: Record<string, string | undefined>; outPath?: string; deps?: Partial<RegradeDeps> };

/** The value that stands for a switch: the flag is given, with no value. */
const SWITCH = '<switch>';
function argvOf(flags: Record<string, string | undefined>): string[] {
  return Object.entries(flags).flatMap(([k, v]) => (v === undefined ? [] : v === SWITCH ? [k] : [k, v]));
}
function baseFlags(outPath: string): Record<string, string | undefined> {
  return {
    '--wire': 'anthropic-messages/v1',
    '--flow': exampleFlow,
    '--variant': 'baseline',
    '--cases': casesPath,
    '--reps': '2',
    '--rep': '0',
    '--draws': '2',
    '--template': templatePath,
    '--criterion': criterionPath,
    '--model': 'example-judge-old',
    '--max-tokens': '256',
    '--thinking': 'NOT_SENT',
    '--effort': 'NOT_SENT',
    '--max-reasks': '0',
    '--base-url': BASE_URL,
    '--reading': READING_JSON_OBJECT,
    '--out': outPath,
  };
}
async function run(o: RunOptions = {}): Promise<Cli> {
  const outPath = o.outPath ?? freshOut();
  const stub = stubGrader(o.stub);
  const out: string[] = [];
  const err: string[] = [];
  const deps: RegradeDeps = {
    graderFactory: stub.factory,
    uuid: () => RUN_ID,
    now: () => new Date(STARTED),
    openOut: openExclusive,
    env: o.env ?? { ANTHROPIC_API_KEY: KEY },
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    ...o.deps,
  };
  const code = await runRegrade(argvOf({ ...baseFlags(outPath), ...o.flags }), deps);
  return { code, out: out.join('\n'), err: err.join('\n'), stub, outPath };
}

function linesOf(path: string): Obj[] {
  const text = readFileSync(path, 'utf8');
  assert.ok(text.endsWith('\n'), 'the file ends with a line feed');
  return text.slice(0, -1).split('\n').map((l) => JSON.parse(l) as Obj);
}
function hasNull(v: unknown): boolean {
  if (v === null) return true;
  if (Array.isArray(v)) return v.some(hasNull);
  if (typeof v === 'object') return Object.values(v as Obj).some(hasNull);
  return false;
}
const slotOf = (row: Obj): string => `${String(row['caseId'])}#${String(row['draw'])}`;
const text = (path: string): string => readFileSync(path, 'utf8');
/** The whole assistant turn of a slot, read from the example flow's trace. */
function turnOf(caseId: string, draw: number): { turn: string; traceSha256: string; question: string } {
  const bytes = readFileSync(join(exampleFlow, 'baseline', 'traces', `${caseId}_rep${draw}.json`));
  const turns = JSON.parse(bytes.toString('utf8')) as { role: string; content: string }[];
  return { turn: turns[turns.length - 1]?.content ?? '', question: turns[turns.length - 2]?.content ?? '', traceSha256: sha256Hex(bytes) };
}

// ---- the good path ---------------------------------------------------------------------------------------------------

test('on the example flow the re-grade writes a header and six rows, in the fixed order, and exits 0', async () => {
  const r = await run({ flags: { '--system': systemPath } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.code, IMPORT_EXIT.written);
  assert.equal(r.err, '');
  const [header, ...rows] = linesOf(r.outPath);
  assert.ok(header !== undefined);
  // Three cases in cases.json, two reps declared: 3 x 2 = 6 rows after the header.
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map(slotOf), ORDER);
  // One call per slot, in the same order, and each prompt handed over is the one written on the row.
  assert.equal(r.stub.prompts.length, 6);
  assert.deepEqual(rows.map((row) => row['promptSent']), r.stub.prompts);
  assert.equal(r.stub.configs.length, 1, 'one grader for the whole re-grade');

  assert.equal(header['schema'], 'example.skill-evals-regrade/v4');
  assert.equal(header['schema'], REGRADE_SCHEMA);
  assert.equal(header['regradeRunId'], RUN_ID);
  assert.equal(header['startedAt'], STARTED);
  assert.equal(header['script'], 'examples/importers/skill-evals/regrade.ts');
  assert.equal(header['rowProfile'], 'skill-evals/1');
  // The path given with --flow is absolute here, and holds a home directory: it is not written, in the header or anywhere in the file.
  assert.equal('flow' in header, false);
  assert.ok(exampleFlow.startsWith('/'));
  assert.equal(text(r.outPath).includes(exampleFlow), false);
  assert.equal(text(r.outPath).includes(root), false);
  assert.equal(header['variant'], 'baseline');
  assert.equal(header['reps'], 2);
  assert.equal(header['slotCount'], 6);
  // The cases file names every case of the flow: none is excluded, and the header says so in both fields.
  assert.deepEqual(header['excludedCaseIds'], []);
  assert.equal(header['excludedCaseCount'], 0);
  // Every key of the header, in the order the script writes them.
  assert.deepEqual(Object.keys(header), ['schema', 'regradeRunId', 'startedAt', 'script', 'rowProfile', 'variant', 'reps', 'sourceRep', 'draws', 'slotCount', 'excludedCaseIds', 'excludedCaseCount', 'resultsSha256', 'stateSha256', 'harnessSha', 'template', 'criterion', 'system', 'selector', 'reading', 'graderConfig', 'scriptFiles']);
  // shasum -a 256 of the two files, as in the flow reader's test.
  assert.equal(header['resultsSha256'], '3e2f58c097b50bf3b33416809f2c883fcb00c9e4134051ac21f7656367b245ec');
  assert.equal(header['stateSha256'], 'cba1a721c135db10ed25ac4866e309861557eeefdb5ba98803cb7df06d4a34a7');
  assert.equal(header['resultsSha256'], sha256Hex(readFileSync(join(exampleFlow, 'baseline', 'results.jsonl'))));
  assert.equal(header['stateSha256'], sha256Hex(readFileSync(join(exampleFlow, '_state.json'))));
  assert.deepEqual(header['template'], { text: text(templatePath), sha256: sha256Hex(readFileSync(templatePath)) });
  assert.deepEqual(header['criterion'], { text: text(criterionPath), sha256: sha256Hex(readFileSync(criterionPath)) });
  assert.deepEqual(header['system'], { text: text(systemPath), sha256: sha256Hex(readFileSync(systemPath)) });
  assert.equal(header['selector'], 'NOT_SENT');
  assert.deepEqual(header['graderConfig'], { wire: 'anthropic-messages/v1', model: 'example-judge-old', max_tokens: 256, thinking: 'NOT_SENT', effort: 'NOT_SENT', maxReasks: 0, baseUrl: BASE_URL });

  assert.deepEqual(r.out.split('\n'), [
    `wrote: ${r.outPath}`,
    `sha256: ${sha256Hex(readFileSync(r.outPath))}`,
    `re-grade run id: ${RUN_ID}`,
    'slots graded: 6 of 6, 6 asks made (0 re-asks; at most 0 per slot), in the order case id then draw (source rep 0, each stored output graded 2 times)',
    'slots with no finished reply: 0',
    'slots the importer will refuse: 0; every reply of a finished, well-formed record was read under the reading rule one-json-object-boolean-pass/v1',
    'excluded cases (in the flow, not in the cases file; not graded): 0',
    'reps of the flow that are whole: 2 of 2 (0, 1); only rep 0 was required to be, and check.ts lists what is wrong with any other',
    'replies with reasoning: 0 of 6',
  ]);
});

test('every hash of a row can be recomputed from the texts in the file, and the prompt from the template', async () => {
  const r = await run({ flags: { '--system': systemPath } });
  assert.equal(r.code, 0, r.err);
  const [header, ...rows] = linesOf(r.outPath);
  const template = (header?.['template'] as { text: string }).text;
  const criterion = (header?.['criterion'] as { text: string }).text;
  const system = (header?.['system'] as { text: string }).text;
  for (const row of rows) {
    const parts = row['parts'] as { question: string; answer: string; criterion: string };
    const source = turnOf(row['caseId'] as string, 0);
    assert.equal(row['traceSha256'], source.traceSha256);
    assert.equal(parts.question, source.question);
    assert.equal(parts.criterion, criterion);
    // With no selector the judge is shown the whole assistant turn.
    assert.equal(parts.answer, source.turn);
    assert.equal(row['storedOutput'], source.turn);
    assert.equal(row['storedOutputSha256'], sha256Hex(parts.answer));
    assert.equal(row['storedOutputSha256'], sha256Hex(row['storedOutput'] as string));
    // The rendering, written out by hand: the template cut at each token, the three texts put between the pieces.
    const [beforeQ, afterQ] = template.split('{question}') as [string, string];
    const [betweenQA, afterA] = afterQ.split('{answer}') as [string, string];
    const [betweenAC, tail] = afterA.split('{criterion}') as [string, string];
    const rendered = beforeQ + parts.question + betweenQA + parts.answer + betweenAC + parts.criterion + tail;
    assert.equal(row['promptSent'], JSON.stringify([{ role: 'system', content: system }, { role: 'user', content: rendered }]));
    // The record is the grader's, unchanged: its hashes are over what this script handed it.
    const record = row['graderEvidence'] as { promptSha256: string; sent: { system: string; user: string } };
    assert.equal(record.promptSha256, sha256Hex(row['promptSent'] as string));
    assert.equal(record.sent.user, sha256Hex(rendered));
    assert.equal(record.sent.system, sha256Hex(system));
    assert.deepEqual(Object.keys(row), ['caseId', 'draw', 'traceSha256', 'storedOutputSha256', 'storedOutput', 'parts', 'promptSent', 'graderEvidence']);
  }
});

test('without --system the message list is [user], and the header says the system text was not sent', async () => {
  const r = await run();
  assert.equal(r.code, 0, r.err);
  const [header, ...rows] = linesOf(r.outPath);
  assert.equal(header?.['system'], 'NOT_SENT');
  for (const row of rows) {
    const list = JSON.parse(row['promptSent'] as string) as { role: string }[];
    assert.deepEqual(list.map((m) => m.role), ['user']);
    assert.equal((row['graderEvidence'] as { sent: { system: string } }).sent.system, 'NOT_SENT');
  }
});

test('the record is written unchanged, key for key', async () => {
  const r = await run();
  const rows = linesOf(r.outPath).slice(1);
  const again = stubGrader();
  const grader = again.factory({ wire: 'anthropic-messages/v1', model: 'example-judge-old', max_tokens: 256, thinking: 'NOT_SENT', effort: 'NOT_SENT', maxReasks: 0, baseUrl: BASE_URL });
  for (const row of rows) {
    const res = await grader.callApi(row['promptSent'] as string);
    assert.deepEqual(row['graderEvidence'], (res.metadata as { graderEvidence: unknown }).graderEvidence);
  }
});

test('no null is written anywhere in the file', async () => {
  const r = await run({ flags: { '--system': systemPath, '--select': '/reply' } });
  assert.equal(r.code, 0, r.err);
  assert.equal(linesOf(r.outPath).some(hasNull), false);
});

// ---- the selector ------------------------------------------------------------------------------------------------------

test('with --select /reply the answer part is the selected text, while storedOutputSha256 is over the whole turn', async () => {
  const r = await run({ flags: { '--select': '/reply' } });
  assert.equal(r.code, 0, r.err);
  const [header, ...rows] = linesOf(r.outPath);
  assert.deepEqual(header?.['selector'], { syntax: 'json-pointer-rfc6901/v1', pointer: '/reply' });
  assert.equal(rows.length, 6);
  for (const row of rows) {
    const parts = row['parts'] as { answer: string };
    const source = turnOf(row['caseId'] as string, 0);
    const selected = (JSON.parse(source.turn) as { reply: string }).reply;
    assert.equal(parts.answer, selected);
    assert.notEqual(parts.answer, source.turn);
    assert.equal(row['storedOutput'], source.turn);
    assert.equal(row['storedOutputSha256'], sha256Hex(source.turn));
    assert.notEqual(row['storedOutputSha256'], sha256Hex(parts.answer));
    // The judge is shown the selected text and not the rest of the turn.
    const user = (JSON.parse(row['promptSent'] as string) as { content: string }[])[0]?.content ?? '';
    assert.ok(user.includes(selected));
    assert.ok(!user.includes('"action"'));
  }
});

test('a selector that does not select a string on every slot is refused before any call, and nothing is written', async () => {
  const r = await run({ flags: { '--select': '/missing' } });
  assert.equal(r.code, IMPORT_EXIT.refused);
  // The selector is applied to the stored outputs of the graded rep, one per case; a slot is named <case>#<source rep>.
  assert.match(r.err, /^REFUSED IMPORT_PACKET: selector "\/missing" cannot be applied to 3 of 3 slot\(s\)/);
  assert.match(r.err, /^fields: bank-dispute#0, clearance-organiser#0, faulty-headphones#0$/m);
  assert.equal(r.stub.prompts.length, 0);
  assert.equal(existsSync(r.outPath), false);
});

test('an empty --select and a selector that is not a JSON Pointer are usage errors', async () => {
  for (const pointer of ['', 'reply', '/a~2']) {
    const r = await run({ flags: { '--select': pointer } });
    assert.equal(r.code, IMPORT_EXIT.usage, pointer);
    // The empty value is refused by the shared flag parser, as in check.ts: the whole turn is the flag left out.
    assert.match(r.err, pointer === '' ? /^USAGE: --select needs a value\. usage: / : /^USAGE: the selector .* is not a JSON Pointer/, pointer);
    assert.equal(r.stub.prompts.length, 0);
    assert.equal(existsSync(r.outPath), false);
  }
});

test('a selected text with an unpaired surrogate, spelled by an escape inside a well-formed stored turn, is refused before any call', async () => {
  const flow = copyFlow();
  const tracePath = join(flow, 'baseline', 'traces', 'bank-dispute_rep1.json');
  const turns = JSON.parse(text(tracePath)) as { content: string }[];
  // The stored turn is well-formed text: the escape is six plain characters in it.
  (turns[2] as { content: string }).content = '{"action":"hand_off","reply":"A colleague will write to you. \\ud800"}';
  writeFileSync(tracePath, JSON.stringify(turns));
  // The turn is the stored output of source rep 1: that is the rep graded here.
  const r = await run({ flags: { '--flow': flow, '--select': '/reply', '--rep': '1' } });
  assert.equal(r.code, IMPORT_EXIT.refused, r.err);
  assert.match(r.err, /^REFUSED IMPORT_PACKET: selector "\/reply" cannot be applied to 1 of 3 slot\(s\): bank-dispute#1: the selected value: the text holds an unpaired surrogate/);
  assert.equal(r.stub.configs.length, 0);
  assert.equal(existsSync(r.outPath), false);
  // Shown whole, the same turn is the text it is, and the re-grade runs.
  const whole = await run({ flags: { '--flow': flow, '--rep': '1' } });
  assert.equal(whole.code, 0, whole.err);
});

// ---- the flags ---------------------------------------------------------------------------------------------------------

test('every flag with no default is required: leaving any one out is a usage error, with no grader built and no file', async () => {
  assert.deepEqual([...REQUIRED_FLAGS['anthropic-messages/v1']], ['--wire', '--flow', '--variant', '--cases', '--reps', '--rep', '--draws', '--template', '--criterion', '--model', '--max-tokens', '--effort', '--max-reasks', '--base-url', '--reading', '--out', '--thinking']);
  for (const flag of REQUIRED_FLAGS['anthropic-messages/v1']) {
    const r = await run({ flags: { [flag]: undefined } });
    assert.equal(r.code, IMPORT_EXIT.usage, flag);
    assert.match(r.err, flag === '--wire' ? /^USAGE: --wire is required and must be one of anthropic-messages\/v1, openai-responses\/v1\. usage: / : new RegExp(`^USAGE: missing ${flag}\\. usage: `), flag);
    assert.equal(r.out, '');
    assert.equal(r.stub.configs.length, 0, flag);
    if (flag !== '--out') assert.equal(existsSync(r.outPath), false, flag);
  }
});

test('an unknown flag, a flag given twice and a flag with no value are usage errors', () => {
  const ok = argvOf(baseFlags('x.jsonl'));
  assert.equal(parseRegradeFlags(ok)['--model'], 'example-judge-old');
  assert.throws(() => parseRegradeFlags([...ok, '--retry', '3']), /USAGE: unknown argument "--retry"/);
  assert.throws(() => parseRegradeFlags([...ok, '--model', 'again']), /USAGE: --model given twice/);
  assert.throws(() => parseRegradeFlags([...ok, '--system']), /USAGE: --system needs a value/);
  assert.throws(() => parseRegradeFlags([...ok, '--system', '--select']), /USAGE: --system needs a value/);
  assert.throws(() => parseRegradeFlags([...ok.slice(0, -1), '']), /USAGE: --out needs a value/);
  assert.match(USAGE, /^usage: node examples\/importers\/skill-evals\/regrade\.ts /);
  for (const flag of [...REQUIRED_FLAGS['anthropic-messages/v1'], ...REQUIRED_FLAGS['openai-responses/v1'], ...OPTIONAL_FLAGS['anthropic-messages/v1']]) assert.ok(USAGE.includes(flag), flag);
});

test('--reps, --max-tokens, --timeout-ms and --temperature are read strictly', async () => {
  const bad: [string, string][] = [
    ['--reps', '0'],
    ['--reps', '2.0'],
    ['--reps', 'two'],
    ['--max-tokens', '0'],
    ['--max-tokens', '1e3'],
    ['--max-tokens', '256 '],
    ['--timeout-ms', '-5'],
    ['--timeout-ms', '1.5'],
    ['--temperature', 'cold'],
    ['--temperature', '.5'],
    ['--temperature', '0x1'],
  ];
  // A number is taken in its one plain spelling, in ASCII digits: no underscore, no sign, no space, no leading zero, no
  // digit of another script, no exponent. The Python re-grade script (inspect/regrade.py) holds its numbers to the same forms.
  for (const flag of ['--reps', '--draws', '--rep', '--max-tokens', '--timeout-ms', '--max-reasks']) {
    for (const value of ['1_0', '+1', '-1', ' 1', '1 ', '١', '１', '01', '1.0', '1e0', '0x1', '1,0']) bad.push([flag, value]);
  }
  for (const value of ['0_1', '0_5', '+0.5', '-0', '-0.0', '-0.5', '-1', ' 0.5', '0.5 ', '5.', '1e0', '1E-1', 'inf', '-inf', 'nan', 'NaN', 'Infinity', '٠', '0.٥', '00', '01', '0,5']) bad.push(['--temperature', value]);
  for (const [flag, value] of bad) {
    const r = await run({ flags: { [flag]: value } });
    assert.equal(r.code, IMPORT_EXIT.usage, `${flag} ${JSON.stringify(value)}`);
    assert.equal(r.stub.configs.length, 0, `${flag} ${JSON.stringify(value)}`);
    assert.equal(existsSync(r.outPath), false);
  }
  // The plain forms are taken, and reach the grader as the numbers they read as.
  for (const [value, n] of [['0', 0], ['1', 1], ['0.5', 0.5], ['0.25', 0.25], ['1.0', 1]] as const) {
    const r = await run({ flags: { '--temperature': value } });
    assert.equal(r.stub.configs.length, 1, value);
    assert.equal(r.stub.configs[0]!.temperature, n, value);
  }
});

test('--thinking is NOT_SENT or the text of a JSON object; anything else is a usage error', async () => {
  for (const value of ['adaptive', '{"type":', '"adaptive"', '[1]', '7', 'null', 'not_sent', '{"type":null}']) {
    const r = await run({ flags: { '--thinking': value } });
    assert.equal(r.code, IMPORT_EXIT.usage, value);
    assert.match(r.err, /--thinking/, value);
    assert.equal(r.stub.configs.length, 0, value);
    assert.equal(existsSync(r.outPath), false);
  }
  // A key given twice: the grader would be handed the last, and the flag as typed says two things.
  const twice = await run({ flags: { '--thinking': '{"type":"adaptive","type":"disabled"}' } });
  assert.equal(twice.code, IMPORT_EXIT.usage);
  assert.match(twice.err, /--thinking must be NOT_SENT or the text of a JSON object.*; the key "type" is given twice in the top-level object/);
  assert.equal(twice.stub.configs.length, 0);
  assert.equal(existsSync(twice.outPath), false);
});

test('--api-key-env is the name of a variable, never a key', async () => {
  const r = await run({ flags: { '--api-key-env': KEY } });
  assert.equal(r.code, IMPORT_EXIT.usage);
  assert.ok(!r.err.includes(KEY), 'the value is not echoed');
  assert.equal(r.stub.configs.length, 0);
  assert.equal(existsSync(r.outPath), false);
});

// ---- what the grader is handed -------------------------------------------------------------------------------------------

test('the grader is handed the stated settings and nothing else; a flag left out is a key left out', async () => {
  const plain = await run();
  assert.deepEqual(plain.stub.configs, [{ wire: 'anthropic-messages/v1', model: 'example-judge-old', max_tokens: 256, thinking: 'NOT_SENT', effort: 'NOT_SENT', maxReasks: 0, baseUrl: BASE_URL }]);

  const full = await run({
    flags: {
      '--thinking': '{"type":"enabled","budget_tokens":1024}',
      '--effort': 'high',
      '--base-url': 'http://127.0.0.1:18765',
      '--temperature': '0.5',
      '--timeout-ms': '30000',
      '--api-version': '2023-06-01',
      '--api-key-env': 'EXAMPLE_JUDGE_KEY',
    },
    env: { EXAMPLE_JUDGE_KEY: KEY },
  });
  assert.equal(full.code, 0, full.err);
  const expected = {
    wire: 'anthropic-messages/v1',
    model: 'example-judge-old',
    max_tokens: 256,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    effort: 'high',
    maxReasks: 0,
    temperature: 0.5,
    baseUrl: 'http://127.0.0.1:18765',
    timeoutMs: 30000,
    apiVersion: '2023-06-01',
    apiKeyEnv: 'EXAMPLE_JUDGE_KEY',
  };
  assert.deepEqual(full.stub.configs, [expected]);
  // The header holds the configuration that was handed over: the name of the key's variable, never the key.
  assert.deepEqual(linesOf(full.outPath)[0]?.['graderConfig'], expected);
});

test('the script does not judge a thinking or effort value: it hands it on, and the grader decides; the reading rule is not handed to the grader', async () => {
  // The stub builds a record from what it was handed, and a thinking object of no known form gives a record the importer refuses: it is counted.
  const r = await run({ flags: { '--thinking': '{"type":"sideways","depth":3}', '--effort': 'enormous', '--go-on-and-count': SWITCH } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.stub.configs[0]?.thinking, { type: 'sideways', depth: 3 });
  assert.equal(r.stub.configs[0]?.effort, 'enormous');
  // The rule is the re-grade's and the importer's: the grader neither reads a reply nor is told a rule.
  assert.equal('reading' in (r.stub.configs[0] ?? {}), false);
  assert.equal('reading' in (linesOf(r.outPath)[0]?.['graderConfig'] as Obj), false);
});

test('--reading is required and names one of the two rules; the header records it, as a field of its own', async () => {
  for (const rule of [READING_JSON_OBJECT, READING_JSON_OBJECT_OR_FENCE]) {
    const r = await run({ flags: { '--reading': rule } });
    assert.equal(r.code, 0, r.err);
    const header = linesOf(r.outPath)[0] ?? {};
    assert.equal(header['reading'], rule);
    // In the header's own order: after the selector, before the grader's configuration.
    const keys = Object.keys(header);
    assert.equal(keys.indexOf('reading'), keys.indexOf('selector') + 1);
    assert.equal(keys.indexOf('graderConfig'), keys.indexOf('reading') + 1);
  }
  // Left out: a usage error that names the flag, with no grader built, no call and no file.
  const none = await run({ flags: { '--reading': undefined } });
  assert.equal(none.code, IMPORT_EXIT.usage);
  assert.match(none.err, /^USAGE: missing --reading\. usage: /);
  assert.equal(none.stub.configs.length, 0);
  assert.equal(existsSync(none.outPath), false);
  // A name that is not one of the two: a usage error that lists both, before the flow is read (the flow named here is not there).
  for (const bad of ['lenient', 'one-json-object-boolean-pass/v2', 'ONE-JSON-OBJECT-BOOLEAN-PASS/V1', ' one-json-object-boolean-pass/v1']) {
    const r = await run({ flags: { '--reading': bad, '--flow': join(work, 'no-such-flow') } });
    assert.equal(r.code, IMPORT_EXIT.usage, bad);
    assert.match(r.err, /^USAGE: --reading must be one of one-json-object-boolean-pass\/v1, one-json-object-boolean-pass-or-json-fence\/v1; found /, bad);
    assert.equal(r.stub.configs.length, 0, bad);
    assert.equal(r.stub.prompts.length, 0, bad);
    assert.equal(existsSync(r.outPath), false, bad);
  }
  assert.match(USAGE, /--reading <one-json-object-boolean-pass\/v1 \| one-json-object-boolean-pass-or-json-fence\/v1>/);
});

const FENCED = '```json\n{"pass": true, "reason": "fenced"}\n```';

test('the re-grade reads each reply under the stated rule and stops at the first slot whose reply it cannot read: the row is kept with its record, no later slot is called, exit 2', async () => {
  // Call 3 is a finished reply in prose: no verdict under either rule.
  const prose = await run({ stub: { reply: (call) => (call === 3 ? 'The reply follows the rules, I think.' : '{"pass": false, "reason": "x"}') } });
  assert.equal(prose.code, IMPORT_EXIT.refused, prose.err);
  assert.equal(prose.stub.prompts.length, 3, 'no call after the slot whose reply cannot be read');
  const rows = linesOf(prose.outPath).slice(1);
  assert.equal(rows.length, 3);
  assert.equal((rows[2]?.['graderEvidence'] as Obj)['reply'], 'The reply follows the rules, I think.');
  assert.match(prose.err, /^REFUSED the re-grade stopped at slot clearance-organiser#0 \(slot 3 of 6\): the importer will refuse it: not exactly one JSON object with a boolean "pass", under the reading rule one-json-object-boolean-pass\/v1 that was stated$/m);
  assert.match(prose.err, /^fields: clearance-organiser#0$/m);
  assert.match(prose.err, /^slots graded: 3 of 6$/m);
  assert.match(prose.err, /--go-on-and-count goes on instead/);
  assert.equal(prose.out, '', 'nothing is reported as written');
  // A fenced object: unreadable under the first rule, and the words say that the other rule reads it, as the importer says it.
  const fenced = await run({ stub: { reply: (call) => (call === 2 ? FENCED : '{"pass": true}') } });
  assert.equal(fenced.code, IMPORT_EXIT.refused);
  assert.equal(fenced.stub.prompts.length, 2);
  assert.match(fenced.err, /^REFUSED the re-grade stopped at slot bank-dispute#1 \(slot 2 of 6\): the importer will refuse it: not exactly one JSON object with a boolean "pass", under the reading rule one-json-object-boolean-pass\/v1 that was stated; readable under one-json-object-boolean-pass-or-json-fence\/v1; that rule is a different judge definition$/m);
  // Under the second rule the same replies are read, every slot is called, and the exit is 0.
  const read = await run({ flags: { '--reading': READING_JSON_OBJECT_OR_FENCE }, stub: { reply: (call) => (call === 2 ? FENCED : '{"pass": true}') } });
  assert.equal(read.code, 0, read.err);
  assert.equal(read.stub.prompts.length, 6);
  assert.match(read.out, /^slots the importer will refuse: 0; every reply of a finished, well-formed record was read under the reading rule one-json-object-boolean-pass-or-json-fence\/v1$/m);
  // The strict reader is the importer's: a key given twice and a "pass" that is not a boolean are not verdicts.
  for (const reply of ['{"pass":true,"pass":false}', '{"pass":"true"}', '[{"pass":true}]', '']) {
    const r = await run({ stub: { reply: (call) => (call === 1 ? reply : '{"pass": true}') } });
    assert.equal(r.code, IMPORT_EXIT.refused, reply);
    assert.equal(r.stub.prompts.length, 1, reply);
  }
});

test('with --go-on-and-count the slots whose reply cannot be read are counted by label, every slot is called, and the exit is 0', async () => {
  const r = await run({ flags: { '--go-on-and-count': SWITCH }, stub: { reply: (call) => (call === 3 || call === 6 ? 'prose' : '{"pass": true}') } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.stub.prompts.length, 6);
  assert.match(r.out, /^slots with no finished reply: 0$/m);
  assert.match(r.out, /^slots the importer will refuse: 2 \(the importer will refuse this file: clearance-organiser#0, faulty-headphones#1\); every reply of a finished, well-formed record was read under the reading rule one-json-object-boolean-pass\/v1$/m);
});

test('--go-on-and-count never goes on after a lost slot: a call that fails ends the re-grade at its slot, with the flag as without it', async () => {
  for (const flags of [{}, { '--go-on-and-count': SWITCH }] as Record<string, string>[]) {
    const r = await run({ flags, stub: { throwOn: { call: 3, message: 'grader: the endpoint answered status 529' } } });
    assert.equal(r.code, IMPORT_EXIT.refused, JSON.stringify(flags));
    assert.equal(r.stub.prompts.length, 3, 'no fourth call');
    const rows = linesOf(r.outPath).slice(1);
    assert.equal(rows.length, 3);
    assert.equal('graderEvidence' in (rows[2] ?? {}), false);
    assert.match(r.err, /^REFUSED the re-grade ended at slot clearance-organiser#0 \(slot 3 of 6\): /);
    assert.match(r.err, /No later slot was called, with or without --go-on-and-count/);
    assert.equal(r.out, '');
  }
  // The same after slots that were counted: two unreadable replies are counted, then the lost slot ends it.
  const mixed = await run({ flags: { '--go-on-and-count': SWITCH }, stub: { reply: () => 'prose', throwOn: { call: 3, message: 'boom' } } });
  assert.equal(mixed.code, IMPORT_EXIT.refused);
  assert.equal(mixed.stub.prompts.length, 3);
  // A result with no record is a lost slot too.
  const noRecord = await run({ flags: { '--go-on-and-count': SWITCH }, stub: { resultOn: { call: 2, result: { output: 'x' } } } });
  assert.equal(noRecord.code, IMPORT_EXIT.refused);
  assert.equal(noRecord.stub.prompts.length, 2);
});

test('a configuration the grader refuses ends the re-grade before any call: usage, no file, the key not echoed', async () => {
  const r = await run({ stub: { refuseConfig: `grader: config.effort must be "NOT_SENT" or a level (seen with ${KEY})` } });
  assert.equal(r.code, IMPORT_EXIT.usage);
  assert.match(r.err, /^USAGE: the grader refused its configuration: grader: config\.effort must be/);
  assert.ok(!r.err.includes(KEY));
  assert.equal(r.stub.prompts.length, 0);
  assert.equal(existsSync(r.outPath), false);
});

test('a key that is not set is found before the output file is created: a usage error that names the variable, no grader built, no call, no file', async () => {
  for (const env of [{}, { ANTHROPIC_API_KEY: '' }, { EXAMPLE_JUDGE_KEY: KEY }] as Record<string, string>[]) {
    let opened = 0;
    const r = await run({ env, deps: { openOut: (path) => { opened += 1; return openExclusive(path); } } });
    assert.equal(r.code, IMPORT_EXIT.usage, JSON.stringify(Object.keys(env)));
    assert.match(r.err, /^USAGE: the environment variable ANTHROPIC_API_KEY is not set \(or is empty\); the grader reads the key from it\. Nothing was written and no call was made\.$/);
    assert.equal(r.out, '');
    assert.equal(opened, 0, 'the output file is never opened');
    assert.equal(r.stub.configs.length, 0, 'no grader is built');
    assert.equal(r.stub.prompts.length, 0);
    assert.equal(existsSync(r.outPath), false);
    assert.ok(!r.err.includes(KEY));
  }
  // The variable named by --api-key-env is the one looked for, and the default one does not stand in for it.
  const named = await run({ flags: { '--api-key-env': 'EXAMPLE_JUDGE_KEY' }, env: { ANTHROPIC_API_KEY: KEY } });
  assert.equal(named.code, IMPORT_EXIT.usage);
  assert.match(named.err, /^USAGE: the environment variable EXAMPLE_JUDGE_KEY is not set/);
  assert.ok(!named.err.includes(KEY));
  assert.equal(existsSync(named.outPath), false);
  // Every other refusal still comes first: a flow that does not read is refused with no key asked for.
  const flowFirst = await run({ env: {}, flags: { '--reps': '3' } });
  assert.equal(flowFirst.code, IMPORT_EXIT.refused);
});

// ---- refusals before the first call -----------------------------------------------------------------------------------------

test('a flow the reader refuses is refused before any call, and nothing is written', async () => {
  // Three reps declared where the flow holds two: every case lacks rep 2.
  const r = await run({ flags: { '--reps': '3' } });
  assert.equal(r.code, IMPORT_EXIT.refused);
  assert.match(r.err, /^REFUSED IMPORT_DRAW_COUNT: /);
  assert.match(r.err, /^fields: /m);
  assert.equal(r.out, '');
  assert.equal(r.stub.prompts.length, 0);
  assert.equal(existsSync(r.outPath), false);

  const flow = copyFlow();
  rmSync(join(flow, 'baseline', 'traces', 'bank-dispute_rep1.json'));
  const noTrace = await run({ flags: { '--flow': flow } });
  assert.equal(noTrace.code, IMPORT_EXIT.refused);
  assert.match(noTrace.err, /bank-dispute_rep1\.json: no trace for this row/);
  assert.equal(noTrace.stub.prompts.length, 0);
  assert.equal(existsSync(noTrace.outPath), false);

  const variant = await run({ flags: { '--variant': 'candidate' } });
  assert.equal(variant.code, IMPORT_EXIT.refused);
  assert.equal(variant.stub.prompts.length, 0);
});

test('a flow that is not there, and an input file that cannot be read, are usage errors', async () => {
  const missing: [string, string][] = [
    ['--flow', join(work, 'no-such-flow')],
    ['--cases', join(work, 'no-cases.json')],
    ['--template', join(work, 'no-template.txt')],
    ['--criterion', join(work, 'no-criterion.txt')],
    ['--system', join(work, 'no-system.txt')],
  ];
  for (const [flag, path] of missing) {
    const r = await run({ flags: { [flag]: path } });
    assert.equal(r.code, IMPORT_EXIT.usage, flag);
    assert.equal(r.stub.prompts.length, 0);
    assert.equal(existsSync(r.outPath), false);
  }
});

test('a cases file that does not validate, and a text that is empty or not UTF-8, are invalid input (65)', async () => {
  const cases = await run({ flags: { '--cases': tempFile('cases.json', '{"bank-dispute": {"klass": "refund_safety"}}') } });
  assert.equal(cases.code, IMPORT_EXIT.invalidInput);
  assert.match(cases.err, /^INVALID_INPUT: /);
  // A case id given twice: the plain parser would keep the last and say nothing.
  const twice = await run({ flags: { '--cases': tempFile('cases.json', text(casesPath).replace('{', '{ "bank-dispute": { "klass": "refund_policy", "expect": "fail" },')) } });
  assert.equal(twice.code, IMPORT_EXIT.invalidInput, twice.err);
  assert.match(twice.err, /^INVALID_INPUT: cases: the key "bank-dispute" is given twice in the top-level object$/);
  assert.equal(twice.stub.configs.length, 0);
  assert.equal(existsSync(twice.outPath), false);
  for (const flag of ['--template', '--criterion', '--system']) {
    const empty = await run({ flags: { [flag]: tempFile('empty.txt', '') } });
    assert.equal(empty.code, IMPORT_EXIT.invalidInput, flag);
    assert.match(empty.err, new RegExp(`${flag}: .*empty`), flag);
    counter += 1;
    const latin = join(work, `${counter}-latin.txt`);
    writeFileSync(latin, Buffer.from([0x7b, 0xe9, 0x7d]));
    const notUtf8 = await run({ flags: { [flag]: latin } });
    assert.equal(notUtf8.code, IMPORT_EXIT.invalidInput, flag);
    const marked = await run({ flags: { [flag]: tempFile('bom.txt', '\uFEFF{question} {answer} {criterion}') } });
    assert.equal(marked.code, IMPORT_EXIT.invalidInput, flag);
    for (const r of [empty, notUtf8, marked]) {
      assert.equal(r.stub.prompts.length, 0);
      assert.equal(existsSync(r.outPath), false);
    }
  }
});

test('a template with a doubled brace, another {name} or a missing token is refused before any call', async () => {
  const templates: [string, RegExp][] = [
    ['{{question}} {answer} {criterion}', /doubled brace/],
    ['{question} {answer} {criterion} {notes}', /a brace that is not one of the three plain tokens .* or another name\)/],
    ['{question} {criterion}', /\{answer\} is missing/],
    ['{question} {answer} {criterion} {"pass": true}', /brace/],
  ];
  for (const [template, why] of templates) {
    const r = await run({ flags: { '--template': tempFile('template.txt', template) } });
    assert.equal(r.code, IMPORT_EXIT.refused, template);
    assert.match(r.err, /^REFUSED IMPORT_PACKET: the template is refused before any call/, template);
    assert.match(r.err, why, template);
    assert.match(r.err, /^fields: template$/m);
    assert.equal(r.stub.prompts.length, 0, template);
    assert.equal(r.stub.configs.length, 0, template);
    assert.equal(existsSync(r.outPath), false, template);
  }
});

test('a token inside a stored answer or a criterion is not expanded in the prompt that is sent', async () => {
  const flow = copyFlow();
  // One slot's stored answer holds the three tokens; the row and the trace of the flow are rewritten together.
  const tracePath = join(flow, 'baseline', 'traces', 'bank-dispute_rep0.json');
  const turns = JSON.parse(text(tracePath)) as { role: string; content: string }[];
  const tricky = 'See {criterion}, then {question}, then {answer}.';
  (turns[turns.length - 1] as { content: string }).content = tricky;
  writeFileSync(tracePath, JSON.stringify(turns));
  const criterion = 'The reply never repeats {answer} or {question}.\n';
  const r = await run({ flags: { '--flow': flow, '--criterion': tempFile('criterion.txt', criterion), '--template': tempFile('t.txt', 'Q={question}|A={answer}|C={criterion}') } });
  assert.equal(r.code, 0, r.err);
  const row = linesOf(r.outPath)[1];
  const question = turns[turns.length - 2]?.content ?? '';
  assert.equal(slotOf(row ?? {}), 'bank-dispute#0');
  assert.deepEqual(JSON.parse(row?.['promptSent'] as string), [{ role: 'user', content: `Q=${question}|A=${tricky}|C=${criterion}` }]);
});

// ---- the output file ----------------------------------------------------------------------------------------------------------

test('an existing --out is refused and left untouched, and no call is made', async () => {
  const outPath = tempFile('kept.jsonl', 'an earlier re-grade\n');
  const r = await run({ outPath });
  assert.equal(r.code, IMPORT_EXIT.usage);
  assert.match(r.err, /^USAGE: .*kept\.jsonl exists; a re-grade never overwrites --out/);
  assert.equal(text(outPath), 'an earlier re-grade\n');
  assert.equal(r.stub.prompts.length, 0);
  // An empty file is a file: it is not written over either.
  const empty = tempFile('empty.jsonl', '');
  const again = await run({ outPath: empty });
  assert.equal(again.code, IMPORT_EXIT.usage);
  assert.equal(text(empty), '');
  assert.equal(again.stub.prompts.length, 0);
});

test('the file is created exclusively: a second open of the same path fails, with no look before the open', () => {
  const path = freshOut();
  const first = openExclusive(path);
  first.write('one\n');
  assert.throws(() => openExclusive(path), /USAGE: .* exists; a re-grade never overwrites --out/);
  first.write('two\n');
  first.close();
  assert.equal(text(path), 'one\ntwo\n');
  assert.throws(() => openExclusive(join(work, 'no-such-dir', 'x.jsonl')), /USAGE: cannot create .* \(ENOENT\)/);
});

test('an --out in a folder that does not exist is a usage error, before any call', async () => {
  const r = await run({ outPath: join(work, 'no-such-dir', 'regrade.jsonl') });
  assert.equal(r.code, IMPORT_EXIT.usage);
  assert.equal(r.stub.prompts.length, 0);
});

// ---- a call that fails ------------------------------------------------------------------------------------------------------------

test('a grader that throws on slot 3 leaves the header and three rows, the third with no record; exit 2, no fourth call', async () => {
  const r = await run({ stub: { throwOn: { call: 3, message: `grader: the endpoint answered status 529 (x-api-key: ${KEY})` } } });
  assert.equal(r.code, IMPORT_EXIT.refused);
  assert.equal(r.stub.prompts.length, 3, 'no fourth call');
  const [header, ...rows] = linesOf(r.outPath);
  assert.equal(header?.['schema'], REGRADE_SCHEMA);
  assert.equal(header?.['slotCount'], 6);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(slotOf), ORDER.slice(0, 3));
  assert.ok('graderEvidence' in (rows[0] ?? {}) && 'graderEvidence' in (rows[1] ?? {}));
  const third = rows[2] ?? {};
  assert.equal('graderEvidence' in third, false);
  assert.deepEqual(Object.keys(third), ['caseId', 'draw', 'traceSha256', 'storedOutputSha256', 'storedOutput', 'parts', 'promptSent', 'error']);
  assert.match(third['error'] as string, /^the grader's call failed: grader: the endpoint answered status 529/);
  assert.ok(!(third['error'] as string).includes(KEY));
  assert.equal(third['promptSent'], r.stub.prompts[2]);

  assert.match(r.err, /^REFUSED the re-grade ended at slot clearance-organiser#0 \(slot 3 of 6\): /);
  assert.match(r.err, /^fields: clearance-organiser#0$/m);
  assert.match(r.err, /^slots graded: 2 of 6$/m);
  assert.match(r.err, /is kept .* not importable/);
  assert.ok(!r.err.includes(KEY));
  assert.equal(r.out, '');
  assert.equal(linesOf(r.outPath).some(hasNull), false);

  // The refused file stays, and a second run cannot replace it.
  const before = text(r.outPath);
  const again = await run({ outPath: r.outPath });
  assert.equal(again.code, IMPORT_EXIT.usage);
  assert.equal(again.stub.prompts.length, 0);
  assert.equal(text(r.outPath), before);
});

test('a failure on the first call leaves the header and one row with no record', async () => {
  const r = await run({ stub: { throwOn: { call: 1, message: 'grader: the key variable named in apiKeyEnv is not set' } } });
  assert.equal(r.code, IMPORT_EXIT.refused);
  const rows = linesOf(r.outPath).slice(1);
  assert.equal(rows.length, 1);
  assert.equal('graderEvidence' in (rows[0] ?? {}), false);
  assert.match(r.err, /^slots graded: 0 of 6$/m);
});

test('a result with no record, an error field, or a value JSON cannot hold ends the re-grade as a failed call does', async () => {
  const record = { schema: 'example.grader-evidence/v5', reply: 'x' };
  const results: [unknown, RegExp][] = [
    [{ output: 'x' }, /no record/],
    [{ output: 'x', metadata: {} }, /no record/],
    [{ output: 'x', metadata: { graderEvidence: 'a text' } }, /no record/],
    [{ error: 'the provider failed', metadata: { graderEvidence: record } }, /returned an error/],
    [undefined, /no record/],
    [{ metadata: { graderEvidence: { ...record, servedModel: null } } }, /servedModel.*null/],
    [{ metadata: { graderEvidence: { ...record, callSeq: Number.NaN } } }, /callSeq/],
    [{ metadata: { graderEvidence: { ...record, callShape: { extras: undefined } } } }, /callShape\.extras/],
  ];
  for (const [result, why] of results) {
    const r = await run({ stub: { resultOn: { call: 2, result } } });
    assert.equal(r.code, IMPORT_EXIT.refused, String(why));
    assert.equal(r.stub.prompts.length, 2, String(why));
    const rows = linesOf(r.outPath).slice(1);
    assert.equal(rows.length, 2);
    assert.equal('graderEvidence' in (rows[1] ?? {}), false);
    assert.match(rows[1]?.['error'] as string, why);
    assert.equal(linesOf(r.outPath).some(hasNull), false);
  }
});

// ---- the key ------------------------------------------------------------------------------------------------------------------------

test('the key is never in the file: not on a good run, not in an error text, not through a record that holds it', async () => {
  const good = await run({ flags: { '--system': systemPath } });
  assert.equal(good.code, 0);
  assert.ok(!text(good.outPath).includes(KEY));
  assert.ok(!good.out.includes(KEY));

  const failed = await run({ stub: { throwOn: { call: 2, message: `request failed with header x-api-key ${KEY} and again ${KEY}` } } });
  assert.equal(failed.code, IMPORT_EXIT.refused);
  assert.ok(!text(failed.outPath).includes(KEY));
  assert.ok(!failed.err.includes(KEY));

  // A grader that put the key into its record: the row is written with no record, and the re-grade ends.
  const leaky = await run({ stub: { resultOn: { call: 1, result: { output: 'x', metadata: { graderEvidence: { schema: 'example.grader-evidence/v5', headers: { 'x-api-key': KEY } } } } } } });
  assert.equal(leaky.code, IMPORT_EXIT.refused);
  assert.ok(!text(leaky.outPath).includes(KEY));
  const rows = linesOf(leaky.outPath).slice(1);
  assert.equal(rows.length, 1);
  assert.equal('graderEvidence' in (rows[0] ?? {}), false);
  assert.match(rows[0]?.['error'] as string, /holds the text of the key/);

  // A key under another variable's name, with a text that only looks like a key in the error.
  const named = await run({ flags: { '--api-key-env': 'EXAMPLE_JUDGE_KEY' }, env: { EXAMPLE_JUDGE_KEY: 'a-secret-of-another-form-123' }, stub: { throwOn: { call: 1, message: 'failed: a-secret-of-another-form-123 / sk-ant-zzzzzzzzzzzzzzzz' } } });
  assert.ok(!text(named.outPath).includes('a-secret-of-another-form-123'));
  assert.ok(!text(named.outPath).includes('sk-ant-zzzzzzzzzzzzzzzz'));
});

test('a text in the form of a key after a header name is taken out of an error text, whatever key the environment holds', async () => {
  // None of these is the key of the environment, and none opens with "sk-": only the name before each says what it is.
  const secrets = { 'x-api-key': 'abcdefgh12345678', authorization: 'zyxwvuts87654321', 'api-key': 'qwertyuiop123456', api_key: 'asdfghjkl0987654', apikey: 'mnbvcxzlkj564738' };
  const message = `request failed; headers: x-api-key: ${secrets['x-api-key']}, authorization: Bearer ${secrets.authorization}, api-key=${secrets['api-key']}, "api_key":"${secrets.api_key}", APIKEY ${secrets.apikey}`;
  const r = await run({ stub: { throwOn: { call: 1, message } } });
  assert.equal(r.code, IMPORT_EXIT.refused);
  const error = linesOf(r.outPath)[1]?.['error'] as string;
  for (const [name, secret] of Object.entries(secrets)) {
    assert.ok(!text(r.outPath).includes(secret), `${name}: in the file`);
    assert.ok(!r.err.includes(secret), `${name}: printed`);
  }
  assert.equal(error.split('[key removed]').length - 1, 5, error);
  // What is not a key stays: the words of the error are still there to read.
  assert.match(error, /^the grader's call failed: request failed; headers: x-api-key: \[key removed\], authorization: \[key removed\], /);
});

test('a refused connection names the base URL, the cause code and the likely reason, in the file and on stderr; other errors stay as they were', async () => {
  const refusedConnection = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:18765'), { code: 'ECONNREFUSED' });
  const r = await run({ flags: { '--base-url': 'http://127.0.0.1:18765' }, stub: { throwOn: { call: 1, message: 'fetch failed', cause: refusedConnection } } });
  assert.equal(r.code, IMPORT_EXIT.refused);
  const error = linesOf(r.outPath)[1]?.['error'] as string;
  assert.equal(error, "the grader's call failed: fetch failed (cause ECONNREFUSED) calling http://127.0.0.1:18765; is the endpoint running and listening there?");
  assert.ok(r.err.includes(error));
  // The host stated, here the grader's former default, is the one that was tried, and it is named.
  const dflt = await run({ flags: { '--base-url': 'https://api.anthropic.com' }, stub: { throwOn: { call: 1, message: 'fetch failed', cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) } } });
  assert.equal(linesOf(dflt.outPath)[1]?.['error'], "the grader's call failed: fetch failed (cause ENOTFOUND) calling https://api.anthropic.com; is the endpoint running and listening there?");
  // A cause that carries no code is said to carry none; the call and its address are still named.
  const bare = await run({ flags: { '--base-url': 'http://127.0.0.1:18765' }, stub: { throwOn: { call: 1, message: 'fetch failed', cause: new Error('unknown') } } });
  assert.equal(linesOf(bare.outPath)[1]?.['error'], "the grader's call failed: fetch failed (cause has no code) calling http://127.0.0.1:18765; is the endpoint running and listening there?");
  // A user:password in the base URL is never printed: the scheme, host and port alone are named.
  const withUser = await run({ flags: { '--base-url': 'http://user:pw@127.0.0.1:18765/v1' }, stub: { throwOn: { call: 1, message: 'fetch failed', cause: refusedConnection } } });
  const named = linesOf(withUser.outPath)[1]?.['error'] as string;
  assert.ok(named.includes('calling http://127.0.0.1:18765;') && !named.includes('pw'), named);
  // An error that is not a failed connection is unchanged.
  const other = await run({ stub: { throwOn: { call: 1, message: 'boom' } } });
  assert.equal(linesOf(other.outPath)[1]?.['error'], "the grader's call failed: boom");
});

test('ANTHROPIC_BASE_URL: set with a --base-url that differs from it is refused before any file or call, naming the variable and never its value; set and stated alike, or empty, is not', async () => {
  const gateway = 'https://gateway.invalid/private-path';
  const refusedRun = async (flags: Record<string, string | undefined>, env: Record<string, string | undefined>): Promise<void> => {
    const r = await run({ flags, env });
    assert.equal(r.code, IMPORT_EXIT.usage, r.err);
    assert.match(r.err, /^USAGE: the environment variable ANTHROPIC_BASE_URL is set, and this grader never reads it/);
    assert.ok(!r.err.includes('private-path') && !r.err.includes('gateway.invalid'), 'the value is not printed');
    assert.equal(existsSync(r.outPath), false, 'nothing was written');
    assert.equal(r.stub.prompts.length, 0, 'no call was made');
    assert.equal(r.stub.configs.length, 0, 'the grader was not even built');
  };
  await refusedRun({ '--base-url': 'http://127.0.0.1:18765' }, { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: gateway });
  await refusedRun({ '--base-url': 'https://api.anthropic.com' }, { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: gateway });
  // The same address stated with --base-url: the user chose it for this grader too.
  const same = await run({ flags: { '--base-url': gateway }, env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: gateway } });
  assert.equal(same.code, 0, same.err);
  // An empty variable is not set (as an empty key variable is not set).
  const empty = await run({ env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: '' } });
  assert.equal(empty.code, 0, empty.err);
});

test('an error text is cut at 2000 characters, in the file and in what is printed', async () => {
  const r = await run({ stub: { throwOn: { call: 1, message: `status 500 ${'body '.repeat(2000)}` } } });
  assert.equal(r.code, IMPORT_EXIT.refused);
  const error = linesOf(r.outPath)[1]?.['error'] as string;
  assert.equal(error.length, 2000 + ' [cut]'.length);
  assert.ok(error.endsWith(' [cut]'));
  assert.ok(error.startsWith("the grader's call failed: status 500 body body "));
  assert.ok(r.err.includes(error) && !r.err.includes(`${error.slice(0, 2000)}b`));
  // A text of exactly the limit is not cut.
  const prefix = "the grader's call failed: ";
  const exact = await run({ stub: { throwOn: { call: 1, message: 'e'.repeat(2000 - prefix.length) } } });
  const whole = linesOf(exact.outPath)[1]?.['error'] as string;
  assert.equal(whole.length, 2000);
  assert.ok(!whole.includes('[cut]'));
});

test('the text of an error the script did not foresee is scrubbed too: the key, and a text in the form of one', async () => {
  const r = await run({ deps: { uuid: () => { throw new Error(`no entropy for ${KEY}; authorization: Bearer abcdefgh12345678`); } } });
  assert.equal(r.code, IMPORT_EXIT_INTERNAL);
  assert.equal(r.err, 'internal error: no entropy for [key removed]; authorization: [key removed]');
  assert.equal(existsSync(r.outPath), false);
  // A key of another form, known only from the environment.
  const named = await run({ flags: { '--api-key-env': 'EXAMPLE_JUDGE_KEY' }, env: { EXAMPLE_JUDGE_KEY: 'a-secret-of-another-form-123' }, deps: { now: () => { throw new Error('clock failed near a-secret-of-another-form-123'); } } });
  assert.equal(named.code, IMPORT_EXIT_INTERNAL);
  assert.equal(named.err, 'internal error: clock failed near [key removed]');
});

test('an input that holds the text of the key is refused before any call, and nothing is written', async () => {
  const r = await run({ flags: { '--criterion': tempFile('criterion.txt', `The reply never shows ${KEY}.\n`) } });
  assert.equal(r.code, IMPORT_EXIT.usage);
  assert.match(r.err, /holds the text of the key/);
  assert.ok(!r.err.includes(KEY));
  assert.equal(r.stub.prompts.length, 0);
  assert.equal(existsSync(r.outPath), false);
});

// ---- what is printed about thinking ----------------------------------------------------------------------------------------------------

test('the count of replies that thought is read from the records, a redacted block included', async () => {
  const r = await run({ stub: { contentTypes: (call) => (call === 2 ? ['thinking', 'text'] : call === 5 ? ['redacted_thinking', 'text'] : ['text']) } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^replies with reasoning: 2 of 6$/m);
});

test('records that hold no contentTypes are not counted as replies that did not think (a record the importer refuses is counted with --go-on-and-count)', async () => {
  const r = await run({ flags: { '--go-on-and-count': SWITCH }, stub: { contentTypes: (call) => (call === 4 ? undefined : ['thinking', 'text']) } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^replies with reasoning: not stated \(1 of 6 record\(s\) hold no contentTypes list\)$/m);
  assert.match(r.out, /^slots the importer will refuse: 1 \(the importer will refuse this file: clearance-organiser#1\); every reply of a finished, well-formed record was read under the reading rule one-json-object-boolean-pass\/v1$/m);
});

// ---- the script's own files --------------------------------------------------------------------------------------------------------------

/** The local files a source file names in an import, an export-from, a `require(...)` or a `createRequire(...)(...)`. */
function importsOf(path: string): string[] {
  const source = text(path);
  const found = new Set<string>();
  const patterns = [/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g, /\bimport\s+['"](\.{1,2}\/[^'"]+)['"]/g, /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]/g, /\brequire\(\s*['"](\.{1,2}\/[^'"]+)['"]/g, /\)\(\s*['"](\.{1,2}\/[^'"]+)['"]/g];
  for (const re of patterns) for (const m of source.matchAll(re)) found.add(join(dirname(path), m[1] as string));
  return [...found];
}

test('scriptFiles is the import closure of regrade.ts under examples/importers, with the sha256 of each file', async () => {
  const importers = join(root, 'examples', 'importers');
  const start = join(dir, 'regrade.ts');
  const closure = new Set<string>([start]);
  const queue = [start];
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    for (const next of importsOf(at)) {
      if (relative(importers, next).startsWith('..') || closure.has(next)) continue;
      closure.add(next);
      queue.push(next);
    }
  }
  const expected = [...closure].map((p) => relative(root, p).split('\\').join('/')).sort();
  // The grader file is reached through the default factory, and is part of the closure.
  assert.ok(expected.includes('examples/importers/promptfoo/grader-provider.cjs'));
  assert.ok(expected.includes('examples/importers/skill-evals/regrade.ts'));

  const r = await run();
  assert.equal(r.code, 0, r.err);
  const scriptFiles = linesOf(r.outPath)[0]?.['scriptFiles'] as { path: string; sha256: string }[];
  assert.deepEqual(scriptFiles.map((f) => f.path), expected);
  for (const f of scriptFiles) assert.equal(f.sha256, sha256Hex(readFileSync(join(root, f.path))), f.path);
  // The constant the importer compares a header's list with is this same closure, with the script and the grader in it.
  assert.deepEqual([...SCRIPT_FILES], expected);
  assert.ok(expected.includes(SCRIPT) && expected.includes(GRADER_FILE));
  assert.equal(linesOf(r.outPath)[0]?.['script'], SCRIPT);
});

test('the default grader is the promptfoo path\'s grader file: a class with callApi, loaded without a call', () => {
  const Grader = loadGraderClass();
  assert.equal(typeof Grader, 'function');
  assert.equal(typeof (Grader as { prototype: { callApi?: unknown } }).prototype.callApi, 'function');
});

// ---- the command ------------------------------------------------------------------------------------------------------------------------------

test('the command itself runs from a shell and stops at its flags, with no key in the environment', () => {
  const none = spawnSync(process.execPath, [join(dir, 'regrade.ts')], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } });
  assert.equal(none.status, IMPORT_EXIT.usage, none.stderr);
  assert.equal(none.stdout, '');
  assert.match(none.stderr, /^USAGE: --wire is required and must be one of anthropic-messages\/v1, openai-responses\/v1\. usage: /);
  // A flow that is refused: exit 2 before the grader is built, so no key is asked for and no call is made.
  const outPath = freshOut();
  const refused = spawnSync(process.execPath, [join(dir, 'regrade.ts'), ...argvOf({ ...baseFlags(outPath), '--reps': '3' })], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } });
  assert.equal(refused.status, IMPORT_EXIT.refused, refused.stderr);
  assert.match(refused.stderr, /^REFUSED IMPORT_DRAW_COUNT: /);
  assert.equal(existsSync(outPath), false);
  // A flow that reads, good flags and no key: the real script with the real grader stops before it creates the file.
  const keyless = freshOut();
  const noKey = spawnSync(process.execPath, [join(dir, 'regrade.ts'), ...argvOf(baseFlags(keyless))], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } });
  assert.equal(noKey.status, IMPORT_EXIT.usage, noKey.stderr);
  assert.match(noKey.stderr, /^USAGE: the environment variable ANTHROPIC_API_KEY is not set/);
  assert.equal(noKey.stdout, '');
  assert.equal(existsSync(keyless), false);
});

test('an error the script did not foresee exits 70, never 1', async () => {
  const r = await run({ deps: { uuid: () => { throw new Error('no entropy'); } } });
  assert.equal(r.code, IMPORT_EXIT_INTERNAL);
  assert.match(r.err, /^internal error: no entropy$/);
  assert.equal(r.stub.prompts.length, 0);
});

// ---- one source rep, graded several times -----------------------------------------------------------------------------------------

test('--rep k --draws n: the stored output of rep k of each case is graded n times; the header states both, and the rows of a case are equal but for the draw and the record', async () => {
  const r = await run({ flags: { '--rep': '1', '--draws': '3', '--system': systemPath } });
  assert.equal(r.code, 0, r.err);
  const [header, ...rows] = linesOf(r.outPath);
  assert.ok(header !== undefined);
  assert.equal(header['reps'], 2, "the flow's declared rep count");
  assert.equal(header['sourceRep'], 1);
  assert.equal(header['draws'], 3);
  // Three cases, each graded three times: 3 x 3 = 9 rows and 9 calls, in the order case id then draw.
  assert.equal(header['slotCount'], 9);
  assert.equal(r.stub.prompts.length, 9);
  assert.deepEqual(rows.map(slotOf), ['bank-dispute', 'clearance-organiser', 'faulty-headphones'].flatMap((id) => [0, 1, 2].map((d) => `${id}#${d}`)));
  // The example flow's _state.json holds 64 zeros as its harness_sha.
  assert.equal(header['harnessSha'], '0'.repeat(64));
  for (const row of rows) {
    // Every row of a case is rep 1's trace and stored output, whatever its draw.
    const source = turnOf(row['caseId'] as string, 1);
    assert.equal(row['traceSha256'], source.traceSha256);
    assert.equal(row['storedOutput'], source.turn);
    assert.notEqual(row['storedOutput'], turnOf(row['caseId'] as string, 0).turn, 'the two reps of the example flow differ');
    const first = rows.find((x) => x['caseId'] === row['caseId']) as Obj;
    for (const k of ['traceSha256', 'storedOutputSha256', 'storedOutput', 'promptSent']) assert.equal(row[k], first[k], k);
    assert.deepEqual(row['parts'], first['parts']);
  }
  // Each draw is a separate call on the same prompt.
  assert.deepEqual(r.stub.prompts, rows.map((row) => row['promptSent']));
  assert.equal(new Set(r.stub.prompts).size, 3);
  assert.equal(new Set(rows.map((row) => (row['graderEvidence'] as Obj)['callSeq'])).size, 9);
  assert.match(r.out, /^slots graded: 9 of 9, 9 asks made \(0 re-asks; at most 0 per slot\), in the order case id then draw \(source rep 1, each stored output graded 3 times\)$/m);
});

test('--draws 1 grades each stored output once', async () => {
  const r = await run({ flags: { '--draws': '1' } });
  assert.equal(r.code, 0, r.err);
  const [header, ...rows] = linesOf(r.outPath);
  assert.equal(header?.['slotCount'], 3);
  assert.deepEqual(rows.map(slotOf), ['bank-dispute#0', 'clearance-organiser#0', 'faulty-headphones#0']);
  assert.match(r.out, /graded 1 time\)$/m);
});

test('--rep and --draws are required and have no default; --rep at or above --reps, a --rep that is not a count from 0, and --draws 0 are usage errors before any call', async () => {
  const bad: [Record<string, string | undefined>, RegExp][] = [
    [{ '--rep': undefined }, /missing --rep\./],
    [{ '--draws': undefined }, /missing --draws\./],
    [{ '--rep': '2' }, /--rep 2 is not one of the 2 declared rep\(s\) of the flow \(--reps 2: reps are 0 to 1\)/],
    [{ '--rep': '7' }, /--rep 7 is not one of the 2 declared rep/],
    [{ '--rep': '-1' }, /--rep must be a non-negative integer, found "-1"/],
    [{ '--rep': '1.0' }, /--rep must be a non-negative integer/],
    [{ '--rep': '01' }, /--rep must be a non-negative integer/],
    [{ '--rep': 'first' }, /--rep must be a non-negative integer/],
    [{ '--draws': '0' }, /--draws must be a positive integer, found "0"/],
    [{ '--draws': '2.5' }, /--draws must be a positive integer/],
    [{ '--draws': 'three' }, /--draws must be a positive integer/],
  ];
  for (const [flags, words] of bad) {
    const r = await run({ flags });
    assert.equal(r.code, IMPORT_EXIT.usage, JSON.stringify(flags));
    assert.match(r.err, words);
    assert.equal(r.stub.prompts.length, 0);
    assert.equal(existsSync(r.outPath), false);
  }
});

/** Edits the rows of a copied flow's results.jsonl in place. */
function editRows(flow: string, edit: (rows: Obj[]) => Obj[] | void): void {
  const path = join(flow, 'baseline', 'results.jsonl');
  const rows = readFileSync(path, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Obj);
  writeFileSync(path, `${(edit(rows) ?? rows).map((r) => JSON.stringify(r)).join('\n')}\n`);
}
const rowAt = (rows: Obj[], id: string, k: number): Obj => {
  const r = rows.find((x) => x['prompt_id'] === id && x['rep'] === k);
  assert.ok(r, `no row ${id}#${k}`);
  return r;
};

test('only the graded rep must be whole: a slot of ANOTHER rep that is cut, unfinished, missing or unselectable does not refuse the re-grade; the same slot in the graded rep does, before any call', async () => {
  const faults: [string, (flow: string) => void, string | undefined, RegExp][] = [
    ['cut at the output cap', (flow) => editRows(flow, (rows) => { rowAt(rows, 'faulty-headphones', 1)['stop_reason'] = 'max_tokens'; }), undefined, /^REFUSED IMPORT_OUTPUT_UNFINISHED: 1 problem\(s\) in rep 1 of the flow, which is not whole /],
    ['a status that is not ok', (flow) => editRows(flow, (rows) => { rowAt(rows, 'faulty-headphones', 1)['status'] = 'error'; }), undefined, /^REFUSED IMPORT_OUTPUT_UNFINISHED: /],
    ['no row', (flow) => editRows(flow, (rows) => rows.filter((r) => !(r['prompt_id'] === 'faulty-headphones' && r['rep'] === 1))), undefined, /^REFUSED IMPORT_DRAW_COUNT: 1 problem\(s\) in rep 1 of the flow, which is not whole /],
    [
      'a turn the selector cannot be applied to',
      (flow) => {
        const tracePath = join(flow, 'baseline', 'traces', 'faulty-headphones_rep1.json');
        const turns = JSON.parse(readFileSync(tracePath, 'utf8')) as { content: string }[];
        (turns[2] as { content: string }).content = 'A member of our team will contact you.';
        writeFileSync(tracePath, JSON.stringify(turns));
      },
      '/reply',
      /^REFUSED IMPORT_PACKET: selector "\/reply" cannot be applied to 1 of 3 slot\(s\): faulty-headphones#1: /,
    ],
  ];
  for (const [what, fault, select, refusal] of faults) {
    const flow = copyFlow();
    fault(flow);
    // Rep 0 is whole: it is graded, with every case and every draw.
    const ok = await run({ flags: { '--flow': flow, '--rep': '0', '--select': select } });
    assert.equal(ok.code, 0, `${what}: ${ok.err}`);
    const [header, ...rows] = linesOf(ok.outPath);
    assert.equal(header?.['sourceRep'], 0, what);
    assert.equal(header?.['slotCount'], 6, what);
    assert.deepEqual(rows.map(slotOf), ORDER, what);
    assert.equal(ok.stub.prompts.length, 6, what);
    // What is said of the other rep rests on the reader alone: the selector is applied to the graded rep only.
    if (select === undefined) assert.match(ok.out, /^reps of the flow that are whole: 1 of 2 \(0\); only rep 0 was required to be/m, what);
    // Rep 1 holds the fault: grading it refuses, with no grader built, no call and no file.
    const refused = await run({ flags: { '--flow': flow, '--rep': '1', '--select': select } });
    assert.equal(refused.code, IMPORT_EXIT.refused, what);
    assert.match(refused.err, refusal, what);
    assert.match(refused.err, /^fields: faulty-headphones#1$/m, what);
    assert.equal(refused.out, '', what);
    assert.equal(refused.stub.configs.length, 0, what);
    assert.equal(refused.stub.prompts.length, 0, what);
    assert.equal(existsSync(refused.outPath), false, what);
  }
});

test('what refuses a flow in any rep still refuses the re-grade of another: a finished row with no trace, a row outside the profile, a trace with a tool turn', async () => {
  const faults: [string, (flow: string) => void][] = [
    ['no trace', (flow) => rmSync(join(flow, 'baseline', 'traces', 'faulty-headphones_rep1.json'))],
    ['a row with no prompt', (flow) => editRows(flow, (rows) => { delete rowAt(rows, 'faulty-headphones', 1)['prompt']; })],
    [
      'a tool turn',
      (flow) => {
        const tracePath = join(flow, 'baseline', 'traces', 'faulty-headphones_rep1.json');
        const turns = JSON.parse(readFileSync(tracePath, 'utf8')) as Obj[];
        (turns[2] as Obj)['role'] = 'tool';
        writeFileSync(tracePath, JSON.stringify(turns));
      },
    ],
  ];
  for (const [what, fault] of faults) {
    const flow = copyFlow();
    fault(flow);
    // The re-grade asks for rep 0 only; the fault is in rep 1.
    const r = await run({ flags: { '--flow': flow, '--rep': '0' } });
    assert.equal(r.code, IMPORT_EXIT.refused, what);
    assert.match(r.err, /problem\(s\) in the flow \(row profile/, what);
    assert.match(r.err, /^fields: faulty-headphones#1$/m, what);
    assert.equal(r.stub.prompts.length, 0, what);
    assert.equal(existsSync(r.outPath), false, what);
  }
});

test('the cases file is the declaration: a case of the flow that it leaves out is not graded, and its id is written into the header, sorted, with the count', async () => {
  const flow = copyFlow();
  // Two more cases in the flow that the cases file does not name: one with rows only, one with an error line only.
  editRows(flow, (rows) => [{ ...rowAt(rows, 'bank-dispute', 0), prompt_id: 'zebra-rug', stop_reason: 'max_tokens' }, ...rows]);
  writeFileSync(join(flow, 'baseline', 'errors.jsonl'), `${readFileSync(join(flow, 'baseline', 'errors.jsonl'), 'utf8')}${JSON.stringify({ prompt_id: 'alpaca-scarf', rep: 0, error: 'example: timed out' })}\n`);
  // And one case of the example is left out of the cases file.
  const stated = JSON.parse(text(casesPath)) as Obj;
  delete stated['clearance-organiser'];
  const r = await run({ flags: { '--flow': flow, '--cases': tempFile('cases.json', JSON.stringify(stated)) } });
  assert.equal(r.code, 0, r.err);
  const [header, ...rows] = linesOf(r.outPath);
  assert.deepEqual(header?.['excludedCaseIds'], ['alpaca-scarf', 'clearance-organiser', 'zebra-rug']);
  assert.equal(header?.['excludedCaseCount'], 3);
  // Two cases are measured, two draws each; no row and no call for an excluded case.
  assert.equal(header?.['slotCount'], 4);
  assert.deepEqual(rows.map(slotOf), ['bank-dispute#0', 'bank-dispute#1', 'faulty-headphones#0', 'faulty-headphones#1']);
  assert.equal(r.stub.prompts.length, 4);
  const left = turnOf('clearance-organiser', 0);
  assert.ok(left.question.length > 20);
  assert.equal(r.stub.prompts.some((p) => (JSON.parse(p) as { content: string }[]).some((m) => m.content.includes(left.question))), false, 'the question of an excluded case is never sent');
  assert.match(r.out, /^excluded cases \(in the flow, not in the cases file; not graded\): 3 \(alpaca-scarf, clearance-organiser, zebra-rug\)$/m);
  assert.equal(hasNull(header), false);

  // A case that IS in the cases file and has no finished row in the graded rep still refuses, whatever is excluded.
  editRows(flow, (rows) => { rowAt(rows, 'bank-dispute', 0)['stop_reason'] = 'max_tokens'; });
  const refused = await run({ flags: { '--flow': flow, '--cases': tempFile('cases.json', JSON.stringify(stated)) } });
  assert.equal(refused.code, IMPORT_EXIT.refused);
  assert.match(refused.err, /^REFUSED IMPORT_OUTPUT_UNFINISHED: /);
  assert.match(refused.err, /^fields: bank-dispute#0$/m);
  assert.equal(existsSync(refused.outPath), false);
  // And a case of the cases file with no row at all refuses the flow.
  stated['damaged-lamp'] = { klass: 'refund_policy', expect: 'pass' };
  const noRow = await run({ flags: { '--flow': copyFlow(), '--cases': tempFile('cases.json', JSON.stringify(stated)) } });
  assert.equal(noRow.code, IMPORT_EXIT.refused);
  assert.match(noRow.err, /^REFUSED IMPORT_CASE_MISSING: /);
  assert.match(noRow.err, /^fields: damaged-lamp$/m);
  assert.equal(noRow.stub.prompts.length, 0);
  assert.equal(existsSync(noRow.outPath), false);
});

test('a flow with no _state.json is re-graded: the header holds the gap marker for its sha256 and for harness_sha, never a null or an empty text; a malformed one refuses', async () => {
  const flow = copyFlow();
  rmSync(join(flow, '_state.json'));
  const r = await run({ flags: { '--flow': flow } });
  assert.equal(r.code, 0, r.err);
  const [header, ...rows] = linesOf(r.outPath);
  assert.equal(header?.['stateSha256'], 'UNKNOWN');
  assert.equal(header?.['harnessSha'], 'UNKNOWN');
  assert.equal(hasNull(header), false);
  assert.equal(rows.length, 6);
  // Nothing else of the header moves.
  const base = linesOf((await run()).outPath)[0] as Obj;
  for (const k of Object.keys(base)) if (!['stateSha256', 'harnessSha', 'flow'].includes(k)) assert.deepEqual(header?.[k], base[k], k);
  assert.notEqual(base['stateSha256'], 'UNKNOWN');

  for (const bad of ['[]', '{"reps": 2', '']) {
    writeFileSync(join(flow, '_state.json'), bad);
    const refused = await run({ flags: { '--flow': flow } });
    assert.equal(refused.code, IMPORT_EXIT.refused, bad);
    assert.match(refused.err, /^fields: _state\.json$/m, bad);
    assert.equal(refused.stub.prompts.length, 0, bad);
    assert.equal(existsSync(refused.outPath), false, bad);
  }
});

test('a grader that throws in the middle of a case\'s draws leaves the earlier rows and ends the re-grade', async () => {
  // Three draws per case: call 5 is the second draw of the second case.
  const r = await run({ flags: { '--draws': '3' }, stub: { throwOn: { call: 5, message: 'grader: the endpoint answered status 529' } } });
  assert.equal(r.code, IMPORT_EXIT.refused);
  assert.equal(r.stub.prompts.length, 5, 'no sixth call');
  const [header, ...rows] = linesOf(r.outPath);
  assert.equal(header?.['slotCount'], 9);
  assert.deepEqual(rows.map(slotOf), ['bank-dispute#0', 'bank-dispute#1', 'bank-dispute#2', 'clearance-organiser#0', 'clearance-organiser#1']);
  assert.ok(rows.slice(0, 4).every((row) => 'graderEvidence' in row && !('error' in row)));
  assert.equal('graderEvidence' in (rows[4] ?? {}), false);
  assert.match((rows[4] ?? {})['error'] as string, /status 529/);
  assert.match(r.err, /^REFUSED the re-grade ended at slot clearance-organiser#1 \(slot 5 of 9\): /);
  assert.match(r.err, /^slots graded: 4 of 9$/m);
});

// ---- the bound of re-asks ------------------------------------------------------------------------------------------------

test('--max-reasks is required; 4, -1 and x are usage errors', async () => {
  const missing = await run({ flags: { '--max-reasks': undefined } });
  assert.equal(missing.code, IMPORT_EXIT.usage);
  assert.match(missing.err, /^USAGE: missing --max-reasks\. usage: /);
  assert.equal(existsSync(missing.outPath), false);
  for (const bad of ['4', '-1', 'x', '1.5', '01', '10', ' 1', '+1', '0x1', '٣']) {
    const r = await run({ flags: { '--max-reasks': bad } });
    assert.equal(r.code, IMPORT_EXIT.usage, bad);
    assert.ok(r.err.startsWith(`USAGE: --max-reasks must be an integer from 0 to 3 (the re-asks one slot may be given; 0 asks every slot once), found ${JSON.stringify(bad)}. usage: `), bad);
    assert.equal(r.stub.configs.length, 0, bad);
    assert.equal(r.stub.prompts.length, 0, bad);
    assert.equal(existsSync(r.outPath), false, bad);
  }
  for (const good of ['0', '1', '2', '3']) {
    const r = await run({ flags: { '--max-reasks': good } });
    assert.equal(r.code, 0, good);
    assert.equal(r.stub.configs[0]?.maxReasks, Number(good));
    // The header holds the bound, as a number, in the configuration the grader was handed.
    assert.equal((linesOf(r.outPath)[0]?.['graderConfig'] as Obj)['maxReasks'], Number(good));
  }
  assert.match(USAGE, /--max-reasks <0 to 3>/);
});

test('the printed line gives the asks made: the slots, and the re-asks their records hold', async () => {
  // Six slots; the record of call 2 holds one earlier ask and that of call 5 two.
  const r = await run({ flags: { '--max-reasks': '2' }, stub: { earlier: (call) => (call === 2 ? 1 : call === 5 ? 2 : 0) } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^slots graded: 6 of 6, 9 asks made \(3 re-asks; at most 2 per slot\), in the order case id then draw \(source rep 0, each stored output graded 2 times\)$/m);
  const one = await run({ flags: { '--max-reasks': '1', '--draws': '1' }, stub: { earlier: (call) => (call === 1 ? 1 : 0) } });
  assert.match(one.out, /^slots graded: 3 of 3, 4 asks made \(1 re-ask; at most 1 per slot\), /m);
  // A record that holds no list of earlier asks is not counted as a slot asked once.
  const none = await run({ flags: { '--go-on-and-count': SWITCH }, stub: { resultOn: { call: 1, result: { output: 'x', metadata: { graderEvidence: { schema: 'other' } } } } } });
  assert.equal(none.code, 0);
  assert.match(none.out, /^slots graded: 6 of 6, asks made: not stated \(a record holds no list of earlier asks\), /m);
  // That record states no stop either: it is not counted as a finished reply.
  assert.match(none.out, /^slots with no finished reply: 1 \(the importer will refuse this file\)$/m);
});

test('the re-grade says how many slots hold no finished reply, with a zero too; it stops at the first one, or with --go-on-and-count counts them and exits 0: the importer is what refuses such a file', async () => {
  const good = await run({});
  assert.equal(good.code, 0);
  assert.match(good.out, /^slots with no finished reply: 0$/m);
  assert.match(good.out, /^slots the importer will refuse: 0; every reply of a finished, well-formed record was read under the reading rule one-json-object-boolean-pass\/v1$/m);
  assert.doesNotMatch(good.out, /the importer will refuse this file/);
  // The line stands right after the count of slots graded.
  const lines = good.out.split('\n');
  assert.equal(lines.findIndex((l) => l.startsWith('slots with no finished reply: ')), lines.findIndex((l) => l.startsWith('slots graded: ')) + 1);
  // A record whose last ask was cut, or stopped in any other way but "end_turn", is a slot with no finished reply.
  const stopOf = (stop: unknown) => ({ output: 'x', metadata: { graderEvidence: { schema: 'example.grader-evidence/v8', wire: 'anthropic-messages/v1', stopReason: stop, contentTypes: ['text'], reask: { max: 0, earlier: [] } } } });
  for (const stop of ['max_tokens', 'refusal', 'stop_sequence', 'tool_use', 'END_TURN', 'end_turn ', '', 7]) {
    const r = await run({ flags: { '--go-on-and-count': SWITCH }, stub: { resultOn: { call: 3, result: stopOf(stop) } } });
    assert.equal(r.code, 0, String(stop));
    assert.match(r.out, /^slots graded: 6 of 6, /m, String(stop));
    assert.match(r.out, /^slots with no finished reply: 1 \(the importer will refuse this file\)$/m, String(stop));
    assert.match(r.out, /^slots the importer will refuse: 1 \(the importer will refuse this file: clearance-organiser#0\); every reply of a finished, well-formed record was read under the reading rule one-json-object-boolean-pass\/v1$/m, String(stop));
  }
  const finished = await run({ stub: { resultOn: { call: 3, result: stopOf('end_turn') } } });
  assert.equal(finished.code, IMPORT_EXIT.refused, 'a record of the wrong form is a slot the importer will refuse, even when it states a finished reply');
});

test('the re-grade stops at the first slot the importer will refuse: the row is kept with its record, no later slot is called, and the exit is 2', async () => {
  // Call 3 stops with "max_tokens" and no earlier ask: the judge was cut at the output cap.
  const r = await run({ stub: { stopReason: (call) => (call === 3 ? 'max_tokens' : 'end_turn') } });
  assert.equal(r.code, IMPORT_EXIT.refused, r.err);
  assert.equal(r.stub.prompts.length, 3, 'no call after the slot the importer will refuse');
  const rows = linesOf(r.outPath).slice(1);
  assert.equal(rows.length, 3);
  assert.equal('graderEvidence' in (rows[2] ?? {}), true, 'the row keeps the grader\'s record');
  assert.equal((rows[2]?.['graderEvidence'] as Obj)['stopReason'], 'max_tokens');
  assert.match(r.err, /^REFUSED the re-grade stopped at slot clearance-organiser#0 \(slot 3 of 6\): the importer will refuse it: the judge stopped with "max_tokens", not "end_turn"$/m);
  assert.match(r.err, /^fields: clearance-organiser#0$/m);
  assert.match(r.err, /^slots graded: 3 of 6$/m);
  assert.match(r.err, / is kept \(the header and 3 row\(s\), the last holding the record the importer will refuse\)/);
  assert.match(r.err, /--go-on-and-count goes on instead/);
  assert.equal(r.out, '', 'nothing is reported as written');
  // the same on the real shape of a cut reply: a bound used up on cut asks
  // a record of the wrong form (a model id that is not one printable line) is refused at its slot too, with the importer's own words
  const formWrong = await run({ stub: { resultOn: { call: 2, result: { output: 'x', metadata: { graderEvidence: { schema: 'example.grader-evidence/v8', wire: 'anthropic-messages/v1' } } } } } });
  assert.equal(formWrong.code, IMPORT_EXIT.refused);
  assert.equal(formWrong.stub.prompts.length, 2);
  assert.match(formWrong.err, /^REFUSED the re-grade stopped at slot bank-dispute#1 \(slot 2 of 6\): the importer will refuse it: IMPORT_EVIDENCE: graderEvidence\.grader: missing/m);
  // the key is not in what is printed or kept
  assert.ok(!r.err.includes(KEY) && !text(r.outPath).includes(KEY));
});

test('with --go-on-and-count every slot is called, the slots the importer will refuse are counted by label, and the exit is 0', async () => {
  const r = await run({ flags: { '--go-on-and-count': SWITCH }, stub: { stopReason: (call) => (call === 3 || call === 5 ? 'max_tokens' : 'end_turn') } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.stub.prompts.length, 6);
  assert.match(r.out, /^slots graded: 6 of 6, /m);
  assert.match(r.out, /^slots with no finished reply: 2 \(the importer will refuse this file\)$/m);
  assert.match(r.out, /^slots the importer will refuse: 2 \(the importer will refuse this file: clearance-organiser#0, faulty-headphones#0\); every reply of a finished, well-formed record was read under the reading rule one-json-object-boolean-pass\/v1$/m);
  // the labels are named up to 20; the rest are counted
  const many = await run({ flags: { '--go-on-and-count': SWITCH, '--draws': '8' }, stub: { stopReason: () => 'max_tokens' } });
  assert.equal(many.code, 0, many.err);
  assert.match(many.out, /^slots the importer will refuse: 24 \(the importer will refuse this file: bank-dispute#0, [^)]*, and 4 more\); every reply of a finished, well-formed record was read under the reading rule one-json-object-boolean-pass\/v1$/m);
  // the switch takes no value, and is refused when given twice or with a value
  assert.equal((await run({ flags: { '--go-on-and-count': 'yes' } })).code, IMPORT_EXIT.usage);
});

test('--reps and --draws are at most 100000, and so is the number of slots: a larger number is a usage error at once, with no file, no grader and no call', async () => {
  const beyond: [Record<string, string>, RegExp][] = [
    [{ '--draws': '4294967296' }, /^USAGE: --draws must be at most 100000, found 4294967296\. usage: /],
    [{ '--draws': '100001' }, /^USAGE: --draws must be at most 100000, found 100001\. usage: /],
    [{ '--draws': '9007199254740991' }, /^USAGE: --draws must be at most 100000, found 9007199254740991\. /],
    [{ '--reps': '4294967296' }, /^USAGE: --reps must be at most 100000, found 4294967296\. usage: /],
    [{ '--reps': '100001' }, /^USAGE: --reps must be at most 100000, found 100001\. usage: /],
    // Each flag within the bound, and their slots beyond it: three cases x 100000 draws.
    [{ '--draws': '100000' }, /^USAGE: 3 case\(s\) x --draws 100000 is 300000 slots, more than the 100000 a re-grade takes\. usage: /],
    [{ '--draws': '33334' }, /^USAGE: 3 case\(s\) x --draws 33334 is 100002 slots, more than the 100000 a re-grade takes\. /],
    // Each flag within the bound, and the slots of the flow the reader looks for beyond it: three cases x --reps.
    [{ '--reps': '100000' }, /^USAGE: 3 case\(s\) of the cases file x 100000 declared rep\(s\) is 300000 slots of the flow, more than the 100000 this path takes$/],
    [{ '--reps': '33334' }, /^USAGE: 3 case\(s\) of the cases file x 33334 declared rep\(s\) is 100002 slots of the flow, more than the 100000 this path takes$/],
  ];
  for (const [flags, words] of beyond) {
    const started = Date.now();
    const r = await run({ flags });
    assert.equal(r.code, IMPORT_EXIT.usage, JSON.stringify(flags));
    assert.match(r.err, words, JSON.stringify(flags));
    assert.ok(Date.now() - started < 5000, JSON.stringify(flags));
    assert.equal(r.stub.configs.length, 0, JSON.stringify(flags));
    assert.equal(r.stub.prompts.length, 0, JSON.stringify(flags));
    assert.equal(existsSync(r.outPath), false, JSON.stringify(flags));
  }
  // The largest declared rep count the three cases take is read, and the flow's own count then refuses it, at once.
  const started = Date.now();
  const most = await run({ flags: { '--reps': '33333' } });
  assert.equal(most.code, IMPORT_EXIT.refused);
  assert.match(most.err, /_state\.json: reps is 2, the declared count is 33333/);
  assert.ok(Date.now() - started < 5000);
});

test('--thinking with a null, at any depth, is a usage error in the words of the one walk for such values', async () => {
  for (const [value, words] of [['{"type":null}', /; --thinking\.type: null is not allowed\. usage: /], ['{"type":"enabled","budget_tokens":1e999}', /; \$\.budget_tokens: a number that is not finite /], ['{"a":[1,{"b":null}]}', /; --thinking\.a\[1\]\.b: null is not allowed\. /]] as const) {
    const r = await run({ flags: { '--thinking': value } });
    assert.equal(r.code, IMPORT_EXIT.usage, value);
    assert.match(r.err, words, value);
    assert.equal(r.stub.configs.length, 0, value);
  }
});

/** The real script and the real grader, in this process, against a fake endpoint of this process. */
async function live(endpoint: FakeEndpointOptions, flags: Record<string, string>): Promise<{ code: number; out: string; err: string; outPath: string; requests: Obj[] }> {
  const logPath = freshOut();
  const ep = await startFakeEndpoint({ port: 0, logPath, ...endpoint });
  const outPath = freshOut();
  const out: string[] = [];
  const err: string[] = [];
  const saved = process.env['ANCHORSET_TEST_REASK_KEY'];
  process.env['ANCHORSET_TEST_REASK_KEY'] = KEY;
  try {
    // A fresh copy of the grader's module, so its call numbers start at 1 as in a process of its own.
    const graderPath = join(root, GRADER_FILE);
    const requireGrader = createRequire(import.meta.url);
    delete requireGrader.cache[graderPath];
    const Grader = requireGrader(graderPath) as ReturnType<typeof loadGraderClass>;
    const code = await runRegrade(
      argvOf({ ...baseFlags(outPath), '--draws': '3', '--model': 'fake-judge-old', '--temperature': '0', '--base-url': `http://127.0.0.1:${ep.port}`, '--api-key-env': 'ANCHORSET_TEST_REASK_KEY', ...flags }),
      { graderFactory: (config) => new Grader({ config }), uuid: () => RUN_ID, now: () => new Date(STARTED), openOut: openExclusive, env: { ANCHORSET_TEST_REASK_KEY: KEY }, io: { out: (s) => out.push(s), err: (s) => err.push(s) } },
    );
    return { code, out: out.join('\n'), err: err.join('\n'), outPath, requests: readFileSync(logPath, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Obj) };
  } finally {
    await ep.close();
    if (saved === undefined) delete process.env['ANCHORSET_TEST_REASK_KEY'];
    else process.env['ANCHORSET_TEST_REASK_KEY'] = saved;
  }
}
const markedCriterion = (marker: string): string => tempFile('criterion.txt', `${readFileSync(criterionPath, 'utf8').trimEnd()} ${marker}\n`);
const bar = join(dir, 'bar.json');
function importOf(regradePath: string): { code: number; out: string; err: string; runPath: string } {
  const runPath = freshOut();
  const out: string[] = [];
  const err: string[] = [];
  const code = importMain(['--in', regradePath, '--cases', casesPath, '--bar', bar, '--out', runPath, '--reading', 'one-json-object-boolean-pass/v1', '--flow', join(dir, 'example-flow')], { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n'), runPath };
}

test('a cut reply is asked again', async () => {
  // The first request with a given body is cut. The draws of a case share one body, so the first draw of each of the
  // three cases is asked twice: 12 requests for 9 slots.
  const r = await live({}, { '--criterion': markedCriterion('[[times:1:truncated]]'), '--max-reasks': '2' });
  assert.equal(r.code, 0, r.err);
  const [header, ...rows] = linesOf(r.outPath);
  assert.equal(rows.length, 9);
  assert.equal(r.requests.length, 12);
  assert.match(r.out, /^slots graded: 9 of 9, 12 asks made \(3 re-asks; at most 2 per slot\), in the order case id then draw /m);
  assert.equal((header?.['graderConfig'] as Obj)['maxReasks'], 2);
  const records = rows.map((row) => row['graderEvidence'] as { stopReason: string; callSeq: number; reask: { max: number; earlier: { reason: string; callSeq: number }[] } });
  assert.deepEqual(records.map((rec) => rec.reask.earlier.map((e) => e.reason)), [['truncated'], [], [], ['truncated'], [], [], ['truncated'], [], []]);
  assert.ok(records.every((rec) => rec.stopReason === 'end_turn' && rec.reask.max === 2));
  assert.deepEqual(records.flatMap((rec) => [...rec.reask.earlier.map((e) => e.callSeq), rec.callSeq]), Array.from({ length: 12 }, (_, i) => i + 1));
  // The two asks of a slot sent the same request.
  assert.equal(JSON.stringify(r.requests[0]?.['bodyJson']), JSON.stringify(r.requests[1]?.['bodyJson']));
  // The file imports: each re-asked slot is an unmeasured judge attempt, then the graded one.
  const imported = importOf(r.outPath);
  assert.equal(imported.code, 0, imported.err);
  assert.match(imported.out, /^re-asks: 3 on 3 of 9 slots \(truncated 3, timeout 0, transport 0, server-error 0, rate-limited 0\); at most 2 per slot$/m);
  const run = JSON.parse(readFileSync(imported.runPath, 'utf8')) as { draws: { attempts: { kind: string }[] }[]; identity: { judgeHarnessVersion: string } };
  assert.deepEqual(run.draws.map((d) => d.attempts.map((a) => a.kind).join('+')), ['unmeasured+graded', 'graded', 'graded', 'unmeasured+graded', 'graded', 'graded', 'unmeasured+graded', 'graded', 'graded']);
  assert.match(run.identity.judgeHarnessVersion, /; max-reasks 2; wire anthropic-messages\/v1; script-files sha256:[0-9a-f]{64}$/);
});

test('a bound used up with no reply ends the re-grade', async () => {
  const r = await live({ mode: 'http-529' }, { '--max-reasks': '1' });
  assert.equal(r.code, IMPORT_EXIT.refused);
  // Two asks of the first slot, and no call for any later slot.
  assert.equal(r.requests.length, 2);
  const rows = linesOf(r.outPath).slice(1);
  assert.equal(rows.length, 1);
  assert.equal('graderEvidence' in (rows[0] ?? {}), false);
  // The row holds the error text, which lists both asks: nothing else records them.
  assert.match(rows[0]?.['error'] as string, /^the grader's call failed: grader: the endpoint answered status 529; no reply after 2 asks, the bound of 1 re-ask\(s\) is used up: ask 1 \(callSeq 1, callId [0-9a-f-]{36}\): server-error, the endpoint answered status 529; ask 2 \(callSeq 2, callId [0-9a-f-]{36}\): server-error, the endpoint answered status 529$/);
  assert.match(r.err, /^REFUSED the re-grade ended at slot bank-dispute#0 \(slot 1 of 9\): /);
  assert.match(r.err, / is kept \(the header and 1 row\(s\), the last with no record\)/);
  assert.ok(existsSync(r.outPath));
  assert.equal(text(r.outPath).includes(KEY), false);
  // The kept file is refused at import, naming the slot and every slot that was never reached.
  const imported = importOf(r.outPath);
  assert.equal(imported.code, 2);
  assert.match(imported.err, /^REFUSED IMPORT_UNGRADED: 9 slot\(s\) hold no finished, readable grade: bank-dispute#0 \(.*the re-grade recorded a failed call: .*no reply after 2 asks/);
  assert.equal(existsSync(imported.runPath), false);
});

test('a failure that is never asked again ends the re-grade after one request, whatever the bound', async () => {
  const r = await live({ mode: 'http-400' }, { '--max-reasks': '3' });
  assert.equal(r.code, IMPORT_EXIT.refused);
  assert.equal(r.requests.length, 1);
  assert.equal(linesOf(r.outPath)[1]?.['error'], "the grader's call failed: grader: the endpoint answered status 400");
});

test('a bound used up on cut replies stops the re-grade at the first such slot, and with --go-on-and-count is written and refused at import', async () => {
  const stopped = await live({}, { '--criterion': markedCriterion('[[times:2:truncated]]'), '--max-reasks': '1' });
  assert.equal(stopped.code, IMPORT_EXIT.refused, stopped.err);
  assert.equal(stopped.requests.length, 2, 'two asks of the first slot, and no later slot is paid for');
  assert.match(stopped.err, /^REFUSED the re-grade stopped at slot bank-dispute#0 \(slot 1 of 9\): the importer will refuse it: the judge's reply was cut at the output cap on each of 2 asks; the bound of 1 re-asks is used up$/m);
  const r = await live({}, { '--criterion': markedCriterion('[[times:2:truncated]]'), '--max-reasks': '1', '--go-on-and-count': SWITCH });
  // The re-grade itself succeeds: a cut reply is a record, not a failed call.
  assert.equal(r.code, 0, r.err);
  assert.equal(r.requests.length, 12);
  assert.match(r.out, /^slots graded: 9 of 9, 12 asks made \(3 re-asks; at most 1 per slot\), /m);
  // And it says what the importer will do with the file: three slots hold only cut replies.
  assert.match(r.out, /^slots with no finished reply: 3 \(the importer will refuse this file\)$/m);
  const imported = importOf(r.outPath);
  assert.equal(imported.code, 2);
  assert.match(imported.err, /^REFUSED IMPORT_UNGRADED: 3 slot\(s\) hold no finished, readable grade: bank-dispute#0 \([^)]*: the judge's reply was cut at the output cap on each of 2 asks; the bound of 1 re-asks is used up\); clearance-organiser#0 \(/);
  assert.match(imported.err, /^fields: bank-dispute#0, clearance-organiser#0, faulty-headphones#0$/m);
  assert.equal(existsSync(imported.runPath), false);
});

test('--timeout-ms is at most 3600000 (one hour), in the words of the grader, refused before the flow is read: no grader, no file, no call', async () => {
  for (const value of ['3600001', '2147483647', '2147483648', '4294967296', '9007199254740993', '0', '-5', '1.5', '1e3']) {
    // A flow that is not there: the flag is refused before the flow would be looked at.
    const r = await run({ flags: { '--timeout-ms': value, '--flow': join(work, 'no-such-flow') } });
    assert.equal(r.code, IMPORT_EXIT.usage, value);
    assert.equal(r.err, `USAGE: --timeout-ms must be a positive integer of at most 3600000 (one hour), found ${JSON.stringify(value)}. ${USAGE}`, value);
    assert.equal(r.stub.configs.length, 0, value);
    assert.equal(existsSync(r.outPath), false, value);
  }
  const most = await run({ flags: { '--timeout-ms': '3600000' } });
  assert.equal(most.code, 0, most.err);
  assert.equal(most.stub.configs[0]?.timeoutMs, 3600000);
  // The grader itself refuses the same value in the same words, should it be handed one by another caller.
  const Grader = loadGraderClass();
  const config = { wire: 'anthropic-messages/v1', model: 'm', max_tokens: 8, thinking: 'NOT_SENT', effort: 'NOT_SENT', maxReasks: 0, timeoutMs: 3600001 } as GraderConfig;
  assert.throws(() => new Grader({ config }), (e: Error) => e.message === 'grader: config.timeoutMs must be a positive integer of at most 3600000 (one hour)');
});

test('a response id with a line feed or a control character ends the re-grade at its slot as a malformed reply: the id reaches neither the terminal nor the file', async () => {
  const { createServer } = await import('node:http');
  const hostile = 'msg_\u001b[2J\u001b[31m\nREFUSED forged';
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: hostile, type: 'message', role: 'assistant', model: 'judge-served', stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"pass":' }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const outPath = freshOut();
  const out: string[] = [];
  const err: string[] = [];
  const saved = process.env['ANCHORSET_TEST_ID_KEY'];
  process.env['ANCHORSET_TEST_ID_KEY'] = KEY;
  try {
    const graderPath = join(root, GRADER_FILE);
    const requireGrader = createRequire(import.meta.url);
    delete requireGrader.cache[graderPath];
    const Grader = requireGrader(graderPath) as ReturnType<typeof loadGraderClass>;
    const port = (server.address() as { port: number }).port;
    const code = await runRegrade(
      argvOf({ ...baseFlags(outPath), '--max-reasks': '3', '--base-url': `http://127.0.0.1:${port}`, '--api-key-env': 'ANCHORSET_TEST_ID_KEY' }),
      { graderFactory: (config) => new Grader({ config }), uuid: () => RUN_ID, now: () => new Date(STARTED), openOut: openExclusive, env: { ANCHORSET_TEST_ID_KEY: KEY }, io: { out: (s) => out.push(s), err: (s) => err.push(s) } },
    );
    assert.equal(code, IMPORT_EXIT.refused);
    // A cut reply would be asked again; a reply whose id is malformed is not one: one request, and the slot ends.
    assert.equal(requests, 1);
    const said = err.join('\n');
    assert.match(said, /^REFUSED the re-grade ended at slot bank-dispute#0 \(slot 1 of 6\): the grader's call failed: grader: the response id is not 1 to 200 visible ASCII characters with no space; it is not shown$/m);
    for (const t of [said, out.join('\n'), text(outPath)]) {
      assert.ok(!t.includes('\u001b') && !t.includes('forged'), JSON.stringify(t.slice(0, 200)));
    }
    assert.equal(linesOf(outPath)[1]?.['error'], "the grader's call failed: grader: the response id is not 1 to 200 visible ASCII characters with no space; it is not shown");
  } finally {
    if (saved === undefined) delete process.env['ANCHORSET_TEST_ID_KEY'];
    else process.env['ANCHORSET_TEST_ID_KEY'] = saved;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---- the address is stated, the grader refuses what the importer would, and every refusal before a call leaves no file ----

test('--base-url is required: leaving it out is a usage error naming it, with no grader, no file and no call', async () => {
  const r = await run({ flags: { '--base-url': undefined } });
  assert.equal(r.code, IMPORT_EXIT.usage);
  assert.match(r.err, /^USAGE: missing --base-url\. usage: .*--base-url <url> --reading <[^>]+> --out <file>/);
  assert.equal(r.stub.configs.length, 0);
  assert.equal(existsSync(r.outPath), false);
  assert.ok(!OPTIONAL_FLAGS['anthropic-messages/v1'].includes('--base-url') && !OPTIONAL_FLAGS['openai-responses/v1'].includes('--base-url'));
  // the address stated is in the configuration handed to the grader and in the header, as it was typed
  const ok = await run({ flags: { '--base-url': 'http://127.0.0.1:19999/prefix' } });
  assert.equal(ok.stub.configs[0]?.baseUrl, 'http://127.0.0.1:19999/prefix');
  assert.equal((linesOf(ok.outPath)[0]?.['graderConfig'] as Obj)['baseUrl'], 'http://127.0.0.1:19999/prefix');
});

test('what the grader checks before its first call is checked before --out is created: a refusal there leaves no file and makes no call', async () => {
  const r = await run({ stub: { preflightError: `grader: the key in the variable named in apiKeyEnv holds a character that is not visible ASCII; the key is not shown (${KEY})` } });
  assert.equal(r.code, IMPORT_EXIT.usage, r.err);
  assert.match(r.err, /^USAGE: the grader refused to start: grader: the key in the variable named in apiKeyEnv holds a character that is not visible ASCII/);
  assert.match(r.err, /Nothing was written and no call was made\.$/);
  assert.ok(!r.err.includes(KEY), 'the key is not echoed');
  assert.equal(r.stub.preflights, 1);
  assert.equal(r.stub.prompts.length, 0);
  assert.equal(existsSync(r.outPath), false);
  // a good run calls it once, and before the first call
  const good = await run();
  assert.equal(good.stub.preflights, 1);
});

/** The real script and the real grader, against a fake endpoint, with environment variables of this process set for the call. */
/** `basePath` is put after the endpoint's address in `--base-url`. */
async function liveWith(vars: Record<string, string>, flags: Record<string, string>, basePath = ''): Promise<{ code: number; err: string; outPath: string; requests: number }> {
  const logPath = freshOut();
  const ep = await startFakeEndpoint({ port: 0, logPath });
  const outPath = freshOut();
  const err: string[] = [];
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries({ ANCHORSET_TEST_PREFLIGHT_KEY: KEY, ...vars })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const graderPath = join(root, GRADER_FILE);
    const requireGrader = createRequire(import.meta.url);
    delete requireGrader.cache[graderPath];
    const Grader = requireGrader(graderPath) as ReturnType<typeof loadGraderClass>;
    const code = await runRegrade(
      argvOf({ ...baseFlags(outPath), '--model': 'fake-judge-old', '--base-url': `http://127.0.0.1:${ep.port}${basePath}`, '--api-key-env': 'ANCHORSET_TEST_PREFLIGHT_KEY', ...flags }),
      { graderFactory: (config) => new Grader({ config }), uuid: () => RUN_ID, now: () => new Date(STARTED), openOut: openExclusive, env: { ANCHORSET_TEST_PREFLIGHT_KEY: process.env['ANCHORSET_TEST_PREFLIGHT_KEY'] }, io: { out: () => undefined, err: (s) => err.push(s) } },
    );
    const requests = readFileSync(logPath, 'utf8').split('\n').filter((l) => l !== '').length;
    return { code, err: err.join('\n'), outPath, requests };
  } finally {
    await ep.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('with the real grader, a key that is not visible ASCII, a turned-off certificate check and an environment proxy each end the re-grade before the file exists, with 0 requests', async () => {
  for (const [what, vars, words] of [
    ['a key with a line feed', { ANCHORSET_TEST_PREFLIGHT_KEY: `${KEY}\n` }, /holds a character that is not visible ASCII/],
    ['a key with a space', { ANCHORSET_TEST_PREFLIGHT_KEY: `${KEY} x` }, /holds a character that is not visible ASCII/],
    ['the certificate check turned off', { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, /NODE_TLS_REJECT_UNAUTHORIZED=0/],
    ['an environment proxy', { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:9' }, /an environment proxy is on/],
  ] as const) {
    const r = await liveWith(vars, {});
    assert.equal(r.code, IMPORT_EXIT.usage, `${what}: ${r.err}`);
    assert.match(r.err, words, what);
    assert.match(r.err, /^USAGE: the grader refused to start: /, what);
    assert.equal(existsSync(r.outPath), false, `${what}: no file`);
    assert.equal(r.requests, 0, what);
    assert.ok(!r.err.includes(KEY), what);
  }
});

test('with the real grader, --model UNKNOWN, --api-version UNKNOWN and a model id that is not one printable line make 0 requests and leave no file', async () => {
  for (const flags of [{ '--model': 'UNKNOWN' }, { '--model': 'none' }, { '--model': `judge${'x'.repeat(200)}` }, { '--api-version': 'UNKNOWN' }, { '--api-version': 'n/a' }]) {
    const r = await liveWith({}, flags);
    assert.equal(r.code, IMPORT_EXIT.usage, `${JSON.stringify(flags)}: ${r.err}`);
    assert.match(r.err, /^USAGE: the grader refused its configuration: grader: config\.(model|apiVersion) must be /, JSON.stringify(flags));
    assert.equal(existsSync(r.outPath), false, JSON.stringify(flags));
    assert.equal(r.requests, 0, JSON.stringify(flags));
  }
});

test('a judge that answers every slot in prose: the re-grade stops at the first slot after one request; with --go-on-and-count it calls every slot, counts all nine, and the importer refuses the file', async () => {
  const stopped = await live({ mode: 'no-verdict' }, {});
  assert.equal(stopped.code, IMPORT_EXIT.refused, stopped.err);
  assert.equal(stopped.requests.length, 1, 'no slot after the first is paid for');
  assert.match(stopped.err, /^REFUSED the re-grade stopped at slot bank-dispute#0 \(slot 1 of 9\): the importer will refuse it: not exactly one JSON object with a boolean "pass", under the reading rule one-json-object-boolean-pass\/v1 that was stated$/m);
  const r = await live({ mode: 'no-verdict' }, { '--go-on-and-count': SWITCH });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.requests.length, 9);
  assert.match(r.out, /^slots with no finished reply: 0$/m);
  assert.match(r.out, /^slots the importer will refuse: 9 \(the importer will refuse this file: bank-dispute#0, [^)]*\); every reply of a finished, well-formed record was read under the reading rule one-json-object-boolean-pass\/v1$/m);
  const out: string[] = [];
  const err: string[] = [];
  const code = importMain(['--in', r.outPath, '--cases', casesPath, '--bar', join(root, 'examples', 'importers', 'skill-evals', 'bar.json'), '--out', freshOut(), '--reading', 'one-json-object-boolean-pass/v1', '--flow', exampleFlow], { out: (x) => out.push(x), err: (x) => err.push(x) });
  assert.equal(code, 2, err.join('\n'));
  assert.match(err[0] ?? '', /^REFUSED IMPORT_UNGRADED: 9 slot\(s\) /);
  // The importer's words for a slot and the re-grade's are the same words: one reading, one sentence.
  const words = 'not exactly one JSON object with a boolean "pass", under the reading rule one-json-object-boolean-pass/v1 that was stated';
  assert.ok((err[0] ?? '').includes(`line 2/graderEvidence/reply: ${words}`), err[0]);
  assert.ok(stopped.err.includes(`the importer will refuse it: ${words}`), stopped.err);
});

test('every line the re-grade prints is one line: a failed call whose text holds a carriage return, an escape sequence and a line feed is written with escapes', async () => {
  const r = await run({ stub: { throwOn: { call: 1, message: 'boom\r\u001b[2Kwrote: forged\nsha256: 000' } } });
  assert.equal(r.code, IMPORT_EXIT.refused);
  const lines = r.err.split('\n');
  assert.equal(lines.length, 4, r.err);
  assert.match(lines[0] ?? '', /^REFUSED the re-grade ended at slot /);
  assert.ok(lines[0]?.includes('boom\\r\\u001b[2Kwrote: forged\\nsha256: 000'), lines[0]);
  for (const line of lines) assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(line), JSON.stringify(line));
});

test('a slot that fails after an earlier ask: the row\'s error text lists every ask of the slot, and it is the only place they are', async () => {
  // The first request is cut and asked again; the second is answered 400, which is never asked again.
  const r = await live({ mode: 'http-400' }, { '--criterion': markedCriterion('[[times:1:truncated]]'), '--max-reasks': '2' });
  assert.equal(r.code, IMPORT_EXIT.refused);
  assert.equal(r.requests.length, 2);
  const rows = linesOf(r.outPath).slice(1);
  assert.equal(rows.length, 1);
  assert.equal('graderEvidence' in (rows[0] ?? {}), false);
  assert.match(rows[0]?.['error'] as string, /^the grader's call failed: grader: the endpoint answered status 400; the slot ends with no record after 2 asks: ask 1 \(callSeq 1, callId [0-9a-f-]{36}\): truncated, response msg_fake_0001; ask 2 \(callSeq 2, callId [0-9a-f-]{36}\): ended the slot$/);
  assert.equal(text(r.outPath).includes(KEY), false);
});

test('a reply in a content encoding ends the re-grade at its slot after one request, whatever the bound', async () => {
  const r = await live({ mode: 'encoded' }, { '--max-reasks': '3' });
  assert.equal(r.code, IMPORT_EXIT.refused);
  assert.equal(r.requests.length, 1);
  assert.equal((r.requests[0]?.['headers'] as Obj)['accept-encoding'], 'identity');
  assert.equal(linesOf(r.outPath)[1]?.['error'], "the grader's call failed: grader: the response is in a content encoding the request did not ask for");
});

test('a --base-url whose path is not plain segments is a usage error in the grader\'s words: 0 requests and no file; a plain path is posted to', async () => {
  for (const path of ['/a/../b', '/a/./b', '/a//b', '/a%2Fb', '/a;b', '/..']) {
    const r = await liveWith({}, {}, path);
    assert.equal(r.code, IMPORT_EXIT.usage, `${path}: ${r.err}`);
    assert.match(r.err, /^USAGE: the grader refused its configuration: grader: baseUrl path must hold plain segments only$/m, path);
    assert.equal(existsSync(r.outPath), false, path);
    assert.equal(r.requests, 0, path);
  }
  // A plain path reaches the stand-in, which knows one route only: the request is made, and answered 404.
  const plain = await liveWith({}, {}, '/proxy');
  assert.equal(plain.code, IMPORT_EXIT.refused, plain.err);
  assert.equal(plain.requests, 1);
  assert.match(plain.err, /grader: the endpoint answered status 404/);
});

test('--max-reasks is compared with the bound as a number: 00, 3.0, 1e0 and 03 are not counts, and 4 to 12 are above the bound', async () => {
  for (const bad of ['00', '03', '3.0', '1e0', '5', '9', '11', '12', '3 ', '0b1']) {
    const r = await run({ flags: { '--max-reasks': bad } });
    assert.equal(r.code, IMPORT_EXIT.usage, bad);
    assert.ok(r.err.startsWith(`USAGE: --max-reasks must be an integer from 0 to 3 (the re-asks one slot may be given; 0 asks every slot once), found ${JSON.stringify(bad)}. usage: `), bad);
    assert.equal(r.stub.configs.length, 0, bad);
  }
  // No character class is built from the bound: a bound of two digits would break one.
  assert.doesNotMatch(readFileSync(join(root, SCRIPT), 'utf8'), /new RegExp\(/);
});

// ---- the OpenAI Responses wire ---------------------------------------------------------------------------------------------------

const OPENAI_FLAGS: Record<string, string | undefined> = { '--wire': 'openai-responses/v1', '--thinking': undefined, '--verbosity': 'NOT_SENT', '--base-url': 'http://127.0.0.1:18765/v1' };
const OPENAI_ENV = { OPENAI_API_KEY: KEY };

test('--wire selects the flags: the OpenAI wire states --verbosity and takes no --thinking or --api-version; the Anthropic wire the reverse; a flag of the other wire is a usage error (64)', async () => {
  const ok = await run({ flags: OPENAI_FLAGS, env: OPENAI_ENV });
  assert.equal(ok.code, 0, ok.err);
  // required on the OpenAI wire: --verbosity; and --wire itself, with no default
  for (const [flag, words] of [['--verbosity', /^USAGE: missing --verbosity\. usage: /], ['--wire', /^USAGE: --wire is required and must be one of /]] as const) {
    const r = await run({ flags: { ...OPENAI_FLAGS, [flag]: undefined }, env: OPENAI_ENV });
    assert.equal(r.code, IMPORT_EXIT.usage, flag);
    assert.match(r.err, words, flag);
    assert.equal(r.stub.configs.length, 0, flag);
    assert.equal(existsSync(r.outPath), false, flag);
  }
  // flags of the other wire: --thinking and --api-version on the OpenAI wire; --verbosity on the Anthropic wire
  for (const extra of [{ '--thinking': 'NOT_SENT' }, { '--api-version': '2023-06-01' }]) {
    const r = await run({ flags: { ...OPENAI_FLAGS, ...extra }, env: OPENAI_ENV });
    assert.equal(r.code, IMPORT_EXIT.usage, JSON.stringify(extra));
    // the wire the flag belongs to is named, as regrade.py names it
    assert.match(r.err, /^USAGE: --(thinking|api-version) is a flag of the anthropic-messages\/v1 wire only; the wire stated is openai-responses\/v1\. usage: /, JSON.stringify(extra));
    assert.equal(r.stub.configs.length, 0);
  }
  const wrong = await run({ flags: { '--verbosity': 'NOT_SENT' } });
  assert.equal(wrong.code, IMPORT_EXIT.usage);
  assert.match(wrong.err, /^USAGE: --verbosity is a flag of the openai-responses\/v1 wire only; the wire stated is anthropic-messages\/v1\. usage: /);
  // an unknown wire name, and one with a different case
  for (const name of ['openai-chat/v1', 'OPENAI-RESPONSES/V1', '']) {
    const r = await run({ flags: { '--wire': name === '' ? SWITCH : name } });
    assert.equal(r.code, IMPORT_EXIT.usage, name);
    assert.match(r.err, /^USAGE: --wire is required and must be one of anthropic-messages\/v1, openai-responses\/v1/);
  }
  assert.deepEqual([...REQUIRED_FLAGS['openai-responses/v1']].filter((f) => !REQUIRED_FLAGS['anthropic-messages/v1'].includes(f)), ['--verbosity']);
  assert.deepEqual([...REQUIRED_FLAGS['anthropic-messages/v1']].filter((f) => !REQUIRED_FLAGS['openai-responses/v1'].includes(f)), ['--thinking']);
});

test('the OpenAI grader is handed the wire, the cap as max_output_tokens, effort, verbosity and the bound; the header holds the same; the default key variable is OPENAI_API_KEY', async () => {
  const r = await run({ flags: { ...OPENAI_FLAGS, '--effort': 'low', '--verbosity': 'high', '--max-tokens': '300' }, env: OPENAI_ENV });
  assert.equal(r.code, 0, r.err);
  const expected = { wire: 'openai-responses/v1', model: 'example-judge-old', effort: 'low', maxReasks: 0, baseUrl: 'http://127.0.0.1:18765/v1', max_output_tokens: 300, verbosity: 'high' };
  assert.deepEqual(r.stub.configs, [expected]);
  assert.deepEqual(linesOf(r.outPath)[0]?.['graderConfig'], expected);
  // the records the stub wrote carry the wire, and the cap is not also given as max_tokens
  for (const row of linesOf(r.outPath).slice(1)) assert.equal((row['graderEvidence'] as Obj)['wire'], 'openai-responses/v1');
  // the Anthropic key does not stand in for the OpenAI one
  const noKey = await run({ flags: OPENAI_FLAGS, env: { ANTHROPIC_API_KEY: KEY } });
  assert.equal(noKey.code, IMPORT_EXIT.usage);
  assert.match(noKey.err, /the environment variable OPENAI_API_KEY is not set/);
  assert.equal(noKey.stub.configs.length, 0);
  assert.equal(existsSync(noKey.outPath), false);
  // a named key variable is the one read
  const named = await run({ flags: { ...OPENAI_FLAGS, '--api-key-env': 'EXAMPLE_OPENAI_KEY' }, env: { EXAMPLE_OPENAI_KEY: KEY } });
  assert.equal(named.code, 0, named.err);
  assert.equal(named.stub.configs[0]?.apiKeyEnv, 'EXAMPLE_OPENAI_KEY');
});

test('each of the four OpenAI address variables, set and different from --base-url (or with none stated), is refused before any file or call, naming the variable and never its value', async () => {
  for (const name of ['OPENAI_BASE_URL', 'OPENAI_API_BASE_URL', 'OPENAI_API_HOST', 'OPENAI_HOST']) {
    const gateway = 'https://gateway.example.test/v1';
    const r = await run({ flags: OPENAI_FLAGS, env: { ...OPENAI_ENV, [name]: gateway } });
    assert.equal(r.code, IMPORT_EXIT.usage, name);
    assert.match(r.err, new RegExp(`the environment variable ${name} is set, and this grader never reads it`));
    assert.ok(!r.err.includes(gateway), 'the value is never printed');
    // a bare host can never equal a base URL: for the two HOST variables the one remedy is to unset the variable
    if (name.endsWith('_HOST')) assert.ok(r.err.includes(' Unset the variable. Nothing was written') && !r.err.includes('State the same address'), r.err);
    else assert.ok(r.err.includes('State the same address with --base-url, or unset the variable. Nothing was written'), r.err);
    assert.equal(r.stub.configs.length, 0);
    assert.equal(existsSync(r.outPath), false);
    // stated alike, or empty: not refused
    const alike = await run({ flags: { ...OPENAI_FLAGS, '--base-url': gateway }, env: { ...OPENAI_ENV, [name]: gateway } });
    assert.equal(alike.code, 0, alike.err);
    const empty = await run({ flags: OPENAI_FLAGS, env: { ...OPENAI_ENV, [name]: '' } });
    assert.equal(empty.code, 0, empty.err);
  }
  // the Anthropic wire's variable is not the OpenAI wire's, and the reverse
  const crossed = await run({ flags: OPENAI_FLAGS, env: { ...OPENAI_ENV, ANTHROPIC_BASE_URL: 'https://gateway.example.test' } });
  assert.equal(crossed.code, 0, crossed.err);
  const crossed2 = await run({ env: { ANTHROPIC_API_KEY: KEY, OPENAI_BASE_URL: 'https://gateway.example.test/v1' } });
  assert.equal(crossed2.code, 0, crossed2.err);
});

test('on the OpenAI wire the re-grade stops at a slot that was cut or filtered, and counts reasoning items', async () => {
  // a cut (incomplete, max_output_tokens) at the last ask, a bound of 0: the importer will refuse it
  const cut = await run({ flags: OPENAI_FLAGS, env: OPENAI_ENV, stub: { stopReason: (call) => (call === 3 ? 'incomplete' : 'completed') } });
  assert.equal(cut.code, IMPORT_EXIT.refused, cut.err);
  assert.match(cut.err, /the importer will refuse it: the judge stopped with status "incomplete" \(max_output_tokens\), not "completed"/);
  assert.equal(cut.stub.prompts.length, 3);
  // with --go-on-and-count the count of such slots is printed and the file is not importable
  const counted = await run({ flags: { ...OPENAI_FLAGS, '--go-on-and-count': SWITCH }, env: OPENAI_ENV, stub: { stopReason: (call) => (call === 3 ? 'incomplete' : 'completed') } });
  assert.equal(counted.code, 0, counted.err);
  assert.match(counted.out, /^slots with no finished reply: 1 \(the importer will refuse this file\)$/m);
  // a reasoning item counts as reasoning
  const thought = await run({ flags: OPENAI_FLAGS, env: OPENAI_ENV, stub: { contentTypes: (call) => (call === 2 ? ['thinking', 'text'] : ['text']) } });
  assert.equal(thought.code, 0, thought.err);
  assert.match(thought.out, /^replies with reasoning: 1 of 6$/m);
  // a response with no `wire` of the right kind never gets here: a record of the other wire is refused by the importer's own check
});
