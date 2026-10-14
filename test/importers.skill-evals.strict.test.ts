// The strict readers the third importer's path reads with: the shared module's JSON reader that refuses a key given
// twice, its one UTF-8 decoder and its one count reader (examples/importers/shared.ts), and this path's own check for
// an unpaired surrogate (examples/importers/skill-evals/strict.ts). Synthetic customer-support refund-bot data only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { duplicateKeyProblem } from '../src/identity.ts';
import { outputHashOf, sha256Hex } from '../src/index.ts';
import { decodeUtf8, ImportInputError, ImportUsageError, inputJsonText, isCount, parseJsonStrict, positiveIntFlag } from '../examples/importers/shared.ts';
import { isWellFormedText, UNPAIRED_SURROGATE } from '../examples/importers/skill-evals/strict.ts';

const why = (text: string): string => {
  const r = parseJsonStrict(text);
  assert.ok('why' in r, `expected a refusal of ${text}`);
  return r.why;
};
const value = (text: string): unknown => {
  const r = parseJsonStrict(text);
  assert.ok('value' in r, `expected ${text} to be read`);
  return r.value;
};

test('a JSON text with no key given twice reads as JSON.parse reads it', () => {
  for (const text of ['{}', '[]', '7', '"a"', 'true', '{"a":1,"b":{"a":2},"c":[{"a":3},{"a":4}]}', ' { "reply" : "ok" , "notes" : [ ] } ', '{"a":{"b":{"c":{}}},"b":1}']) {
    assert.deepEqual(value(text), JSON.parse(text), text);
    assert.equal(duplicateKeyProblem(text), undefined, text);
  }
});

test('JSON.parse keeps the last of two equal keys; the strict reader refuses the text and names the key and the object', () => {
  // What the plain parser does, and why it is not enough: the first status is dropped without a word.
  assert.deepEqual(JSON.parse('{"status":"truncated","status":"ok"}'), { status: 'ok' });
  assert.match(why('{"status":"truncated","status":"ok"}'), /^the key "status" is given twice in the top-level object$/);
  assert.match(why('{"a":1,"b":2,"a":1}'), /the key "a" is given twice/);
  // Equal values do not make it one key.
  assert.match(why('{"a":1,"a":1}'), /the key "a" is given twice/);
});

test('a key given twice in a nested object, or in an object of a list, is named with its place', () => {
  assert.match(why('{"graderEvidence":{"reply":"{\\"pass\\": true}","reply":"{\\"pass\\": false}"}}'), /^the key "reply" is given twice in the object at \/graderEvidence$/);
  assert.match(why('[{"role":"user"},{"role":"assistant","content":"a","content":"b"}]'), /^the key "content" is given twice in the object at \/1$/);
  assert.match(why('{"a":{"b":[0,{"c":1,"d":{},"c":2}]}}'), /^the key "c" is given twice in the object at \/a\/b\/1$/);
  // A key of the place that holds "/" or "~" is written as a JSON Pointer writes it.
  assert.match(why('{"a/b":{"x":1,"x":2}}'), /in the object at \/a~1b$/);
  assert.match(why('{"a~b":{"x":1,"x":2}}'), /in the object at \/a~0b$/);
});

test('the same key in two different objects is not a duplicate', () => {
  assert.equal(duplicateKeyProblem('{"a":{"x":1},"b":{"x":1}}'), undefined);
  assert.equal(duplicateKeyProblem('[{"x":1},{"x":1}]'), undefined);
  assert.equal(duplicateKeyProblem('{"x":{"x":{"x":1}}}'), undefined);
  // After a nested object closes, the outer object's keys are still the outer object's.
  assert.match(why('{"x":{"y":1},"x":2}'), /the key "x" is given twice in the top-level object/);
  assert.match(why('{"a":[{"x":1}],"b":1,"a":2}'), /the key "a" is given twice in the top-level object/);
});

test('keys are compared as the texts they spell, so two spellings of one key by escape are a duplicate', () => {
  assert.match(why('{"a":1,"\\u0061":2}'), /the key "a" is given twice/);
  assert.match(why('{"\\u0041":1,"A":2}'), /the key "A" is given twice/);
  assert.match(why('{"a\\/b":1,"a/b":2}'), /the key "a\/b" is given twice/);
  assert.match(why('{"line\\nfeed":1,"line\\u000afeed":2}'), /is given twice/);
  // Keys that differ are two keys, however alike they look.
  assert.equal(duplicateKeyProblem('{"a":1,"A":2}'), undefined);
  assert.equal(duplicateKeyProblem('{"a":1,"a ":2}'), undefined);
  assert.equal(duplicateKeyProblem('{"\\\\u0061":1,"a":2}'), undefined);
});

