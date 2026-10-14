import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertComparable,
  canonicalJson,
  duplicateKeyProblem,
  GAP,
  hashOf,
  identityDiff,
  IDENTITY_FIELDS,
  NO_JUDGE,
  NO_SEED,
  packetHashOf,
  parseIdentity,
  parseJsonText,
  RefusalError,
  sha256Hex,
  validateIdentity,
} from '../src/identity.ts';
import { InputError } from '../src/errors.ts';
import type { RunIdentity } from '../src/identity.ts';
import { makeIdentity, makeJudgedIdentity } from './helpers.ts';

test('canonicalJson is independent of key order at every depth', () => {
  const a = { b: 1, a: { d: [3, { y: 1, x: 2 }], c: 'x' } };
  const b = { a: { c: 'x', d: [3, { x: 2, y: 1 }] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"a":{"c":"x","d":[3,{"x":2,"y":1}]},"b":1}');
  assert.equal(hashOf(a), hashOf(b));
});

test('canonicalJson keeps array order and handles primitives', () => {
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.equal(canonicalJson('é"'), '"é\\""');
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson(true), 'true');
  assert.equal(canonicalJson(-0), '0');
});

test('canonicalJson rejects undefined, functions, NaN, Infinity, cycles and class instances', () => {
  assert.throws(() => canonicalJson(undefined), TypeError);
  assert.throws(() => canonicalJson({ a: undefined }), TypeError);
  assert.throws(() => canonicalJson([undefined]), TypeError);
  assert.throws(() => canonicalJson({ f: () => 1 }), TypeError);
  assert.throws(() => canonicalJson(Number.NaN), TypeError);
  assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY), TypeError);
  assert.throws(() => canonicalJson(new Date(0)), TypeError);
  const cyc: Record<string, unknown> = {};
  cyc['self'] = cyc;
  assert.throws(() => canonicalJson(cyc), TypeError);
  const shared = { x: 1 };
  assert.equal(canonicalJson([shared, shared]), '[{"x":1},{"x":1}]');
});

test('sha256Hex returns the full 64-char digest (FIPS 180-2 "abc" vector)', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(Buffer.from('abc')), sha256Hex('abc'));
});

test('validateIdentity accepts gaps and NO_JUDGE, rejects nulls, truncated hashes and missing fields', () => {
  assert.deepEqual(validateIdentity(makeIdentity({ systemModelServed: GAP, seed: GAP })), []);
  assert.deepEqual(validateIdentity(makeIdentity({ judgeDefinitionHash: NO_JUDGE })), []);
  const bad = { ...makeIdentity(), systemModelServed: null, rubricHash: 'abc123', extra: 1 } as unknown;
  const problems = validateIdentity(bad);
  assert.ok(problems.some((p) => p.includes('systemModelServed') && p.includes('null')));
  assert.ok(problems.some((p) => p.includes('rubricHash')));
  assert.ok(problems.some((p) => p.includes('extra')));
  const { seed: _seed, ...missing } = makeIdentity();
  assert.ok(validateIdentity(missing).some((p) => p.includes('seed') && p.includes('missing')));
  assert.throws(() => parseIdentity(bad), InputError);
});

test('identityDiff lists differing fields', () => {
  const a = makeIdentity();
  const b = makeIdentity({ systemModelServed: 'model-x-2026-06-01', seed: 7 });
  assert.deepEqual(identityDiff(a, b), ['systemModelServed', 'seed']);
  assert.deepEqual(identityDiff(a, a), []);
});

test('assertComparable refuses a differing field unless it is allowed', () => {
  const a = makeIdentity();
  const b = makeIdentity({ systemModelServed: 'model-x-2026-06-01' });
  assert.doesNotThrow(() => assertComparable(a, a));
  assert.throws(
    () => assertComparable(a, b),
    (e: unknown) => e instanceof RefusalError && e.code === 'IDENTITY_MISMATCH' && e.fields.join() === 'systemModelServed',
  );
  assert.doesNotThrow(() => assertComparable(a, b, { allowDiffer: ['systemModelServed'] }));
});

