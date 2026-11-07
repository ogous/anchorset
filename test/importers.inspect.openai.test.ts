// The OpenAI Responses wire in the Inspect importer and the Python recording grader, against the local stand-in (zero spend, no
// network). Three halves:
//   1. the Inspect fixtures the real tool wrote on the OpenAI wire: they import, go through judge-change, and the pair of a Claude
//      judge and a GPT judge moves four judge fields; a file that mixes two wires, a v7 record, and a log whose model arguments
//      contradict its record are refused;
//   2. the Python grader and the JavaScript grader, given the same exchanges by the stand-in, write the same record (ids aside);
//   3. the status-before-text order, with the Python grader's record: a reply that a reading rule would accept is never graded
//      when the response was cut, filtered or held a refusal.
// Halves 2 and 3 need a Python with inspect_ai (ANCHORSET_INSPECT_VENV) and are skipped without one.
// Synthetic customer-support refund-bot data only.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { sha256Hex } from '../src/index.ts';
import { startFakeEndpoint } from '../examples/importers/fake-endpoint.ts';
import { strictGrade } from '../examples/importers/inspect/import.ts';
import { ImportRefusal, parseRecord, READING_JSON_OBJECT, readSlot, ungradedReason } from '../examples/importers/shared.ts';
import { scratchEnv, skipUnlessFound } from './helpers.ts';

const root = join(import.meta.dirname, '..');
const importers = join(root, 'examples', 'importers');
const inspect = join(importers, 'inspect');
const work = mkdtempSync(join(tmpdir(), 'anchorset-inspect-openai-'));
after(() => rmSync(work, { recursive: true, force: true }));

const node = (script: string, args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: root, env: scratchEnv() });
const cli = (...args: string[]) => node(join(root, 'src', 'cli.ts'), args);
const makePlan = join(importers, 'make-plan.ts');
const bar = join(inspect, 'bar.json');
const FOUR = 'judgeModelRequested,judgeModelServed,judgeCallShapeHash,judgeHarnessVersion';
type J = Record<string, any>;
const json = (p: string): J => JSON.parse(readFileSync(p, 'utf8')) as J;

/** A fixture of the Inspect folder imported by the real command. */
function importFixture(fixture: string, name: string, from = 'fixtures'): { path: string; sha256: string; stdout: string } {
  const dir = join(work, 'runs');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  const r = node(join(inspect, 'import.ts'), ['--in', join(inspect, from, `${fixture}.json`), '--cases', join(inspect, 'cases.json'), '--bar', bar, '--out', path]);
  assert.equal(r.status, 0, r.stderr);
  return { path, sha256: sha256Hex(readFileSync(path)), stdout: r.stdout };
}
const importText = (text: string, name: string): { status: number | null; stdout: string; stderr: string } => {
  const file = join(work, `${name}.in.json`);
  writeFileSync(file, text);
  return node(join(inspect, 'import.ts'), ['--in', file, '--cases', join(inspect, 'cases.json'), '--bar', bar, '--out', join(work, `${name}.run.json`)]);
};
const planFlags = (moves: string, out: string): string[] => ['--bar', bar, '--system', 'refund-bot', '--stored-outputs', 'system-side-not-compared', '--measured-class', 'refund_policy', '--cut', 'C', '--label-rule', 'majority', '--pooling', 'items-equal', '--estimate-draws', '0,1,2', '--judge-moves', moves, '--out', out];
function inputs(name: string, oldRun: string, newRun: string): string {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  copyFileSync(oldRun, join(dir, 'old.json'));
  copyFileSync(newRun, join(dir, 'new.json'));
  return dir;
}

// ---- 1. the fixtures -------------------------------------------------------------------------------------------------------