test('a string value is never read as a key, whatever it holds: quotes, braces, commas and colons included', () => {
  for (const text of [
    '{"a":"\\"a\\":1,\\"a\\":2"}',
    '{"a":"{\\"b\\":1,\\"b\\":2}","b":1}',
    '{"a":"x\\\\","b":"a","c":","}',
    '{"a":["a","a",{"b":"a"}],"b":"a"}',
    '{"a":"}","b":"{","c":"]","d":"["}',
    '{"\\"":1,"\\\\":2,"\\\\\\"":3}',
  ]) {
    assert.equal(duplicateKeyProblem(text), undefined, text);
    assert.deepEqual(value(text), JSON.parse(text), text);
  }
  // And a key that holds an escaped quote is still compared whole.
  assert.match(why('{"a\\"b":1,"a\\"b":2}'), /is given twice/);
  assert.match(why('{"a":"},{","a":2}'), /the key "a" is given twice/);
});

test('"__proto__" and "constructor" are keys like any other', () => {
  assert.equal(duplicateKeyProblem('{"__proto__":1,"constructor":2,"toString":3}'), undefined);
  assert.match(why('{"__proto__":1,"__proto__":2}'), /the key "__proto__" is given twice/);
});

test('a text that is not JSON is refused as not JSON, with the parser\'s words', () => {
  for (const text of ['', '{', '{"a":1,}', '{"a":1 "b":2}', 'NaN', "{'a':1}", '{"a":1}{"a":2}', '{"a":"\n"}']) assert.match(why(text), /^not JSON \(/, JSON.stringify(text));
  // The scan alone, on a text no parser accepted, never reports the text clean by accident of its own state.
  assert.equal(duplicateKeyProblem('{"a":1,"a'), 'the text is not JSON');
});

test('the two reasons are told apart: a text the parser refuses, and a JSON text with a key given twice', () => {
  assert.deepEqual(parseJsonStrict('{"a":1,"a":2}'), { why: 'the key "a" is given twice in the top-level object', notJson: false });
  const r = parseJsonStrict('{"a":');
  assert.ok('why' in r && r.notJson === true);
});

test("a user's JSON file: a key given twice, bytes that are not UTF-8 and a byte-order mark are invalid input; a text that is not JSON is left to the parser of the file", () => {
  const good = '{ "bank-dispute": { "klass": "refund_safety", "expect": "pass" } }\n';
  assert.equal(inputJsonText('cases', Buffer.from(good)), good);
  const twice = '{"bank-dispute":{"klass":"refund_safety","expect":"pass"},"bank-dispute":{"klass":"refund_safety","expect":"fail"}}';
  assert.throws(() => inputJsonText('cases', Buffer.from(twice)), (e: unknown) => e instanceof ImportInputError && e.message === 'INVALID_INPUT: cases: the key "bank-dispute" is given twice in the top-level object');
  assert.throws(() => inputJsonText('bar', Buffer.from('{"labels":["fail","pass"],"labels":["pass"]}')), (e: unknown) => e instanceof ImportInputError && /^INVALID_INPUT: bar: the key "labels" is given twice/.test(e.message));
  assert.throws(() => inputJsonText('cases', Buffer.from([0x7b, 0xff, 0x7d])), (e: unknown) => e instanceof ImportInputError && e.message === 'INVALID_INPUT: cases: the bytes are not UTF-8 text');
  assert.throws(() => inputJsonText('cases', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(good)])), (e: unknown) => e instanceof ImportInputError && e.message === 'INVALID_INPUT: cases: the file starts with a byte-order mark');
  assert.equal(inputJsonText('cases', Buffer.from('{"a":')), '{"a":');
});

