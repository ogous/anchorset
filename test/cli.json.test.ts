// What `--json` prints: every report names its contract and the tool; a refusal under `--json` is one object, for every
// command; and a ratings or anchor file names its own format. Synthetic customer-support refund-bot data only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { readLedger } from '../src/ledger.ts';
import { ANCHOR_SCHEMA, RATINGS_SCHEMA, REPORT_SCHEMAS, TOOL_NAME, TOOL_VERSION } from '../src/version.ts';

const root = join(import.meta.dirname, '..');
const ex = (...f: string[]): string => join(root, 'examples', 'refund-bot', ...f);
const run = (...args: string[]) => spawnSync(process.execPath, [join(root, 'src', 'cli.ts'), ...args], { encoding: 'utf8' });
const dir = mkdtempSync(join(tmpdir(), 'anchorset-cli-json-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const TOOL = { name: TOOL_NAME, version: TOOL_VERSION };

/** A copy of an example file with a change made to its parsed JSON. */
function changed(name: string, change: (f: Record<string, unknown>) => void, file = ex(name)): string {
  const f = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  change(f);
  const path = join(dir, `${Math.random().toString(36).slice(2)}-${name}`);
  writeFileSync(path, JSON.stringify(f));
  return path;
}

const gateArgs = ['gate', '--baseline', ex('baseline.json'), '--candidate', ex('candidate.json'), '--bar', ex('bar.json')];
const allow = ['--allow-differ', 'systemModelServed,systemCallShapeHash'];
const driftArgs = ['drift', '--old', ex('anchor_old.json'), '--new', ex('anchor_new.json'), '--flag', 'handoff'];

test('every --json report names its contract and the tool as its first two keys', () => {
  const cases: [string, string[]][] = [
    ['gate', [...gateArgs, ...allow, '--json']],
    ['agree', ['agree', '--ratings', ex('ratings.json'), '--json']],
    ['drift', [...driftArgs, '--json']],
    ['flips', ['flips', '--run', ex('judged.json'), '--json']],
  ];
  for (const [command, args] of cases) {
    const r = run(...args);
    assert.ok(r.status === 0 || r.status === 1, `${command}: ${r.stderr}`);
    const o = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(o).slice(0, 2), ['schema', 'tool'], command);
    assert.equal(o['schema'], REPORT_SCHEMAS[command as keyof typeof REPORT_SCHEMAS], command);
    assert.deepEqual(o['tool'], TOOL, command);
  }
  assert.deepEqual(REPORT_SCHEMAS, {
    gate: 'anchorset.gate-report/v2',
    agree: 'anchorset.agree-report/v2',
    drift: 'anchorset.drift-report/v2',
    flips: 'anchorset.flips-report/v2',
    'write-run': 'anchorset.write-run-report/v1',
    validate: 'anchorset.validate-report/v1',
    refusal: 'anchorset.refusal/v2',
  });
  // The gate's object keeps `kind` and `exitCode`, which the plugin and the verdict lines are read by.
  const gate = JSON.parse(run(...gateArgs, ...allow, '--json').stdout) as { kind: string; exitCode: number };
  assert.deepEqual([gate.kind, gate.exitCode], ['evaluated', 1]);
});

test('the printed report is the recorded result: agree and drift write the same object, contract and tool included, to the ledger', () => {
  for (const [command, args] of [['agree', ['agree', '--ratings', ex('ratings.json')]], ['drift', driftArgs]] as const) {
    const ledger = join(dir, `${command}.jsonl`);
    const r = run(...args, '--json', '--ledger', ledger);
    assert.equal(r.status, 0, r.stderr);
    const printed = JSON.parse(r.stdout) as Record<string, unknown>;
    const rec = readLedger(ledger)[0];
    assert.deepEqual(rec?.result, printed, command);
    assert.equal(printed['schema'], REPORT_SCHEMAS[command]);
    assert.deepEqual(rec?.tool, TOOL);
  }
});

test('a refusal under --json is one object, the same keys for every command, on stdout, with nothing on stderr and the exit code 2', () => {
  const refusals: [string, string[], string, string[]][] = [
    ['gate', [...gateArgs, '--json'], 'IDENTITY_MISMATCH', ['systemModelServed', 'systemCallShapeHash']],
    ['agree', ['agree', '--ratings', changed('ratings.json', (f) => void ((f['packetHashes'] as Record<string, Record<string, string>>)['rater-a']!['t01'] = 'c'.repeat(64))), '--json'], 'PACKET_MISMATCH', ['t01']],
    ['drift', [...driftArgs.slice(0, 4), changed('anchor_new.json', (f) => void ((f['labels'] as string[]).reverse())), ...driftArgs.slice(5), '--json'], 'LABELS_MISMATCH', ['labels']],
    ['flips', ['flips', '--run', changed('judged.json', (f) => void ((f['identity'] as Record<string, unknown>)['drawsPerCase'] = 'UNKNOWN')), '--json'], 'IDENTITY_GAP', ['drawsPerCase']],
    ['judge-change', ['judge-change', '--plan', join(root, 'examples', 'judge-change', 'plan.json'), '--bar', changed('bar.json', (f) => void (f['labels'] = [...(f['labels'] as string[])].reverse()), join(root, 'examples', 'judge-change', 'bar.json')), '--inputs', join(root, 'examples', 'judge-change', 'runs'), '--json'], 'HASH_MISMATCH', []],
  ];
  for (const [command, args, code, fields] of refusals) {
    const r = run(...args);
    assert.equal(r.status, 2, `${command}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stderr, '', command);
    const o = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(o), ['schema', 'tool', 'kind', 'command', 'code', 'fields', 'message', 'exitCode'], command);
    assert.equal(o['schema'], REPORT_SCHEMAS.refusal);
    assert.deepEqual(o['tool'], TOOL);
    assert.deepEqual([o['kind'], o['command'], o['code'], o['exitCode']], ['refused', command, code, 2], command);
    if (fields.length > 0) assert.deepEqual(o['fields'], fields, command);
    assert.match(String(o['message']), new RegExp(`^${code}: `), command);
    // The same refusal without --json is the text on stderr, and nothing on stdout.
    const text = run(...args.filter((a) => a !== '--json'));
    assert.equal(text.status, 2, command);
    assert.equal(text.stdout, '', command);
    assert.match(text.stderr, new RegExp(`^REFUSED ${code}\\n`), command);
  }
});

test('a usage error and invalid input stay text on stderr under --json, and an error nobody foresaw is not a refusal object', () => {
  const usage = run('gate', '--baseline', ex('baseline.json'), '--json');
  assert.equal(usage.status, 64);
  assert.equal(usage.stdout, '');
  const invalid = run('agree', '--ratings', ex('bar.json'), '--json');
  assert.equal(invalid.status, 65);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /invalid input \(INVALID_ARGUMENT\)/);
});

test('a ratings file and an anchor file name their own format: without it, or with another, the file is invalid input (65)', () => {
  assert.equal(RATINGS_SCHEMA, 'anchorset.ratings/v2');
  assert.equal(ANCHOR_SCHEMA, 'anchorset.anchor/v1');
  const ratings = JSON.parse(readFileSync(ex('ratings.json'), 'utf8')) as Record<string, unknown>;
  const anchor = JSON.parse(readFileSync(ex('anchor_old.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(ratings['schema'], RATINGS_SCHEMA);
  assert.equal(anchor['schema'], ANCHOR_SCHEMA);
  const noRatings = run('agree', '--ratings', changed('ratings.json', (f) => void delete f['schema']));
  assert.equal(noRatings.status, 65, noRatings.stderr);
  assert.match(noRatings.stderr, /^ {2}- ratings\.schema: required, and must be "anchorset\.ratings\/v2"$/m);
  assert.equal(noRatings.stdout, '');
  const otherRatings = run('agree', '--ratings', changed('ratings.json', (f) => void (f['schema'] = 'anchorset.ratings/v1')));
  assert.equal(otherRatings.status, 65);
  assert.match(otherRatings.stderr, /ratings\.schema: required, and must be "anchorset\.ratings\/v2"/);
  const noAnchor = run('drift', '--old', changed('anchor_old.json', (f) => void delete f['schema']), '--new', ex('anchor_new.json'), '--flag', 'handoff');
  assert.equal(noAnchor.status, 65, noAnchor.stderr);
  assert.match(noAnchor.stderr, /^ {2}- old\.schema: required, and must be "anchorset\.anchor\/v1"$/m);
  const noNew = run('drift', '--old', ex('anchor_old.json'), '--new', changed('anchor_new.json', (f) => void delete f['schema']), '--flag', 'handoff');
  assert.equal(noNew.status, 65);
  assert.match(noNew.stderr, /^ {2}- new\.schema: required/m);
  // The ratings schema in an anchor file is another format's name.
  const wrong = run('drift', '--old', changed('anchor_old.json', (f) => void (f['schema'] = RATINGS_SCHEMA)), '--new', ex('anchor_new.json'), '--flag', 'handoff');
  assert.equal(wrong.status, 65);
});

test('the --help footer says what --json prints: the contract and tool keys of every report but judge-change, and all eight keys of the refusal object', () => {
  const help = run('--help').stdout.replace(/\s+/g, ' ');
  assert.match(help, /names its contract in "schema" and the tool in "tool"[^.]*, except judge-change/);
  const refused = JSON.parse(run('flips', '--run', changed('judged.json', (f) => void ((f['identity'] as Record<string, unknown>)['drawsPerCase'] = 'UNKNOWN')), '--json').stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(refused), ['schema', 'tool', 'kind', 'command', 'code', 'fields', 'message', 'exitCode']);
  const shown = /the object \{([^}]*)\}/.exec(help)?.[1] ?? assert.fail('the footer does not show the refusal object');
  for (const k of Object.keys(refused)) assert.ok(shown.includes(`"${k}"`), `the footer's refusal object lacks "${k}"`);
});