describe('the Inspect fixtures on the OpenAI wire', () => {
  it('import: the wire, the harness string, the served-id statement, the reasoning line and the re-ask line are printed; the run names the wire', () => {
    const o = importFixture('openai-old-judge', 'oa-old');
    assert.match(o.stdout, /^wire: openai-responses\/v1$/m);
    assert.match(o.stdout, /^judge model served: "fake-judge-old", the same text as the model requested\./m);
    assert.match(o.stdout, /^replies with reasoning: 0 of 9 asks; reasoning tokens \(the provider's own count\): total 0, median 0, max 0; counter absent on 0$/m);
    assert.match(o.stdout, /^re-asks: 0 on 0 of 9 slots /m);
    const run = json(o.path);
    assert.match(run['identity'].judgeHarnessVersion, /^inspect_ai 0\.3\.275; anchorset-recording-grader python sha256:[0-9a-f]{64}; python 3\.\d+\.\d+; max-reasks 0; wire openai-responses\/v1$/);
    assert.equal(run['identity'].judgeModelServed, 'fake-judge-old');
    assert.equal(run['callShapes'].judge.endpoint, 'http://127.0.0.1:18765/v1/responses');
    assert.equal(run['callShapes'].judge.contextPolicy, 'none');
    assert.deepEqual(run['callShapes'].judge.extras, { 'openai.store': false });
    assert.equal(run['callShapes'].judge.apiVersion, 'NOT_SENT');
  });

  it('the records are the OpenAI wire\'s: sent holds store false and truncation disabled, and the key set is the OpenAI one', () => {
    const l = json(join(inspect, 'fixtures', 'openai-old-judge.json'));
    for (const s of l['samples']) {
      const rec = s.scores.model_graded_qa.metadata.grading[1].metadata.graderEvidence as J;
      assert.equal(rec['schema'], 'example.grader-evidence/v8');
      assert.equal(rec['wire'], 'openai-responses/v1');
      assert.equal(rec['stopReason'], 'completed');
      assert.equal(rec['incompleteReason'], 'ABSENT');
      assert.deepEqual(rec['sent'], { system: 'NOT_SENT', user: rec['sent'].user, reasoning: 'NOT_SENT', text: 'NOT_SENT', store: false, truncation: 'disabled' });
      assert.deepEqual(rec['contentTypes'], ['message[phase=final_answer]/output_text']);
    }
    assert.deepEqual(l['eval'].scorers[0].options.model.model_args, { wire: 'openai-responses/v1', effort: 'NOT_SENT', verbosity: 'NOT_SENT', max_reasks: 0 });
  });

  it('the old and new OpenAI judges go through judge-change: the model is the only move, and the strict marker flips the one case', () => {
    const o = importFixture('openai-old-judge', 'oa-old-2');
    const n = importFixture('openai-new-judge', 'oa-new-2');
    const planPath = join(work, 'oa-plan.json');
    const made = node(makePlan, ['--old', o.path, '--new', n.path, ...planFlags('judgeModelRequested,judgeModelServed', planPath)]);
    assert.equal(made.status, 0, made.stderr);
    assert.equal(made.stderr, '', 'two OpenAI runs name one wire: no cross-wire note');
    const r = cli('judge-change', '--plan', planPath, '--bar', bar, '--inputs', inputs('oa-inputs', o.path, n.path));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /judgeModelRequested {1,}fake-judge-old -> fake-judge-strict-new/);
    assert.doesNotMatch(r.stdout, /judgeHarnessVersion|judgeCallShapeHash/);
    assert.match(r.stdout, /^per-draw pass rate {1,}1\.000 {1,}0\.667 {1,}-0\.333$/m);
    assert.match(r.stdout, /items whose label differs between the judges \(1: pass -> fail 1, fail -> pass 0\):\n {2}refund-bot\/c3 {2}pass -> fail/);
  });

  it('the motivating pair: the Claude judge\'s Inspect file against the GPT judge\'s moves four judge fields, and the plan must declare all four', () => {
    const a = importFixture('old-judge', 'anth-old');
    const o = importFixture('openai-new-judge', 'oa-new-3');
    const planPath = join(work, 'cross-plan.json');
    const made = node(makePlan, ['--old', a.path, '--new', o.path, ...planFlags(FOUR, planPath)]);
    assert.equal(made.status, 0, made.stderr);
    assert.match(made.stderr, /^The two run files were graded through two APIs \(`anthropic-messages\/v1` and `openai-responses\/v1`\)\./);
    const plan = json(planPath);
    assert.deepEqual(plan['judgeMoves'], ['judgeModelRequested', 'judgeModelServed', 'judgeCallShapeHash', 'judgeHarnessVersion']);
    assert.equal(plan['judges'].old.judgeDefinitionHash, plan['judges'].new.judgeDefinitionHash, 'a wire switch does not move the judge definition');
    const r = cli('judge-change', '--plan', planPath, '--bar', bar, '--inputs', inputs('cross-inputs', a.path, o.path));
    assert.equal(r.status, 0, r.stderr);
    for (const [left, field] of [['judgeModelRequested,judgeModelServed,judgeCallShapeHash', 'judgeHarnessVersion'], ['judgeModelRequested,judgeModelServed,judgeHarnessVersion', 'judgeCallShapeHash']] as const) {
      const bad = node(makePlan, ['--old', a.path, '--new', o.path, ...planFlags(left, join(work, `refused-${field}.json`))]);
      assert.equal(bad.status, 2, bad.stderr);
      assert.match(bad.stderr, new RegExp(`^REFUSED IDENTITY_MISMATCH\\n {2}fields: ${field}\\n`));
    }
  });

  it('the other listed Inspect version: its OpenAI witnesses give the same measurement as the reference version\'s files', () => {
    const [ro, rn] = [importFixture('openai-old-judge', 'ref-old'), importFixture('openai-new-judge', 'ref-new')];
    const [wo, wn] = [importFixture('openai-old-judge', 'wit-old', 'by-version/0.3.286'), importFixture('openai-new-judge', 'wit-new', 'by-version/0.3.286')];
    const measure = (name: string, a: { path: string }, b: { path: string }): string => {
      const planPath = join(work, `${name}-plan.json`);
      const made = node(makePlan, ['--old', a.path, '--new', b.path, ...planFlags('judgeModelRequested,judgeModelServed', planPath)]);
      assert.equal(made.status, 0, made.stderr);
      const r = cli('judge-change', '--plan', planPath, '--bar', bar, '--inputs', inputs(`${name}-in`, a.path, b.path));
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.split('\n').filter((l) => /per-draw pass rate|label pass rate|items whose label differs|old judge fails draws/.test(l)).join('\n');
    };
    const reference = measure('ref', ro, rn);
    assert.ok(reference.length > 0);
    assert.equal(measure('wit', wo, wn), reference);
  });

  it('a file that holds the records of two wires is IMPORT_MIXED_IDENTITY naming the wire, for each listed version', () => {
    for (const path of [join(inspect, 'bad-fixtures', 'mixed-wires.json'), join(inspect, 'by-version', '0.3.286', 'bad', 'mixed-wires.json')]) {
      assert.ok(existsSync(path), path);
      const r = importText(readFileSync(path, 'utf8'), 'mixed');
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /^REFUSED IMPORT_MIXED_IDENTITY: wire: 2 distinct values\nfields: wire\n/);
    }
  });

  it('a v7 record is refused with the instruction to grade again', () => {
    const text = readFileSync(join(inspect, 'fixtures', 'openai-old-judge.json'), 'utf8').replaceAll('"example.grader-evidence/v8"', '"example.grader-evidence/v7"');
    const r = importText(text, 'v7');
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /REFUSED IMPORT_EVIDENCE/);
    assert.match(r.stderr, /this record is of version example\.grader-evidence\/v7, an earlier version than example\.grader-evidence\/v8; re-grade with the current grader \(examples\/importers\/inspect\/recording_grader\.py/);
  });

  it('the log\'s model arguments must be the OpenAI wire\'s and the record\'s: a wrong wire, a missing or changed effort or verbosity, and an argument of the other wire each refuse, naming the argument', () => {
    const edits: [string, (a: J) => void, RegExp][] = [
      ['a wire that differs from the record', (a) => { a['wire'] = 'anthropic-messages/v1'; }, /model_args\/wire: "anthropic-messages\/v1" but the record says "openai-responses\/v1"/],
      ['no wire', (a) => { delete a['wire']; }, /model_args\/wire: "not set" but the record says/],
      ['an effort the record did not send', (a) => { a['effort'] = 'high'; }, /model_args\/effort: "high" but the record says "NOT_SENT"/],
      ['a verbosity the record did not send', (a) => { a['verbosity'] = 'low'; }, /model_args\/verbosity: "low" but the record says "NOT_SENT"/],
      ['no verbosity', (a) => { delete a['verbosity']; }, /model_args\/verbosity: "not set" but the record says "NOT_SENT"/],
      ['a thinking argument (the other wire\'s)', (a) => { a['thinking'] = 'NOT_SENT'; }, /keys thinking are not documented settings of the grader/],
      ['an api_version (the other wire\'s)', (a) => { a['api_version'] = '2023-06-01'; }, /keys api_version are not documented settings of the grader/],
      ['another bound', (a) => { a['max_reasks'] = 2; }, /model_args\/max_reasks: 2 but the record says the bound was 0 re-ask/],
    ];
    for (const [what, edit, expected] of edits) {
      const l = json(join(inspect, 'fixtures', 'openai-old-judge.json'));
      edit(l['eval'].scorers[0].options.model.model_args as J);
      const r = importText(JSON.stringify(l), 'args');
      assert.equal(r.status, 2, `${what}: ${r.stderr}`);
      assert.match(r.stderr, /REFUSED IMPORT_EVIDENCE/, what);
      assert.match(r.stderr, expected, what);
    }
  });

  it('a record whose store, truncation or context policy contradicts the OpenAI wire is refused', () => {
    for (const [what, edit] of [
      ['store true', (r: J) => { r['sent'].store = true; }],
      ['truncation auto', (r: J) => { r['sent'].truncation = 'auto'; }],
      ['a thinking key from the other wire', (r: J) => { r['sent'].thinking = 'NOT_SENT'; }],
    ] as const) {
      const l = json(join(inspect, 'fixtures', 'openai-old-judge.json'));
      for (const s of l['samples']) edit(s.scores.model_graded_qa.metadata.grading[1].metadata.graderEvidence as J);
      const r = importText(JSON.stringify(l), 'sent');
      assert.equal(r.status, 2, `${what}: ${r.stderr}`);
      assert.match(r.stderr, /REFUSED IMPORT_EVIDENCE/, what);
    }
  });
});

