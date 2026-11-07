import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { CALL_SHAPE_SCHEMA, callShapeHash, NOT_SENT } from '../src/callshape.ts';
import type { CallShape } from '../src/callshape.ts';
import { hashOf, NO_JUDGE, outputHashOf, sha256Hex } from '../src/identity.ts';
import type { RunIdentity } from '../src/identity.ts';
import type { PacketBasis, RunArtifact } from '../src/artifact.ts';
import { caseSetHash as caseSetHashOf } from '../src/artifact.ts';
import { barHash as barHashOf } from '../src/gate.ts';
import type { BarFile } from '../src/gate.ts';
import type { GateInputs } from '../src/ledger.ts';
import { gateAdmission, gateRuns as gateRunsDirect } from '../src/regression.ts';
import type { GateRunResult } from '../src/regression.ts';
import type { Attempt, Draw, FailedAttempt, FailReason, GradedAttempt } from '../src/scoring.ts';

/** The packet every judged test attempt was shown, unless a test says otherwise. */
export const PACKET = sha256Hex('packet');

/** A graded attempt from a code-graded run; pass { judgeStop: 'tool-use' } for a judged run, which then carries PACKET. */
export function gradedAttempt(label: string, over: Partial<GradedAttempt> = {}): GradedAttempt {
  const judged = over.judgeStop !== undefined && over.judgeStop !== NO_JUDGE;
  const base: GradedAttempt = { kind: 'graded', label, outputHash: sha256Hex(`output ${label}`), systemStop: 'tool-use', judgeStop: NO_JUDGE, packetHash: judged ? PACKET : NO_JUDGE };
  return Object.assign(base, over);
}

/** A failed attempt, hashing its own failure record as the output. */
export function failedAttempt(reason: FailReason, over: Partial<FailedAttempt> = {}): FailedAttempt {
  const base: FailedAttempt = { kind: 'failed', reason, detail: reason, outputHash: outputHashOf({ failed: reason }), systemStop: reason === 'truncated' ? 'max-tokens' : NOT_SENT };
  return Object.assign(base, over);
}

/** An attempt that measured nothing: the system gave no response, or the judge could not grade. */
export function unmeasured(role: 'system' | 'judge', reason: string, outputHash = sha256Hex('judged output')): Attempt {
  return (role === 'system' ? { kind: 'unmeasured', role, reason, detail: reason } : { kind: 'unmeasured', role, reason, detail: reason, outputHash, systemStop: 'tool-use', packetHash: PACKET }) as Attempt;
}

/** One draw slot with its attempts, the last being the outcome. */
export function slot(caseId: string, drawIndex: number, ...attempts: Attempt[]): Draw {
  return { caseId, drawIndex, attempts };
}

/** A fully known call shape for the system under test (a forced routing tool); override any key. */
export function makeCallShape(overrides: Partial<CallShape> = {}): CallShape {
  const base: CallShape = {
    schema: CALL_SHAPE_SCHEMA,
    endpoint: 'example-provider:messages',
    apiVersion: '2026-01-01',
    betaFlags: [],
    thinkingMode: 'off',
    thinkingBudgetTokens: NOT_SENT,
    effort: NOT_SENT,
    toolChoice: 'named',
    toolChoiceName: 'route',
    strictTools: true,
    parallelToolUse: false,
    temperature: 0,
    topP: NOT_SENT,
    topK: NOT_SENT,
    frequencyPenalty: NOT_SENT,
    presencePenalty: NOT_SENT,
    samplingSeed: NOT_SENT,
    maxOutputTokens: 512,
    stopSequences: NOT_SENT,
    responseFormat: { kind: 'tool', name: 'route' },
    contextPolicy: 'none',
    stream: false,
    timeoutMs: 30000,
    extras: {},
  };
  return Object.assign(base, overrides);
}

/** A fully known call shape for a judge that grades through a forced "grade" tool. */
export function makeJudgeCallShape(overrides: Partial<CallShape> = {}): CallShape {
  return makeCallShape({ toolChoiceName: 'grade', responseFormat: { kind: 'tool', name: 'grade' }, maxOutputTokens: 256, ...overrides });
}

/** A run graded by code: every judge field is NO_JUDGE. */
export function makeIdentity(overrides: Partial<RunIdentity> = {}): RunIdentity {
  return {
    caseSetHash: hashOf('cases'),
    rubricHash: hashOf('rubric'),
    barHash: hashOf('bar'),
    systemModelRequested: 'model-x',
    systemModelServed: 'model-x-2026-01-01',
    systemCallShapeHash: callShapeHash(makeCallShape()),
    systemPromptHash: hashOf('prompt'),
    systemToolsHash: hashOf([]),
    systemHarnessVersion: 'h1',
    judgeDefinitionHash: NO_JUDGE,
    judgeModelRequested: NO_JUDGE,
    judgeModelServed: NO_JUDGE,
    judgeCallShapeHash: NO_JUDGE,
    judgeHarnessVersion: NO_JUDGE,
    seed: 42,
    drawsPerCase: 3,
    ...overrides,
  };
}