test('assertComparable refuses a gap, even when both sides are gaps and even when the field is allowed to differ', () => {
  const a = makeIdentity({ systemModelServed: GAP });
  const b = makeIdentity({ systemModelServed: GAP });
  assert.throws(
    () => assertComparable(a, b),
    (e: unknown) => e instanceof RefusalError && e.code === 'IDENTITY_GAP' && e.fields.join() === 'systemModelServed',
  );
  assert.throws(() => assertComparable(a, b, { allowDiffer: ['systemModelServed'] }), RefusalError);
  assert.throws(() => assertComparable(makeIdentity(), makeIdentity({ seed: GAP })), RefusalError);
});

test('assertComparable reports mismatches and gaps together', () => {
  const a = makeIdentity({ systemHarnessVersion: GAP });
  const b = makeIdentity({ barHash: hashOf('other bar') });
  assert.throws(
    () => assertComparable(a, b),
    (e: unknown) => e instanceof RefusalError && e.code === 'IDENTITY_MISMATCH' && e.fields.join() === 'barHash,systemHarnessVersion',
  );
});

test('assertComparable rejects an unknown allowDiffer field', () => {
  const a = makeIdentity();
  assert.throws(() => assertComparable(a, a, { allowDiffer: ['nope' as 'seed'] }), InputError);
});

test('assertComparable refuses a gap even on an allowed field (a declared difference must be known)', () => {
  const a = makeIdentity({ systemModelServed: 'model-a' });
  const b = makeIdentity({ systemModelServed: GAP });
  assert.throws(
    () => assertComparable(a, b, { allowDiffer: ['systemModelServed'] }),
    (e: unknown) => e instanceof RefusalError && e.code === 'IDENTITY_GAP' && e.fields.join() === 'systemModelServed',
  );
  assert.doesNotThrow(() => assertComparable(a, makeIdentity({ systemModelServed: 'model-b' }), { allowDiffer: ['systemModelServed'] }));
});

test('identity separates the system under test from the judge; the old unscoped model fields are unknown', () => {
  for (const f of ['systemModelRequested', 'systemModelServed', 'systemCallShapeHash', 'systemHarnessVersion', 'judgeModelRequested', 'judgeModelServed', 'judgeCallShapeHash']) {
    assert.ok((IDENTITY_FIELDS as readonly string[]).includes(f), f);
  }
  for (const f of ['modelRequested', 'modelServed', 'callShapeHash', 'harnessVersion']) {
    assert.ok(!(IDENTITY_FIELDS as readonly string[]).includes(f), f);
  }
  const legacy = { ...makeIdentity(), modelServed: 'model-x-2026-01-01' } as unknown;
  assert.ok(validateIdentity(legacy).some((p) => p.includes('modelServed') && p.includes('unknown field')));
});

test('judge fields are all NO_JUDGE exactly when judgeDefinitionHash is NO_JUDGE', () => {
  assert.deepEqual(validateIdentity(makeIdentity()), []);
  assert.deepEqual(validateIdentity(makeJudgedIdentity()), []);
  assert.deepEqual(validateIdentity(makeJudgedIdentity({ judgeModelServed: GAP })), []);
  const halfJudge = validateIdentity(makeIdentity({ judgeModelServed: 'judge-2026-01-01' }));
  assert.ok(halfJudge.some((p) => p.includes('judgeModelServed') && p.includes(NO_JUDGE)));
  const noJudgeModel = validateIdentity(makeJudgedIdentity({ judgeModelRequested: NO_JUDGE }));
  assert.ok(noJudgeModel.some((p) => p.includes('judgeModelRequested') && p.includes(NO_JUDGE)));
  assert.ok(validateIdentity(makeJudgedIdentity({ judgeCallShapeHash: 'short' })).some((p) => p.includes('judgeCallShapeHash')));
  assert.ok(validateIdentity(makeIdentity({ systemModelServed: NO_JUDGE })).some((p) => p.includes('systemModelServed')));
});

