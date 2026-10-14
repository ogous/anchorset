// The field selector (examples/importers/skill-evals/selector.ts): a JSON Pointer (RFC 6901) into the assistant turn
// parsed as JSON. Pure: no file is read here but the example flow, for the last tests. Synthetic refund-bot data only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sha256Hex } from '../src/index.ts';
import { ImportRefusal, ImportUsageError, loadBar, parseCasesFile } from '../examples/importers/shared.ts';
import { readFlow } from '../examples/importers/skill-evals/flow.ts';
import { parsePointer, select, selectAll, SELECTOR_SYNTAX, selectorDefinition, trySelect, WHOLE_TURN } from '../examples/importers/skill-evals/selector.ts';

const refused = (text: string, pointer: string, words: RegExp): void => {
  assert.throws(
    () => select(text, pointer),
    (e: unknown) => e instanceof ImportRefusal && e.code === 'IMPORT_PACKET' && e.fields.length === 1 && words.test(e.message),
    `${pointer} on ${text}`,
  );
};

const ANSWER = '{"action":"refund","reply":"Your refund for order A-10492 is approved.","notes":["checked the date","checked the item"]}';

test('a pointer selects a string of the turn parsed as JSON', () => {
  assert.equal(select(ANSWER, '/reply'), 'Your refund for order A-10492 is approved.');
  assert.equal(select(ANSWER, '/action'), 'refund');
  assert.equal(select(ANSWER, '/notes/0'), 'checked the date');
  assert.equal(select(ANSWER, '/notes/1'), 'checked the item');
  assert.equal(select('{"out":{"customer":{"reply":"Hello."}}}', '/out/customer/reply'), 'Hello.');
  // White space around the JSON text is JSON's own; the selected string is never trimmed.
  assert.equal(select('\n {"reply":"  two spaces each side  "} \n', '/reply'), '  two spaces each side  ');
});

test('the empty selector means the whole turn: the stored text, unparsed and unchanged', () => {
  assert.equal(WHOLE_TURN, '');
  assert.equal(select(ANSWER, ''), ANSWER);
  assert.equal(select('Plain words, not JSON. ', ''), 'Plain words, not JSON. ');
  assert.equal(select('"a JSON string"', ''), '"a JSON string"');
  refused('', '', /the turn is empty/);
});

test("RFC 6901 section 5: the standard's own document and pointers", () => {
  // The document of RFC 6901, section 5, with the values the section lists for each pointer:
  //   ""      the whole document      "/foo"  ["bar", "baz"]    "/foo/0"  "bar"    "/"     0
  //   "/a~1b" 1      "/c%d" 2      "/e^f" 3      "/g|h" 4      "/i\\j" 5      "/k\"l" 6      "/ " 7      "/m~0n" 8
  const doc = '{"foo":["bar","baz"],"":0,"a/b":1,"c%d":2,"e^f":3,"g|h":4,"i\\\\j":5,"k\\"l":6," ":7,"m~n":8}';
  assert.equal(select(doc, '/foo/0'), 'bar');
  refused(doc, '/foo', /the selected value is array, not a string/);
  // Each of these resolves to the number the section lists: the refusal is "a number, not a string", never "does not resolve".
  for (const pointer of ['/', '/a~1b', '/c%d', '/e^f', '/g|h', '/i\\j', '/k"l', '/ ', '/m~0n']) {
    refused(doc, pointer, /the selected value is number, not a string/);
  }
  // The same keys with string values, so the selection itself is seen: the value names the key it sits under.
  const strings = JSON.stringify({ foo: ['bar', 'baz'], '': 'empty key', 'a/b': 'slash', 'c%d': 'percent', 'e^f': 'caret', 'g|h': 'bar', 'i\\j': 'backslash', 'k"l': 'quote', ' ': 'space', 'm~n': 'tilde' });
  const expected: [string, string][] = [
    ['/', 'empty key'],
    ['/a~1b', 'slash'],
    ['/c%d', 'percent'],
    ['/e^f', 'caret'],
    ['/g|h', 'bar'],
    ['/i\\j', 'backslash'],
    ['/k"l', 'quote'],
    ['/ ', 'space'],
    ['/m~0n', 'tilde'],
    ['/foo/1', 'baz'],
  ];
  for (const [pointer, value] of expected) assert.equal(select(strings, pointer), value, pointer);
});

