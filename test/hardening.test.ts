// What a file, a flag or a reader of the output may do to a command without changing what its exit code means.
// Exit 1 is the verdict "regression", so nothing here may end as exit 1 or as a stack trace: a reader that closed
// its end of the pipe, a file that declares more than it holds, a list as long as an input, a number too large to
// read. Every bound stated in docs/RUN_FORMAT.md and docs/RATINGS_FORMAT.md is held here at the bound and one past
// it. Synthetic refund-bot data only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import { agreementReport, cohenKappa, prevalence } from '../src/agreement.ts';
import { caseSetHash, MAX_RUN_SLOTS, RUN_SCHEMA, runArtifactProblems } from '../src/artifact.ts';
import { validateCallShape } from '../src/callshape.ts';
import { main } from '../src/cli.ts';
import { driftReport } from '../src/drift.ts';
import { InputError } from '../src/errors.ts';
import { barHash, evaluate, parseBarFile, splitBarFile } from '../src/gate.ts';
import type { BarFile } from '../src/gate.ts';
import type { RunArtifact } from '../src/artifact.ts';
import { gateRuns } from '../src/regression.ts';
import { appendAll, canonicalJson, duplicateKeyProblem, findUnhashable, GAP, hashOf, INEXACT_INTEGER, MAX_DRAWS_PER_CASE, MAX_JSON_DEPTH, MAX_TEXT_BYTES, NOT_UTF8, parseJsonBytes, parseJsonText, sha256Hex, TOO_LONG, utf8Text, validateIdentity, oneLine } from '../src/identity.ts';
import { judgeChangePlanProblems } from '../src/judgechange.ts';
import { checkLedgerFile, readLedger, validateRecord } from '../src/ledger.ts';
import { foldRun, MAX_LABELS, slotProblems, validateLabelSet } from '../src/scoring.ts';
import type { Case, ClassSpec, Draw, FoldedCase } from '../src/scoring.ts';
import { groupDraws } from '../src/stability.ts';
import { bootstrapCI, MAX_RESAMPLES } from '../src/stats.ts';
import { main as studyCheck } from '../tools/study-check.ts';
import { gradedAttempt, makeCallShape, makeIdentity, slot } from './helpers.ts';

const root = join(import.meta.dirname, '..');
const ex = (...p: string[]): string => join(root, 'examples', ...p);
const dir = mkdtempSync(join(tmpdir(), 'anchorset-hardening-'));
after(() => rmSync(dir, { recursive: true, force: true }));

