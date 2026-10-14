import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parseRunArtifact, runArtifactProblems } from '../src/artifact.ts';
import { foldOfCase } from '../src/cutmap.ts';
import { InputError } from '../src/errors.ts';
import { parseBarFile } from '../src/gate.ts';
import { canonicalJson, findIllFormed, hashOf, outputHashOf, packetHashOf, sha256Hex } from '../src/identity.ts';
import { judgeChangePlanProblems, referenceProblems } from '../src/judgechange.ts';
import { validateRecord } from '../src/ledger.ts';
import { seedFromString } from '../src/rng.ts';

// Node encodes every unpaired UTF-16 surrogate as U+FFFD when it turns a string into UTF-8, so each
// of these texts has the bytes of another one. None of them is hashable text.
const HIGH = '\ud800';
const LOW = '\udc00';
const REVERSED = '\udc00\ud800';
const REPLACEMENT = '�';
const ILL_FORMED: readonly [string, string][] = [
  ['a lone high surrogate', `a${HIGH}b`],
  ['a lone low surrogate', `a${LOW}b`],
  ['a reversed pair', `a${REVERSED}b`],
  ['another high surrogate', 'a\ud801b'],
];
const UNPAIRED = /unpaired surrogate/;

const utf8Sha = (s: string): string => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

test('the defect: before the fix, texts that differ only in an unpaired surrogate had one sha256', () => {
  // The bytes Node would hash are the same for all three, which is why the texts must be refused.
  assert.equal(utf8Sha(`a${HIGH}b`), utf8Sha(`a${REPLACEMENT}b`));
  assert.equal(utf8Sha(`a${HIGH}b`), utf8Sha('a\ud801b'));
  // So a hash for any of them would not say which text was hashed: none gets one.
  const hashes: string[] = [];
  for (const s of [`a${HIGH}b`, 'a\ud801b', `a${LOW}b`]) {
    try {
      hashes.push(sha256Hex(s));
    } catch {
      // refused: no hash
    }
  }
  assert.deepEqual(hashes, [], 'an unpaired surrogate got a hash, and it is the hash of the replacement character');
});

test('sha256Hex refuses a string with an unpaired surrogate, and still hashes well-formed text and bytes as before', () => {
  for (const [what, s] of ILL_FORMED) assert.throws(() => sha256Hex(s), (e: unknown) => e instanceof TypeError && UNPAIRED.test(e.message), what);
  assert.throws(() => sha256Hex(HIGH), TypeError);
  // FIPS 180-2 test vector.
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  // The replacement character itself is well-formed text (bytes EF BF BD).
  assert.equal(sha256Hex(REPLACEMENT), '83d544ccc223c057d2bf80d3f2a32982c32c3c0db8e2674820da5064783fb097');
  assert.equal(sha256Hex(REPLACEMENT), sha256Hex(new Uint8Array([0xef, 0xbf, 0xbd])));
  // A paired surrogate is one code point (U+1F600).
  assert.equal(sha256Hex('😀'), 'f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9');
  // Bytes are hashed as given, whatever they hold: the check is on strings only.
  assert.equal(sha256Hex(new Uint8Array([0xed, 0xa0, 0x80])), createHash('sha256').update(new Uint8Array([0xed, 0xa0, 0x80])).digest('hex'));
});

test('canonicalJson refuses an unpaired surrogate in a string value and in an object key, naming the path', () => {
  for (const [what, s] of ILL_FORMED) {
    assert.throws(() => canonicalJson(s), (e: unknown) => e instanceof TypeError && /^canonicalJson: .*unpaired surrogate.* at \$$/.test(e.message), what);
    assert.throws(() => canonicalJson({ a: [1, { b: s }] }), (e: unknown) => e instanceof TypeError && UNPAIRED.test(e.message) && e.message.endsWith('at $.a[1].b'), what);
    assert.throws(() => canonicalJson({ a: { [s]: 1 } }), (e: unknown) => e instanceof TypeError && UNPAIRED.test(e.message) && e.message.includes('object key') && e.message.includes('$.a'), what);
  }
  // The message is itself well-formed, so it can be printed and logged.
  try {
    canonicalJson({ [HIGH]: 1 });
    assert.fail('not refused');
  } catch (e) {
    assert.ok((e as Error).message.isWellFormed());
    assert.match((e as Error).message, /\\ud800/);
  }
  assert.equal(canonicalJson({ b: REPLACEMENT, [REPLACEMENT]: '😀' }), `{"b":"${REPLACEMENT}","${REPLACEMENT}":"😀"}`);
});