test('the escapes ~0 and ~1: "~1" is "/", "~0" is "~", and "~01" is the key "~1", never "/"', () => {
  assert.deepEqual(parsePointer(''), []);
  assert.deepEqual(parsePointer('/'), ['']);
  assert.deepEqual(parsePointer('/a~1b'), ['a/b']);
  assert.deepEqual(parsePointer('/m~0n'), ['m~n']);
  // Worked by hand: "~01" is "~0" then "1". Unescaping "~1" first leaves "~01" alone (its "~" is followed by "0"), and
  // unescaping "~0" second gives "~1". The other order would turn it into "/".
  assert.deepEqual(parsePointer('/~01'), ['~1']);
  assert.deepEqual(parsePointer('/~00/~1~1/x~0~1y'), ['~0', '//', 'x~/y']);
  assert.deepEqual(parsePointer('/a//b/'), ['a', '', 'b', '']);
  const doc = JSON.stringify({ '~1': 'tilde one', '/': 'slash', 'a/b': { 'c~d': 'nested' } });
  assert.equal(select(doc, '/~01'), 'tilde one');
  assert.equal(select(doc, '/~1'), 'slash');
  assert.equal(select(doc, '/a~1b/c~0d'), 'nested');
  // A refusal names the place reached, escaped again as a pointer.
  refused(doc, '/a~1b/missing', /"\/a~1b" has no key "missing"/);
});

test('a text that is not a JSON Pointer is a usage error, not a refusal', () => {
  for (const pointer of ['reply', 'reply/text', ' /reply', '#/reply', '$.reply', '/a~2b', '/a~', '/~', '/a~~0']) {
    assert.throws(() => parsePointer(pointer), ImportUsageError, pointer);
    assert.throws(() => select(ANSWER, pointer), ImportUsageError, pointer);
    assert.throws(() => selectorDefinition(pointer), ImportUsageError, pointer);
  }
});

test('a turn that is not JSON is refused', () => {
  refused('Your refund is approved.', '/reply', /the turn is not JSON/);
  // A code fence around the object is not JSON: nothing is stripped.
  refused('```json\n{"reply":"Hello."}\n```', '/reply', /the turn is not JSON/);
  refused('{"reply":"Hello."} Thanks!', '/reply', /the turn is not JSON/);
  refused('', '/reply', /the turn is not JSON/);
});

test('a pointer that does not resolve is refused', () => {
  refused(ANSWER, '/answer', /does not resolve: the document has no key "answer"/);
  refused(ANSWER, '/Reply', /does not resolve/);
  refused(ANSWER, '/reply/0', /does not resolve: "\/reply" is string, with nothing below it/);
  refused(ANSWER, '/notes/2', /does not resolve: "\/notes" is a list of 2, with no element "2"/);
  // RFC 6901, section 4: "-" is the element after the last one, and an index has no leading zero.
  refused(ANSWER, '/notes/-', /does not resolve/);
  refused(ANSWER, '/notes/01', /does not resolve/);
  refused(ANSWER, '/notes/1.0', /does not resolve/);
  refused(ANSWER, '/notes/-1', /does not resolve/);
  // Only the document's own keys: nothing a JavaScript object or list inherits.
  refused(ANSWER, '/toString', /does not resolve/);
  refused(ANSWER, '/constructor/name', /does not resolve/);
  refused(ANSWER, '/notes/length', /does not resolve/);
  refused(ANSWER, '/__proto__', /does not resolve/);
  refused('"just a string"', '/reply', /does not resolve: the document is string/);
  refused('[]', '/0', /does not resolve/);
});

test('a selected value that is not a non-empty string is refused', () => {
  const doc = '{"n":7,"flag":true,"none":null,"list":["a"],"obj":{"reply":"x"},"empty":""}';
  refused(doc, '/n', /the selected value is number, not a string/);
  refused(doc, '/flag', /the selected value is boolean, not a string/);
  refused(doc, '/none', /the selected value is null, not a string/);
  refused(doc, '/list', /the selected value is array, not a string/);
  refused(doc, '/obj', /the selected value is object, not a string/);
  refused(doc, '/empty', /the selected value is an empty string/);
  assert.equal(select(doc, '/obj/reply'), 'x');
});

test('trySelect returns the reason instead of throwing', () => {
  assert.deepEqual(trySelect(ANSWER, '/action'), { value: 'refund' });
  assert.deepEqual(trySelect(ANSWER, '/nope'), { why: 'the pointer does not resolve: the document has no key "nope"' });
});

