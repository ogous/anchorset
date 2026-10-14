import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { IDENTITY_FIELDS } from '../src/identity.ts';

const root = join(import.meta.dirname, '..');
const run = (...args: string[]) => spawnSync(process.execPath, [join(root, 'src', 'cli.ts'), ...args], { encoding: 'utf8' });
const ex = (f: string): string => join(root, 'examples', 'refund-bot', f);
const gateArgs = ['gate', '--baseline', ex('baseline.json'), '--candidate', ex('candidate.json'), '--bar', ex('bar.json')];
const COMMANDS = ['gate', 'agree', 'drift', 'flips', 'judge-change'];

test('--version prints the tool name and version and exits 0', () => {
  const r = run('--version');
  assert.equal(r.status, 0, r.stderr);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  assert.equal(r.stdout.trim(), `anchorset ${pkg.version}`);
});

test("<command> --help prints that command's usage alone and exits 0", () => {
  for (const cmd of COMMANDS) {
    const r = run(cmd, '--help');
    assert.equal(r.status, 0, `${cmd}: ${r.stderr}`);
    assert.ok(r.stdout.includes(`  anchorset ${cmd} `), cmd);
    for (const other of COMMANDS.filter((c) => c !== cmd)) {
      assert.ok(!r.stdout.includes(`  anchorset ${other} `), `${cmd} help names ${other}`);
    }
    assert.ok(r.stdout.includes('exit codes:'), cmd);
  }
});

test("a usage error prints the one command's usage, and names every missing flag", () => {
  const r = run('gate');
  assert.equal(r.status, 64);
  assert.ok(r.stderr.includes('anchorset: --baseline, --candidate, --bar are required'), r.stderr);
  assert.ok(r.stderr.includes('  anchorset gate '));
  assert.ok(!r.stderr.includes('  anchorset agree '));
  const one = run('agree');
  assert.equal(one.status, 64);
  assert.ok(one.stderr.includes('anchorset: --ratings is required'), one.stderr);
  // An unknown subcommand has no usage of its own: it gets the whole text.
  const bad = run('nosuch');
  assert.equal(bad.status, 64);
  assert.ok(bad.stderr.includes('  anchorset gate ') && bad.stderr.includes('  anchorset flips '));
});

test('--allow-differ with an unknown field lists the valid identity fields', () => {
  const r = run(...gateArgs, '--allow-differ', 'nonsense');
  assert.equal(r.status, 64);
  assert.ok(r.stderr.includes('unknown identity field(s) nonsense; the fields are '), r.stderr);
  assert.ok(r.stderr.includes(`the fields are ${IDENTITY_FIELDS.join(', ')}`), r.stderr);
});

test('<command> -h prints the same usage as <command> --help; -h as the value of a flag is that flag\'s value', () => {
  for (const cmd of COMMANDS) {
    const short = run(cmd, '-h');
    assert.equal(short.status, 0, `${cmd}: ${short.stderr}`);
    assert.equal(short.stdout, run(cmd, '--help').stdout, cmd);
  }
  // A value is never taken for the help flag: a file named "-h" is read, and is not found here.
  const value = run('flips', '--run', '-h');
  assert.equal(value.status, 65, value.stderr);
  assert.match(value.stderr, /cannot read -h/);
});

test('gate --help says what --ledger records: the identities, the bar hash, the flags and the summary, not the run files; a refused gate is recorded too', () => {
  const text = run('gate', '--help').stdout.replace(/\s+/g, ' ');
  assert.doesNotMatch(text, /--labels/);
  assert.match(text, /--ledger: appends one record: the identities the runs declared \(three with --rejudge-of, and its bootstrap\), the bar's hash, the flags and the summary of the result; it holds no hash of the run files/);
  assert.match(text, /A refused gate is recorded too/);
  // The ledger note beside agree and drift keeps its own wording, which is about files.
  assert.match(run('agree', '--help').stdout.replace(/\s+/g, ' '), /--ledger \(agree, drift\): appends one record of the report: the sha256 of every file read/);
});

test('agree --help and drift --help say they are measurements that never exit 1, as flips and judge-change do', () => {
  for (const cmd of ['agree', 'drift', 'flips', 'judge-change']) {
    assert.match(run(cmd, '--help').stdout.replace(/\s+/g, ' '), /A measurement[^.]*: it never exits 1\./, cmd);
  }
  assert.doesNotMatch(run('gate', '--help').stdout, /never exits 1/);
});

test('judge-change --help says the folder holds only the plan\'s run files, plus the plan, the bar and the ledger, which are skipped', () => {
  const text = run('judge-change', '--help').stdout.replace(/\s+/g, ' ');
  assert.match(text, /<dir> must hold only the files the plan names by sha256, and may also hold the plan, the bar and the --ledger file, which are skipped/);
  assert.doesNotMatch(text, /names every run file in <dir> by its sha256/);
});