test('hashOf refuses an unpaired surrogate at any depth, and well-formed values hash as before', () => {
  for (const [what, s] of ILL_FORMED) {
    assert.throws(() => hashOf(s), TypeError, what);
    assert.throws(() => hashOf({ output: { text: s } }), (e: unknown) => e instanceof TypeError && e.message.endsWith('at $.output.text'), what);
    assert.throws(() => hashOf([{ [s]: 'x' }]), (e: unknown) => e instanceof TypeError && UNPAIRED.test(e.message), what);
  }
  assert.equal(hashOf(REPLACEMENT), '568601070314e0f4489c9944b3c151d5251d379330008293bb7e1a826a22a845');
  assert.equal(hashOf({ b: [1, 'x'], a: { c: true } }), '7a6b78591af835d18d4daa81abddae58f97fe664c748a14974c36b93b4c4664e');
});

test('outputHashOf refuses an output that is not well-formed text, as a string and as a record', () => {
  for (const [what, s] of ILL_FORMED) {
    assert.throws(() => outputHashOf(s), (e: unknown) => e instanceof TypeError && UNPAIRED.test(e.message), what);
    assert.throws(() => outputHashOf({ failed: 'error', detail: s }), (e: unknown) => e instanceof TypeError && e.message.endsWith('at $.detail'), what);
    assert.throws(() => outputHashOf({ [s]: 'x' }), TypeError, what);
  }
  assert.equal(outputHashOf(REPLACEMENT), '83d544ccc223c057d2bf80d3f2a32982c32c3c0db8e2674820da5064783fb097');
  assert.notEqual(outputHashOf(REPLACEMENT), outputHashOf('?'));
});

test('packetHashOf refuses an unpaired surrogate in a field, a field name or the output', () => {
  for (const [what, s] of ILL_FORMED) {
    assert.throws(() => packetHashOf({ question: s }, 'b'), (e: unknown) => e instanceof TypeError && UNPAIRED.test(e.message), what);
    assert.throws(() => packetHashOf({ question: 'a' }, s), TypeError, what);
    assert.throws(() => packetHashOf({ [s]: 'a' }, 'b'), TypeError, what);
    assert.throws(() => packetHashOf({ question: { text: s } }, 'b'), TypeError, what);
  }
  assert.equal(packetHashOf({ q: 'a' }, 'b'), '1f0578ad6904c993372e39f73459e98a68f158c3c2b4984e5397e2149fef0df9');
});

test('the other places that hash a string refuse it too: seedFromString and foldOfCase', () => {
  for (const [what, s] of ILL_FORMED) {
    assert.throws(() => seedFromString(s), TypeError, what);
    assert.throws(() => foldOfCase(s, 5), TypeError, what);
  }
  // First four bytes of sha256("abc"), big-endian: unchanged.
  assert.equal(seedFromString('abc'), 0xba7816bf);
});

test('findIllFormed names every string and key that holds an unpaired surrogate, and nothing else', () => {
  const out: string[] = [];
  findIllFormed({ ok: REPLACEMENT, a: [HIGH, { b: LOW }], [REVERSED]: 1, n: 3, t: true }, 'doc', out);
  assert.equal(out.length, 3);
  assert.match(out[0] as string, /^doc\.a\[0\]: .*unpaired surrogate/);
  assert.match(out[1] as string, /^doc\.a\[1\]\.b: .*unpaired surrogate/);
  assert.match(out[2] as string, /^doc: the object key "\\udc00\\ud800" .*unpaired surrogate/);
  assert.ok(out.every((p) => p.isWellFormed()));
});

// --- Files that are read: an unpaired surrogate is invalid input, named by its field -----------------
const root = join(import.meta.dirname, '..');
const ex = (...f: string[]): string => join(root, 'examples', ...f);
const readEx = (...f: string[]): Record<string, unknown> => JSON.parse(readFileSync(ex(...f), 'utf8')) as Record<string, unknown>;