test("the selector's own text is exposed for the judge's definition, unchanged and unhashed", () => {
  assert.equal(SELECTOR_SYNTAX, 'json-pointer-rfc6901/v1');
  assert.deepEqual(selectorDefinition('/reply'), { syntax: 'json-pointer-rfc6901/v1', pointer: '/reply' });
  assert.deepEqual(selectorDefinition(''), { syntax: 'json-pointer-rfc6901/v1', pointer: '' });
  // Two spellings of one key are two selectors: the text is kept as given, never normalised.
  assert.notDeepEqual(selectorDefinition('/a~1b'), selectorDefinition('/a/b'));
});

test('selectAll lists every slot the selector cannot be applied to', () => {
  const slots = [
    { caseId: 'c1', draw: 0, answer: '{"reply":"Approved."}' },
    { caseId: 'c1', draw: 1, answer: 'Approved.' },
    { caseId: 'c2', draw: 0, answer: '{"reply":7}' },
    { caseId: 'c2', draw: 1, answer: '{"message":"Declined."}' },
  ];
  assert.deepEqual(selectAll([slots[0] as (typeof slots)[number]], '/reply'), ['Approved.']);
  assert.deepEqual(selectAll(slots, ''), slots.map((s) => s.answer));
  assert.throws(
    () => selectAll(slots, '/reply'),
    (e: unknown) => e instanceof ImportRefusal && e.code === 'IMPORT_PACKET' && e.fields.join() === 'c1#1,c2#0,c2#1' && /3 of 4 slot/.test(e.message),
  );
});

test('on the example flow, /reply selects the message to the customer, and the stored-output hash stays over the whole turn', () => {
  const dir = join(import.meta.dirname, '..', 'examples', 'importers', 'skill-evals');
  const cases = parseCasesFile(readFileSync(join(dir, 'cases.json'), 'utf8'), loadBar(readFileSync(join(dir, 'bar.json'), 'utf8')));
  const flow = readFlow(join(dir, 'example-flow'), 'baseline', cases, 2);
  const replies = selectAll(flow.slots, '/reply');
  assert.equal(replies.length, 6);
  assert.equal(replies[0], 'I have passed order A-09977 to a colleague, who will write to you about the standing desk. I cannot decide this request myself, and I am not able to promise a date.');
  flow.slots.forEach((s, i) => {
    assert.equal(s.storedOutputSha256, sha256Hex(s.answer));
    assert.notEqual(s.storedOutputSha256, sha256Hex(replies[i] as string));
    assert.equal(s.answer.includes(replies[i] as string), true);
  });
  // Rep 0 of clearance-organiser is the example's one wrong answer: the bot refunds a clearance item.
  assert.deepEqual(selectAll(flow.slots, '/action'), ['hand_off', 'hand_off', 'refund', 'decline', 'refund', 'refund']);
});

test('a selected value that holds an unpaired surrogate is refused: a well-formed turn can spell one with an escape', () => {
  // The turn is well-formed text (a backslash, a "u" and four digits); the value the pointer selects from it is not.
  const turn = '{"action":"refund","reply":"Your refund is approved. \\ud800"}';
  assert.equal(turn.includes('\ud800'), false);
  refused(turn, '/reply', /the selected value: the text holds an unpaired surrogate/);
  refused('{"reply":"\\udc00 first"}', '/reply', /unpaired surrogate/);
  // Another key of the same turn selects fine, and so does a whole pair.
  assert.equal(select(turn, '/action'), 'refund');
  assert.equal(select('{"reply":"ok \\ud83d\\ude00"}', '/reply'), 'ok \u{1f600}');
  // The whole turn, handed in with an unpaired surrogate in it, is refused too.
  refused('plain words \ud800', WHOLE_TURN, /the turn: the text holds an unpaired surrogate/);
});

test('a turn in which a key is given twice is refused when a selector is applied to it; shown whole, the turn is not parsed', () => {
  const twice = '{"reply":"Your refund is approved.","reply":"Clearance items are not refunded."}';
  // What the plain parser would select: the second reply.
  assert.equal((JSON.parse(twice) as { reply: string }).reply, 'Clearance items are not refunded.');
  refused(twice, '/reply', /in the turn, the key "reply" is given twice in the top-level object/);
  refused('{"items":[{"text":"a","text":"b"}]}', '/items/0/text', /the key "text" is given twice in the object at \/items\/0/);
  // A key the pointer does not walk through refuses too: the turn is not the one document it seems to be.
  refused('{"reply":"ok","notes":{"a":1,"a":2}}', '/reply', /the key "a" is given twice in the object at \/notes/);
  refused('{"reply":"ok","\\u0072eply":"other"}', '/reply', /the key "reply" is given twice/);
  assert.equal(select(twice, WHOLE_TURN), twice);
});
