// The offline check command (examples/importers/skill-evals/check.ts): what it prints, its exit codes, and that it
// writes nothing and can make no call. Each refusal is made on a temp copy of the hand-written example flow.
// Synthetic customer-support refund-bot data only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { sha256Hex } from '../src/index.ts';
import { IMPORT_EXIT, parseFlagList } from '../examples/importers/shared.ts';
import { main, parseCheckFlags, USAGE } from '../examples/importers/skill-evals/check.ts';
import { OPTIONAL_FLAGS, parseRegradeFlags, REQUIRED_FLAGS, USAGE as REGRADE_USAGE } from '../examples/importers/skill-evals/regrade.ts';

const root = join(import.meta.dirname, '..');
const dir = join(root, 'examples', 'importers', 'skill-evals');
const exampleFlow = join(dir, 'example-flow');
const casesPath = join(dir, 'cases.json');
const barPath = join(dir, 'bar.json');
const work = mkdtempSync(join(tmpdir(), 'anchorset-skill-check-'));
after(() => rmSync(work, { recursive: true, force: true }));

let counter = 0;
function copy(): string {
  counter += 1;
  const to = join(work, `flow-${counter}`);
  cpSync(exampleFlow, to, { recursive: true });
  return to;
}
function tempFile(name: string, text: string): string {
  counter += 1;
  const path = join(work, `${counter}-${name}`);
  writeFileSync(path, text);
  return path;
}

type Cli = { code: number; out: string; err: string };
function run(argv: readonly string[]): Cli {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const base = (flow: string, over: Record<string, string> = {}): string[] => Object.entries({ '--flow': flow, '--variant': 'baseline', '--cases': casesPath, '--reps': '2', ...over }).flat();

/** Every file below a directory with the sha256 of its bytes: what "nothing was written" is checked against. */
function snapshot(at: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of (readdirSync(at, { recursive: true }) as string[]).sort()) {
    const path = join(at, rel);
    out[rel] = statSync(path).isFile() ? sha256Hex(readFileSync(path)) : 'dir';
  }
  return out;
}

// ---- the good path --------------------------------------------------------------------------------------------------

test('on the example flow the check prints what was read and exits 0', () => {
  const r = run(base(exampleFlow));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.code, IMPORT_EXIT.written);
  assert.equal(r.err, '');
  assert.deepEqual(r.out.split('\n'), [
    `read: flow ${exampleFlow}, variant baseline, row profile skill-evals/1`,
    'cases: 3 in the cases file; reps declared: 2',
    // Each rep holds a finished answer for each of the three cases.
    'rep 0: whole (3 finished answers, each with its trace); it can be re-graded with --rep 0',
    'rep 1: whole (3 finished answers, each with its trace); it can be re-graded with --rep 1',
    'reps that can be re-graded: 0, 1 (2 of 2)',
    'excluded cases (in the flow, not in the cases file; never graded, their traces not read): 0',
    // shasum -a 256 of the two files, as in the flow reader's test.
    'results.jsonl sha256: 3e2f58c097b50bf3b33416809f2c883fcb00c9e4134051ac21f7656367b245ec',
    '_state.json sha256: cba1a721c135db10ed25ac4866e309861557eeefdb5ba98803cb7df06d4a34a7',
    'superseded error lines: 1',
    '  errors.jsonl line 1: bank-dispute#1 (a later attempt at this slot wrote its row)',
    'selector: none given; the judge would be shown the whole assistant turn',
    'cases: the classes and labels were not checked against a bar (no --bar)',
    'nothing was written and no call was made',
  ]);
});

test('with --select the check says the pointer selects a string on every slot; with --bar that the cases fit the bar', () => {
  const r = run(base(exampleFlow, { '--select': '/reply', '--bar': barPath }));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^selector "\/reply" \(json-pointer-rfc6901\/v1\): selects a non-empty string on every slot of each whole rep$/m);
  assert.match(r.out, /^cases: every class and label is in the bar$/m);
  // The whole turn has one spelling: the flag left out. An empty value is a usage error, as in the re-grade script.
  const whole = run(base(exampleFlow));
  assert.equal(whole.code, 0, whole.err);
  assert.match(whole.out, /^selector: none given; the judge would be shown the whole assistant turn$/m);
  const empty = run([...base(exampleFlow), '--select', '']);
  assert.equal(empty.code, IMPORT_EXIT.usage);
  assert.match(empty.err, /^USAGE: --select needs a value\. usage: /);
  assert.equal(empty.out, '');
});