test('allowing the system model to differ does not let a judge alias move through', () => {
  // The system was upgraded on purpose; separately, the judge alias now points at a different model.
  const baseline = makeJudgedIdentity();
  const candidate = makeJudgedIdentity({ systemModelServed: 'model-x-2026-06-01', judgeModelServed: 'judge-2026-06-01' });
  assert.equal(candidate.judgeModelRequested, baseline.judgeModelRequested);
  assert.throws(
    () => assertComparable(baseline, candidate, { allowDiffer: ['systemModelServed'] }),
    (e: unknown) => e instanceof RefusalError && e.code === 'IDENTITY_MISMATCH' && e.fields.join() === 'judgeModelServed',
  );
  assert.doesNotThrow(() => assertComparable(baseline, makeJudgedIdentity({ systemModelServed: 'model-x-2026-06-01' }), { allowDiffer: ['systemModelServed'] }));
});

test('identity: the prompt and the tools are hash fields of their own; the judge records its harness', () => {
  const judged = makeJudgedIdentity();
  assert.deepEqual(validateIdentity(judged), []);
  assert.ok(validateIdentity({ ...judged, systemPromptHash: 'abc' }).some((p) => p.includes('systemPromptHash')));
  assert.ok(validateIdentity({ ...judged, systemToolsHash: 'abc' }).some((p) => p.includes('systemToolsHash')));
  const { judgeHarnessVersion: _dropped, ...noHarness } = judged;
  assert.ok(validateIdentity(noHarness).some((p) => p.includes('judgeHarnessVersion: missing')));
  assert.ok(validateIdentity({ ...makeIdentity(), judgeHarnessVersion: 'j1' }).some((p) => p.includes('judgeHarnessVersion')));
});

test('an allowed prompt change admits neither a call-shape change nor a tools change', () => {
  const a = makeIdentity();
  const prompt = { systemPromptHash: hashOf('prompt v2') };
  assert.doesNotThrow(() => assertComparable(a, makeIdentity(prompt), { allowDiffer: ['systemPromptHash'] }));
  const refusedOn = (b: RunIdentity, field: string): void => {
    assert.throws(() => assertComparable(a, b, { allowDiffer: ['systemPromptHash'] }), (e: unknown) => e instanceof RefusalError && e.fields.join() === field);
  };
  refusedOn(makeIdentity({ ...prompt, systemCallShapeHash: hashOf('other shape') }), 'systemCallShapeHash');
  refusedOn(makeIdentity({ ...prompt, systemToolsHash: hashOf(['a tool']) }), 'systemToolsHash');
});

test('identity: a string field that reads as a gap is refused, so "unknown" never compares equal to itself', () => {
  for (const [field, value] of [['systemModelServed', 'unknown'], ['systemHarnessVersion', 'n/a'], ['systemModelRequested', 'None'], ['judgeHarnessVersion', 'NOT_SENT']] as const) {
    const id = { ...makeJudgedIdentity(), [field]: value };
    assert.ok(validateIdentity(id).some((p) => p.includes(field) && p.includes('gap')), `${field}=${value}`);
  }
  assert.deepEqual(validateIdentity(makeJudgedIdentity({ systemModelServed: GAP })), []);
});

