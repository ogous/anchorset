import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { CALL_SHAPE_SCHEMA, callShapeHash, NOT_SENT } from '../src/callshape.ts';
import type { CallShape } from '../src/callshape.ts';
import { hashOf, NO_JUDGE, outputHashOf, sha256Hex } from '../src/identity.ts';
import type { RunIdentity } from '../src/identity.ts';
import type { PacketBasis, RunArtifact } from '../src/artifact.ts';
import type { GateInputs } from '../src/ledger.ts';
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