describe('the Inspect importer reads the stop and the content before the text: a record with a whole GRADE: line that was cut, filtered or held a refusal is IMPORT_UNGRADED', () => {
  for (const [what, edit, why] of [
    ['incomplete / content_filter', (r: J) => { r['stopReason'] = 'incomplete'; r['incompleteReason'] = 'content_filter'; }, /stopped with status "incomplete" \(content_filter\), not "completed"/],
    ['incomplete / max_output_tokens', (r: J) => { r['stopReason'] = 'incomplete'; r['incompleteReason'] = 'max_output_tokens'; }, /stopped with status "incomplete" \(max_output_tokens\), not "completed"/],
    ['a refusal part after the text', (r: J) => { r['contentTypes'] = ['message/output_text', 'message/refusal']; }, /holds a refusal part/],
    ['a refusal part before the text', (r: J) => { r['contentTypes'] = ['message/refusal', 'message/output_text']; }, /holds a refusal part/],
  ] as const) {
    // With a whole verdict the strict reading accepts, only the stop or the content can end the slot. With a reply that has no GRADE: line the
    // strict reading would give its own reason, so the stop or the content has to be asked first (import.ts: ungradedReason, then strictGrade).
    for (const [replyKind, reply] of [['a whole verdict', undefined], ['a reply with no GRADE: line', 'The judge wrote prose and no grade line.']] as const) {
      it(`${what}, ${replyKind}: the slot is ungraded and the refusal names the stop or the content`, () => {
        const l = json(join(inspect, 'fixtures', 'openai-old-judge.json'));
        const rec = l['samples'][0].scores.model_graded_qa.metadata.grading[1].metadata.graderEvidence as J;
        if (reply === undefined) assert.equal(strictGrade(rec['reply']), 'C');
        else rec['reply'] = reply;
        edit(rec);
        const r = importText(JSON.stringify(l), 'ungraded');
        assert.equal(r.status, 2, r.stderr);
        assert.match(r.stderr, /REFUSED IMPORT_UNGRADED/, what);
        assert.match(r.stderr, why, what);
        assert.doesNotMatch(r.stderr, /no strict reading/, what);
      });
    }
  }
});

