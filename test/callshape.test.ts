import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callShapeDiff, callShapeHash, NOT_SENT, validateCallShape } from '../src/callshape.ts';
import type { CallShape } from '../src/callshape.ts';
import { InputError } from '../src/errors.ts';
import { GAP } from '../src/identity.ts';
import { makeCallShape } from './helpers.ts';

const problems = (overrides: Record<string, unknown>): string[] => validateCallShape({ ...makeCallShape(), ...overrides });
const refused = (overrides: Record<string, unknown>, fragment: string): void => {
  const p = problems(overrides);
  assert.ok(p.some((x) => x.includes(fragment)), `expected a problem containing "${fragment}", got ${JSON.stringify(p)}`);
};

test('callShapeHash: golden vector (sha256 of the canonical JSON, computed outside this library)', () => {
  const shape: CallShape = {
    schema: 'anchorset.callshape/v1',
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
  assert.equal(callShapeHash(shape), 'a11e51bfa39c62091c91a8ede2d82ba0709e685019a28797698900e6b10a287d');
});

test('callShapeHash: a gap at any depth, extras included, makes the whole hash UNKNOWN', () => {
  for (const over of [
    { effort: GAP },
    { stopSequences: ['END', GAP] },
    { betaFlags: [GAP] },
    { responseFormat: { kind: 'tool', name: GAP } },
    { extras: { 'vendor.service_tier': { level: GAP } } },
    { extras: GAP },
  ] as Partial<CallShape>[]) {
    assert.equal(callShapeHash(makeCallShape(over)), GAP, JSON.stringify(over));
  }
});

test('callShapeHash: NOT_SENT is a known value, distinct from a sent default; an endpoint is never NOT_SENT', () => {
  const unsent = callShapeHash(makeCallShape({ temperature: NOT_SENT }));
  assert.notEqual(unsent, GAP);
  assert.notEqual(unsent, callShapeHash(makeCallShape({ temperature: 1 })));
  refused({ endpoint: NOT_SENT }, 'endpoint');
});

test('validateCallShape: every named key is required and an unknown key is refused', () => {
  const { effort: _dropped, ...missing } = makeCallShape();
  assert.ok(validateCallShape(missing).some((p) => p.includes('effort: missing')));
  refused({ decoder: 'api' }, 'decoder: unknown field');
  refused({ temperature: null }, 'temperature: null');
});

test('validateCallShape: enumerable knobs are closed lists, not open tokens', () => {
  refused({ thinkingMode: 'extended' }, 'thinkingMode');
  refused({ thinkingMode: 'budget-4096' }, 'thinkingMode');
  refused({ effort: 'unknown' }, 'effort');
  refused({ contextPolicy: 'magic' }, 'contextPolicy');
  refused({ toolChoice: 'forced' }, 'toolChoice');
});

test('validateCallShape: free-text keys refuse gap spellings in any case', () => {
  refused({ endpoint: 'unknown' }, 'endpoint');
  refused({ apiVersion: 'N/A' }, 'apiVersion');
  refused({ toolChoiceName: 'None' }, 'toolChoiceName');
  refused({ responseFormat: { kind: 'tool', name: 'not_sent' } }, 'responseFormat');
});

test('validateCallShape: numbers and lists have fixed grammars', () => {
  refused({ maxOutputTokens: 0 }, 'maxOutputTokens');
  refused({ topP: 1.5 }, 'topP');
  refused({ temperature: -0.1 }, 'temperature');
  refused({ betaFlags: ['b', 'a'] }, 'betaFlags');
  refused({ stopSequences: ['b', 'a'] }, 'stopSequences');
  refused({ responseFormat: { kind: 'json-schema', schemaHash: 'x' } }, 'responseFormat');
});

test('validateCallShape: a thinking budget only with budgeted thinking, a tool name only with a named tool', () => {
  refused({ thinkingMode: 'off', thinkingBudgetTokens: 4096 }, 'thinkingBudgetTokens');
  refused({ thinkingMode: 'budgeted', thinkingBudgetTokens: NOT_SENT }, 'thinkingBudgetTokens');
  assert.deepEqual(problems({ thinkingMode: 'budgeted', thinkingBudgetTokens: 4096 }), []);
  refused({ toolChoice: 'named', toolChoiceName: NOT_SENT }, 'toolChoiceName');
  refused({ toolChoice: 'auto', toolChoiceName: 'route' }, 'toolChoiceName');
  assert.deepEqual(problems({ toolChoice: 'auto', toolChoiceName: NOT_SENT }), []);
});

test('validateCallShape: extras keys are namespaced, cannot shadow a named key at any depth, and hold no null', () => {
  refused({ extras: { temperature: 0 } }, 'namespace');
  for (const key of ['vendor.max_tokens', 'vendor.reasoning_effort', 'vendor.seed', 'vendor.context_management', 'vendor.schema', 'vendor.parallel_tool_calls']) {
    refused({ extras: { [key]: 1 } }, 'shadows');
  }
  refused({ extras: { 'vendor.opts': { temperature: 0.7 } } }, 'shadows');
  refused({ extras: { 'vendor.service_tier': { level: null } } }, 'null');
  assert.deepEqual(problems({ extras: { 'vendor.service_tier': 'priority' } }), []);
});

test('callShapeHash throws INVALID_CALL_SHAPE listing every problem', () => {
  assert.throws(
    () => callShapeHash(makeCallShape({ maxOutputTokens: -1, effort: 'High' as CallShape['effort'] })),
    (e: unknown) => e instanceof InputError && e.code === 'INVALID_CALL_SHAPE' && e.problems.length === 2,
  );
});

test('validateCallShape: a gap inside a value does not switch off its grammar or the null check', () => {
  refused({ betaFlags: [GAP, null] }, 'null');
  refused({ temperature: { x: GAP } }, 'temperature');
  refused({ responseFormat: { kind: 'weird', name: GAP } }, 'responseFormat');
  refused({ stopSequences: [GAP, ''] }, 'stopSequences');
  assert.deepEqual(problems({ betaFlags: [GAP, 'a'] }), []);
});

test('validateCallShape: the schema id, the response format and the numbers are pinned', () => {
  refused({ schema: 'anchorset.callshape/v0' }, 'schema');
  refused({ responseFormat: { kind: 'json-schema', name: 'x', schemaHash: 'a'.repeat(64) } }, 'responseFormat');
  refused({ topK: 0 }, 'topK');
  refused({ samplingSeed: 1.5 }, 'samplingSeed');
  refused({ timeoutMs: 0 }, 'timeoutMs');
  refused({ frequencyPenalty: 'high' }, 'frequencyPenalty');
  refused({ thinkingMode: 'budgeted', thinkingBudgetTokens: 0 }, 'thinkingBudgetTokens');
});

test('validateCallShape: an extras key has no empty segment, and no segment after the namespace may shadow a named key', () => {
  refused({ extras: { 'vendor.max_tokens.': 1 } }, 'namespace.name');
  refused({ extras: { 'vendor..seed': 1 } }, 'namespace.name');
  refused({ extras: { 'vendor.max_tokens.value': 1 } }, 'shadows');
});

test('callShapeDiff names the keys that differ, and the keys that are unknown', () => {
  assert.deepEqual(callShapeDiff(makeCallShape(), makeCallShape()), []);
  assert.deepEqual(callShapeDiff(makeCallShape(), makeCallShape({ temperature: 0.3 })), ['temperature 0 -> 0.3']);
  assert.deepEqual(callShapeDiff(makeCallShape({ effort: GAP }), makeCallShape({ effort: GAP })), ['effort unknown']);
});

test('effort "none" is a word that was sent: it validates, hashes apart from NOT_SENT, and reads as a move; near spellings and the same word in extras stay refused', () => {
  assert.deepEqual(problems({ effort: 'none' }), []);
  const sent: CallShape = { ...makeCallShape(), effort: 'none' };
  const notSent: CallShape = { ...makeCallShape(), effort: NOT_SENT };
  assert.notEqual(callShapeHash(sent), callShapeHash(notSent));
  assert.notEqual(callShapeHash(sent), GAP);
  assert.ok(callShapeDiff(notSent, sent).some((d) => d.includes('effort') && d.includes('"none"')));
  refused({ effort: 'None' }, 'effort');
  refused({ effort: 'unknown' }, 'effort');
  refused({ extras: { 'openai.reasoning_effort': 'none' } }, 'shadows');
});
