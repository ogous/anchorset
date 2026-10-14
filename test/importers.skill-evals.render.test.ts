// The judge prompt of the third importer's re-grade (examples/importers/skill-evals/render.ts): single-pass
// substitution of exactly three tokens, and the template rules that refuse before any call.
// Synthetic customer-support refund-bot data only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ImportRefusal, renderSkeleton, skeletonFromTemplate, templateProblem } from '../examples/importers/shared.ts';
import { checkTemplate, promptTextOf, renderTemplate, TEMPLATE_TOKENS, templateProblems } from '../examples/importers/skill-evals/render.ts';

const TEMPLATE = 'Q: {question}\nA: {answer}\nC: {criterion}\n';
const parts = { question: 'Can I have a refund?', answer: 'Yes, within 14 days.', criterion: 'The reply follows the refund rules.' };

function refusal(fn: () => unknown): ImportRefusal {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ImportRefusal, `expected an ImportRefusal, got ${String(e)}`);
    return e;
  }
  throw new Error('expected a refusal, and nothing was thrown');
}

test('the three tokens, in a fixed order', () => {
  assert.deepEqual([...TEMPLATE_TOKENS], ['question', 'answer', 'criterion']);
});

test('each token is replaced by its text, and everything else of the template stays byte for byte', () => {
  assert.equal(renderTemplate(TEMPLATE, parts), 'Q: Can I have a refund?\nA: Yes, within 14 days.\nC: The reply follows the refund rules.\n');
  assert.deepEqual(templateProblems(TEMPLATE), []);
});

test('single pass: a token inside substituted text is not expanded', () => {
  // The four-replace renderer would put the answer into the question here, and the criterion into the answer.
  const tricky = { question: 'What does {answer} mean?', answer: 'It is {criterion}, not {question}.', criterion: 'Never write {question} or {answer}.' };
  assert.equal(renderTemplate(TEMPLATE, tricky), 'Q: What does {answer} mean?\nA: It is {criterion}, not {question}.\nC: Never write {question} or {answer}.\n');
});

test('substituted text may hold braces, doubled braces, dollar signs and backslashes: none is read as a pattern', () => {
  const odd = { question: '$& $1 $$ \\n', answer: '{"action":"refund","reply":"{{ok}}"}', criterion: '{0} {x!r} {y:>4}' };
  assert.equal(renderTemplate(TEMPLATE, odd), 'Q: $& $1 $$ \\n\nA: {"action":"refund","reply":"{{ok}}"}\nC: {0} {x!r} {y:>4}\n');
});

test('the tokens may come in any order in the template', () => {
  assert.equal(renderTemplate('{criterion}|{answer}|{question}', { question: 'q', answer: 'a', criterion: 'c' }), 'c|a|q');
});

test('a doubled brace in the template is refused', () => {
  for (const t of ['{{question}} {question} {answer} {criterion}', '{question} {answer} {criterion} }}', '{question} {answer} {criterion} {{']) {
    const e = refusal(() => checkTemplate(t));
    assert.equal(e.code, 'IMPORT_PACKET');
    assert.deepEqual([...e.fields], ['template']);
    assert.match(e.message, /doubled brace/);
  }
});

test('any other {name} in the template is refused, in the shared rule\'s own sentence', () => {
  const e = refusal(() => checkTemplate('{question} {answer} {criterion} {notes}'));
  assert.equal(e.code, 'IMPORT_PACKET');
  assert.equal(
    e.message,
    'IMPORT_PACKET: the template is refused before any call: a brace that is not one of the three plain tokens {question}, {answer}, {criterion} (a doubled brace, a format specification, a conversion, an index, or another name)',
  );
  // A format specification, a conversion, an index, an attribute, an empty field, a token with spaces: none is one of the three.
  for (const other of ['{answer:>10}', '{answer!r}', '{0}', '{}', '{answer.text}', '{answer[0]}', '{ question }', '{Question}']) {
    const r = refusal(() => checkTemplate(`{question} {answer} {criterion} ${other}`));
    assert.equal(r.code, 'IMPORT_PACKET', other);
  }
});