test('packetHashOf: what the rater was shown, field by field, as presented', () => {
  const message = 'Where is my refund?';
  const reply = 'Refunds take five working days.';
  // Golden vector: sha256 of the canonical JSON {"fields":{"message":<sha256 of the text>},"output":<sha256 of the text>}.
  assert.equal(packetHashOf({ message }, reply), sha256Hex(`{"fields":{"message":"${sha256Hex(message)}"},"output":"${sha256Hex(reply)}"}`));
  // The output shown whole hashes as the stored output does; a cut view is a different packet.
  assert.notEqual(packetHashOf({ message }, reply), packetHashOf({ message }, reply.slice(0, 10)));
  assert.notEqual(packetHashOf({ message }, reply), packetHashOf({ message, policy: 'thirty days' }, reply));
  assert.equal(packetHashOf({ a: 'x', b: 'y' }, reply), packetHashOf({ b: 'y', a: 'x' }, reply));
  assert.equal(packetHashOf({ ticket: { id: 7, open: true } }, { route: 'none' }), packetHashOf({ ticket: { open: true, id: 7 } }, { route: 'none' }));
});

// --- A key given twice in one object: JSON.parse keeps the last value and says nothing ----------------

test('duplicateKeyProblem names a key given twice at the top level, in a nested object and in an object inside a list', () => {
  assert.equal(duplicateKeyProblem('{"a":1,"a":2}'), 'the key "a" is given twice in the top-level object');
  assert.equal(duplicateKeyProblem('{"a":1,"b":{"c":1,"d":2,"c":3}}'), 'the key "c" is given twice in the object at /b');
  assert.equal(duplicateKeyProblem('[{"x":1},{"y":[0,{"k":1,"k":1}]}]'), 'the key "k" is given twice in the object at /1/y/1');
  // A key whose first value was an object or a list is still given twice.
  assert.equal(duplicateKeyProblem('{"a":{"b":[1,2,{"c":1}]},"a":0}'), 'the key "a" is given twice in the top-level object');
  assert.equal(duplicateKeyProblem('{"a":[{"b":1}],"z":{"a":[1,2],"q":"x","a":[1,2]}}'), 'the key "a" is given twice in the object at /z');
  // Whitespace of any kind between the tokens changes nothing.
  assert.equal(duplicateKeyProblem(' {\n\t"a" : 1 ,\r\n "a"\n: 2 } '), 'the key "a" is given twice in the top-level object');
  // The first repeat in the text is the one named.
  assert.equal(duplicateKeyProblem('{"p":{"x":1,"x":2},"p":3}'), 'the key "x" is given twice in the object at /p');
  // The empty key is a key.
  assert.equal(duplicateKeyProblem('{"":1,"":2}'), 'the key "" is given twice in the top-level object');
});

test('duplicateKeyProblem: the place is a JSON Pointer (RFC 6901), with ~ and / escaped in a key on the way', () => {
  assert.equal(duplicateKeyProblem('{"a/b":{"m~n":[{"k":1,"k":2}]}}'), 'the key "k" is given twice in the object at /a~1b/m~0n/0');
  assert.equal(duplicateKeyProblem('{"":{"k":1,"k":2}}'), 'the key "k" is given twice in the object at /');
  assert.equal(duplicateKeyProblem('{"~1":{"k":1,"k":2}}'), 'the key "k" is given twice in the object at /~01');
  // The index of a list counts its items, whatever they hold.
  assert.equal(duplicateKeyProblem('[[1,2],{"a":[",",{"b":1}]},"x,y",{"k":1,"k":2}]'), 'the key "k" is given twice in the object at /3');
});