// ---- 2 and 3. the Python grader beside the JavaScript grader, and the order of status and text --------------------------------

const venv = process.env['ANCHORSET_INSPECT_VENV'];
const py = ((): string | undefined => {
  const found = [...(venv === undefined ? [] : [join(venv, 'bin', 'python')]), 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python'].find((p) => spawnSync(p, ['-c', 'import inspect_ai'], { env: { PATH: process.env['PATH'] ?? '' } }).status === 0);
  return found;
})();

const require = createRequire(import.meta.url);
const GRADER_PATH = join(importers, 'promptfoo', 'grader-provider.cjs');
const KEY_ENV = 'ANCHORSET_EQUALITY_TEST_KEY';
const OPENAI_ADDRESS_VARIABLES = ['OPENAI_BASE_URL', 'OPENAI_API_BASE_URL', 'OPENAI_API_HOST', 'OPENAI_HOST'] as const;
const KEY = 'equality-test-dummy-credential-0123456789';
const OAI = 'openai-responses/v1';
const ANT = 'anthropic-messages/v1';

type Case = { name: string; wire: string; prompt: string; reasks?: number; effort?: string; verbosity?: string; thinking?: unknown; temperature?: number; cap?: number };
const oai = (name: string, prompt: string, over: Partial<Case> = {}): Case => ({ name, wire: OAI, prompt, ...over });
const ant = (name: string, prompt: string, over: Partial<Case> = {}): Case => ({ name, wire: ANT, prompt, ...over });
const Q = 'Question: may I have a refund?\nAnswer: refund granted within 30 days.';
/** The same exchanges, given to both graders. Cuts are asked again at once (no wait follows one); a failure with no reply is on a bound of 0, so no wait either. */
const CASES: Case[] = [
  oai('o normal', Q),
  oai('o settings sent', Q, { effort: 'high', verbosity: 'low', temperature: 0.5, cap: 64 }),
  oai('o integer temperature', Q, { temperature: 0, effort: 'none', verbosity: 'medium' }),
  oai('o reasoning item', `${Q} [[thinking]]`),
  oai('o no counter', `${Q} [[thinking]] [[no-counter]]`),
  oai('o dated served id', `${Q} [[served:dated]]`),
  oai('o cut then whole', `${Q} [[times:1:truncated]]`, { reasks: 2 }),
  oai('o cut verdict-whole then whole', `${Q} [[format:grade]] [[times:1:truncated-verdict-whole]]`, { reasks: 1 }),
  oai('o cut reasoning then whole', `${Q} [[times:1:truncated-reasoning]]`, { reasks: 1 }),
  oai('o cut, the bound used up', `${Q} [[times:2:truncated]]`, { reasks: 1 }),
  oai('o cut verdict-whole, the bound used up', `${Q} [[format:grade]] [[times:2:truncated-verdict-whole]]`, { reasks: 1 }),
  oai('o cut verdict-whole at bound 0', `${Q} [[format:grade]] [[mode:truncated-verdict-whole]]`),
  oai('o cut reasoning at bound 0', `${Q} [[mode:truncated-reasoning]]`),
  oai('o content filter', `${Q} [[format:grade]] [[mode:content-filter]]`, { reasks: 2 }),
  oai('o refusal', `${Q} [[mode:refusal]]`, { reasks: 2 }),
  oai('o refusal after text', `${Q} [[format:grade]] [[mode:refusal-after-text]]`, { reasks: 2 }),
  oai('o refusal before text', `${Q} [[format:grade]] [[mode:refusal-before-text]]`, { reasks: 2 }),
  oai('o message incomplete', `${Q} [[mode:message-incomplete]]`),
  oai('o phase absent', `${Q} [[mode:phase-absent]]`),
  oai('o phase commentary', `${Q} [[mode:phase-commentary]]`),
  oai('o function call', `${Q} [[mode:tool-use]]`),
  oai('o empty text', `${Q} [[mode:empty]]`),
  oai('o no verdict', `${Q} [[mode:no-verdict]]`),
  oai('o status failed', `${Q} [[mode:status-failed]]`, { reasks: 2 }),
  oai('o error set', `${Q} [[mode:error-set]]`, { reasks: 2 }),
  oai('o bad object', `${Q} [[mode:bad-object]]`, { reasks: 2 }),
  oai('o truncation auto echoed', `${Q} [[mode:echo-truncation-auto]]`, { reasks: 2 }),
  oai('o store true echoed', `${Q} [[mode:echo-store-true]]`, { reasks: 2 }),
  oai('o http 400', `${Q} [[mode:http-400]]`, { reasks: 2 }),
  oai('o http 503 at bound 0', `${Q} [[mode:http-503]]`),
  oai('o redirect', `${Q} [[mode:redirect]]`, { reasks: 2 }),
  oai('o encoded', `${Q} [[mode:encoded]]`, { reasks: 2 }),
  oai('o a mode the route has no counterpart for', `${Q} [[mode:stop-seq]]`),
  ant('a normal', Q),
  ant('a settings sent', Q, { effort: 'high', thinking: { type: 'adaptive' }, temperature: 0.5, cap: 64 }),
  ant('a budgeted thinking', Q, { thinking: { type: 'enabled', budget_tokens: 2048 }, cap: 4096 }),
  ant('a thinking block', `${Q} [[thinking]]`),
  ant('a cut then whole', `${Q} [[times:1:truncated]]`, { reasks: 2 }),
  ant('a cut, the bound used up', `${Q} [[times:2:truncated]]`, { reasks: 1 }),
  ant('a refusal', `${Q} [[mode:refusal]]`),
  ant('a stop sequence', `${Q} [[mode:stop-seq]]`),
  ant('a tool use', `${Q} [[mode:tool-use]]`),
  ant('a non-text', `${Q} [[mode:non-text]]`),
  ant('a http 400', `${Q} [[mode:http-400]]`, { reasks: 2 }),
];

type Outcome = { rec: J } | { error: string };

/** A child process run without blocking this one (the stand-in answers from this process): its status, stdout and stderr. */
function run(command: string, args: string[], input: string, env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}
const PY_DRIVER = `
import asyncio, json, sys
sys.path.insert(0, ${JSON.stringify(inspect)})
from inspect_ai.model import ChatMessageUser, GenerateConfig
import recording_grader as rg
async def no_wait(seconds):
    pass
rg._wait = no_wait
spec = json.load(sys.stdin)
out = []
for c in spec["cases"]:
    cfg = {"max_tokens": c["cap"]}
    if c.get("temperature") is not None:
        cfg["temperature"] = c["temperature"]
    args = {"wire": c["wire"], "effort": c["effort"], "max_reasks": c["reasks"], "api_key_env": spec["key_env"]}
    if c["wire"] == "openai-responses/v1":
        args["verbosity"] = c["verbosity"]
    else:
        args["thinking"] = c["thinking"]
    try:
        g = rg.RecordingGrader("judge-requested", base_url=c["base"], config=GenerateConfig(**cfg), **args)
        o = asyncio.run(g.generate([ChatMessageUser(content=c["prompt"])], [], "none", GenerateConfig(**cfg)))
        out.append({"rec": o.metadata["graderEvidence"]})
    except Exception as e:
        out.append({"error": str(e)})
print(json.dumps(out))
`;

const withDefaults = (c: Case): Required<Pick<Case, 'reasks' | 'effort' | 'cap'>> & Case => ({ ...c, reasks: c.reasks ?? 0, effort: c.effort ?? 'NOT_SENT', verbosity: c.verbosity ?? 'NOT_SENT', thinking: c.thinking ?? 'NOT_SENT', cap: c.cap ?? 256 });

async function runPython(): Promise<Outcome[]> {
  const ep = await startFakeEndpoint({ port: 0 });
  try {
    // each wire has its own route on the one stand-in: the base URL of a case is the host, and the host with /v1 for the OpenAI wire
    const host = `http://127.0.0.1:${ep.port}`;
    const cases = CASES.map((c) => ({ ...withDefaults(c), base: c.wire === OAI ? `${host}/v1` : host }));
    // Asynchronously: the stand-in answers from this process, so a blocking call would never get its answer.
    const r = await run(py as string, ['-c', PY_DRIVER], JSON.stringify({ key_env: KEY_ENV, cases }), scratchEnv({ [KEY_ENV]: KEY, PYTHONDONTWRITEBYTECODE: '1' }));
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout) as Outcome[];
  } finally {
    await ep.close();
  }
}