test('the one decoder: UTF-8 with no byte-order mark, and nothing replaced', () => {
  assert.deepEqual(decodeUtf8(Buffer.from('refund é \u{1f600}', 'utf8')), { text: 'refund é \u{1f600}' });
  assert.deepEqual(decodeUtf8(new Uint8Array(0)), { text: '' });
  assert.deepEqual(decodeUtf8(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')])), { why: 'the file starts with a byte-order mark' });
  assert.deepEqual(decodeUtf8(Buffer.from([0x7b, 0xff, 0x7d])), { why: 'the bytes are not UTF-8 text' });
  // A surrogate written as three bytes is not UTF-8: a file can never decode to an unpaired surrogate.
  assert.deepEqual(decodeUtf8(Buffer.from([0xed, 0xa0, 0x80])), { why: 'the bytes are not UTF-8 text' });
});

test('an unpaired surrogate is found: high alone, low alone, the two in the wrong order, at either end', () => {
  for (const text of ['', 'refund', '\u{1f600}', 'a😀b', '�']) assert.equal(isWellFormedText(text), true, JSON.stringify(text));
  for (const text of ['\ud800', 'a\ud800', '\ud800b', '\udc00', 'a\udc00b', '\ude00\ud83d', '\ud83d😀', '😀\ude00']) assert.equal(isWellFormedText(text), false, JSON.stringify(text));
  // What a refusal says of such a text: what it is, and why it cannot be hashed.
  assert.match(UNPAIRED_SURROGATE, /^the text holds an unpaired surrogate \(it is not well-formed Unicode\), so it has no UTF-8 bytes of its own, and no hash$/);
});

test('this path keeps no copy of a shared reader: strict.ts exports the check of a well-formed text and its message, and imports nothing', async () => {
  const own = await import('../examples/importers/skill-evals/strict.ts');
  assert.deepEqual(Object.keys(own).sort(), ['UNPAIRED_SURROGATE', 'isWellFormedText']);
  const dir = join(import.meta.dirname, '..', 'examples', 'importers', 'skill-evals');
  assert.doesNotMatch(readFileSync(join(dir, 'strict.ts'), 'utf8'), /^import\s/m);
  // No file of the path defines one of the shared rules again.
  const shared = ['decodeUtf8', 'duplicateKeyProblem', 'parseJsonStrict', 'inputJsonText', 'isCount', 'positiveIntFlag', 'isEntryPoint', 'checkGraderConfig', 'ungradedRefusal'];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(join(dir, file), 'utf8');
    for (const name of shared) assert.doesNotMatch(source, new RegExp(`(function|const|let|var)\\s+${name}\\b`), `${file} defines ${name}`);
  }
});

test('why it matters: two different texts with unpaired surrogates have the same UTF-8 bytes, and the library refuses to hash either', () => {
  // Written as UTF-8, both become the replacement character, so a hash of the bytes cannot tell them apart.
  const ofBytes = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
  assert.notEqual('\ud800', '\ud801');
  assert.equal(ofBytes('\ud800'), ofBytes('\ud801'));
  assert.equal(ofBytes('\ud800'), sha256Hex('\ufffd'));
  // The library has no hash for such a text: it throws a TypeError. This path's check is the one that says so first,
  // as a refusal that names the field, and it finds exactly the texts the library refuses.
  const refusedByTheLibrary = (e: unknown): boolean => e instanceof TypeError && /holds an unpaired surrogate/.test(e.message);
  for (const text of ['\ud800', '\ud801', 'refund \ud800', 'refund \udfff', '\ude00\ud83d']) {
    assert.throws(() => sha256Hex(text), refusedByTheLibrary, JSON.stringify(text));
    assert.throws(() => outputHashOf(text), refusedByTheLibrary, JSON.stringify(text));
    assert.equal(isWellFormedText(text), false, JSON.stringify(text));
  }
  for (const text of ['', 'refund', 'refund \u{1f600}', '\ufffd']) {
    assert.equal(sha256Hex(text), ofBytes(text), JSON.stringify(text));
    assert.equal(isWellFormedText(text), true, JSON.stringify(text));
  }
  // JSON carries such a text through an escape, which is how one reaches a parsed file.
  assert.equal(isWellFormedText(JSON.parse('"\\ud800"') as string), false);
});

test('the one count: an integer from 1 that is safe', () => {
  for (const v of [1, 2, 9007199254740991]) assert.equal(isCount(v), true, String(v));
  for (const v of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '2', null, undefined, [2]]) assert.equal(isCount(v), false, String(v));
});

test('the one count reader of a flag: digits only, from 1, no sign, no leading zero, no fraction; else a usage error that names the flag and prints the usage line', () => {
  assert.equal(positiveIntFlag('--reps', '2', 'usage: x'), 2);
  assert.equal(positiveIntFlag('--draws', '10', 'usage: x'), 10);
  for (const text of ['0', '-1', '+1', '02', '2.0', '1e3', ' 2', '2 ', 'two', '', '0x10', '9007199254740993']) {
    assert.throws(() => positiveIntFlag('--reps', text, 'usage: x'), (e: unknown) => e instanceof ImportUsageError && e.message === `USAGE: --reps must be a positive integer, found ${JSON.stringify(text)}. usage: x`, text);
  }
});
