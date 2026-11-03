import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { hashOf, sha256Hex } from '../src/identity.ts';
import { readLedger } from '../src/ledger.ts';
import { atPointer, checkStudyCells, parseStudyManifest, printed, STUDY_ROLES, studyInputName, studyManifestProblems, studyPathProblems } from '../src/study.ts';
import { JUDGE_CHANGE_FILE_ROLES } from '../src/judgechange.ts';
import type { StudyManifest } from '../src/study.ts';
import { TOOL_VERSION } from '../src/version.ts';

const root = join(import.meta.dirname, '..');
const example = join(root, 'examples', 'judge-change');
const manifest = (): StudyManifest => JSON.parse(readFileSync(join(example, 'manifest.json'), 'utf8')) as StudyManifest;
const check = (...args: string[]) => spawnSync(process.execPath, [join(root, 'tools', 'study-check.ts'), ...args], { encoding: 'utf8' });
const tmp = mkdtempSync(join(tmpdir(), 'anchorset-study-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
/** A private copy of the example, so that a test can change a file. */
const copy = (name: string): string => {
  const dir = join(tmp, name);
  cpSync(example, dir, { recursive: true });
  return dir;
};
const has = (x: unknown, fragment: string): void => assert.ok(studyManifestProblems(x).some((p) => p.includes(fragment)), `${fragment}: ${studyManifestProblems(x).join(' | ')}`);

test('printed: a number as a table prints it', () => {
  assert.equal(printed(0.146875, 100, 1), '14.7');
  assert.equal(printed(2.579840280942802, 1, 2), '2.58');
  assert.equal(printed(-0.9281999999999999, 1, 2), '-0.93');
  assert.equal(printed(4, 1, 0), '4');
  // No negative zero: a value that rounds to 0 prints as 0.
  assert.equal(printed(-0.0004, 1, 2), '0.00');
  assert.equal(printed(-0.1, 100, 1), '-10.0');
});

test('atPointer follows a JSON Pointer, with its two escapes, and returns undefined for a missing step', () => {
  const doc = { a: { 'b c': [10, { 'x/y': 1, 'm~n': 2 }] }, '': 3 };
  assert.equal(atPointer(doc, '/a/b c/0'), 10);
  assert.equal(atPointer(doc, '/a/b c/1/x~1y'), 1);
  assert.equal(atPointer(doc, '/a/b c/1/m~0n'), 2);
  assert.equal(atPointer(doc, '/'), 3);
  assert.equal(atPointer(doc, '/a/nope/0'), undefined);
  assert.equal(atPointer(doc, '/a/b c/7'), undefined);
  // An inherited property is not a cell.
  assert.equal(atPointer(doc, '/a/toString'), undefined);
});

test('the example manifest is valid, and the manifest schema is closed', () => {
  const m = manifest();
  assert.deepEqual(studyManifestProblems(m), []);
  assert.equal(parseStudyManifest(m), m);
  assert.equal(m.cellsSha256, hashOf(m.cells));
  has({ ...m, extra: 1 }, 'manifest.extra: unknown field');
  has({ ...m, schema: 'anchorset.study/v0' }, 'manifest.schema');
  has({ ...m, dataDoi: '' }, 'manifest.dataDoi');
  has({ ...m, library: { name: 'anchorset', version: '0.0.1' } }, 'manifest.library.commit');
  has({ ...m, inputs: m.inputs.filter((f) => f.role !== 'bar') }, 'exactly one file with role "bar", found 0');
  has({ ...m, inputs: [...m.inputs, { ...(m.inputs[0] as object), path: 'plan2.json' }] }, 'exactly one file with role "plan", found 2');
  has({ ...m, inputs: [...m.inputs, m.inputs[0]] }, 'listed twice');
  has({ ...m, inputs: [{ ...(m.inputs[0] as object), path: '../plan.json' }, ...m.inputs.slice(1)] }, 'inside its folder');
  has({ ...m, inputs: [{ ...(m.inputs[0] as object), role: 'data' }, ...m.inputs.slice(1)] }, 'role: must be one of');
  has({ ...m, excluded: [{ name: 'x' }] }, 'manifest.excluded');
  has({ ...m, firstRun: { ...m.firstRun, resultSha256: 'see the record' } }, 'manifest.firstRun.resultSha256');
});

test('a manifest cell is a pointer, a scale, a precision and the value as printed; the list is hashed', () => {
  const m = manifest();
  const cell = (over: Record<string, unknown>): unknown => {
    const cells = [{ ...(m.cells[0] as object), ...over }, ...m.cells.slice(1)];
    return { ...m, cells, cellsSha256: hashOf(cells) };
  };
  has(cell({ path: 'perDrawPassRate/old' }), 'cells[0].path');
  has(cell({ scale: 10 }), 'cells[0].scale');
  has(cell({ precision: 2 }), 'cells[0].expected: must have exactly 2 decimal place(s)');
  has(cell({ expected: '0.67' }), 'cells[0].expected: must have exactly 3 decimal place(s)');
  has(cell({ expected: '.667' }), 'cells[0].expected');
  // A cell edited after the list was hashed is caught: expected values are never rewritten quietly.
  has({ ...m, cells: [{ ...(m.cells[0] as object), expected: '0.668' }, ...m.cells.slice(1)] }, 'manifest.cellsSha256');
});

test('checkStudyCells compares every cell as printed; a missing or non-numeric cell is a mismatch, never skipped', () => {
  const m = manifest();
  const report = {
    perDrawPassRate: { old: 169 / 360, new: 0.2861, change: -0.1833 },
    labelPassRate: { change: -0.19167 },
    flips: { acrossJudges: 0.275, withinJudge: 'not declared' },
    counts: { items: 120 },
    gate: { counts: { passDoNothingOnly: 0, passRejudgedOnly: 5, passBoth: 1 } },
    map: { counts: { passRecalibratedOnly: 2, passRejudgedCutOnly: 1, passBoth: 6 } },
  };
  const r = checkStudyCells(m, report);
  assert.equal(r.matched, 12);
  assert.deepEqual(r.mismatches, [
    { name: 'labels that differ between two sets of one judge', path: '/flips/withinJudge', expected: '0.167', got: 'not a number ("not declared")' },
    { name: 'flips beyond re-asking', path: '/flips/beyondReask', expected: '0.108', got: 'missing' },
  ]);
});

test('study-check re-runs the example manifest: every cell matches, exit 0', () => {
  const r = check(join(example, 'manifest.json'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /the judge-change example \(synthetic\): 14 of 14 in-scope cells match \(1 excluded, each with its reason\)/);
  const j = JSON.parse(check(join(example, 'manifest.json'), '--json').stdout) as { matched: number; mismatches: unknown[]; resultSha256: string; firstRunResultSha256: string; firstRunReport: string };
  assert.deepEqual([j.matched, j.mismatches], [14, []]);
  // The first run was made by the manifest's library version. This version produces the same report but for the
  // version it names: byte for byte when the two versions are one, and otherwise the hash differs and the check says why.
  if (manifest().library.version === TOOL_VERSION) {
    assert.equal(j.resultSha256, j.firstRunResultSha256);
    assert.equal(j.firstRunReport, 'byte for byte');
    assert.match(r.stdout, /this report is the first run's, byte for byte\n/);
  } else {
    assert.notEqual(j.resultSha256, j.firstRunResultSha256);
    assert.equal(j.firstRunReport, 'apart from the tool version');
    assert.ok(r.stdout.includes(`this report is the first run's apart from the tool version (${manifest().library.version} in the manifest, ${TOOL_VERSION} here)\n`), r.stdout);
  }
});

test('study-check: a report that is not the first run\'s says so, and one whose manifest names this version is byte for byte', () => {
  const run = (m: StudyManifest) => {
    const dir = copy(`first-run-${m.firstRun.resultSha256.slice(0, 8)}-${m.library.version}`);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
    return check(join(dir, 'manifest.json'));
  };
  const m = manifest();
  const other = run({ ...m, firstRun: { ...m.firstRun, resultSha256: '0'.repeat(64) } });
  assert.equal(other.status, 0, other.stderr);
  assert.match(other.stdout, /this report differs from the first run's in some field outside the cells, or in a cell\n/);
  const now = JSON.parse(check(join(example, 'manifest.json'), '--json').stdout) as { resultSha256: string };
  const same = run({ ...m, library: { ...m.library, version: TOOL_VERSION }, firstRun: { ...m.firstRun, resultSha256: now.resultSha256 } });
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.stdout, /this report is the first run's, byte for byte\n/);
  // A first run that differs in its version and in one more field is not "apart from the tool version".
  const report = JSON.parse(spawnSync(process.execPath, [join(root, 'src', 'cli.ts'), 'judge-change', '--plan', join(example, 'plan.json'), '--bar', join(example, 'bar.json'), '--inputs', join(example, 'runs'), '--json'], { encoding: 'utf8' }).stdout) as Record<string, unknown> & { tool: Record<string, unknown> };
  const oneMore = hashOf({ ...report, tool: { ...report.tool, version: '0.0.9' }, kind: 'not the same' });
  const both = run({ ...m, library: { ...m.library, version: '0.0.9' }, firstRun: { ...m.firstRun, resultSha256: oneMore } });
  assert.equal(both.status, 0, both.stderr);
  assert.match(both.stdout, /this report differs from the first run's in some field outside the cells, or in a cell\n/);
  // And the same first run with only its version changed is: the line names both versions.
  const onlyVersion = run({ ...m, library: { ...m.library, version: '0.0.9' }, firstRun: { ...m.firstRun, resultSha256: hashOf({ ...report, tool: { ...report.tool, version: '0.0.9' } }) } });
  assert.ok(onlyVersion.stdout.includes(`this report is the first run's apart from the tool version (0.0.9 in the manifest, ${TOOL_VERSION} here)\n`), onlyVersion.stdout);
});

test('study-check: a published value that no longer matches exits 1 and names the cell; nothing is rewritten', () => {
  const dir = copy('differs');
  const m = manifest();
  const cells = m.cells.map((c) => (c.path === '/flips/beyondReask' ? { ...c, expected: '0.200' } : c));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...m, cells, cellsSha256: hashOf(cells) }));
  const r = check(join(dir, 'manifest.json'));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /13 of 14 in-scope cells match/);
  assert.match(r.stdout, /DIFFERS {2}flips beyond re-asking: published 0\.200, recomputed 0\.108 {2}\(\/flips\/beyondReask\)/);
  assert.match(r.stdout, /the expected values stay as published/);
});

test('study-check: an input that is not the file the manifest names is refused (2); a broken manifest is 65', () => {
  const dir = copy('tampered');
  const run = join(dir, 'runs', 'bot-v1.new-judge.json');
  writeFileSync(run, readFileSync(run, 'utf8').replace('"label": "4"', '"label": "5"'));
  const r = check(join(dir, 'manifest.json'));
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /REFUSED HASH_MISMATCH\n {2}fields: runs\/bot-v1\.new-judge\.json/);
  const bad = copy('bad');
  writeFileSync(join(bad, 'manifest.json'), JSON.stringify({ ...manifest(), cells: [] }));
  assert.equal(check(join(bad, 'manifest.json')).status, 65);
  assert.equal(check(join(tmp, 'no-such.json')).status, 65);
  assert.equal(check().status, 64);
});

test('study-check: a manifest, a plan, a bar, a run or a reference file that gives a key twice is invalid input (65), with the file, the key and its place named', () => {
  const sha = (path: string): string => sha256Hex(readFileSync(path));
  /**
   * Gives a key twice in one file of a private copy, the file's own value last, so that JSON.parse reads the
   * file as before; then re-binds every file that names the changed one by its sha256 (the plan names the
   * runs, the manifest names all), so that the hashes hold and only the repeated key is wrong.
   */
  const twice = (name: string, file: string, after: RegExp, insert: string): string => {
    const dir = copy(name);
    /** Rewrites one file of the copy and returns its sha256 before and after. */
    const edit = (rel: string, change: (text: string) => string): [string, string] => {
      const before = sha(join(dir, rel));
      const text = readFileSync(join(dir, rel), 'utf8');
      const changed = change(text);
      assert.notEqual(changed, text, rel);
      writeFileSync(join(dir, rel), changed);
      return [before, sha(join(dir, rel))];
    };
    const original = readFileSync(join(dir, file), 'utf8');
    const moved = [edit(file, (t) => t.replace(after, (m) => `${m}${insert}`))];
    assert.deepEqual(JSON.parse(readFileSync(join(dir, file), 'utf8')), JSON.parse(original));
    if (file.startsWith('runs/')) moved.push(edit('plan.json', (t) => t.replaceAll(...(moved[0] as [string, string]))));
    if (file !== 'manifest.json') edit('manifest.json', (t) => moved.reduce((text, [before, now]) => text.replaceAll(before, now), t));
    return join(dir, 'manifest.json');
  };
  const invalid = (path: string, code: string, problem: string): void => {
    for (const r of [check(path), check(path, '--json')]) {
      assert.equal(r.status, 65, r.stdout + r.stderr);
      assert.equal(r.stderr, `invalid input (${code})\n  - ${problem}\n`);
      assert.equal(r.stdout, '');
    }
  };
  const top = twice('twice-manifest', 'manifest.json', /^\{/, '"study": "another study",');
  invalid(top, 'INVALID_ARGUMENT', `${top}: the key "study" is given twice in the top-level object`);
  const cell = twice('twice-cell', 'manifest.json', /"cells": \[\s*\{/, '"expected": "0.000",');
  invalid(cell, 'INVALID_ARGUMENT', `${cell}: the key "expected" is given twice in the object at /cells/0`);
  invalid(twice('twice-plan', 'plan.json', /"judges": \{/, '"old": {},'), 'INVALID_ARGUMENT', 'plan.json: the key "old" is given twice in the object at /judges');
  invalid(twice('twice-bar', 'bar.json', /"classes": \{/, '"reply_quality": {"direction": "floor", "minPassRate": 0},'), 'INVALID_ARGUMENT', 'bar.json: the key "reply_quality" is given twice in the object at /classes');
  invalid(twice('twice-run', 'runs/bot-v1.old-judge.json', /"draws": \[\s*\{/, '"\\u0063aseId": "q02",'), 'INVALID_ARTIFACT', 'bot-v1.old-judge.json: the key "caseId" is given twice in the object at /draws/0');
  invalid(twice('twice-reference', 'runs/bot-v3.reference.json', /"verdicts": \{/, '"q01": "pass",'), 'INVALID_ARTIFACT', 'bot-v3.reference.json: the key "q01" is given twice in the object at /verdicts');
  // A manifest that is not JSON keeps the parser's own message, also when a key is repeated in it.
  const cut = copy('twice-cut');
  const text = '{"schema": "anchorset.study/v1", "schema": ';
  writeFileSync(join(cut, 'manifest.json'), text);
  let message = '';
  try {
    JSON.parse(text);
  } catch (e) {
    message = (e as Error).message;
  }
  assert.notEqual(message, '');
  const r = check(join(cut, 'manifest.json'));
  assert.equal(r.status, 65);
  assert.equal(r.stderr, `invalid input: ${message}\n`);
});

test('one report hash: the command, its ledger record, study-check and the manifest agree on the example', () => {
  const ledger = join(tmp, 'one-hash', 'ledger.jsonl');
  const cli = spawnSync(process.execPath, [join(root, 'src', 'cli.ts'), 'judge-change', '--plan', join(example, 'plan.json'), '--bar', join(example, 'bar.json'), '--inputs', join(example, 'runs'), '--json', '--ledger', ledger], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const fromCli = hashOf(JSON.parse(cli.stdout));
  const fromLedger = readLedger(ledger)[0]?.resultHash;
  const fromCheck = (JSON.parse(check(join(example, 'manifest.json'), '--json').stdout) as { resultSha256: string }).resultSha256;
  assert.equal(fromLedger, fromCli);
  assert.equal(fromCheck, fromCli);
  // The first run's report names the manifest's library version; with that one field set back, it is this report.
  const report = JSON.parse(cli.stdout) as { tool: { name: string; version: string } };
  assert.equal(manifest().firstRun.resultSha256, hashOf({ ...report, tool: { ...report.tool, version: manifest().library.version } }));
  // The hash covers each file's name, and a name is the file's own name, never its folder.
  assert.equal(studyInputName('runs/bot-v1.old-judge.json'), 'bot-v1.old-judge.json');
  assert.equal(studyInputName('plan.json'), 'plan.json');
  assert.equal(studyInputName('a/b/c.json'), 'c.json');
});

test('a manifest whose files share a file name is refused: the report names files without their folders', () => {
  const m = manifest();
  const twin = { path: 'other/bot-v1.old-judge.json', role: 'run', sha256: hashOf('another run') };
  has({ ...m, inputs: [...m.inputs, twin] }, 'path: the same file name as runs/bot-v1.old-judge.json ("bot-v1.old-judge.json")');
  // Any two files, whatever their roles: a converter named like the plan is refused too.
  has({ ...m, inputs: [...m.inputs, { path: 'tools/plan.json', role: 'converter', sha256: hashOf('a converter') }] }, 'the same file name as plan.json ("plan.json")');
  const dir = copy('twins');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...m, inputs: [...m.inputs, twin] }));
  const r = check(join(dir, 'manifest.json'));
  assert.equal(r.status, 65, r.stdout + r.stderr);
  assert.match(r.stderr, /the same file name as runs\/bot-v1\.old-judge\.json/);
});

test('the file roles of a manifest are the roles of a ledger record, and the converter', () => {
  assert.deepEqual(JUDGE_CHANGE_FILE_ROLES, ['plan', 'bar', 'run', 'reference', 'tie-break', 'resample-indices']);
  assert.deepEqual(STUDY_ROLES, [...JUDGE_CHANGE_FILE_ROLES, 'converter']);
});

test('manifest paths are portable POSIX-relative paths: no backslash, drive prefix, absolute path, empty component, "." or ".."', () => {
  const m = manifest();
  const withPath = (path: unknown): unknown => ({ ...m, inputs: [{ ...(m.inputs[0] as object), path }, ...m.inputs.slice(1)] });
  const refusedPath = (path: string, why: string): void => {
    has(withPath(path), `manifest.inputs[0].path: must be a path relative to the manifest, inside its folder, written with "/" between its parts; this one ${why}`);
    assert.deepEqual(studyPathProblems(path).join(', '), why, path);
  };
  // A backslash: a separator on one platform and a file-name character on another, so the file's name would differ.
  refusedPath('runs\\plan.json', 'holds a backslash');
  refusedPath('..\\..\\outside\\plan.json', 'holds a backslash');
  refusedPath('C:\\data\\plan.json', 'holds a backslash, starts with a drive prefix');
  // A drive prefix, with either separator or none.
  refusedPath('C:/data/plan.json', 'starts with a drive prefix');
  refusedPath('c:plan.json', 'starts with a drive prefix');
  // An absolute path, a UNC-like path, and a root.
  refusedPath('/etc/plan.json', 'is absolute');
  refusedPath('//server/share/plan.json', 'is absolute, has an empty component');
  // Empty components: a doubled separator, and a trailing one (a folder, not a file).
  refusedPath('runs//plan.json', 'has an empty component');
  refusedPath('runs/', 'has an empty component');
  // "." and "..", anywhere: at the start, in the middle, at the end.
  refusedPath('./plan.json', 'has a "." or ".." component');
  refusedPath('runs/./plan.json', 'has a "." or ".." component');
  refusedPath('../plan.json', 'has a "." or ".." component');
  refusedPath('runs/../../plan.json', 'has a "." or ".." component');
  refusedPath('runs/..', 'has a "." or ".." component');
  refusedPath('.', 'has a "." or ".." component');
  has(withPath(''), 'manifest.inputs[0].path: must be a path relative to the manifest');
  has(withPath(7), 'manifest.inputs[0].path: must be a path relative to the manifest');
  // Portable paths: plain names, folders, and names that merely contain dots or a colon further in.
  for (const ok of ['plan.json', 'runs/bot-v1.old-judge.json', 'a/b/c/d.json', '.hidden/plan.json', 'runs/..plan.json', 'runs/plan..json', 'data/v1:final.json']) {
    assert.deepEqual(studyPathProblems(ok), [], ok);
    assert.deepEqual(studyManifestProblems(withPath(ok)).filter((p) => p.includes('inputs[0].path')), [], ok);
  }
  // Every path of the example is portable.
  assert.deepEqual(m.inputs.flatMap((f) => studyPathProblems(f.path)), []);
  // The tool refuses such a manifest as invalid input (65) before it reads any file.
  const dir = copy('unportable');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(withPath('runs\\..\\plan.json')));
  const r = check(join(dir, 'manifest.json'));
  assert.equal(r.status, 65, r.stdout + r.stderr);
  assert.match(r.stderr, /manifest\.inputs\[0\]\.path: must be a path relative to the manifest.*holds a backslash/);
});

test('study-check takes one manifest path and an optional --json, in either order; any other flag, a second path or none is a usage error (64), never a run', () => {
  const m = join(example, 'manifest.json');
  for (const argv of [['--jsno', m], [m, '--jsno'], ['-h', m], ['-h'], ['--help'], [m, 'extra'], [m, m], [m, '--json', '--json'], ['--json'], [], ['--', m], ['-', m]]) {
    const r = check(...argv);
    assert.equal(r.status, 64, `${JSON.stringify(argv)}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, '', JSON.stringify(argv));
    assert.match(r.stderr, /^usage: node tools\/study-check\.ts <manifest\.json> \[--json\]\n$/, JSON.stringify(argv));
  }
  const plain = check(m);
  assert.equal(plain.status, 0, plain.stderr);
  for (const argv of [[m, '--json'], ['--json', m]]) {
    const r = check(...argv);
    assert.equal(r.status, 0, r.stderr);
    assert.equal((JSON.parse(r.stdout) as { matched: number }).matched, 14);
  }
});

test('manifest: a changed cell list is reported even when the manifest has other problems, and not when a cell itself is invalid (its own problem is the one to fix)', () => {
  const m = manifest();
  const edited = [{ ...(m.cells[0] as object), expected: '0.668' }, ...m.cells.slice(1)];
  // Another problem elsewhere in the manifest (a bad study name) does not hide the changed cell list.
  const both = studyManifestProblems({ ...m, study: '', cells: edited });
  assert.ok(both.some((p) => p.startsWith('manifest.study')), both.join(' | '));
  assert.ok(both.some((p) => p.startsWith('manifest.cellsSha256: declared')), both.join(' | '));
  // A cell that is not valid names its own problem; the hash is not compared over a list that is not a list of cells.
  const broken = studyManifestProblems({ ...m, cells: [{ ...(m.cells[0] as object), scale: 7 }, ...m.cells.slice(1)] });
  assert.ok(broken.some((p) => p.includes('.scale: must be 1 or 100')), broken.join(' | '));
  assert.ok(!broken.some((p) => p.startsWith('manifest.cellsSha256: declared')), broken.join(' | '));
  // The unedited manifest is still valid.
  assert.deepEqual(studyManifestProblems(m), []);
});