async function runJavaScript(): Promise<Outcome[]> {
  const ep = await startFakeEndpoint({ port: 0 });
  const saved = process.env[KEY_ENV];
  process.env[KEY_ENV] = KEY;
  // The in-process grader reads this process's environment: an address variable of the machine would refuse every OpenAI case.
  const savedAddresses = OPENAI_ADDRESS_VARIABLES.map((k) => [k, process.env[k]] as const);
  for (const k of OPENAI_ADDRESS_VARIABLES) delete process.env[k];
  try {
    const host = `http://127.0.0.1:${ep.port}`;
    const out: Outcome[] = [];
    for (const raw of CASES) {
      const c = withDefaults(raw);
      delete require.cache[GRADER_PATH];
      const Grader = require(GRADER_PATH) as new (o: unknown) => { callApi(p: string): Promise<{ metadata: { graderEvidence: J } }> };
      const config: J = { wire: c.wire, model: 'judge-requested', baseUrl: c.wire === OAI ? `${host}/v1` : host, effort: c.effort, maxReasks: c.reasks, apiKeyEnv: KEY_ENV };
      if (c.wire === OAI) {
        config['max_output_tokens'] = c.cap;
        config['verbosity'] = c.verbosity;
      } else {
        config['max_tokens'] = c.cap;
        config['thinking'] = c.thinking;
      }
      if (c.temperature !== undefined) config['temperature'] = c.temperature;
      try {
        const grader = new Grader({ id: 'file://grader-provider.cjs', config });
        const r = await grader.callApi(JSON.stringify([{ role: 'user', content: c.prompt }]));
        out.push({ rec: r.metadata.graderEvidence });
      } catch (e) {
        out.push({ error: (e as Error).message });
      }
    }
    return out;
  } finally {
    if (saved === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = saved;
    for (const [k, v] of savedAddresses) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await ep.close();
  }
}

/** A record without what differs between the two graders by construction: who wrote it, the ids and call numbers, the prompt hash (the text differs), the port. */
function normalised(rec: J): J {
  const c = JSON.parse(JSON.stringify(rec)) as J;
  delete c['grader'];
  delete c['graderRunId'];
  delete c['callSeq'];
  delete c['callId'];
  delete c['promptSha256'];
  c['responseId'] = '<id>';
  c['callShape'].endpoint = String(c['callShape'].endpoint).replace(/:\d+\//, ':<port>/');
  c['reask'].earlier = c['reask'].earlier.map((a: J) => {
    const k = { ...a };
    delete k['callSeq'];
    delete k['callId'];
    if ('responseId' in k) k['responseId'] = '<id>';
    return k;
  });
  return c;
}

describe('the Python grader and the JavaScript grader write the same record over the same exchanges', { skip: skipUnlessFound(py, 'no Python with inspect_ai on this machine (set ANCHORSET_INSPECT_VENV)') }, () => {
  let python: Outcome[] = [];
  let javascript: Outcome[] = [];
  before(async () => {
    python = await runPython();
    javascript = await runJavaScript();
  });

  it('every exchange is run by both, and the cases name every shape of the OpenAI wire', () => {
    assert.equal(python.length, CASES.length);
    assert.equal(javascript.length, CASES.length);
    assert.equal(new Set(CASES.map((c) => c.name)).size, CASES.length);
    assert.ok(CASES.filter((c) => c.wire === OAI).length >= 30);
  });

  for (const [i, c] of CASES.entries()) {
    it(`${c.name}`, () => {
      const p = python[i] as Outcome;
      const j = javascript[i] as Outcome;
      if ('error' in p || 'error' in j) {
        // either both end the slot with no record, or the records are compared
        assert.ok('error' in p && 'error' in j, `one grader ended the slot and the other wrote a record: python ${JSON.stringify(p).slice(0, 300)} / javascript ${JSON.stringify(j).slice(0, 300)}`);
        // The failure is the same sentence for every body the grader refuses on its own; a transport detail differs with the platform.
        if (!/transport|fetch failed|terminated|socket/i.test(p.error)) assert.equal(p.error, j.error, c.name);
        return;
      }
      assert.deepEqual(normalised(p.rec), normalised(j.rec), c.name);
      assert.equal(p.rec['wire'], c.wire);
      assert.equal(p.rec['grader'].language, 'python');
      assert.equal(j.rec['grader'].language, 'js');
    });
  }
});

// ---- the two parsers, fed the same bodies directly ---------------------------------------------------------------------------

/** A status 200 body of the Responses wire; a test names what differs. */
const body = (over: J = {}): J => ({ id: 'resp_body_1', object: 'response', model: 'judge-served', status: 'completed', incomplete_details: null, usage: { input_tokens: 10, output_tokens: 5 }, output: [], ...over });
const textMessage = (extra: J = {}): J => ({ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'ok\n\nGRADE: C' }], ...extra });
const BODIES: [string, J][] = [
  ['completed with output []', body()],
  ['a cut with output []', body({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })],
  ['a message with no parts beside a completed one', body({ output: [textMessage({ content: [] }), textMessage()] })],
  ['a message with no parts alone', body({ output: [textMessage({ content: [] })] })],
  ['a null phase', body({ output: [textMessage({ phase: null })] })],
  ['a phase final_answer', body({ output: [textMessage({ phase: 'final_answer' })] })],
  ['a phase commentary', body({ output: [textMessage({ phase: 'commentary' })] })],
  ['incomplete and max_messages', body({ status: 'incomplete', incomplete_details: { reason: 'max_messages' }, output: [textMessage()] })],
  ['incomplete and steered', body({ status: 'incomplete', incomplete_details: { reason: 'steered' }, output: [textMessage()] })],
  ['a normal body', body({ output: [textMessage()] })],
];