test('duplicateKeyProblem: keys are compared as the strings they spell, whatever escapes spell them', () => {
  assert.equal(duplicateKeyProblem('{"a":1,"\\u0061":2}'), 'the key "a" is given twice in the top-level object');
  assert.equal(duplicateKeyProblem('{"\\u0061":1,"a":2}'), 'the key "a" is given twice in the top-level object');
  assert.equal(duplicateKeyProblem('{"a/b":1,"a\\/b":2}'), 'the key "a/b" is given twice in the top-level object');
  assert.equal(duplicateKeyProblem('{"\\u00e9":1,"é":2}'), 'the key "é" is given twice in the top-level object');
  assert.equal(duplicateKeyProblem('{"\\ud83d\\ude00":1,"😀":2}'), 'the key "😀" is given twice in the top-level object');
  assert.equal(duplicateKeyProblem('{"q\\"":1,"q\\u0022":2}'), 'the key "q\\"" is given twice in the top-level object');
  assert.equal(duplicateKeyProblem('{"a\\\\":1,"a\\u005c":2}'), 'the key "a\\\\" is given twice in the top-level object');
  // An unpaired surrogate is printed as an escape, so the message stays printable.
  assert.equal(duplicateKeyProblem('{"\\ud800":1,"\\uD800":2}'), 'the key "\\ud800" is given twice in the top-level object');
  // Names an object already has by inheritance are keys like any other.
  assert.equal(duplicateKeyProblem('{"__proto__":1,"constructor":2,"toString":3}'), undefined);
  assert.equal(duplicateKeyProblem('{"__proto__":{"a":1},"__proto__":{"a":2}}'), 'the key "__proto__" is given twice in the top-level object');
  assert.equal(duplicateKeyProblem('{"constructor":1,"x":{"toString":1,"toString":2}}'), 'the key "toString" is given twice in the object at /x');
});

test('duplicateKeyProblem allows what is not a repeat: other objects, other spellings, and keys that only appear in a string', () => {
  for (const text of [
    '{}',
    '[]',
    '1',
    '"a"',
    'null',
    '{"a":1,"b":2}',
    // The same key in two different objects.
    '{"a":{"x":1},"b":{"x":1}}',
    '[{"x":1},{"x":1}]',
    '{"x":{"x":{"x":1}}}',
    '{"a":[{"k":1}],"b":[{"k":1}],"k":2}',
    '{"a":{"b":1},"b":2}',
    // Keys that differ: by case, by a space, by an escaped backslash, by composition.
    '{"a":1,"A":2}',
    '{"a":1,"a ":2}',
    '{"\\\\u0061":1,"a":2}',
    '{"é":1,"e\\u0301":2}',
    // A key that merely appears inside a string value, or as a value.
    '{"a":"a"}',
    '{"a":"{\\"a\\":1,\\"a\\":2}"}',
    '{"a":"\\"a\\":1","b":"a"}',
    '{"a":["a","a"],"b":"a\\\\"}',
    '{"k":"}","j":"{","i":"[\\"a\\",","h":"\\\\\\"","g":","}',
    '["a","a",{"a":"a"}]',
    '[["a","a"],["a"]]',
  ]) {
    JSON.parse(text);
    assert.equal(duplicateKeyProblem(text), undefined, text);
  }
});

test('duplicateKeyProblem does not use the call stack: it reads a text nested far deeper than a recursive reader could', () => {
  const depth = 200_000;
  // Lists in lists, with a clean object and then a repeated key at the bottom.
  const lists = (inner: string): string => `${'['.repeat(depth)}${inner}${']'.repeat(depth)}`;
  assert.equal(duplicateKeyProblem(lists('{"a":1,"b":2}')), undefined);
  assert.equal(duplicateKeyProblem(lists('{"a":1,"a":2}')), `the key "a" is given twice in the object at ${'/0'.repeat(depth)}`);
  // Objects in objects, every one under the same key: no repeat, until the innermost has one.
  const objects = (inner: string): string => `${'{"a":'.repeat(depth)}${inner}${'}'.repeat(depth)}`;
  assert.equal(duplicateKeyProblem(objects('{"a":1}')), undefined);
  assert.equal(duplicateKeyProblem(objects('{"z":1,"z":2}')), `the key "z" is given twice in the object at ${'/a'.repeat(depth)}`);
});

