import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, parseCommits, signoffProblems } from '../tools/dco-check.ts';
import type { CommitRecord } from '../tools/dco-check.ts';

// The check CONTRIBUTING.md names: every commit of a pull request carries a Signed-off-by line (Developer Certificate of
// Origin 1.1), by the author or the committer of that commit. Merge commits are not asked for one.

const commit = (over: Partial<CommitRecord> = {}): CommitRecord => ({
  sha: 'a'.repeat(40), parents: ['b'.repeat(40)], authorEmail: 'dev@example.com', committerEmail: 'dev@example.com',
  message: 'Fix a thing\n\nSigned-off-by: Dev Eloper <dev@example.com>\n', ...over,
});

test('a commit signed off by its author passes', () => {
  assert.deepEqual(signoffProblems([commit()]), []);
});

test('a commit without the line is refused, naming its short id', () => {
  const p = signoffProblems([commit({ sha: 'c0ffee0123456789'.padEnd(40, '0'), message: 'Fix a thing\n' })]);
  assert.equal(p.length, 1);
  assert.match(p[0] as string, /^c0ffee0123: no Signed-off-by line/);
});

test('each of these is refused: a malformed line, a line that is not at the start of a line, another person\'s address, an empty name', () => {
  const bad = [
    'Fix\n\nSigned-off-by: Dev Eloper\n',
    'Fix\n\nSigned-off-by: Dev Eloper <not-an-address>\n',
    'Fix\n\n  Signed-off-by: Dev Eloper <dev@example.com>\n',
    'Fix\n\nsigned-off-by: Dev Eloper <dev@example.com>\n',
    'Fix\n\nsee Signed-off-by: Dev Eloper <dev@example.com>\n',
    'Fix\n\nSigned-off-by:  <dev@example.com>\n',
    'Fix\n\nSigned-off-by: Someone Else <other@example.com>\n',
  ];
  for (const message of bad) assert.equal(signoffProblems([commit({ message })]).length, 1, JSON.stringify(message));
});

test('the address is compared without regard to case, and the committer may sign off a commit the author wrote', () => {
  assert.deepEqual(signoffProblems([commit({ message: 'Fix\n\nSigned-off-by: Dev <DEV@Example.COM>\n' })]), []);
  assert.deepEqual(signoffProblems([commit({ authorEmail: 'author@example.com', committerEmail: 'maint@example.com', message: 'Fix\n\nSigned-off-by: Maint <maint@example.com>\n' })]), []);
  assert.equal(signoffProblems([commit({ authorEmail: 'author@example.com', committerEmail: 'maint@example.com' })]).length, 1);
});

test('a merge commit is not asked for a line, and a range of no commits passes', () => {
  assert.deepEqual(signoffProblems([commit({ parents: ['b'.repeat(40), 'd'.repeat(40)], message: 'Merge branch\n' })]), []);
  assert.deepEqual(signoffProblems([]), []);
});

test('every unsigned commit of a list is named, not only the first', () => {
  const p = signoffProblems([commit({ sha: '1'.repeat(40), message: 'x\n' }), commit(), commit({ sha: '2'.repeat(40), message: 'y\n' })]);
  assert.equal(p.length, 2);
});

test('the log text is read into records, and a text that is not the shape is refused, never read as a pass', () => {
  const rec = '\x1e' + ['a'.repeat(40), 'b'.repeat(40), 'dev@example.com', 'dev@example.com', 'Fix\n\nSigned-off-by: D <dev@example.com>\n'].join('\x1f');
  assert.deepEqual(parseCommits(rec), [commit({ message: 'Fix\n\nSigned-off-by: D <dev@example.com>\n' })]);
  assert.deepEqual(parseCommits(''), []);
  assert.throws(() => parseCommits('\x1e' + ['a', 'b', 'c'].join('\x1f')), /not the shape/);
  assert.throws(() => parseCommits('no record mark'), /not the shape/);
});

// --- the command, on a real repository ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=Dev Eloper', '-c', 'user.email=dev@example.com', ...args], {
    cwd, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function run(cwd: string, argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = [], err: string[] = [];
  const was = process.cwd();
  process.chdir(cwd);
  try { return { code: main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }), out: out.join('\n'), err: err.join('\n') }; } finally { process.chdir(was); }
}

test('on a repository: a range of signed commits passes (exit 0), one unsigned commit refuses it (exit 2), a bad argument is a usage error (64), an unknown revision is an internal error (70)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anchorset-dco-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'a\n'); git(dir, 'add', 'a.txt'); git(dir, 'commit', '-q', '-s', '-m', 'base');
    const base = git(dir, 'rev-parse', 'HEAD');
    writeFileSync(join(dir, 'b.txt'), 'b\n'); git(dir, 'add', 'b.txt'); git(dir, 'commit', '-q', '-s', '-m', 'signed');
    const ok = run(dir, [`${base}..HEAD`]);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /1 commit/);
    writeFileSync(join(dir, 'c.txt'), 'c\n'); git(dir, 'add', 'c.txt'); git(dir, 'commit', '-q', '-m', 'unsigned');
    const unsigned = git(dir, 'rev-parse', 'HEAD').slice(0, 10);
    const refused = run(dir, [`${base}..HEAD`]);
    assert.equal(refused.code, 2);
    assert.match(refused.err, /REFUSED DCO/);
    assert.ok(refused.err.includes(`${unsigned}: no Signed-off-by line`), refused.err);
    assert.equal(run(dir, []).code, 64);
    assert.equal(run(dir, ['--all']).code, 64);
    assert.equal(run(dir, ['-n1']).code, 64);
    assert.equal(run(dir, ['a..b', 'c..d']).code, 64);
    assert.equal(run(dir, ['HEAD']).code, 64);
    assert.equal(run(dir, ['nosuchrev..HEAD']).code, 70);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