/** The JavaScript parser, taken out of the grader's source without a change to that file (it exports only the class). */
function javascriptParser(): (data: unknown) => unknown {
  const source = readFileSync(GRADER_PATH, 'utf8');
  return new Function('require', 'module', 'exports', '__dirname', '__filename', `${source}\nreturn parseResponses;`)(require, { exports: {} }, {}, dirname(GRADER_PATH), GRADER_PATH) as (data: unknown) => unknown;
}

describe('the Python parser and the JavaScript parser give the same answer to the same body', { skip: skipUnlessFound(py, 'no Python with inspect_ai on this machine (set ANCHORSET_INSPECT_VENV)') }, () => {
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(inspect)})
import recording_grader as rg
out = []
for b in json.load(sys.stdin):
    try:
        out.append({"ok": rg.parse_responses(b)})
    except Exception as e:
        out.append({"error": str(e)})
print(json.dumps(out))
`;
  const r = ((): { status: number | null; stdout: string; stderr: string } => spawnSync(py as string, ['-c', script], { input: JSON.stringify(BODIES.map(([, b]) => b)), encoding: 'utf8', env: scratchEnv({ PYTHONDONTWRITEBYTECODE: '1' }) }))();
  const python = r.status === 0 ? (JSON.parse(r.stdout) as J[]) : [];
  const parse = javascriptParser();
  const javascript = BODIES.map(([, b]) => {
    try {
      return { ok: parse(b) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  });
  it('the Python side ran', () => assert.equal(r.status, 0, r.stderr));
  for (const [i, [name]] of BODIES.entries()) {
    it(name, () => assert.deepEqual(python[i], javascript[i]));
  }
  it('the bodies that are whole are taken, and the shapes the test names are those the parsers hold', () => {
    const at = (name: string): J => javascript[BODIES.findIndex(([n]) => n === name)] as J;
    assert.deepEqual((at('completed with output []')['ok'] as J)['contentTypes'], []);
    assert.equal((at('a cut with output []')['ok'] as J)['cut'], true);
    assert.deepEqual((at('a message with no parts beside a completed one')['ok'] as J)['contentTypes'], ['message', 'message/output_text']);
    assert.ok('error' in at('a null phase'));
    assert.deepEqual((at('a phase final_answer')['ok'] as J)['contentTypes'], ['message[phase=final_answer]/output_text']);
    assert.deepEqual((at('a phase commentary')['ok'] as J)['contentTypes'], ['message[phase=commentary]/output_text']);
    for (const n of ['incomplete and max_messages', 'incomplete and steered']) assert.equal((at(n)['ok'] as J)['cut'], false, n);
  });
});

describe('status before text: a reply that a reading rule would accept is never graded when the response was cut, filtered or held a refusal (the Python grader\'s record)', { skip: skipUnlessFound(py, 'no Python with inspect_ai on this machine (set ANCHORSET_INSPECT_VENV)') }, () => {
  let python: Outcome[] = [];
  before(async () => {
    python = await runPython();
  });
  const recordOf = (name: string): J => {
    const i = CASES.findIndex((c) => c.name === name);
    const o = python[i] as Outcome;
    assert.ok('rec' in o, `${name}: ${JSON.stringify(o).slice(0, 300)}`);
    return parseRecord(o.rec, name, 'inspect') as unknown as J;
  };

  // This test pins an order: the reply of each of these records is a whole verdict the first reading rule accepts, and the label
  // `message/output_text` looks readable, so a check of the content before the stop would read it as a finished grade.
  for (const [name, why] of [
    ['o cut verdict-whole at bound 0', /stopped with status "incomplete" \(max_output_tokens\), not "completed"/],
    ['o cut verdict-whole, the bound used up', /cut at the output cap on each of 2 asks; the bound of 1 re-asks is used up/],
    ['o content filter', /stopped with status "incomplete" \(content_filter\), not "completed"/],
    ['o refusal after text', /holds a refusal part/],
    ['o refusal before text', /holds a refusal part/],
  ] as const) {
    it(`${name}: readSlot gives the stop or content reason at '', never a verdict`, () => {
      const rec = recordOf(name);
      // The reply the record holds is a verdict the Inspect importer's own reading (strictGrade) accepts, so the stop or the content
      // is the only thing that keeps the slot from being graded; and ungradedReason, which import.ts asks first, says so.
      assert.match(String(strictGrade(rec['reply'] as string)), /^[A-Z]$/, `${name}: the reply must hold a GRADE: line the rule accepts`);
      assert.match(String(ungradedReason(rec as never)), why, name);
      const read = readSlot(rec as never, READING_JSON_OBJECT);
      assert.ok('at' in read, `${name}: ${JSON.stringify(read)}`);
      assert.equal(read.at, '');
      assert.match(read.why, why);
    });
  }

  it('the cut verdict-whole is asked again within the bound (two asks), then ungraded; the others are final (one ask, a bound of 2 unused)', () => {
    assert.equal(recordOf('o cut verdict-whole, the bound used up')['reask'].earlier.length, 1);
    assert.equal(recordOf('o cut verdict-whole then whole')['reask'].earlier.length, 1);
    assert.equal(recordOf('o cut verdict-whole then whole')['stopReason'], 'completed');
    for (const name of ['o content filter', 'o refusal after text', 'o refusal before text', 'o refusal']) assert.deepEqual(recordOf(name)['reask'].earlier, [], name);
  });

  it('phase: final_answer and an absent phase are read; commentary is not (the fake endpoint sends final_answer by default)', () => {
    const q = (n: string): J => recordOf(n);
    assert.deepEqual(q('o normal')['contentTypes'], ['message[phase=final_answer]/output_text']);
    assert.deepEqual(q('o phase absent')['contentTypes'], ['message/output_text']);
    assert.deepEqual(q('o phase commentary')['contentTypes'], ['message[phase=commentary]/output_text']);
    assert.equal(ungradedReason(q('o normal') as never), undefined);
    assert.equal(ungradedReason(q('o phase absent') as never), undefined);
    assert.match(String(ungradedReason(q('o phase commentary') as never)), /not zero or more reasoning items followed by exactly one completed message/);
  });

  it('the Python tests of a slot (regrade.py\'s) and the importer\'s agree, record by record', () => {
    // regrade.py stops the re-grade at a slot the importer will refuse: its importer_refusal is the importer's ungradedReason for these records
    const script = `