test('duplicateKeyProblem never calls a text clean that it could not read to the end', () => {
  // These are not JSON. The parser refuses them first (parseJsonText); the scan alone still does not say "no repeat".
  for (const text of ['{"a":1,"a', '{"a":1,"a\\', '{"a":1,"\\u00', '{"a":1,"b\\x":2}', '{"a":1,"\n":2}']) {
    assert.throws(() => JSON.parse(text), SyntaxError, text);
    assert.equal(duplicateKeyProblem(text), 'the text is not JSON', text);
  }
});

test("parseJsonText: the value of a JSON text, the parser's own words for a text that is not JSON, and the repeated key otherwise", () => {
  assert.deepEqual(parseJsonText('{"a":[1,{"b":null}],"c":"x"}'), { json: { a: [1, { b: null }], c: 'x' } });
  assert.deepEqual(parseJsonText(' 7 '), { json: 7 });
  // Not JSON: the message is the parser's, as it was before the scan existed, and the scan adds nothing to it.
  for (const text of ['{ not json', '', '{"a":1,"a":2', '{"a":1,"a":2}}', '[1,]', '{"a":1,"a']) {
    let message = '';
    try {
      JSON.parse(text);
    } catch (e) {
      message = (e as Error).message;
    }
    assert.notEqual(message, '', text);
    assert.deepEqual(parseJsonText(text), { problem: `invalid JSON: ${message}`, notJson: true }, text);
  }
  // JSON, with a key given twice: refused, and the value that JSON.parse would have kept is not handed on.
  assert.deepEqual(parseJsonText('{"a":1,"a":2}'), { problem: 'the key "a" is given twice in the top-level object', notJson: false });
  assert.deepEqual(parseJsonText('{"runs":[{"id":"r1","id":"r2"}]}'), { problem: 'the key "id" is given twice in the object at /runs/0', notJson: false });
});

// --- The seed of a harness that makes no random choice ---------------------------------------------
// A uint32 says which random choices a run made. A harness that makes none has no such number: 0 would be a seed
// nobody drew, and it could not be told from a real seed 0. It records the explicit sentinel instead.
test('NO_SEED: the seed is a uint32, the sentinel "NO_SEED" or the gap, and nothing else; null, 0-like strings and other spellings are refused', () => {
  assert.equal(NO_SEED, 'NO_SEED');
  assert.deepEqual(validateIdentity(makeIdentity({ seed: NO_SEED })), []);
  assert.deepEqual(validateIdentity(makeJudgedIdentity({ seed: NO_SEED })), []);
  assert.deepEqual(validateIdentity(makeIdentity({ seed: 0 })), []);
  assert.deepEqual(validateIdentity(makeIdentity({ seed: 0xffffffff })), []);
  const expected = 'identity.seed: must be a uint32 integer, "NO_SEED" for a harness that makes no random choice, or "UNKNOWN"';
  for (const bad of ['no_seed', 'No_Seed', 'NO SEED', 'NOSEED', ' NO_SEED', 'NO_SEED ', 'none', 'NONE', '', '0', 'NO_JUDGE', -1, 0x100000000, 1.5, Number.NaN, true, false, [], ['NO_SEED'], {}, { seed: NO_SEED }]) {
    assert.deepEqual(validateIdentity({ ...makeIdentity(), seed: bad }), [expected], JSON.stringify(bad));
  }
  // Never null: a null is not a statement that no seed was drawn.
  assert.deepEqual(validateIdentity({ ...makeIdentity(), seed: null }), ['identity.seed: null is not allowed (use "UNKNOWN")']);
  const { seed: _seed, ...missing } = makeIdentity();
  assert.deepEqual(validateIdentity(missing), ['identity.seed: missing (use "UNKNOWN" for an unknown value)']);
});