/** A run graded by an LLM judge. */
export function makeJudgedIdentity(overrides: Partial<RunIdentity> = {}): RunIdentity {
  return makeIdentity({
    judgeDefinitionHash: hashOf('judge prompt v1'),
    judgeModelRequested: 'judge-alias',
    judgeModelServed: 'judge-2026-01-01',
    judgeCallShapeHash: callShapeHash(makeJudgeCallShape()),
    judgeHarnessVersion: 'judge-harness 1',
    ...overrides,
  });
}

/** The packet basis a valid run with this identity declares: recorded when judged, NO_JUDGE when graded by code. */
export function packetBasisFor(identity: RunIdentity): { packetBasis: PacketBasis } {
  return { packetBasis: identity.judgeDefinitionHash === NO_JUDGE ? NO_JUDGE : 'recorded' };
}

/** The call-shape records that match makeIdentity / makeJudgedIdentity's declared hashes. */
export function callShapesFor(identity: RunIdentity): { system: CallShape; judge: CallShape | typeof NO_JUDGE } {
  return { system: makeCallShape(), judge: identity.judgeDefinitionHash === NO_JUDGE ? NO_JUDGE : makeJudgeCallShape() };
}

/**
 * The script's own stderr. Node may write runtime warnings before the script writes anything (Node 22 prints one, with
 * a "(Use `node --trace-warnings ...`)" line after it, when NODE_USE_ENV_PROXY is set). Only lines of those two forms,
 * and only before the script's first line, are taken off; everything else is kept, so an assertion anchored at the
 * start still checks the script's own first line.
 */
const NODE_WARNING_LINE = /^(?:\(node:\d+\) (?:\[[A-Z0-9_-]+\] )?[A-Za-z]*Warning: [^\n]*|\(Use `node --trace-warnings \.\.\.` to show where the warning was created\))\n/;
export function ownStderr(text: string): string {
  let t = text;
  while (NODE_WARNING_LINE.test(t)) t = t.replace(NODE_WARNING_LINE, '');
  return t;
}

/** What a gate was given, in the ledger's own shape: two identical identities, a bar hash and no waived field. Override any key. */
export function gateInputs(over: Partial<GateInputs> = {}): GateInputs {
  return { baseline: makeIdentity(), candidate: makeIdentity(), barHash: hashOf('bar'), allowDiffer: [], ...over };
}

/** A scratch copy of a run with its packet basis set to "recorded": the packet source is dropped, as the format allows it only beside "declared". */
export function asRecorded(run: RunArtifact): RunArtifact {
  const { packetSource: _dropped, ...rest } = structuredClone(run);
  return { ...rest, packetBasis: 'recorded' };
}

/**
 * Outside the two pinned sentences (test/drift.test.ts), no shipped text puts a number on how often a repeated reading
 * of one judge state is called shifted. `text` is a document with its whitespace runs folded to single spaces.
 */
export function assertNoRateBesideRepeatedReading(text: string): void {
  assert.doesNotMatch(text, /classified other than/);
  for (const sentence of text.split(/(?<=[.:;]) /).filter((x) => /read(ing)?s? [^.]{0,40}twice|read twice|both readings|repeat-reading|one (judge )?state|same state/i.test(x))) {
    assert.doesNotMatch(sentence, /\d\s?%|\bof 10,000\b|\d+ in \d+/, `a rate beside a repeated reading, outside the pinned sentences: ${sentence}`);
  }
}

/** The variable that names a study's manifests, for a test that recomputes the study's tables: comma-separated files, in the order the table was made in. */
export const STUDY_MANIFESTS_VARIABLE = 'ANCHORSET_STUDY_MANIFESTS';

/**
 * The manifest files the variable names, as absolute paths in the order given. Unset gives none. A set variable is read
 * whole: an empty value, an empty or repeated name, or a name that is not a readable file is a refusal that names the
 * variable, never a shorter list.
 */