import json, runpy, sys
m = runpy.run_path(${JSON.stringify(join(inspect, 'regrade.py'))}, run_name="not_main")
print(json.dumps([m["importer_refusal"](r) for r in json.load(sys.stdin)]))
`;
    const names = CASES.filter((c) => c.wire === OAI).map((c) => c.name).filter((n) => python[CASES.findIndex((c) => c.name === n)] !== undefined && 'rec' in (python[CASES.findIndex((c) => c.name === n)] as Outcome));
    const recs = names.map((n) => (python[CASES.findIndex((c) => c.name === n)] as { rec: J }).rec);
    const r = spawnSync(py as string, ['-c', script], { input: JSON.stringify(recs), encoding: 'utf8', env: scratchEnv({ PYTHONDONTWRITEBYTECODE: '1' }) });
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout) as (string | null)[];
    names.forEach((n, i) => {
      const rec = recordOf(n);
      let importer: string | undefined;
      try {
        const read = readSlot(rec as never, READING_JSON_OBJECT);
        importer = 'at' in read && read.at === '' ? read.why : undefined;
      } catch (e) {
        assert.ok(e instanceof ImportRefusal);
      }
      // regrade.py's test stops where the importer's stop-or-content test does (a reply with no strict GRADE line is a third thing, read at import)
      assert.equal(got[i] !== null && !/strict reading/.test(got[i] as string), importer !== undefined, `${n}: python ${String(got[i])} / importer ${String(importer)}`);
    });
  });
});

// ---- regrade.py: the --wire flag set (usage errors come before the log is read, so no inspect_ai is needed) ---------------------------

const python310 = ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python'].find((p) => spawnSync(p, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'], { env: { PATH: process.env['PATH'] ?? '' } }).status === 0);

describe('regrade.py: --wire selects the flags of a run, and a flag of the other wire is a usage error (64)', { skip: skipUnlessFound(python310, 'no Python 3.10 or later on this machine') }, () => {
  const regrade = (args: string[], extraEnv: Record<string, string> = {}) => spawnSync(python310 as string, [join(inspect, 'regrade.py'), ...args], { encoding: 'utf8', env: scratchEnv({ PYTHONDONTWRITEBYTECODE: '1', ...extraEnv }) });
  const common = ['--log', 'no-such-log.json', '--epochs', '1', '--judge-model', 'm', '--max-tokens', '16', '--out-dir', join(work, 'never'), '--base-url', 'http://127.0.0.1:1', '--effort', 'NOT_SENT', '--max-reasks', '0'];

  it('a run without --wire, with an unknown one, or with it stated twice or empty', () => {
    for (const [args, expected] of [
      [[...common, '--thinking', 'NOT_SENT'], /^usage error: a run needs \['--wire'\]/],
      [[...common, '--wire', 'openai', '--verbosity', 'NOT_SENT'], /^usage error: --wire must be one of anthropic-messages\/v1, openai-responses\/v1, found "openai"/],
      [[...common, '--wire', OAI, '--wire', OAI, '--verbosity', 'NOT_SENT'], /--wire was given twice/],
      [[...common, '--wire', '', '--verbosity', 'NOT_SENT'], /--wire was given an empty value/],
    ] as const) {
      const r = regrade([...args]);
      assert.equal(r.status, 64, r.stderr);
      assert.match(r.stderr, expected);
    }
    assert.equal(existsSync(join(work, 'never')), false);
  });

  it('each wire needs its own flag (--verbosity, or --thinking), and the other wire\'s flags are refused', () => {
    let r = regrade([...common, '--wire', OAI]);
    assert.equal(r.status, 64, r.stderr);
    assert.match(r.stderr, /^usage error: a run needs \['--verbosity'\]/);
    r = regrade([...common, '--wire', ANT]);
    assert.equal(r.status, 64, r.stderr);
    assert.match(r.stderr, /^usage error: a run needs \['--thinking'\]/);
    for (const extra of [['--thinking', 'NOT_SENT'], ['--api-version', '2023-06-01']]) {
      r = regrade([...common, '--wire', OAI, '--verbosity', 'NOT_SENT', ...extra]);
      assert.equal(r.status, 64, r.stderr);
      assert.match(r.stderr, new RegExp(`^usage error: ${extra[0]} is a flag of the anthropic-messages/v1 wire only; the wire stated is openai-responses/v1`));
    }
    r = regrade([...common, '--wire', ANT, '--thinking', 'NOT_SENT', '--verbosity', 'low']);
    assert.equal(r.status, 64, r.stderr);
    assert.match(r.stderr, /^usage error: --verbosity is a flag of the openai-responses\/v1 wire only/);
    assert.equal(existsSync(join(work, 'never')), false);
  });

  it('--check takes no wire', () => {
    const r = regrade(['--log', 'no-such-log.json', '--epochs', '1', '--check', '--wire', OAI]);
    assert.equal(r.status, 64, r.stderr);
    assert.match(r.stderr, /--check makes no call and takes none of/);
  });

  it('each of the four OpenAI address variables stops a run that states another address, naming the variable and never its value; the Anthropic wire is not stopped by them', () => {
    for (const name of ['OPENAI_BASE_URL', 'OPENAI_API_BASE_URL', 'OPENAI_API_HOST', 'OPENAI_HOST']) {
      const r = regrade([...common, '--wire', OAI, '--verbosity', 'NOT_SENT'], { [name]: 'http://127.0.0.1:4000/private-path' });
      assert.equal(r.status, 64, r.stderr);
      assert.match(r.stderr, new RegExp(`^usage error: the environment variable ${name} is set, and this grader never reads it`));
      assert.ok(!r.stderr.includes('private-path') && !r.stderr.includes('4000'), 'the value is not printed');
      // a bare host can never equal a base URL: for the two HOST variables the one remedy is to unset the variable
      if (name.endsWith('_HOST')) assert.ok(r.stderr.includes(' Unset the variable. Nothing was written') && !r.stderr.includes('State the same address'), r.stderr);
      else assert.ok(r.stderr.includes('State the same address with --base-url, or unset the variable. Nothing was written'), r.stderr);
      // the same address stated is not refused for the variable (it goes on, and ends on the missing log)
      const same = regrade([...common.slice(0, common.indexOf('--base-url')), '--base-url', 'http://127.0.0.1:4000/private-path', ...common.slice(common.indexOf('--base-url') + 2), '--wire', OAI, '--verbosity', 'NOT_SENT'], { [name]: 'http://127.0.0.1:4000/private-path' });
      assert.doesNotMatch(same.stderr, /this grader never reads it/);
      const other = regrade([...common, '--wire', ANT, '--thinking', 'NOT_SENT'], { [name]: 'http://127.0.0.1:4000/private-path' });
      assert.doesNotMatch(other.stderr, /this grader never reads it/);
    }
  });
});