type Ran = { status: number; stdout: string; stderr: string };
/** The command in this process: an error that escapes `main` fails the test by itself. */
const run = (...args: string[]): Ran => {
  const out: string[] = [];
  const err: string[] = [];
  const status = main(args, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
};
let n = 0;
const file = (v: unknown, name = 'f.json'): string => {
  const path = join(dir, `${n++}-${name}`);
  writeFileSync(path, typeof v === 'string' ? v : JSON.stringify(v));
  return path;
};
const NO_TRACE = /\n\s+at .*\(|RangeError|TypeError|node:internal|node:events|Maximum call stack|Unhandled 'error'/;
const invalid = (r: Ran, what: RegExp, name: string): void => {
  assert.equal(r.status, 65, `${name}: exit ${r.status}: ${r.stderr.slice(0, 300)}`);
  assert.match(r.stderr, what, name);
  assert.doesNotMatch(r.stderr, NO_TRACE, name);
  assert.equal(r.stdout, '', name);
};

// A small run graded by code: two cases, two draws each, every draw passing.
const bar = { labels: ['lo', 'hi'], classes: { k: { direction: 'floor', minPassRate: 0.5 } }, knownFailures: [] };
const barPath = file(bar, 'bar.json');
const twoCases: Case[] = [{ id: 'c1', klass: 'k', input: 'a', expect: 'hi' }, { id: 'c2', klass: 'k', input: 'b', expect: 'hi' }];
const drawsOf = (cases: readonly Case[], perCase: number): Draw[] => cases.flatMap((c) => Array.from({ length: perCase }, (_, i) => slot(c.id, i, gradedAttempt('hi', { outputHash: sha256Hex(c.id) }))));
const runOf = (over: { cases?: Case[]; perCase?: number; draws?: Draw[] } = {}): Record<string, unknown> => {
  const cases = over.cases ?? twoCases;
  const perCase = over.perCase ?? 2;
  return {
    schema: RUN_SCHEMA,
    identity: makeIdentity({ caseSetHash: caseSetHash(cases), barHash: barHash(parseBarFile(bar)), drawsPerCase: perCase }),
    callShapes: { system: makeCallShape(), judge: 'NO_JUDGE' },
    cases,
    draws: over.draws ?? drawsOf(cases, perCase),
    packetBasis: 'NO_JUDGE',
  };
};
/** The run as a JSON text with one token put in by hand, for a value JSON.stringify would not write. */
const runText = (find: string, put: string, over: Parameters<typeof runOf>[0] = {}): string => {
  const text = JSON.stringify(runOf(over));
  assert.ok(text.includes(find), find);
  return text.replace(find, put);
};
const gate = (path: string): Ran => run('gate', '--baseline', path, '--candidate', path, '--bar', barPath);
const flips = (path: string): Ran => run('flips', '--run', path);

test('the small run of this file is a valid run: the gate passes it against itself and flips reads it', () => {
  const path = file(runOf());
  assert.equal(gate(path).status, 0, gate(path).stderr);
  assert.equal(flips(path).status, 0, flips(path).stderr);
});

// ---- a reader that closed its end of the pipe -------------------------------------------------------------------------------

/**
 * A command as a process of its own, in a pipeline whose reader has already gone when the command first writes
 * (`true` exits at once; the command starts 0.3 s later). `where` says which stream goes into that pipe. Returns
 * the command's own exit code (bash's PIPESTATUS), and the stream that was not piped.
 */
const piped = (where: 'stdout' | 'stderr', script: string, ...args: string[]): { status: number; other: string } => {
  const redirect = where === 'stdout' ? '' : '2>&1 >/dev/null';
  const r = spawnSync('bash', ['-c', `{ sleep 0.3; exec "$0" "$@" ${redirect}; } | true; exit "\${PIPESTATUS[0]}"`, process.execPath, join(root, script), ...args], { encoding: 'utf8' });
  return { status: r.status ?? -1, other: where === 'stdout' ? r.stderr : r.stdout };
};
const hasBash = process.platform !== 'win32' && spawnSync('bash', ['-c', 'exit 0']).status === 0;
const demo = ['gate', '--baseline', ex('refund-bot', 'baseline.json'), '--candidate', ex('refund-bot', 'candidate.json'), '--bar', ex('refund-bot', 'bar.json'), '--allow-differ', 'systemModelServed,systemCallShapeHash'];

test('a reader that closed stdout does not change the exit code: 0 stays 0, the verdict stays the verdict, and nothing is a stack trace', { skip: !hasBash }, () => {
  const same = ['gate', '--baseline', ex('refund-bot', 'baseline.json'), '--candidate', ex('refund-bot', 'baseline.json'), '--bar', ex('refund-bot', 'bar.json')];
  const commands: [string, number, string[]][] = [
    ['a gate that passes', 0, same],
    ['a gate that passes, --json', 0, [...same, '--json']],
    ['the demo gate, whose verdict is a regression', 1, demo],
    ['agree --json', 0, ['agree', '--ratings', ex('refund-bot', 'ratings.json'), '--json']],
    ['agree', 0, ['agree', '--ratings', ex('refund-bot', 'ratings.json')]],
    ['drift', 0, ['drift', '--old', ex('refund-bot', 'anchor_old.json'), '--new', ex('refund-bot', 'anchor_new.json'), '--flag', 'handoff']],
    ['flips', 0, ['flips', '--run', ex('refund-bot', 'judged.json')]],
    ['judge-change', 0, ['judge-change', '--plan', ex('judge-change', 'plan.json'), '--bar', ex('judge-change', 'bar.json'), '--inputs', ex('judge-change', 'runs')]],
    ['--help', 0, ['--help']],
  ];
  for (const [name, own, args] of commands) {
    // The command's own exit code, with every reader present.
    const whole = spawnSync(process.execPath, [join(root, 'src', 'cli.ts'), ...args], { encoding: 'utf8' });
    assert.equal(whole.status, own, `${name}: ${whole.stderr}`);
    assert.ok(whole.stdout.length > 0, name);
    const r = piped('stdout', 'src/cli.ts', ...args);
    assert.equal(r.status, own, `${name}: exit ${r.status} with stdout closed: ${r.other.slice(0, 300)}`);
    assert.equal(r.other, '', `${name}: nothing is said on stderr about a reader that left`);
  }
});

test('a reader that closed stderr does not change the exit code: invalid input stays 65, a refusal 2, a usage error 64', { skip: !hasBash }, () => {
  const bad = file('{"schema": ', 'not-json.json');
  const commands: [string, number, string[]][] = [
    ['a run file that is not JSON', 65, ['gate', '--baseline', bad, '--candidate', bad, '--bar', ex('refund-bot', 'bar.json')]],
    ['a ratings file that is not JSON', 65, ['agree', '--ratings', bad]],
    ['the demo gate without its declared axes', 2, demo.slice(0, -2)],
    ['an unknown flag', 64, ['gate', '--nosuch']],
  ];
  for (const [name, own, args] of commands) {
    const whole = spawnSync(process.execPath, [join(root, 'src', 'cli.ts'), ...args], { encoding: 'utf8' });
    assert.equal(whole.status, own, `${name}: ${whole.stderr}`);
    assert.ok(whole.stderr.length > 0, name);
    const r = piped('stderr', 'src/cli.ts', ...args);
    assert.equal(r.status, own, `${name}: exit ${r.status} with stderr closed`);
    assert.equal(r.other, '', name);
  }
});

test('study-check has the same rule: a reader that closed its output leaves the exit code as it was', { skip: !hasBash }, () => {
  assert.deepEqual(piped('stdout', 'tools/study-check.ts', ex('judge-change', 'manifest.json')), { status: 0, other: '' });
  assert.deepEqual(piped('stderr', 'tools/study-check.ts', join(dir, 'no-such-manifest.json')), { status: 65, other: '' });
});

test('a write that fails for any other reason is exit 70 with one line on stderr, never exit 1', { skip: !hasBash }, () => {
  // Standard output opened for reading only: every write to it fails, and no reader closed anything.
  const readOnly = file('', 'read-only.txt');
  for (const args of [['--help'], demo, ['flips', '--run', ex('refund-bot', 'judged.json'), '--json']]) {
    const r = spawnSync('bash', ['-c', '"$0" "$@" 1<"$TARGET"', process.execPath, join(root, 'src', 'cli.ts'), ...args], { encoding: 'utf8', env: { ...process.env, TARGET: readOnly } });
    assert.equal(r.status, 70, `${args[0]}: ${r.stderr}`);
    assert.match(r.stderr, /^anchorset: internal error: [^\n]+\n$/, args[0]);
    assert.doesNotMatch(r.stderr, NO_TRACE);
  }
  // study-check: its report used to go through console.log, which drops a failed write and says nothing, so the
  // command exited 0 with nothing printed.
  const s = spawnSync('bash', ['-c', '"$0" "$@" 1<"$TARGET"', process.execPath, join(root, 'tools', 'study-check.ts'), ex('judge-change', 'manifest.json')], { encoding: 'utf8', env: { ...process.env, TARGET: readOnly } });
  assert.equal(s.status, 70, s.stderr);
  // The line names the tool that failed to write, not the CLI.
  assert.match(s.stderr, /^study-check: internal error: cannot write to stdout: [^\n]+\n$/);
  assert.equal(readFileSync(readOnly, 'utf8'), '');
});

// ---- a file that declares more than it holds ----------------------------------------------------------------------------

test(`drawsPerCase: at most ${MAX_DRAWS_PER_CASE}; a file of a few bytes that declares more is invalid input (65), not memory spent on its slots`, () => {
  assert.equal(MAX_DRAWS_PER_CASE, 10_000);
  const identity = (perCase: unknown): string[] => validateIdentity({ ...makeIdentity(), drawsPerCase: perCase });
  assert.deepEqual(identity(MAX_DRAWS_PER_CASE), []);
  assert.deepEqual(identity(MAX_DRAWS_PER_CASE + 1), ['identity.drawsPerCase: at most 10000 draws per case are read']);
  for (const perCase of ['10001', '100000000', '500000000', '4294967295', '4294967296', '1e21']) {
    const path = file(runText('"drawsPerCase":2', `"drawsPerCase":${perCase}`), 'draws.json');
    for (const [name, r] of [['gate', gate(path)], ['flips', flips(path)]] as const) {
      invalid(r, /artifact\.identity\.drawsPerCase: at most 10000 draws per case are read/, `${name}, drawsPerCase ${perCase}`);
    }
  }
});

test('the one slot check holds the same bound for a caller that skips the parser: the fold and the flip rate refuse before a slot is counted', () => {
  assert.deepEqual(slotProblems([], MAX_DRAWS_PER_CASE), []);
  for (const perCase of [MAX_DRAWS_PER_CASE + 1, 100_000_000, 2 ** 32, 1e21, Number.POSITIVE_INFINITY, Number.NaN]) {
    assert.deepEqual(slotProblems([], perCase), [`drawsPerCase ${perCase}: at most 10000 draws per case are read`]);
    const draws = drawsOf(twoCases, 2);
    const thrown = (f: () => unknown): InputError => {
      try {
        f();
      } catch (e) {
        assert.ok(e instanceof InputError, String(e));
        return e;
      }
      return assert.fail('not refused');
    };
    assert.equal(thrown(() => foldRun(twoCases, draws, ['lo', 'hi'], { k: { direction: 'floor' } }, perCase)).code, 'INVALID_DRAWS');
    assert.equal(thrown(() => groupDraws(draws, perCase, ['c1', 'c2'])).code, 'INVALID_DRAWS');
  }
});

test(`a run declares at most ${MAX_RUN_SLOTS} draw slots (cases times drawsPerCase), whether or not it holds a draw for them`, () => {
  assert.equal(MAX_RUN_SLOTS, 1_000_000);
  const cases = (count: number): Case[] => Array.from({ length: count }, (_, i) => ({ id: `c${i}`, klass: 'k', input: 'a', expect: 'hi' }));
  // 100 cases of 10,000 draws are the bound, 101 are past it. No draw is in either file: every slot is missing.
  const at = runArtifactProblems(runOf({ cases: cases(100), perCase: MAX_DRAWS_PER_CASE, draws: [] }));
  assert.deepEqual(at, []);
  const past = file(runOf({ cases: cases(101), perCase: MAX_DRAWS_PER_CASE, draws: [] }), 'slots.json');
  for (const r of [gate(past), flips(past)]) invalid(r, /artifact: 101 cases of 10000 draws each are 1010000 draw slots; at most 1000000 are read/, 'slots');
});

test('a judge-change plan holds the same bound on drawsPerCase', () => {
  const plan = JSON.parse(readFileSync(ex('judge-change', 'plan.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(judgeChangePlanProblems(plan), []);
  assert.ok(judgeChangePlanProblems({ ...plan, drawsPerCase: MAX_DRAWS_PER_CASE + 1 }).includes('plan.drawsPerCase: at most 10000 draws per case are read'));
  assert.ok(judgeChangePlanProblems({ ...plan, resampling: { iterations: MAX_RESAMPLES + 1, seed: 1, spreadFloor: 0 } }).includes('plan.resampling.iterations: at most 1000000 are drawn'));
});

// ---- a list as long as an input ---------------------------------------------------------------------------------------------

const MANY = 150_000;

test('appendAll appends a list longer than a call may take arguments', () => {
  const out: number[] = [0];
  appendAll(out, Array.from({ length: 400_000 }, (_, i) => i + 1));
  assert.equal(out.length, 400_001);
  assert.deepEqual([out[0], out[1], out[400_000]], [0, 1, 400_000]);
  appendAll(out, new Set([-1]));
  assert.equal(out.at(-1), -1);
});

// The text report of `flips` took its column widths by Math.max(...) over the listed cases, and a run of 150,000 flipping
// cases overflowed the stack there (exit 70). That run takes about a minute to read, so it is not built here: the scan
// below holds that site and every other one.
test('no source file spreads a list into an argument list: not into push, not into Math.max or Math.min', () => {
  const files = [...readdirSync(join(root, 'src')).map((f) => join(root, 'src', f)), join(root, 'tools', 'study-check.ts')].filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 15);
  const found: string[] = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (/\.(push|unshift|concat)\(\s*\.\.\.|Math\.(max|min)\([^)]*\.\.\.|String\.fromCharCode\(\s*\.\.\.|\.apply\(/.test(line)) found.push(`${f.slice(root.length + 1)}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(found, []);
});

test(`${MANY} unknown keys, nulls or problems in one file are invalid input (65) that lists them all, never a stack overflow`, () => {
  const keys = (prefix: string): string => Array.from({ length: MANY }, (_, i) => `"${prefix}${i}":1`).join(',');
  // In the identity, in one case, and at the top of the file.
  const inIdentity = file(runText('"seed":42', `"seed":42,${keys('x')}`), 'keys-identity.json');
  const inCase = file(runText('"expect":"hi"}]', `"expect":"hi",${keys('y')}}]`), 'keys-case.json');
  const atTop = file(runText('"packetBasis"', `${keys('z')},"packetBasis"`), 'keys-top.json');
  for (const [name, r, what] of [['identity', gate(inIdentity), /artifact\.identity\.x149999: unknown field/], ['case', flips(inCase), /artifact\.cases\[1\]\.y149999: unknown field/], ['top', gate(atTop), /artifact\.z149999: unknown field/]] as const) {
    invalid(r, what, name);
    assert.ok(r.stderr.split('\n').length > MANY, name);
  }
  // A call shape whose one value holds that many nulls.
  const nulls = validateCallShape({ ...makeCallShape(), betaFlags: Array.from({ length: MANY }, () => null) });
  assert.ok(nulls.length >= MANY);
  assert.equal(nulls[MANY - 1], `callShape.betaFlags[${MANY - 1}]: null is not allowed`);
  // Every draw of a run invalid in the same way: the problems of all the attempt lists are appended to one list.
  const draws = Array.from({ length: MANY }, (_, i) => ({ caseId: 'c1', drawIndex: i % 2, attempts: [] }));
  const problems = runArtifactProblems(runOf({ draws: draws as unknown as Draw[] }));
  assert.ok(problems.length >= MANY);
});

// ---- a number too large to read ---------------------------------------------------------------------------------------------

test('a number too large to read is invalid input in every JSON text, named by its path: it reads as infinity, which has no canonical JSON', () => {
  const NOT_FINITE = 'a number that is not finite (a JSON text holds none, and a number too large to be read, such as 1e999, becomes infinity)';
  assert.deepEqual(parseJsonText('{"a":[1,{"b":1e999}]}'), { problem: `$.a[1].b: ${NOT_FINITE}`, notJson: false });
  assert.deepEqual(parseJsonText('[-1e999]'), { problem: `$[0]: ${NOT_FINITE}`, notJson: false });
  assert.deepEqual(parseJsonText('1e999'), { problem: `$: ${NOT_FINITE}`, notJson: false });
  // The first one, in the order of the document; and the largest and smallest numbers that are read stay read.
  assert.deepEqual(parseJsonText('{"a":1e999,"b":-1e999}'), { problem: `$.a: ${NOT_FINITE}`, notJson: false });
  assert.deepEqual(parseJsonText('[1.7976931348623157e308,-1.7976931348623157e308,5e-324,1e-999]'), { json: [Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, 0] });
  assert.deepEqual(parseJsonBytes(Buffer.from('{"n":2e308}')), { problem: `$.n: ${NOT_FINITE}`, notJson: false });

  const inInput = file(runText('"input":"a"', '"input":1e999'), 'inf-input.json');
  for (const r of [gate(inInput), flips(inInput)]) invalid(r, /inf-input\.json: \$\.cases\[0\]\.input: a number that is not finite/, 'case input');
  const ratings = JSON.parse(readFileSync(ex('refund-bot', 'ratings.json'), 'utf8')) as Record<string, unknown>;
  invalid(run('agree', '--ratings', file(JSON.stringify({ ...ratings, bootstrap: { seed: 1 } }).replace('"seed":1', '"seed":1e999'))), /\$\.bootstrap\.seed: a number that is not finite/, 'ratings');
  const bad = file(JSON.stringify(bar).replace('0.5', '1e999'), 'inf-bar.json');
  invalid(run('gate', '--baseline', ex('refund-bot', 'baseline.json'), '--candidate', ex('refund-bot', 'baseline.json'), '--bar', bad), /\$\.classes\.k\.minPassRate: a number that is not finite/, 'bar');
  // A ledger line and a study manifest go through the same reader.
  const ledger = file('{"schema":"anchorset.ledger/v1","at":1e999}\n', 'ledger.jsonl');
  assert.throws(() => readLedger(ledger), (e: unknown) => e instanceof InputError && e.code === 'INVALID_LEDGER' && /^line 1: \$\.at: a number that is not finite/.test(e.problems[0] as string));
  const err: string[] = [];
  assert.equal(studyCheck([file('{"cells":[1e999]}', 'manifest.json')], { out: () => undefined, err: (s) => err.push(s) }), 65);
  assert.match(err.join('\n'), /\$\.cells\[0\]: a number that is not finite/);
});

test('runArtifactProblems returns a problem, and never throws, for a value a caller parsed that has no canonical JSON', () => {
  const withInput = (input: unknown): unknown => {
    const a = runOf();
    return { ...a, cases: [{ ...twoCases[0], input }, twoCases[1]] };
  };
  const deep = (levels: number): unknown => {
    let v: unknown = 'x';
    for (let i = 0; i < levels; i++) v = [v];
    return v;
  };
  const self: Record<string, unknown> = {};
  self['self'] = self;
  const twice: Record<string, unknown> = {};
  twice['a'] = twice;
  twice['b'] = twice;
  const cases: [string, unknown, RegExp][] = [
    ['infinity', Number.POSITIVE_INFINITY, /^artifact\.cases\[0\]\.input: a number that is not finite/],
    ['NaN', { n: [Number.NaN] }, /^artifact\.cases\[0\]\.input\.n\[0\]: a number that is not finite/],
    ['nested too deep', deep(MAX_JSON_DEPTH), /^artifact\.cases\[0\]\.input(\[0\])+: objects and lists are nested more than 128 deep$/],
    ['nested 200,000 deep', deep(200_000), /: objects and lists are nested more than 128 deep$/],
    ['a value that holds itself', self, /^artifact\.cases\[0\]\.input\.self: the value holds itself, and a JSON value cannot$/],
    ['a value that holds itself twice over', twice, /^artifact\.cases\[0\]\.input\.[ab]: the value holds itself, and a JSON value cannot$/],
    ['undefined', { u: undefined }, /^artifact\.cases\[0\]\.input\.u: undefined is not a JSON value$/],
    ['a bigint', 1n, /^artifact\.cases\[0\]\.input: a bigint is not a JSON value$/],
    ['a function', () => 1, /^artifact\.cases\[0\]\.input: a function is not a JSON value$/],
    ['a Map', new Map([[1, 2]]), /^artifact\.cases\[0\]\.input: an object that is not a plain object is not a JSON value$/],
  ];
  for (const [name, input, what] of cases) {
    let problems: string[] = [];
    assert.doesNotThrow(() => (problems = runArtifactProblems(withInput(input))), name);
    assert.equal(problems.filter((p) => what.test(p)).length, name.includes('twice') ? 2 : 1, `${name}: ${problems.slice(0, 3).join(' | ').slice(0, 300)}`);
    // What canonicalJson would have thrown for the same value: the problem stands in for that error.
    assert.throws(() => canonicalJson({ cases: [{ input }] }), TypeError, name);
  }
  // The deepest input a file may hold is still read: the artifact, its case list and the case are three levels above it.
  assert.deepEqual(runArtifactProblems(withInput(deep(MAX_JSON_DEPTH - 3))).filter((p) => /nested/.test(p)), []);
  // In a call shape too: the extras are free-form.
  const a = runOf() as { callShapes: { system: Record<string, unknown> } };
  a.callShapes.system = { ...a.callShapes.system, extras: { 'vendor.x': Number.NEGATIVE_INFINITY } };
  assert.ok(runArtifactProblems(a).some((p) => /^artifact\.callShapes\.system\.extras\.vendor\.x: a number that is not finite/.test(p)));
  const out: string[] = [];
  findUnhashable({ a: [1, 'x', null, true, { b: {} }] }, 'v', out);
  assert.deepEqual(out, []);
});

test('parseBarFile refuses a bar a caller parsed that has no canonical JSON as INVALID_BAR, naming where: never a TypeError from the hash, never a walk without end', () => {
  const base = (): { labels: string[]; classes: Record<string, Record<string, unknown>>; knownFailures: Record<string, unknown>[] } => ({
    labels: ['lo', 'hi'],
    classes: { k: { direction: 'floor', minPassRate: 0.5 } },
    knownFailures: [{ caseId: 'c1', since: '2026-01-10', note: 'tracked' }],
  });
  const withNote = (extra: unknown): unknown => {
    const b = base();
    (b.knownFailures[0] as Record<string, unknown>)['note'] = extra;
    return b;
  };
  const cyclic = base() as Record<string, unknown>;
  cyclic['knownFailures'] = [cyclic];
  const cyclicClass = base();
  (cyclicClass.classes['k'] as Record<string, unknown>)['nonCompensable'] = cyclicClass.classes;
  const undefinedFlag = base();
  (undefinedFlag.classes['k'] as Record<string, unknown>)['nonCompensable'] = undefined;
  const bigRate = base();
  (bigRate.classes['k'] as Record<string, unknown>)['minPassRate'] = 1n;
  const cases: [string, unknown, RegExp][] = [
    ['undefined where a field may be absent', undefinedFlag, /^bar\.classes\.k\.nonCompensable: undefined is not a JSON value$/],
    ['a bigint', bigRate, /^bar\.classes\.k\.minPassRate: a bigint is not a JSON value$/],
    ['a bigint in a known failure', { ...base(), knownFailures: [{ caseId: 'c1', since: '2026-01-10', note: 'x', n: 1n }] }, /^bar\.knownFailures\[0\]\.n: a bigint is not a JSON value$/],
    ['undefined in a known failure', { ...base(), knownFailures: [{ caseId: 'c1', since: '2026-01-10', note: 'x', n: undefined }] }, /^bar\.knownFailures\[0\]\.n: undefined is not a JSON value$/],
    ['a function', withNote(() => 'x'), /^bar\.knownFailures\[0\]\.note: a function is not a JSON value$/],
    ['a Date', withNote(new Date(0)), /^bar\.knownFailures\[0\]\.note: an object that is not a plain object is not a JSON value$/],
    ['a number that is not finite', { ...base(), classes: { k: { direction: 'floor', minPassRate: Number.NaN } } }, /^bar\.classes\.k\.minPassRate: a number that is not finite/],
    ['a bar that holds itself', cyclic, /^bar\.knownFailures\[0\]: the value holds itself, and a JSON value cannot$/],
    ['a class that holds the classes', cyclicClass, /^bar\.classes\.k\.nonCompensable: the value holds itself, and a JSON value cannot$/],
  ];
  for (const [name, bar, what] of cases) {
    for (const call of [() => parseBarFile(bar), () => gateRuns(runOf() as unknown as RunArtifact, runOf() as unknown as RunArtifact, bar as BarFile)]) {
      assert.throws(call, (e: unknown) => {
        assert.ok(e instanceof InputError, `${name}: ${String(e)}`);
        assert.equal(e.code, 'INVALID_BAR', name);
        assert.equal(e.problems.filter((p) => what.test(p)).length, 1, `${name}: ${e.problems.join(' | ').slice(0, 300)}`);
        return true;
      });
    }
  }
  // The bar of the other tests is still read, and its hash is taken.
  assert.equal(barHash(parseBarFile(base())).length, 64);
});

// ---- names and counts that come from a file ---------------------------------------------------------------------------------

test('a label named __proto__ keeps its share in prevalence and in each rater\'s marginals', () => {
  const p = prevalence(['__proto__', 'a', 'a', '__proto__']);
  assert.deepEqual(Object.entries(p), [['__proto__', 0.5], ['a', 0.5]]);
  assert.equal(Object.getPrototypeOf(p), Object.prototype);
  const hash = sha256Hex('p');
  const items = ['i1', 'i2', 'i3', 'i4'];
  const rated = (labels: string[]): Record<string, string> => Object.fromEntries(items.map((id, i) => [id, labels[i] as string]));
  const packets = Object.fromEntries(items.map((id) => [id, hash]));
  const ratings = { r1: rated(['__proto__', '__proto__', 'a', 'a']), r2: rated(['__proto__', 'a', 'a', 'a']) };
  const report = agreementReport(ratings, { packetHashes: { r1: packets, r2: packets }, categories: ['__proto__', 'a'], bootstrap: { iterations: 50 } });
  const sum = (r: Record<string, number>): number => Object.values(r).reduce((s, x) => s + x, 0);
  assert.deepEqual(Object.entries(report.prevalence), [['__proto__', 0.375], ['a', 0.625]]);
  const pair = report.pairwise[0] as (typeof report.pairwise)[number];
  for (const shares of [report.prevalence, pair.prevalence, pair.marginals.a, pair.marginals.b]) assert.equal(sum(shares), 1);
  assert.deepEqual(Object.entries(pair.marginals.b), [['__proto__', 0.25], ['a', 0.75]]);
  // And in the printed report, and in the JSON a ledger would hash.
  const text = JSON.stringify({ schema: 'anchorset.ratings/v1', categories: ['__proto__', 'a'], ratings, packetHashes: { r1: packets, r2: packets }, bootstrap: { iterations: 50 } });
  const path = file(text, 'proto.json');
  assert.match(run('agree', '--ratings', path).stdout, /^prevalence {7}__proto__ 0\.375 · a 0\.625$/m);
  assert.deepEqual(Object.keys((JSON.parse(run('agree', '--ratings', path, '--json').stdout) as { prevalence: object }).prevalence), ['__proto__', 'a']);
});

test(`at most ${MAX_LABELS} labels or categories: one more is invalid input (65) in drift and in agree, not a table of their square`, () => {
  assert.equal(MAX_LABELS, 1_000);
  const names = (count: number): string[] => Array.from({ length: count }, (_, i) => `l${i}`);
  assert.deepEqual(validateLabelSet(names(MAX_LABELS)), []);
  assert.deepEqual(validateLabelSet(names(MAX_LABELS + 1)), ['labels: 1001 labels; at most 1000 are read']);
  // Observed labels count as declared ones do.
  assert.equal(cohenKappa(names(MAX_LABELS), names(MAX_LABELS)).kappa, 1);
  assert.throws(() => cohenKappa(names(MAX_LABELS + 1), names(MAX_LABELS + 1)), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && e.problems[0] === 'categories: 1001 categories; at most 1000 are read');
  assert.throws(() => cohenKappa(['a'], ['a'], names(MAX_LABELS + 1)), (e: unknown) => e instanceof InputError && e.problems[0] === 'categories: 1001 categories; at most 1000 are read');
  const hash = sha256Hex('p');
  const verdicts = new Map(names(MAX_LABELS + 1).map((l) => [l, l]));
  const hashes = new Map(names(MAX_LABELS + 1).map((l) => [l, hash]));
  assert.throws(() => driftReport(verdicts, verdicts, { labels: names(MAX_LABELS + 1), flagLabels: ['l0'], packetHashes: { old: hashes, new: hashes } }), (e: unknown) => e instanceof InputError && e.problems[0] === 'labels: 1001 labels; at most 1000 are read');

  for (const count of [MAX_LABELS + 1, MANY]) {
    const ids = names(count);
    const anchor = file({ schema: 'anchorset.anchor/v1', labels: ids, verdicts: Object.fromEntries(ids.map((l) => [l, l])), packetHashes: Object.fromEntries(ids.map((l) => [l, hash])) }, 'anchor.json');
    invalid(run('drift', '--old', anchor, '--new', anchor, '--flag', 'l0'), new RegExp(`labels: ${count} labels; at most 1000 are read`), `drift, ${count} labels`);
    const one = { ratings: Object.fromEntries(ids.map((l) => [l, l])), packets: Object.fromEntries(ids.map((l) => [l, hash])) };
    const ratings = file({ schema: 'anchorset.ratings/v1', categories: ids, ratings: { r1: one.ratings, r2: one.ratings }, packetHashes: { r1: one.packets, r2: one.packets } }, 'ratings.json');
    invalid(run('agree', '--ratings', ratings), new RegExp(`categories: ${count} categories; at most 1000 are read`), `agree, ${count} labels`);
  }
  // A bar file's label set is a label set.
  invalid(run('gate', '--baseline', ex('refund-bot', 'baseline.json'), '--candidate', ex('refund-bot', 'baseline.json'), '--bar', file({ ...bar, labels: names(MAX_LABELS + 1) }, 'bar.json')), /labels: 1001 labels; at most 1000 are read/, 'bar');
});

test(`at most ${MAX_RESAMPLES} resamples: a ratings file that asks for more is invalid input (65)`, () => {
  assert.equal(MAX_RESAMPLES, 1_000_000);
  const opts = { seed: 1, alpha: 0.05 };
  assert.equal(bootstrapCI([1], (s) => s[0] as number, { ...opts, iterations: MAX_RESAMPLES }).undefinedResamples, 0);
  assert.throws(() => bootstrapCI([1], (s) => s[0] as number, { ...opts, iterations: MAX_RESAMPLES + 1 }), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && e.problems[0] === 'bootstrap: iterations 1000001; at most 1000000 are drawn');
  const ratings = JSON.parse(readFileSync(ex('refund-bot', 'ratings.json'), 'utf8')) as Record<string, unknown>;
  for (const iterations of [MAX_RESAMPLES + 1, 1e15, Number.MAX_SAFE_INTEGER]) {
    invalid(run('agree', '--ratings', file({ ...ratings, bootstrap: { iterations } })), /bootstrap: iterations \d+; at most 1000000 are drawn/, `iterations ${iterations}`);
  }
});

// ---- errors that are reported as what they are --------------------------------------------------------------------------

test(`a file of more than ${MAX_TEXT_BYTES} bytes is refused by its length, and is not called "not UTF-8"`, () => {
  assert.equal(MAX_TEXT_BYTES, 536_870_888);
  assert.equal(TOO_LONG, 'the file is longer than 536870888 bytes, the most that is read as one text');
  // Zero bytes are valid UTF-8, and these pages are never touched: the length alone refuses.
  const long = Buffer.alloc(MAX_TEXT_BYTES + 1);
  assert.deepEqual(utf8Text(long), { problem: TOO_LONG });
  assert.deepEqual(parseJsonBytes(long), { problem: `invalid JSON: ${TOO_LONG}`, notJson: true });
  assert.deepEqual(utf8Text(Buffer.from([0x7b, 0xff, 0x7d])), { problem: NOT_UTF8 });
});

test('only the decoder\'s own refusal is "not UTF-8", and only the file system\'s word makes a ledger invalid: any other error stays an error (exit 70)', () => {
  const ledger = join(dir, 'held.jsonl');
  assert.equal(run('agree', '--ratings', ex('refund-bot', 'ratings.json'), '--ledger', ledger).status, 0);
  assert.equal(checkLedgerFile(ledger), 1);
  const unforeseen = Object.assign(new Error('not foreseen'), { code: 'ERR_NOT_FORESEEN' });
  const decode = mock.method(TextDecoder.prototype, 'decode', () => {
    throw unforeseen;
  });
  try {
    assert.throws(() => utf8Text(Buffer.from('{}')), (e: unknown) => e === unforeseen);
    assert.throws(() => readLedger(ledger), (e: unknown) => e === unforeseen);
    assert.throws(() => checkLedgerFile(ledger), (e: unknown) => e === unforeseen);
    const r = run('agree', '--ratings', ex('refund-bot', 'ratings.json'), '--ledger', ledger);
    assert.deepEqual([r.status, r.stderr, r.stdout], [70, 'anchorset: internal error: not foreseen', '']);
    // study-check: an error that merely carries a code is not invalid input.
    const err: string[] = [];
    assert.equal(studyCheck([ex('judge-change', 'manifest.json')], { out: () => undefined, err: (s) => err.push(s) }), 70);
    assert.deepEqual(err, ['internal error: not foreseen']);
  } finally {
    decode.mock.restore();
  }
  assert.equal(checkLedgerFile(ledger), 1);
  // What the file system says about a ledger path is still invalid input that names the path.
  assert.throws(() => checkLedgerFile(join(ledger, 'under-a-file.jsonl')), (e: unknown) => e instanceof InputError && e.code === 'INVALID_LEDGER');
});

test('study-check: a manifest or an input that cannot be read is invalid input (65) that names the file', () => {
  const missing = join(dir, 'no-such-manifest.json');
  const err: string[] = [];
  assert.equal(studyCheck([missing], { out: () => undefined, err: (s) => err.push(s) }), 65);
  assert.equal(err.length, 2);
  assert.equal(err[0], 'invalid input (INVALID_ARGUMENT)');
  assert.match(err[1] as string, new RegExp(`^ {2}- cannot read ${missing.replace(/[.\\/]/g, '\\$&')}: ENOENT`));
});

// ---- the duplicate-key scan never calls a text clean that it could not read to the end ---------------------------------

test('duplicateKeyProblem: a text it cannot read to the end is "not JSON", never clean, whatever the parser would have said', () => {
  const NOT_JSON = 'the text is not JSON';
  // Each of these is refused by JSON.parse, so parseJsonText never hands one to the scan: the scan is asked directly.
  const texts: [string, string][] = [
    ['a string left open, with nothing around it', '"abc'],
    ['a string left open after a closed list', '[1] "abc'],
    ['a string left open', '{"a": "b'],
    ['a key left open', '{"a'],
    ['a string that ends in a backslash', '["a\\'],
    ['a close with nothing open', ']'],
    ['a close with nothing open, after a value', '{"a":1}}'],
    ['a list closed as an object', '[1}'],
    ['an object closed as a list', '{"a":1]'],
    ['a comma at the top level', '1,2'],
    ['a comma after the last close', '{"a":1},'],
    ['a list left open', '[1,2'],
    ['an object left open', '{"a":1'],
    ['an object left open inside a list', '[{"a":1}, {"b":2'],
  ];
  for (const [name, text] of texts) {
    assert.throws(() => JSON.parse(text), SyntaxError, name);
    assert.equal(duplicateKeyProblem(text), NOT_JSON, name);
  }
  // And the texts beside them that are JSON are clean.
  for (const text of ['{"a": "b"}', '[]', '{"a":1}', '[1]', '[1,2]', '[{"a":1}, {"b":2}]', '"a,]}"']) assert.equal(duplicateKeyProblem(text), undefined, text);
});

test('a ledger with a byte that is not UTF-8: the line named is the one that holds the byte, also when an earlier line starts with U+FEFF', () => {
  // Line 2 starts with the bytes of a byte-order mark. Inside a file that is a character like any other, and the line is UTF-8.
  const bytes = Buffer.concat([Buffer.from('{"line":1}\n'), Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"line":2}\n{"line":3,"x":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
  const path = join(dir, 'bom-inside.jsonl');
  writeFileSync(path, bytes);
  assert.throws(() => readLedger(path), (e: unknown) => e instanceof InputError && e.code === 'INVALID_LEDGER' && e.problems.length === 1 && e.problems[0] === `line 3: ${NOT_UTF8}`);
});

// ---- text read from a file cannot start a report line of its own --------------------------------------------------------

test('oneLine writes every control character and line separator as an escape, and leaves other text as it is', () => {
  assert.equal(oneLine('a\nb\rc\td'), 'a\\nb\\rc\\td');
  assert.equal(oneLine('\u0000\u001b[2K\u007f\u0085\u009f\u2028\u2029'), '\\u0000\\u001b[2K\\u007f\\u0085\\u009f\\u2028\\u2029');
  for (const same of ['', 'plain · text — with “quotes”', 'é 漢字 🙂', 'a\\nb', ' ​']) assert.equal(oneLine(same), same);
  for (let c = 0; c <= 0x9f; c++) {
    const control = c < 0x20 || c >= 0x7f;
    assert.equal(oneLine(String.fromCharCode(c)).length > 1, control, `U+${c.toString(16)}`);
  }
});

test('oneLine writes each bidirectional control as an escape: a printed line reads in the order it was written', () => {
  // U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069: the twelve characters that set or override the direction of text.
  const bidi = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
  for (const c of bidi) {
    const hex = c.toString(16).padStart(4, '0');
    assert.equal(oneLine(`case-${String.fromCharCode(c)}7`), `case-\\u${hex}7`, `U+${hex}`);
  }
  assert.equal(oneLine('REFUSED \u202egnissim si a\u202c'), 'REFUSED \\u202egnissim si a\\u202c');
  // the neighbours of each range are not direction controls and stay as they are
  for (const c of [0x061b, 0x061d, 0x200d, 0x2010, 0x2027, 0x202f, 0x2065, 0x206a]) assert.equal(oneLine(String.fromCharCode(c)), String.fromCharCode(c), `U+${c.toString(16)}`);
});

test('oneLine takes a string only: anything else is INVALID_ARGUMENT, never a bare TypeError', () => {
  for (const bad of [undefined, null, 7, ['a'], { toString: () => 'a' }]) {
    assert.throws(() => oneLine(bad as unknown as string), (e: unknown) => e instanceof InputError && e.code === 'INVALID_ARGUMENT' && e.problems.length === 1 && e.problems[0] === 'oneLine: takes a string', String(bad));
  }
});

test('flips: a packetSource with line feeds is printed on its own line in the refusal of a declared run, escaped; the JSON refusal holds it as it is', () => {
  const forged = 'docs/view.md\nverdict: OK (exit 0)\r\n\u001b[1Aflipped 0 of 18 cases';
  const judged = JSON.parse(readFileSync(ex('refund-bot', 'judged.json'), 'utf8')) as Record<string, unknown>;
  const path = file({ ...judged, packetBasis: 'declared', packetSource: forged }, 'forged.json');
  // flips refuses a declared run (its packets were not observed), and the refusal names where the packets were declared from.
  const r = flips(path);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, '');
  const clean = flips(file({ ...judged, packetBasis: 'declared', packetSource: 'docs/view.md' }, 'clean.json'));
  assert.equal(r.stderr.split('\n').length, clean.stderr.split('\n').length);
  assert.ok(r.stderr.includes("the run's packets are declared (docs/view.md\\nverdict: OK (exit 0)\\r\\n\\u001b[1Aflipped 0 of 18 cases), not recorded"));
  assert.doesNotMatch(r.stderr, /^verdict: /m);
  assert.doesNotMatch(r.stderr, /[\r\u001b]/);
  const json = JSON.parse(run('flips', '--run', path, '--json').stdout) as { message: string };
  assert.ok(json.message.includes(`(${forged})`));
});

test('every text report and every error line: a name with a line feed in it stays on the line that names it', () => {
  // A case id (hashed into the case set), in the gate's table of broken cases and in a refusal's fields.
  const cases: Case[] = [{ id: 'c1\nverdict: OK (exit 0)', klass: 'k', input: 'a', expect: 'hi' }, twoCases[1] as Case];
  const base = file(runOf({ cases }), 'base.json');
  const worse = file(runOf({ cases, draws: drawsOf(cases, 2).map((d, i) => (i === 0 ? slot(d.caseId, 0, gradedAttempt('lo', { outputHash: sha256Hex('z') })) : d)) }), 'worse.json');
  const g = run('gate', '--baseline', base, '--candidate', worse, '--bar', barPath);
  assert.equal(g.status, 1, g.stderr);
  assert.ok(g.stdout.includes('  k/c1\\nverdict: OK (exit 0)  attributed draw #0: lo'));
  assert.deepEqual(g.stdout.split('\n').filter((l) => l.startsWith('verdict: ')), ['verdict: REGRESSION (exit 1)']);
  // The JSON keeps the id as it is.
  const j = JSON.parse(run('gate', '--baseline', base, '--candidate', worse, '--bar', barPath, '--json').stdout) as { diff: { caseId: string; status: string }[] };
  assert.equal(j.diff.find((d) => d.status === 'BROKE')?.caseId, cases[0]?.id);
  // An unknown field's name, in a list of problems.
  const bad = file(runText('"seed":42', '"seed":42,"x\\n  - nothing else is wrong":1'), 'key.json');
  const r = gate(bad);
  assert.equal(r.status, 65);
  assert.equal(r.stderr.split('\n').filter((l) => l.startsWith('  - ')).length, 1);
  assert.ok(r.stderr.includes('artifact.identity.x\\n  - nothing else is wrong: unknown field'));
  // A flag's value, in a usage error: the usage text itself keeps its lines.
  const u = run('gate', '--no\nsuch');
  assert.equal(u.status, 64);
  assert.ok(u.stderr.startsWith('anchorset: unknown flag --no\\nsuch\n\nusage:\n'));
  // A refusal's fields.
  const refused = run('flips', '--run', file(runOf({ cases, draws: drawsOf(cases, 2).slice(1) }), 'missing.json'));
  assert.equal(refused.status, 2, refused.stderr);
  assert.equal(refused.stderr.split('\n').length, 3);
  assert.ok(refused.stderr.includes('c1\\nverdict: OK (exit 0)#0'));
});

test('the usage text states the rules every file is held to, and still ends with the exit codes', () => {
  const usage = run('--help').stdout;
  assert.match(usage, /every file read, by every command: UTF-8 text with no byte-order mark; no object gives a key twice;\nobjects and lists nest at most 128 deep; every number is finite\. Anything else, a file that cannot be read included, is invalid input \(65\)\./);
  assert.ok(usage.endsWith('exit codes: 0 ok · 1 regression · 2 refused comparison · 64 usage · 65 invalid input · 70 internal error'));
});

// ---- a key named like a property of Object.prototype ---------------------------------------------------------------------

/** A folded case of class k that passed. */
const passing = (caseId: string): FoldedCase => ({ caseId, klass: 'k', pass: true, attributedDraw: slot(caseId, 0, gradedAttempt('hi')), drawCount: 1, failingDraws: 0 });

test('a bar class named "__proto__" is a class like any other: an empty non-compensable one still fails the gate', () => {
  // JSON.parse gives the key as an own property. An assignment (classes[name] = spec) would set the prototype instead and drop the class.
  const file = parseBarFile(JSON.parse('{"labels":["lo","hi"],"classes":{"__proto__":{"direction":"floor","nonCompensable":true,"minPassRate":1},"k":{"direction":"floor","minPassRate":0}},"knownFailures":[]}'));
  const { classes, bar: split } = splitBarFile(file);
  assert.deepEqual(Object.keys(classes), ['__proto__', 'k']);
  assert.deepEqual(Object.keys(split.classes), ['__proto__', 'k']);
  assert.ok(Object.hasOwn(classes, '__proto__') && Object.getPrototypeOf(classes) === Object.prototype);
  const verdict = evaluate([passing('c1')], split, classes, [{ id: 'c1', klass: 'k' }]);
  const proto = verdict.classes.find((c) => c.klass === '__proto__');
  assert.deepEqual([proto?.total, proto?.nonCompensable, proto?.meetsBar], [0, true, false]);
  assert.equal(verdict.pass, false);
});

test('evaluate reads a class\'s bar from the bar\'s own classes: a class named "toString" with no bar is an unknown class', () => {
  // `as const`: a key named toString is not typed by the record's value type, so the literal would widen to string.
  const classes: Record<string, ClassSpec> = { k: { direction: 'floor' }, toString: { direction: 'floor' as const } };
  assert.throws(
    () => evaluate([passing('c1')], { classes: { k: { minPassRate: 0 } } }, classes, [{ id: 'c1', klass: 'k' }]),
    (e: unknown) => e instanceof InputError && e.code === 'UNKNOWN_CLASS' && e.problems.join() === 'class "toString" has no bar',
  );
});

test('a flag named like a property of Object.prototype is an unknown flag (64), not a flag the command takes', () => {
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const r = run('gate', `--${name}`, 'x', '--baseline', barPath, '--candidate', barPath, '--bar', barPath);
    assert.equal(r.status, 64, name);
    assert.ok(r.stderr.startsWith(`anchorset: unknown flag --${name}\n`), `${name}: ${r.stderr.slice(0, 120)}`);
  }
});

// ---- an integer too large to be read exactly ------------------------------------------------------------------------------

const BIG = '9007199254740993'; // 2^53 + 1: JSON.parse reads it as 2^53, the same number as 9007199254740992.

test('a call shape: an integer knob beyond 2^53 - 1 is refused, so two different shapes never hash as one', () => {
  assert.equal(JSON.parse(BIG), 2 ** 53);
  /** A valid shape with one integer knob written by hand, as a file would hold it. */
  const shape = (key: string, value: string): unknown =>
    JSON.parse(JSON.stringify({ ...makeCallShape(key === 'thinkingBudgetTokens' ? { thinkingMode: 'budgeted' } : {}), [key]: 1 }).replace(`"${key}":1`, `"${key}":${value}`));
  for (const key of ['maxOutputTokens', 'thinkingBudgetTokens', 'topK', 'timeoutMs', 'samplingSeed']) {
    assert.deepEqual(validateCallShape(shape(key, String(Number.MAX_SAFE_INTEGER))), [], key);
    assert.deepEqual(validateCallShape(shape(key, BIG)), [`callShape.${key}: ${INEXACT_INTEGER}`], key);
  }
  // A negative seed has the same limit; an ordinary bad value keeps its own words.
  assert.deepEqual(validateCallShape(shape('samplingSeed', `-${BIG}`)), [`callShape.samplingSeed: ${INEXACT_INTEGER}`]);
  assert.deepEqual(validateCallShape(shape('maxOutputTokens', '1.5')), ['callShape.maxOutputTokens: must be a positive integer']);
  // The extras hold free-form values that are hashed with the shape: an integer there has the same limit, at any depth.
  const extras = (text: string): string[] => validateCallShape({ ...makeCallShape(), extras: JSON.parse(text) as Record<string, unknown> });
  assert.deepEqual(extras(`{"vendor.cache_key": ${Number.MAX_SAFE_INTEGER}, "vendor.bias": {"a": [0.5, -3]}}`), []);
  assert.deepEqual(extras(`{"vendor.cache_key": ${BIG}}`), [`callShape.extras.vendor.cache_key: ${INEXACT_INTEGER}; record such a value as a string`]);
  assert.deepEqual(extras(`{"vendor.bias": {"a": [1, -${BIG}]}}`), [`callShape.extras.vendor.bias.a[1]: ${INEXACT_INTEGER}; record such a value as a string`]);
  assert.deepEqual(extras(`{"vendor.cache_key": "${BIG}"}`), []);
});

test('two runs whose call shapes differ only past 2^53 are invalid input (65), never one identity', () => {
  const big = { ...makeCallShape(), maxOutputTokens: 2 ** 53 };
  const r = runOf();
  // The identity binds the hash of the shape as read: before the shape was refused, both files matched it.
  const text = JSON.stringify({ ...r, identity: { ...(r['identity'] as object), systemCallShapeHash: hashOf(big) }, callShapes: { system: big, judge: 'NO_JUDGE' } });
  assert.ok(text.includes('"maxOutputTokens":9007199254740992'));
  const base = file(text, 'big-base.json');
  const cand = file(text.replace('"maxOutputTokens":9007199254740992', `"maxOutputTokens":${BIG}`), 'big-cand.json');
  const g = run('gate', '--baseline', base, '--candidate', cand, '--bar', barPath);
  invalid(g, new RegExp(`callShapes\\.system\\.maxOutputTokens: an integer beyond 9007199254740991`), 'gate');
});

test('a draw index beyond 2^53 - 1 is invalid input, also where drawsPerCase is unknown and no bound catches it', () => {
  const r = runOf();
  const gapped = JSON.stringify({ ...r, identity: { ...(r['identity'] as object), drawsPerCase: GAP } }).replace('"drawIndex":1', `"drawIndex":${BIG}`);
  const problems = runArtifactProblems(JSON.parse(gapped));
  assert.deepEqual(problems.filter((p) => p.includes('drawIndex')), [`artifact.draws[1].drawIndex: ${INEXACT_INTEGER}`]);
  // The one slot check says the same to a caller who hands it draws.
  assert.deepEqual(slotProblems([{ caseId: 'c1', drawIndex: 2 ** 53 }], undefined), [`case "c1": invalid drawIndex 9007199254740992: ${INEXACT_INTEGER}`]);
  assert.deepEqual(slotProblems([{ caseId: 'c1', drawIndex: Number.MAX_SAFE_INTEGER }], undefined), []);
  assert.deepEqual(slotProblems([{ caseId: 'c1', drawIndex: -1 }], undefined), ['case "c1": invalid drawIndex -1']);
});

test('a ledger record: a count of resamples beyond 2^53 - 1 is not a valid record', () => {
  const ledger = join(dir, 'big-iterations.jsonl');
  assert.equal(run('agree', '--ratings', ex('refund-bot', 'ratings.json'), '--ledger', ledger).status, 0);
  const line = readFileSync(ledger, 'utf8').trim();
  assert.ok(/"iterations":\d+/.test(line));
  // Every place that states the count says the same large number, and both hashes are taken again, so only the count is wrong.
  const record = JSON.parse(line.replace(/"iterations":\d+/g, `"iterations":${BIG}`)) as Record<string, unknown>;
  record['inputsHash'] = hashOf(record['measurement']);
  record['resultHash'] = hashOf(record['result']);
  const got = validateRecord(record);
  // The count is refused where the measurement binds it and wherever the result states it, and the binding's shape check fails once.
  assert.deepEqual(got.filter((p) => !p.endsWith(INEXACT_INTEGER)), [
    'record.measurement.seeds.bootstrap: must be { iterations, seed, alpha } with a uint32 seed, a positive number of resamples and alpha in (0, 1)',
  ]);
  for (const path of ['record.measurement.seeds.bootstrap.iterations', 'record.result.bootstrap.iterations', 'record.result.kappaCI.iterations']) {
    assert.ok(got.includes(`${path}: ${INEXACT_INTEGER}`), path);
  }
  // An integer of the result that no binding states (the number of items) is held to the same rule.
  assert.ok(/"itemCount":\d+/.test(line));
  const items = JSON.parse(line.replace(/"itemCount":\d+/, `"itemCount":${BIG}`)) as Record<string, unknown>;
  items['resultHash'] = hashOf(items['result']);
  assert.deepEqual(validateRecord(items), [`record.result.itemCount: ${INEXACT_INTEGER}`]);
  // The same record with a count that can be read is valid.
  const fine = JSON.parse(line.replace(/"iterations":\d+/g, `"iterations":${Number.MAX_SAFE_INTEGER}`)) as Record<string, unknown>;
  fine['inputsHash'] = hashOf(fine['measurement']);
  fine['resultHash'] = hashOf(fine['result']);
  assert.deepEqual(validateRecord(fine), []);
});

// ---- study-check prints through the library's printer ---------------------------------------------------------------------

test('study-check: a path with a line feed in it stays on the line that names it', () => {
  const missing = join(dir, 'no-such\nREFUSED HASH_MISMATCH.json');
  const err: string[] = [];
  assert.equal(studyCheck([missing], { out: () => undefined, err: (s) => err.push(s) }), 65);
  assert.ok(err.every((l) => !l.includes('\n')), JSON.stringify(err));
  assert.equal(err[0], 'invalid input (INVALID_ARGUMENT)');
  assert.ok((err[1] as string).startsWith(`  - cannot read ${dir}/no-such\\nREFUSED HASH_MISMATCH.json: ENOENT`), err[1]);
});