test('the parsers refuse a document with an unpaired surrogate as invalid input, naming the field', () => {
  const run = readEx('refund-bot', 'baseline.json');
  ((run['cases'] as Record<string, unknown>[])[0] as Record<string, unknown>)['input'] = { text: `refund ${HIGH}` };
  const runProblems = runArtifactProblems(run);
  assert.deepEqual(runProblems.filter((p) => UNPAIRED.test(p)).map((p) => p.split(':')[0]), ['artifact.cases[0].input.text']);
  assert.throws(() => parseRunArtifact(run), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARTIFACT' && e.problems.some((p) => p.startsWith('artifact.cases[0].input.text: ')));

  const bar = readEx('refund-bot', 'bar.json');
  (bar['knownFailures'] as unknown[]) = [{ caseId: 'r01', since: '2026-01-01', note: `known ${LOW}` }];
  assert.throws(() => parseBarFile(bar), (e: unknown) => e instanceof InputError && e.code === 'INVALID_BAR' && e.problems.some((p) => p.startsWith('bar.knownFailures[0].note: ') && UNPAIRED.test(p)));

  const plan = readEx('judge-change', 'plan.json');
  (plan['judges'] as Record<string, Record<string, unknown>>)['old']!['judgeModelServed'] = `judge${HIGH}`;
  assert.ok(judgeChangePlanProblems(plan).some((p) => p.startsWith('plan.judges.old.judgeModelServed: ') && UNPAIRED.test(p)));

  const reference = readEx('judge-change', 'runs', 'bot-v1.reference.json');
  reference['verdictRule'] = `majority ${REVERSED}`;
  assert.ok(referenceProblems(reference).some((p) => p.startsWith('reference.verdictRule: ') && UNPAIRED.test(p)));

  assert.ok(validateRecord({ kind: `gate${HIGH}` }).some((p) => p.startsWith('record.kind: ') && UNPAIRED.test(p)));
});

const cli = (...args: string[]) => spawnSync(process.execPath, [join(root, 'src', 'cli.ts'), ...args], { encoding: 'utf8' });
const dir = mkdtempSync(join(tmpdir(), 'anchorset-wellformed-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
/** Writes a copy of an example with one change. JSON.stringify writes an unpaired surrogate as a \uXXXX escape. */
const changed = (file: string[], change: (f: Record<string, unknown>) => void): string => {
  const f = readEx(...file);
  change(f);
  const text = JSON.stringify(f);
  assert.match(text, /\\ud[89a-f][0-9a-f]{2}/);
  const path = join(dir, `${n++}-${file.at(-1) as string}`);
  writeFileSync(path, text);
  return path;
};
const firstCase = (f: Record<string, unknown>): Record<string, unknown> => (f['cases'] as Record<string, unknown>[])[0] as Record<string, unknown>;
/** Invalid input: exit 65, the field named, the surrogate printed as an escape, and no stack trace. */
const assertInvalid = (r: { status: number | null; stdout: string; stderr: string }, field: RegExp): void => {
  assert.equal(r.status, 65, r.stderr);
  assert.match(r.stderr, /^anchorset: invalid input \(/);
  assert.match(r.stderr, field);
  assert.match(r.stderr, UNPAIRED);
  assert.doesNotMatch(r.stderr, /\n\s+at .*\(|TypeError|node:internal/);
  assert.doesNotMatch(r.stderr, /�/);
  assert.equal(r.stdout, '');
};

test('gate: a run file or a bar file with an unpaired surrogate is invalid input (exit 65), with or without a ledger', () => {
  const bar = ex('refund-bot', 'bar.json');
  const baseline = ex('refund-bot', 'baseline.json');
  const candidate = ex('refund-bot', 'candidate.json');
  const badRun = changed(['refund-bot', 'baseline.json'], (f) => {
    firstCase(f)['input'] = { text: `refund ${HIGH}` };
  });
  assertInvalid(cli('gate', '--baseline', badRun, '--candidate', candidate, '--bar', bar), /--baseline .*: artifact\.cases\[0\]\.input\.text: /);
  assertInvalid(cli('gate', '--baseline', baseline, '--candidate', badRun, '--bar', bar, '--ledger', join(dir, 'gate.jsonl')), /--candidate .*: artifact\.cases\[0\]\.input\.text: /);
  assertInvalid(cli('gate', '--baseline', baseline, '--candidate', candidate, '--rejudge-of', badRun, '--bar', bar), /--rejudge-of .*: artifact\.cases\[0\]\.input\.text: /);
  const badKey = changed(['refund-bot', 'baseline.json'], (f) => {
    firstCase(f)['input'] = { [`k${LOW}`]: 'refund' };
  });
  assertInvalid(cli('gate', '--baseline', badKey, '--candidate', candidate, '--bar', bar), /artifact\.cases\[0\]\.input: the object key "k\\udc00"/);
  const badBar = changed(['refund-bot', 'bar.json'], (f) => {
    f['knownFailures'] = [{ caseId: 'r01', since: '2026-01-01', note: `known ${HIGH}` }];
  });
  assertInvalid(cli('gate', '--baseline', baseline, '--candidate', candidate, '--bar', badBar), /bar\.knownFailures\[0\]\.note: /);
});

test('agree: a ratings file with an unpaired surrogate is invalid input (exit 65), with or without a ledger', () => {
  const bad = changed(['refund-bot', 'ratings.json'], (f) => {
    for (const k of ['ratings', 'packetHashes']) {
      for (const items of Object.values(f[k] as Record<string, Record<string, string>>)) {
        const [first] = Object.keys(items) as [string];
        items[`${first}${HIGH}`] = items[first] as string;
        delete items[first];
      }
    }
  });
  assertInvalid(cli('agree', '--ratings', bad), /ratings\.ratings\.[^:]+: the object key /);
  assertInvalid(cli('agree', '--ratings', bad, '--json', '--ledger', join(dir, 'agree.jsonl')), /ratings\.ratings\.[^:]+: the object key /);
});

test('drift: an anchor file with an unpaired surrogate is invalid input (exit 65), with or without a ledger', () => {
  const oldPath = ex('refund-bot', 'anchor_old.json');
  const newPath = ex('refund-bot', 'anchor_new.json');
  const rename = (f: Record<string, unknown>): void => {
    for (const k of ['verdicts', 'packetHashes']) {
      const items = f[k] as Record<string, string>;
      const [first] = Object.keys(items) as [string];
      items[`${first}${LOW}`] = items[first] as string;
      delete items[first];
    }
  };
  // Both files carry the same ill-formed item id, so nothing but the surrogate is wrong with the pair.
  const badOld = changed(['refund-bot', 'anchor_old.json'], rename);
  const badNew = changed(['refund-bot', 'anchor_new.json'], rename);
  assertInvalid(cli('drift', '--old', badOld, '--new', badNew, '--flag', 'review,handoff', '--ledger', join(dir, 'drift.jsonl')), /old\.verdicts: the object key /);
  assertInvalid(cli('drift', '--old', oldPath, '--new', badNew, '--flag', 'review,handoff'), /new\.verdicts: the object key /);
  assertInvalid(cli('drift', '--old', badOld, '--new', newPath, '--flag', 'review,handoff', '--json'), /old\.verdicts: the object key /);
});

test('flips: a run file with an unpaired surrogate is invalid input (exit 65)', () => {
  const bad = changed(['refund-bot', 'judged.json'], (f) => {
    firstCase(f)['input'] = `refund ${REVERSED}`;
  });
  assertInvalid(cli('flips', '--run', bad), /--run .*: artifact\.cases\[0\]\.input: /);
  assertInvalid(cli('flips', '--run', bad, '--json'), /--run .*: artifact\.cases\[0\]\.input: /);
});

test('judge-change: a plan, a bar or a bound run file with an unpaired surrogate is invalid input (exit 65)', () => {
  const plan = ex('judge-change', 'plan.json');
  const bar = ex('judge-change', 'bar.json');
  const runs = ex('judge-change', 'runs');
  const badPlan = changed(['judge-change', 'plan.json'], (f) => {
    (f['judges'] as Record<string, Record<string, unknown>>)['old']!['judgeModelServed'] = `judge${HIGH}`;
  });
  assertInvalid(cli('judge-change', '--plan', badPlan, '--bar', bar, '--inputs', runs), /--plan .*: plan\.judges\.old\.judgeModelServed: /);
  const badBar = changed(['judge-change', 'bar.json'], (f) => {
    f['knownFailures'] = [{ caseId: 'c', since: '2026-01-01', note: `known ${LOW}` }];
  });
  assertInvalid(cli('judge-change', '--plan', plan, '--bar', badBar, '--inputs', runs), /bar\.knownFailures\[0\]\.note: /);

  // A run file the plan binds by its sha256: the roster admits it, and the parser refuses it.
  const inputs = join(dir, 'runs');
  cpSync(runs, inputs, { recursive: true });
  const name = 'bot-v1.old-judge.json';
  const before = sha256Hex(readFileSync(join(inputs, name)));
  const run = JSON.parse(readFileSync(join(inputs, name), 'utf8')) as Record<string, unknown>;
  firstCase(run)['input'] = { text: `refund ${HIGH}` };
  writeFileSync(join(inputs, name), JSON.stringify(run));
  const rebound = join(dir, 'rebound-plan.json');
  const planText = readFileSync(plan, 'utf8');
  assert.ok(planText.includes(before));
  writeFileSync(rebound, planText.replaceAll(before, sha256Hex(readFileSync(join(inputs, name)))));
  assertInvalid(cli('judge-change', '--plan', rebound, '--bar', bar, '--inputs', inputs), /bot-v1\.old-judge\.json: artifact\.cases\[0\]\.input\.text: /);

  const reference = 'bot-v1.reference.json';
  cpSync(join(runs, name), join(inputs, name));
  const refBefore = sha256Hex(readFileSync(join(inputs, reference)));
  const ref = JSON.parse(readFileSync(join(inputs, reference), 'utf8')) as Record<string, unknown>;
  ref['verdictRule'] = `majority ${REVERSED}`;
  writeFileSync(join(inputs, reference), JSON.stringify(ref));
  assert.ok(planText.includes(refBefore));
  writeFileSync(rebound, planText.replaceAll(refBefore, sha256Hex(readFileSync(join(inputs, reference)))));
  assertInvalid(cli('judge-change', '--plan', rebound, '--bar', bar, '--inputs', inputs, '--ledger', join(dir, 'jc.jsonl')), /bot-v1\.reference\.json: reference\.verdictRule: /);
});