export function studyManifestPaths(value: string | undefined, base: string): string[] {
  if (value === undefined) return [];
  const paths: string[] = [];
  for (const raw of value.split(',')) {
    const name = raw.trim();
    if (name === '') throw new Error(`${STUDY_MANIFESTS_VARIABLE} holds an empty name (value ${JSON.stringify(value)})`);
    const path = resolve(base, name);
    if (paths.includes(path)) throw new Error(`${STUDY_MANIFESTS_VARIABLE} names ${name} twice`);
    let isFile = false;
    try {
      isFile = statSync(path).isFile();
    } catch {
      // not readable: refused below
    }
    if (!isFile) throw new Error(`${STUDY_MANIFESTS_VARIABLE} names ${name}, which is not a file that can be read`);
    paths.push(path);
  }
  return paths;
}

/**
 * `gateRuns`, with the admission held to it on every call: where the gate refuses, the first entry of `gateAdmission`
 * is that refusal (code, fields and message); where it evaluates, the admission is empty; where it throws, the
 * admission throws the same error, or is empty because the error came after it (the fold of the candidate or of the
 * original baseline). So every gate fixture of a test that calls this is a parity fixture of the one admission check.
 */
export function gateRunsWithAdmission(...args: Parameters<typeof gateRunsDirect>): GateRunResult {
  let result: GateRunResult;
  try {
    result = gateRunsDirect(...args);
  } catch (e) {
    let admitted: unknown;
    try {
      admitted = gateAdmission(...args);
    } catch (x) {
      assert.ok(x instanceof Error && e instanceof Error && x.constructor === e.constructor && x.message === e.message, 'gateAdmission throws what gateRuns throws');
      throw e;
    }
    assert.deepEqual(admitted, [], 'where gateRuns throws after its admission, the admission is empty');
    throw e;
  }
  const items = gateAdmission(...args);
  if (result.kind === 'refused') {
    const first = items[0];
    assert.ok(first !== undefined && first.kind === 'refused', 'gateAdmission lists a refusal first where gateRuns refuses');
    const { code, fields, message } = first.refusal;
    assert.deepEqual({ code, fields: [...fields], message }, { code: result.refusal.code, fields: [...result.refusal.fields], message: result.refusal.message });
  } else {
    assert.deepEqual(items, [], 'gateAdmission is empty where gateRuns evaluates');
  }
  return result;
}

// --- The refund-bot fixtures of the judge-change report: one generator for the judge diff, the judge-flip list and the
// no-grade counts. Synthetic data only. ---------------------------------------------------------------------------

/** A bar of the refund bot: grades 1 to 5, an answer passes at 4 or above; refund_policy is non-compensable. */
export const REFUND_BAR = Object.freeze({
  labels: ['1', '2', '3', '4', '5'],
  classes: { reply_quality: { direction: 'floor', minPassRate: 0.5 }, refund_policy: { direction: 'floor', nonCompensable: true, minPassRate: 1 } },
  knownFailures: [],
}) as unknown as BarFile;

/** The three judges of the fixtures: one requested name served by two dated snapshots, and a cheaper one. */
export const OLD_JUDGE: Partial<RunIdentity> = { judgeModelRequested: 'example-judge', judgeModelServed: 'example-judge-2026-01-15' };
export const NEW_JUDGE: Partial<RunIdentity> = { judgeModelRequested: 'example-judge', judgeModelServed: 'example-judge-2026-06-01' };
export const MINI_JUDGE: Partial<RunIdentity> = { judgeModelRequested: 'example-judge-mini', judgeModelServed: 'example-judge-mini-2026-09-01' };

/**
 * One draw of a fixture: a label, graded on the case's stored answer; "!<reason>" for a judge that gave no grade on it
 * (parse-failure, content-filter, truncated, timeout, client-error ...); "~<reason>" for a system with no response
 * (timeout ...); "T" for an answer cut at its cap, "E" for the system's own error; "-" for a slot with no record.
 */
export type DrawSpec = string;

export type RefundRunOptions = {
  /** Case id -> one spec per draw. A case id starting with "p" is of class refund_policy, any other of reply_quality. */
  grades: Record<string, readonly DrawSpec[]>;
  identity?: Partial<RunIdentity>;
  /** The stored answer of a draw; one answer per case by default. */
  answer?: (caseId: string, drawIndex: number) => string;
  packetBasis?: PacketBasis;
  /** Earlier attempts of a slot ("case#draw"), before its outcome: judge retries. */
  retries?: Record<string, readonly Attempt[]>;
  judgeShape?: CallShape;
};

export const refundCases = (ids: readonly string[]): { id: string; klass: string; input: unknown; expect: string }[] =>
  ids.map((id) => ({ id, klass: id.startsWith('p') ? 'refund_policy' : 'reply_quality', input: { message: `Where is my refund for order ${id}?` }, expect: '4' }));