test('the command itself runs from a shell, with no key in the environment', () => {
  const r = spawnSync(process.execPath, [join(dir, 'check.ts'), ...base(exampleFlow, { '--select': '/reply' })], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^reps that can be re-graded: 0, 1 \(2 of 2\)$/m);
  assert.match(r.stdout, /nothing was written and no call was made/);
  const refusedRun = spawnSync(process.execPath, [join(dir, 'check.ts'), ...base(exampleFlow, { '--reps': '3' })], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } });
  assert.equal(refusedRun.status, 2);
  assert.equal(refusedRun.stdout, '');
  assert.match(refusedRun.stderr, /^REFUSED IMPORT_DRAW_COUNT: /);
});

test('a flow with no errors.jsonl prints zero superseded lines; an unused trace file is named', () => {
  const flow = copy();
  rmSync(join(flow, 'baseline', 'errors.jsonl'));
  writeFileSync(join(flow, 'baseline', 'traces', 'old-case_rep0.json'), '[]\n');
  const r = run(base(flow));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^superseded error lines: 0$/m);
  assert.match(r.out, /^trace files no row names \(not read, not bound\): old-case_rep0\.json$/m);
});

// ---- refusals: exit 2, in the importers' print format, every slot listed ---------------------------------------------

/** The rows of a copy's results.jsonl, edited in place. */
function editRows(flow: string, edit: (rows: Record<string, unknown>[]) => Record<string, unknown>[] | void): void {
  const resultsPath = join(flow, 'baseline', 'results.jsonl');
  const rows = readFileSync(resultsPath, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
  writeFileSync(resultsPath, `${(edit(rows) ?? rows).map((r) => JSON.stringify(r)).join('\n')}\n`);
}
const slotRow = (rows: Record<string, unknown>[], id: string, rep: number): Record<string, unknown> => {
  const r = rows.find((x) => x['prompt_id'] === id && x['rep'] === rep);
  assert.ok(r, `no row ${id}#${rep}`);
  return r;
};

test('a flow in which no rep is whole exits 2 and prints REFUSED with the code, every problem of every rep, then the fields line', () => {
  const flow = copy();
  // One fault in each rep: line 1 (faulty-headphones#0) is truncated, and the row of bank-dispute#1 (line 6) is dropped.
  editRows(flow, (rows) => {
    Object.assign(rows[0] as object, { status: 'truncated', stop_reason: 'max_tokens' });
    return rows.slice(0, 5);
  });
  const r = run(base(flow));
  assert.equal(r.code, 2);
  assert.equal(r.code, IMPORT_EXIT.refused);
  assert.equal(r.out, '');
  const lines = r.err.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0] as string, /^REFUSED IMPORT_OUTPUT_UNFINISHED: 3 problem\(s\) in the flow: none of its 2 declared rep\(s\) is whole, so none can be re-graded \(row profile skill-evals\/1\): /);
  assert.match(lines[0] as string, /status "truncated"/);
  assert.match(lines[0] as string, /stop_reason "max_tokens"/);
  assert.match(lines[0] as string, /bank-dispute#1: expected \(cases\.json x 2 reps\), but no row holds it; errors\.jsonl line 1 records a failed attempt at it/);
  assert.match(lines[0] as string, /leave it out of cases\.json/);
  assert.equal(lines[1], 'fields: faulty-headphones#0, bank-dispute#1');
});