test('NO_SEED is reserved for the seed: no other identity field may hold it', () => {
  for (const f of IDENTITY_FIELDS.filter((x) => x !== 'seed')) {
    const problems = validateIdentity({ ...makeJudgedIdentity(), [f]: NO_SEED });
    assert.equal(problems.length, 1, `${f}: ${problems.join('; ')}`);
    assert.ok((problems[0] as string).startsWith(`identity.${f}: `), problems[0]);
  }
  assert.deepEqual(validateIdentity({ ...makeIdentity(), systemHarnessVersion: NO_SEED }), ['identity.systemHarnessVersion: must be a non-empty string or "UNKNOWN" ("NO_JUDGE" is reserved for the judge fields and "NO_SEED" for the seed)']);
});

test('NO_SEED compares only with itself: two runs that both declare it are comparable; beside a number it is refused naming seed, also when seed is allowed to differ; beside a gap it is a gap', () => {
  const none = makeIdentity({ seed: NO_SEED });
  assert.doesNotThrow(() => assertComparable(none, makeIdentity({ seed: NO_SEED })));
  assert.deepEqual(identityDiff(none, makeIdentity({ seed: NO_SEED })), []);
  const mismatch = (a: RunIdentity, b: RunIdentity, allowDiffer: ('seed' | 'systemModelServed')[]): void => {
    assert.throws(
      () => assertComparable(a, b, { allowDiffer }),
      (e: unknown) =>
        e instanceof RefusalError && e.code === 'IDENTITY_MISMATCH' && e.fields.join() === 'seed' &&
        e.message.includes('a run that made no random choice is not compared with a seeded run, also when seed is allowed to differ'),
      `${String(a.seed)} vs ${String(b.seed)}, allowed: ${allowDiffer.join()}`,
    );
  };
  for (const seeded of [0, 1, 20260115, 0xffffffff]) {
    for (const allowDiffer of [[], ['seed'], ['seed', 'systemModelServed']] as ('seed' | 'systemModelServed')[][]) {
      mismatch(none, makeIdentity({ seed: seeded }), allowDiffer);
      mismatch(makeIdentity({ seed: seeded }), none, allowDiffer);
    }
  }
  // Two numeric seeds still differ under the flag, as before: the strict rule is about the sentinel alone.
  assert.doesNotThrow(() => assertComparable(makeIdentity({ seed: 1 }), makeIdentity({ seed: 2 }), { allowDiffer: ['seed'] }));
  // Beside a gap nothing is known about the other run's randomness: IDENTITY_GAP, with or without the flag.
  for (const allowDiffer of [[], ['seed']] as 'seed'[][]) {
    for (const [a, b] of [[none, makeIdentity({ seed: GAP })], [makeIdentity({ seed: GAP }), none]] as const) {
      assert.throws(() => assertComparable(a, b, { allowDiffer }), (e: unknown) => e instanceof RefusalError && e.code === 'IDENTITY_GAP' && e.fields.join() === 'seed');
    }
  }
  // The sentinel beside a number is reported with any other mismatch and any gap, in the identity's field order.
  assert.throws(
    () => assertComparable(makeIdentity({ seed: NO_SEED, systemHarnessVersion: GAP }), makeIdentity({ seed: 3, barHash: hashOf('other bar') }), { allowDiffer: ['seed'] }),
    (e: unknown) => e instanceof RefusalError && e.code === 'IDENTITY_MISMATCH' && e.fields.join() === 'barHash,seed,systemHarnessVersion',
  );
});

// A conversion from another tool's result file cannot know what that tool's harness drew, so it records the gap and
// never the statement "no random choice". Checked on what is committed: no importer source and no file an importer
// wrote holds the sentinel.
test('NO_SEED is never written by a conversion: no example importer, grader or committed imported file holds it', () => {
  const root = join(import.meta.dirname, '..', 'examples', 'importers');
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  const files = walk(root).filter((f) => /\.(ts|cjs|py|json|jsonl|yaml|sh|md|txt)$/.test(f));
  assert.ok(files.length > 50, `only ${files.length} files found under examples/importers`);
  const holding = files.filter((f) => readFileSync(f, 'utf8').includes(NO_SEED));
  assert.deepEqual(holding, []);
});