test('a brace that belongs to no token is refused, a JSON example included', () => {
  for (const t of ['{question} {answer} {criterion} {', '{question} {answer} {criterion} }', '{question} {answer} {criterion} {"pass": true}']) {
    const e = refusal(() => checkTemplate(t));
    assert.equal(e.code, 'IMPORT_PACKET');
    assert.match(e.message, /brace/);
  }
});

test('one of each: the brace rule and the renderer are the shared module\'s, called and not copied; this file adds "each token exactly once"', () => {
  const templates = [
    TEMPLATE,
    '{criterion}|{answer}|{question}',
    '{{question}} {question} {answer} {criterion}',
    '{question} {answer} {criterion} {notes}',
    '{question} {answer} {criterion} {answer:>10}',
    '{question} {answer} {criterion} }',
    '{ques{answer}tion} {criterion}',
    '{question} {answer} {criterion} {"pass": true}',
    'no token at all',
    `${TEMPLATE}{answer}`,
  ];
  for (const t of templates) {
    const shared = templateProblem(t, TEMPLATE_TOKENS);
    const all = templateProblems(t);
    // The brace problem, when there is one, is the shared sentence, once and first; every other problem is a count.
    assert.deepEqual(all.filter((p) => !/ is missing$| appears \d+ times, not once$/.test(p)), shared === undefined ? [] : [shared], t);
    if (shared !== undefined) assert.equal(all[0], shared, t);
  }
  // The renderer: the same text as the shared skeleton filled with the same parts, on parts that hold tokens and patterns.
  const tricky = { question: 'What does {answer} mean? $& $1', answer: 'It is {criterion}, not {question}. {{x}}', criterion: 'Never write {question} or {answer}. \\n' };
  for (const t of [TEMPLATE, '{criterion}|{answer}|{question}', '{answer}{question}{criterion}']) {
    assert.equal(renderTemplate(t, tricky), renderSkeleton(skeletonFromTemplate(t, TEMPLATE_TOKENS), tricky)[0], t);
  }
  // And the file holds no pattern or replacement of its own to drift from them.
  const source = readFileSync(join(import.meta.dirname, '..', 'examples', 'importers', 'skill-evals', 'render.ts'), 'utf8');
  assert.equal(/\.replace\(|\.matchAll\(|new RegExp|\/[gimsuy]*\.test\(/.test(source), false, 'render.ts holds a pattern of its own');
  for (const call of ['templateProblem(template, TEMPLATE_TOKENS)', 'renderSkeleton(skeletonFromTemplate(template, TEMPLATE_TOKENS), parts)']) assert.ok(source.includes(call), call);
});

test('a missing token is refused, each of the three by name', () => {
  for (const token of TEMPLATE_TOKENS) {
    const t = TEMPLATE.replace(`{${token}}`, 'x');
    const e = refusal(() => checkTemplate(t));
    assert.equal(e.code, 'IMPORT_PACKET');
    assert.match(e.message, new RegExp(`\\{${token}\\} is missing`));
  }
  assert.equal(templateProblems('no token at all').length, 3);
});

test('a token given twice is refused', () => {
  const e = refusal(() => checkTemplate(`${TEMPLATE}{answer}`));
  assert.match(e.message, /\{answer\} appears 2 times/);
});

test('rendering checks the template first, and an empty part is refused', () => {
  refusal(() => renderTemplate('{question} {answer}', parts));
  for (const token of TEMPLATE_TOKENS) {
    const e = refusal(() => renderTemplate(TEMPLATE, { ...parts, [token]: '' }));
    assert.equal(e.code, 'IMPORT_PACKET');
    assert.match(e.message, new RegExp(`${token}: the text is empty`));
  }
});

test('the prompt handed to the grader is the JSON text of [system, user] or [user], with exactly a role and a content each', () => {
  assert.equal(promptTextOf(undefined, 'hello'), '[{"role":"user","content":"hello"}]');
  assert.equal(promptTextOf('be strict', 'hello'), '[{"role":"system","content":"be strict"},{"role":"user","content":"hello"}]');
  assert.deepEqual(JSON.parse(promptTextOf('s "quoted"\n', 'u\u2028')), [
    { role: 'system', content: 's "quoted"\n' },
    { role: 'user', content: 'u\u2028' },
  ]);
});