test('a slot that is not finished, or has no row, in ONE rep is listed, not refused: exit 0, the rep is named as not whole with its problems, and the other as the one that can be re-graded', () => {
  const flow = copy();
  // Both faults in rep 1: clearance-organiser#1 is cut at the output cap, and the row of bank-dispute#1 is dropped.
  editRows(flow, (rows) => {
    slotRow(rows, 'clearance-organiser', 1)['stop_reason'] = 'max_tokens';
    return rows.filter((r) => !(r['prompt_id'] === 'bank-dispute' && r['rep'] === 1));
  });
  const r = run(base(flow));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  const lines = r.out.split('\n');
  assert.deepEqual(lines.slice(1, 3), ['cases: 3 in the cases file; reps declared: 2', 'rep 0: whole (3 finished answers, each with its trace); it can be re-graded with --rep 0']);
  assert.equal(lines[3], 'rep 1: NOT whole; it cannot be re-graded (2 problems):');
  assert.match(lines[4] as string, /^  IMPORT_OUTPUT_UNFINISHED: baseline\/results\.jsonl:3: stop_reason "max_tokens", not "end_turn": the stored output is not a finished answer; to measure without this case, leave it out of cases\.json/);
  assert.match(lines[5] as string, /^  IMPORT_DRAW_COUNT: bank-dispute#1: expected \(cases\.json x 2 reps\), but no row holds it; errors\.jsonl line 1 records a failed attempt at it/);
  assert.equal(lines[6], 'reps that can be re-graded: 0 (1 of 2)');
  // The same two faults, one moved to rep 0: no rep is whole, and the check refuses.
  editRows(flow, (rows) => {
    slotRow(rows, 'clearance-organiser', 1)['stop_reason'] = 'end_turn';
    slotRow(rows, 'clearance-organiser', 0)['stop_reason'] = 'max_tokens';
  });
  const none = run(base(flow));
  assert.equal(none.code, 2);
  assert.match(none.err, /^fields: clearance-organiser#0, bank-dispute#1$/m);
});

test('a case of the flow that is not in the cases file is listed as excluded, with its rows and its error lines: exit 0', () => {
  const flow = copy();
  editRows(flow, (rows) => [...rows, { ...slotRow(rows, 'bank-dispute', 0), prompt_id: 'late-parcel', stop_reason: 'max_tokens' }]);
  writeFileSync(join(flow, 'baseline', 'errors.jsonl'), `${readFileSync(join(flow, 'baseline', 'errors.jsonl'), 'utf8')}${JSON.stringify({ prompt_id: 'late-parcel', rep: 1, error: 'example: timed out' })}\n${JSON.stringify({ prompt_id: 'damaged-lamp', rep: 0, error: 'example: timed out' })}\n`);
  const r = run(base(flow));
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  const at = lines.indexOf('excluded cases (in the flow, not in the cases file; never graded, their traces not read): 2');
  assert.notEqual(at, -1, r.out);
  assert.deepEqual(lines.slice(at + 1, at + 3), ['  damaged-lamp: no row; errors.jsonl line 3', '  late-parcel: results.jsonl line 7 (rep 0, not a finished answer); errors.jsonl line 2']);
  assert.match(r.out, /^reps that can be re-graded: 0, 1 \(2 of 2\)$/m);
  // The same case named in the cases file: its one row is not a finished answer and rep 1 has none, so no rep is whole.
  const stated = JSON.parse(readFileSync(casesPath, 'utf8')) as Record<string, unknown>;
  stated['late-parcel'] = { klass: 'refund_policy', expect: 'pass' };
  const named = run(base(flow, { '--cases': tempFile('cases.json', JSON.stringify(stated)) }));
  assert.equal(named.code, 2);
  assert.match(named.err, /^fields: late-parcel#0, late-parcel#1$/m);
});

test('a flow with no _state.json reads: exit 0, and the output says the file is not there and prints the gap marker for its sha256', () => {
  const flow = copy();
  rmSync(join(flow, '_state.json'));
  const r = run(base(flow));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^_state\.json sha256: UNKNOWN \(the flow holds no _state\.json; harness_sha is UNKNOWN too\)$/m);
  // A state file that is there and is not an object still refuses.
  writeFileSync(join(flow, '_state.json'), '[]');
  const bad = run(base(flow));
  assert.equal(bad.code, 2);
  assert.match(bad.err, /^fields: _state\.json$/m);
});

test('the last rep missing on every case is listed: with three reps declared and no state file to contradict it, rep 2 is not whole and reps 0 and 1 can be re-graded', () => {
  // The untouched example declared as three reps is refused whole: its state file says two.
  const r = run(base(exampleFlow, { '--reps': '3' }));
  assert.equal(r.code, 2);
  assert.match(r.err, /^fields: _state\.json$/m);
  const flow = copy();
  rmSync(join(flow, '_state.json'));
  const listed = run(base(flow, { '--reps': '3' }));
  assert.equal(listed.code, 0, listed.err);
  assert.match(listed.out, /^rep 2: NOT whole; it cannot be re-graded \(3 problems\):$/m);
  assert.match(listed.out, /^reps that can be re-graded: 0, 1 \(2 of 3\)$/m);
  for (const id of ['bank-dispute', 'clearance-organiser', 'faulty-headphones']) assert.ok(listed.out.includes(`  IMPORT_DRAW_COUNT: ${id}#2: expected (cases.json x 3 reps), but no row holds it`), id);
});

test('the slots of the flow (the cases times --reps) are at most 100000: more is a usage error at once, before the flow is read, whether the state file agrees with the count or there is none', () => {
  // A state file that states the same large count as --reps does not refuse, so every slot of every
  // declared rep was looked for, and 300 cases x 100000 reps ran out of memory before any check of the slot count.
  const agreeing = copy();
  const state = JSON.parse(readFileSync(join(agreeing, '_state.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(agreeing, '_state.json'), `${JSON.stringify({ ...state, reps: 100000 })}\n`);
  const noState = copy();
  rmSync(join(noState, '_state.json'));
  const cases = JSON.parse(readFileSync(casesPath, 'utf8')) as Record<string, unknown>;
  const many = tempFile('many-cases.json', JSON.stringify(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`case-${String(i).padStart(3, '0')}`, cases['bank-dispute']]))));
  for (const [flow, casesFile, reps, words] of [
    [agreeing, casesPath, '100000', '3 case(s) of the cases file x 100000 declared rep(s) is 300000 slots of the flow'],
    [agreeing, many, '100000', '300 case(s) of the cases file x 100000 declared rep(s) is 30000000 slots of the flow'],
    [noState, casesPath, '33334', '3 case(s) of the cases file x 33334 declared rep(s) is 100002 slots of the flow'],
  ] as const) {
    const started = Date.now();
    const r = run(base(flow, { '--cases': casesFile, '--reps': reps }));
    assert.equal(r.code, IMPORT_EXIT.usage, r.err.slice(0, 300));
    assert.equal(r.err, `USAGE: ${words}, more than the 100000 this path takes`);
    assert.equal(r.out, '');
    assert.ok(Date.now() - started < 2000, `${reps}: refused in ${Date.now() - started} ms`);
  }
  // At the bound the flow is read: the missing reps of the three cases are listed, and reps 0 and 1 can be re-graded.
  const at = run(base(noState, { '--reps': '33333' }));
  assert.equal(at.code, 0, at.err.slice(0, 300));
  assert.match(at.out, /^reps that can be re-graded: 0, 1 \(2 of 33333\)$/m);
});

test('a variant name outside baseline and v<N> is refused, exit 2', () => {
  const r = run(base(exampleFlow, { '--variant': '../example-flow/baseline' }));
  assert.equal(r.code, 2);
  assert.match(r.err, /^REFUSED IMPORT_PATH: .*variant: /);
  assert.match(r.err, /^fields: variant$/m);
});

test('a selector that cannot be applied on any rep refuses with every slot listed; one that cannot be applied in one rep makes that rep not whole', () => {
  const none = run(base(exampleFlow, { '--select': '/message' }));
  assert.equal(none.code, 2);
  assert.match(none.err, /^REFUSED IMPORT_PACKET: 6 problem\(s\) in the flow: none of its 2 declared rep\(s\) is whole/);
  assert.match(none.err, /bank-dispute#0: selector "\/message" cannot be applied: /);
  // In the order of the reps, then of the case ids.
  assert.match(none.err, /^fields: bank-dispute#0, clearance-organiser#0, faulty-headphones#0, bank-dispute#1, clearance-organiser#1, faulty-headphones#1$/m);
  // One slot whose turn is prose: the whole turn still reads, the pointer does not.
  const flow = copy();
  const tracePath = join(flow, 'baseline', 'traces', 'clearance-organiser_rep1.json');
  const turns = JSON.parse(readFileSync(tracePath, 'utf8'));
  turns[2].content = 'Clearance items cannot be refunded.';
  writeFileSync(tracePath, JSON.stringify(turns));
  const whole = run(base(flow));
  assert.equal(whole.code, 0);
  assert.match(whole.out, /^reps that can be re-graded: 0, 1 \(2 of 2\)$/m);
  // With the selector, rep 1 is listed as not whole and rep 0 can be re-graded.
  const one = run(base(flow, { '--select': '/reply' }));
  assert.equal(one.code, 0, one.err);
  assert.match(one.out, /^rep 0: whole /m);
  assert.match(one.out, /^rep 1: NOT whole; it cannot be re-graded \(1 problem\):$/m);
  assert.match(one.out, /^  IMPORT_PACKET: clearance-organiser#1: selector "\/reply" cannot be applied: the turn is not JSON/m);
  assert.match(one.out, /^reps that can be re-graded: 0 \(1 of 2\)$/m);
  // A second such slot in rep 0: no rep is whole under the selector, and the check refuses.
  const other = join(flow, 'baseline', 'traces', 'bank-dispute_rep0.json');
  const otherTurns = JSON.parse(readFileSync(other, 'utf8'));
  otherTurns[2].content = 'A colleague will write to you.';
  writeFileSync(other, JSON.stringify(otherTurns));
  const both = run(base(flow, { '--select': '/reply' }));
  assert.equal(both.code, 2);
  assert.match(both.err, /^fields: bank-dispute#0, clearance-organiser#1$/m);
});

// ---- usage (64) and invalid input (65) ----------------------------------------------------------------------------------

test('usage errors exit 64 and print the usage line', () => {
  const good = base(exampleFlow);
  const without = (flag: string): string[] => {
    const i = good.indexOf(flag);
    return [...good.slice(0, i), ...good.slice(i + 2)];
  };
  const bad: [string, string[], RegExp][] = [
    ['no argument', [], /missing --flow, --variant, --cases, --reps/],
    ['no --reps: the count has no default', without('--reps'), /missing --reps/],
    ['no --variant', without('--variant'), /missing --variant/],
    ['no --cases', without('--cases'), /missing --cases/],
    ['no --flow', without('--flow'), /missing --flow/],
    ['an unknown flag', [...good, '--out', 'x.json'], /unknown argument "--out"/],
    ['a flag twice', [...good, '--reps', '2'], /--reps given twice/],
    ['a flag with no value', [...without('--reps'), '--reps'], /--reps needs a value/],
    ['an empty value', base(exampleFlow, { '--variant': '' }), /--variant needs a value/],
    ['--reps 0', base(exampleFlow, { '--reps': '0' }), /--reps must be a positive integer/],
    ['--reps 2.0', base(exampleFlow, { '--reps': '2.0' }), /--reps must be a positive integer/],
    ['--reps two', base(exampleFlow, { '--reps': 'two' }), /--reps must be a positive integer/],
    ['--reps 02', base(exampleFlow, { '--reps': '02' }), /--reps must be a positive integer/],
    // Beyond the path's count bound: a usage error at once, never a long loop or an exhausted memory.
    ['--reps 100001', base(exampleFlow, { '--reps': '100001' }), /^USAGE: --reps must be at most 100000, found 100001\. usage: /],
    ['--reps 4294967296', base(exampleFlow, { '--reps': '4294967296' }), /^USAGE: --reps must be at most 100000, found 4294967296\. usage: /],
    // The whole turn has one spelling, the flag left out; the re-grade script reads the same value the same way.
    ['an empty selector', base(exampleFlow, { '--select': '' }), /--select needs a value/],
    ['a selector that is not a pointer', base(exampleFlow, { '--select': 'reply' }), /not a JSON Pointer/],
    ['a selector with a bad escape', base(exampleFlow, { '--select': '/a~2' }), /not a JSON Pointer/],
    ['a cases file that is not there', base(exampleFlow, { '--cases': join(work, 'no-cases.json') }), /cannot read .*no-cases\.json \(ENOENT\)/],
    ['a bar that is not there', base(exampleFlow, { '--bar': join(work, 'no-bar.json') }), /cannot read .*no-bar\.json \(ENOENT\)/],
    ['a flow that is not there', base(join(work, 'no-flow')), /cannot read the flow .*no-flow \(ENOENT\)/],
  ];
  for (const [name, argv, words] of bad) {
    const r = run(argv);
    assert.equal(r.code, 64, `${name}: ${r.err}`);
    assert.equal(r.code, IMPORT_EXIT.usage);
    assert.match(r.err, /^USAGE: /, name);
    assert.match(r.err, words, name);
    assert.equal(r.out, '', name);
  }
  assert.throws(() => parseCheckFlags(['--flow']), /--flow needs a value/);
  assert.match(USAGE, /--flow <dir> --variant <name> --cases <cases\.json> --reps <n> \[--select <pointer>\]/);
});

test('one of each: the check and the re-grade script read their flags with the shared parser and their counts with the one count reader, and agree on --select ""', () => {
  const regradeArgs = REQUIRED_FLAGS.flatMap((f) => [f, 'x']);
  // The same value, the same answer, in the shared parser's own words.
  const words = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      return (e as Error).message;
    }
    return 'accepted';
  };
  assert.equal(words(() => parseCheckFlags([...base(exampleFlow), '--select', ''])), `USAGE: --select needs a value. ${USAGE}`);
  assert.equal(words(() => parseRegradeFlags([...regradeArgs, '--select', ''])), `USAGE: --select needs a value. ${REGRADE_USAGE}`);
  // Each parser is the shared one over the file's own flag lists: the same messages for the same mistakes.
  for (const [parse, args, usage, required, optional] of [
    [parseCheckFlags, base(exampleFlow), USAGE, ['--flow', '--variant', '--cases', '--reps'], ['--select', '--bar']],
    [parseRegradeFlags, regradeArgs, REGRADE_USAGE, [...REQUIRED_FLAGS], [...OPTIONAL_FLAGS]],
  ] as const) {
    const mistakes: string[][] = [[...args, '--retry', '3'], [...args, args[0] as string, 'again'], [...args, optional[0] as string], args.slice(2), [...args, optional[0] as string, '--x']];
    for (const argv of mistakes) {
      assert.equal(words(() => parse(argv)), words(() => parseFlagList(argv, usage, required, optional)), argv.join(' '));
      assert.match(words(() => parse(argv)), /^USAGE: /);
    }
    assert.deepEqual(parse([...args]), parseFlagList([...args], usage, required, optional));
  }
  for (const file of ['check.ts', 'regrade.ts']) {
    const source = readFileSync(join(dir, file), 'utf8');
    assert.ok(source.includes('parseFlagList(argv, USAGE, '), `${file}: the shared flag parser`);
    assert.ok(source.includes('positiveIntFlag('), `${file}: the one count reader`);
    assert.equal(/argv\[k|needs a value|unknown argument|\[1-9\]\\d\*\$/.test(source), false, `${file}: a flag loop or a count pattern of its own`);
    assert.equal(/TextDecoder/.test(source), false, `${file}: a decoder of its own`);
  }
});

test('a cases file that does not validate exits 65, with or without a bar', () => {
  const bad: [string, string, string[], RegExp][] = [
    ['not JSON', '{', [], /cases: not JSON/],
    ['a list', '[]', [], /cases: expected object, found array/],
    ['no case', '{}', [], /must hold at least one case/],
    ['a null class', '{"bank-dispute":{"klass":null,"expect":"pass"}}', [], /klass: must be a non-empty string \(null is not allowed\)/],
    ['an unknown key', '{"bank-dispute":{"klass":"refund_safety","expect":"pass","note":"x"}}', [], /note: unknown field/],
    ['a class the bar lacks', '{"bank-dispute":{"klass":"refund_speed","expect":"pass"}}', ['--bar', barPath], /"refund_speed" is not a class of the bar/],
    ['a label the bar lacks', '{"bank-dispute":{"klass":"refund_safety","expect":"good"}}', ['--bar', barPath], /"good" is not a label of the bar/],
  ];
  for (const [name, text, extra, words] of bad) {
    const r = run([...base(exampleFlow, { '--cases': tempFile('cases.json', text) }), ...extra]);
    assert.equal(r.code, 65, `${name}: ${r.err}`);
    assert.equal(r.code, IMPORT_EXIT.invalidInput);
    assert.match(r.err, /^INVALID_INPUT: /, name);
    assert.match(r.err, words, name);
  }
  const badBar = run([...base(exampleFlow), '--bar', tempFile('bar.json', '{"labels":[]}')]);
  assert.equal(badBar.code, 65, badBar.err);
});

test('a case id or a key of the bar given twice, and a cases file that is not UTF-8, exit 65: the plain parser would keep the last and say nothing', () => {
  const casesText = readFileSync(casesPath, 'utf8');
  const twice = casesText.replace('{', '{ "bank-dispute": { "klass": "refund_policy", "expect": "fail" },');
  assert.equal(Object.keys(JSON.parse(twice) as object).length, 3, 'to the plain parser the roster is the same three cases');
  for (const extra of [[], ['--bar', barPath]]) {
    const r = run([...base(exampleFlow, { '--cases': tempFile('cases.json', twice) }), ...extra]);
    assert.equal(r.code, IMPORT_EXIT.invalidInput, r.err);
    assert.match(r.err, /^INVALID_INPUT: cases: the key "bank-dispute" is given twice in the top-level object$/);
    assert.equal(r.out, '');
  }
  const bar = run([...base(exampleFlow), '--bar', tempFile('bar.json', readFileSync(barPath, 'utf8').replace('"labels"', '"labels": ["fail", "pass", "unsure"],\n  "labels"'))]);
  assert.equal(bar.code, IMPORT_EXIT.invalidInput, bar.err);
  assert.match(bar.err, /^INVALID_INPUT: bar: the key "labels" is given twice/);
  // Bytes that are not UTF-8 are not replaced by a character that two different files would share.
  counter += 1;
  const latin = join(work, `${counter}-cases.json`);
  writeFileSync(latin, Buffer.concat([Buffer.from('{"caf'), Buffer.from([0xe9]), Buffer.from('":{"klass":"refund_policy","expect":"pass"}}')]));
  const notUtf8 = run(base(exampleFlow, { '--cases': latin }));
  assert.equal(notUtf8.code, IMPORT_EXIT.invalidInput, notUtf8.err);
  assert.match(notUtf8.err, /^INVALID_INPUT: cases: the bytes are not UTF-8 text$/);
});

test('without --bar a class the bar lacks is not seen by the check, and the output says the bar was not read', () => {
  const r = run(base(exampleFlow, { '--cases': tempFile('cases.json', readFileSync(casesPath, 'utf8').replace('refund_safety', 'refund_speed')) }));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /not checked against a bar \(no --bar\)/);
});

test("a cases id that matches no prompt_id is refused, and the message says ids are the row's prompt_id", () => {
  const r = run(base(exampleFlow, { '--cases': tempFile('cases.json', readFileSync(casesPath, 'utf8').replace('bank-dispute', 'Bank dispute')) }));
  assert.equal(r.code, 2);
  assert.match(r.err, /^REFUSED IMPORT_CASE_MISSING: /);
  assert.match(r.err, /a case id is the row's prompt_id/);
  assert.match(r.err, /leave it out of cases\.json/);
  // The stated id has no row, which refuses. The rows of bank-dispute are then of a case outside the cases file: not refused.
  assert.match(r.err, /^fields: Bank dispute$/m);
});

// ---- no write, no network, no key ---------------------------------------------------------------------------------------

test('the check writes nothing: the flow and the working directory are byte for byte the same after it', () => {
  const flow = copy();
  const before = snapshot(work);
  assert.equal(run(base(flow, { '--select': '/reply', '--bar': barPath })).code, 0);
  assert.equal(run(base(flow, { '--reps': '5' })).code, 2);
  assert.equal(run(base(flow, { '--select': '/nothing' })).code, 2);
  assert.deepEqual(snapshot(work), before);
});

test('the four files import no network module, no process spawner and nothing outside the examples and the library entry', () => {
  const allowed: Record<string, string[]> = {
    'flow.ts': ['node:fs', 'node:path', '../../../src/index.ts', '../shared.ts', './strict.ts'],
    'selector.ts': ['../shared.ts', './strict.ts'],
    'strict.ts': [],
    'check.ts': ['../shared.ts', './flow.ts', './selector.ts'],
  };
  for (const [file, modules] of Object.entries(allowed)) {
    const source = readFileSync(join(dir, file), 'utf8');
    const imported = [...source.matchAll(/^import\s[^;]*?from '([^']+)';$/gms)].map((m) => m[1] as string);
    assert.deepEqual([...new Set(imported)].sort(), [...modules].sort(), file);
    assert.equal(/\b(fetch|XMLHttpRequest|WebSocket)\s*\(|require\(|import\(|process\.env/.test(source), false, `${file}: a call out, a dynamic import or a read of the environment`);
    assert.equal(/writeFile|appendFile|mkdir|rmSync|unlink|rename|copyFile|createWriteStream|symlinkSync/.test(source), false, `${file}: a write to the disk`);
  }
});