/** A run of the refund bot graded by a judge, with recorded packets unless told otherwise. */
export function refundRun(o: RefundRunOptions): RunArtifact {
  const ids = Object.keys(o.grades).sort();
  const cases = refundCases(ids);
  const n = Math.max(...ids.map((id) => (o.grades[id] as readonly DrawSpec[]).length));
  const answer = o.answer ?? ((id: string) => `Your refund for order ${id} is on its way.`);
  const judgeShape = o.judgeShape ?? makeJudgeCallShape();
  const identity = makeJudgedIdentity({ caseSetHash: caseSetHashOf(cases), barHash: barHashOf(REFUND_BAR), drawsPerCase: n, judgeCallShapeHash: callShapeHash(judgeShape), ...OLD_JUDGE, ...o.identity });
  const draws: Draw[] = [];
  for (const id of ids) {
    (o.grades[id] as readonly DrawSpec[]).forEach((spec, d) => {
      if (spec === '-') return;
      const text = answer(id, d);
      const outputHash = outputHashOf(text);
      const packetHash = o.packetBasis === 'UNKNOWN' ? 'UNKNOWN' : sha256Hex(`packet ${id} ${text}`);
      let last: Attempt;
      if (spec === 'T') last = failedAttempt('truncated', { outputHash });
      else if (spec === 'E') last = failedAttempt('system-error');
      else if (spec.startsWith('~')) last = { kind: 'unmeasured', role: 'system', reason: spec.slice(1), detail: '' } as Attempt;
      else if (spec.startsWith('!')) last = { kind: 'unmeasured', role: 'judge', reason: spec.slice(1), detail: '', outputHash, systemStop: 'end', packetHash } as Attempt;
      else last = { kind: 'graded', label: spec, outputHash, systemStop: 'end', judgeStop: 'tool-use', packetHash };
      draws.push({ caseId: id, drawIndex: d, attempts: [...(o.retries?.[`${id}#${d}`] ?? []), last] });
    });
  }
  const basis = o.packetBasis ?? 'recorded';
  return { schema: 'anchorset.run/v3', identity, callShapes: { system: makeCallShape(), judge: judgeShape }, cases, draws, packetBasis: basis, ...(basis === 'declared' ? { packetSource: 'the rendered grading prompt of the refund-bot eval' } : {}) };
}

/** A judge retry on a stored answer: an earlier attempt of the slot that got no reply. */
export function judgeRetry(caseId: string, reason: 'timeout' | 'rate-limited' | 'server-error' | 'transport' | 'truncated', answer = `Your refund for order ${caseId} is on its way.`): Attempt {
  return { kind: 'unmeasured', role: 'judge', reason, detail: '', outputHash: outputHashOf(answer), systemStop: 'end', packetHash: sha256Hex(`packet ${caseId} ${answer}`) } as Attempt;
}

// ---- the environment of a test that runs a grader as a subprocess (the paid-API guard) --------------------------------

/** The sentinel keys every such environment holds. Neither is a key of any account: a request that carried one would be refused by any real host. */
export const SENTINEL_KEYS = Object.freeze({ ANTHROPIC_API_KEY: 'sentinel-anthropic-key-not-a-real-key', OPENAI_API_KEY: 'sentinel-openai-key-not-a-real-key' });

/**
 * An environment for a subprocess that runs a recording grader, built from scratch: the machine's PATH, the two sentinel keys, and
 * what `extra` adds. Nothing else of this process's environment comes along, so a real key, a gateway address (`*_BASE_URL`,
 * `*_HOST`) or a proxy setting on the machine that runs the tests cannot reach a grader. A test that sets an address variable on
 * purpose, to see the grader refuse it, passes it in `extra`.
 */
export function scratchEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return { PATH: process.env['PATH'] ?? '', ...SENTINEL_KEYS, ...extra };
}

/** ANCHORSET_REQUIRE_INSPECT=1 (the importers job of CI, the release check): a test that needs Python or inspect_ai fails instead of being skipped. */
export const REQUIRE_INSPECT = process.env['ANCHORSET_REQUIRE_INSPECT'] === '1';

/** Inside a test: skip for this reason, or fail with it when the Python tier is required. */
export function skipOrFail(t: { skip: (reason?: string) => void }, reason: string): void {
  if (REQUIRE_INSPECT) assert.fail(`${reason} (ANCHORSET_REQUIRE_INSPECT=1: a skip is a failure)`);
  t.skip(reason);
}

/** For a describe() options object: the skip reason, or false when there is none. Under the require switch a missing tool throws at load, so the file fails. */
export function skipUnlessFound(found: unknown, reason: string): string | false {
  if (found !== undefined) return false;
  if (REQUIRE_INSPECT) throw new Error(`${reason} (ANCHORSET_REQUIRE_INSPECT=1: a skip is a failure)`);
  return reason;
}
