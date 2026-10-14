import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DRY_RUN_FIELD, NEVER_PUBLISHED, PLUGIN_FOLDER, README_PLUGIN_HEADING, PACKAGE_NAME, PUBLIC_REPOSITORY_URL, entryTargets, main, packageProblems, packedFiles, readmeProblems, releaseTreeProblems, treeProblems } from '../tools/release-tree-check.ts';
import type { DryRunResult } from '../tools/release-tree-check.ts';

const script = join(import.meta.dirname, '..', 'tools', 'release-tree-check.ts');

/** A package.json that passes: the smallest one a release could be made from. */
function goodPackage(): Record<string, unknown> {
  return { name: PACKAGE_NAME, version: '0.0.0', files: ['kept.txt'], repository: { type: 'git', url: PUBLIC_REPOSITORY_URL } };
}

/** A scratch tree with the given package.json (a string is written as it is) and one file to pack. */
function tree(pkg: unknown, extra: readonly string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'anchorset-release-tree.'));
  writeFileSync(join(root, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg, null, 2));
  writeFileSync(join(root, 'kept.txt'), 'kept\n');
  for (const path of extra) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), 'x\n');
  }
  return root;
}

const fields = (problems: readonly { field: string }[]): string[] => problems.map((p) => p.field);
/** A dry run that exits 0 and lists these files as the ones it would pack. */
const passes = (...files: string[]): DryRunResult => ({ status: 0, lastLines: [], files: ['package.json', 'kept.txt', ...files] });
const neverRun = (): DryRunResult => {
  throw new Error('the dry run must not be started in a refused tree');
};

test('a publishable package.json has no problem', () => {
  assert.deepEqual(packageProblems(goodPackage()), []);
});

test('the key "private" is refused whatever its value, and the refusal names it', () => {
  for (const value of [true, false, 'no', 0]) {
    const problems = packageProblems({ ...goodPackage(), private: value });
    assert.deepEqual(fields(problems), ['private'], JSON.stringify(value));
  }
});

test('the key "publishConfig" is refused whatever its value, and the refusal names it', () => {
  for (const value of [{}, { 'dry-run': false }, { registry: 'https://registry.example.invalid/' }, { access: 'public' }, null]) {
    const problems = packageProblems({ ...goodPackage(), publishConfig: value });
    assert.deepEqual(fields(problems), ['publishConfig'], JSON.stringify(value));
  }
});

test('a repository that is not exactly the public one is refused, and the refusal names repository.url', () => {
  const others: unknown[] = [
    undefined,
    'github:ogous/anchorset',
    PUBLIC_REPOSITORY_URL,
    { type: 'git' },
    { type: 'git', url: 'https://github.com/ogous/anchorset.git' },
    { type: 'git', url: 'git+https://github.com/ogous/anchorset' },
    { type: 'git', url: 'git+https://github.com/ogous/anchorset-other.git' },
    { type: 'git', url: 'git+https://github.com/someone-else/anchorset.git' },
    { type: 'git', url: `${PUBLIC_REPOSITORY_URL} ` },
    { type: 'git', url: PUBLIC_REPOSITORY_URL.toUpperCase() },
    [PUBLIC_REPOSITORY_URL],
  ];
  for (const repository of others) {
    const pkg = goodPackage();
    if (repository === undefined) delete pkg['repository'];
    else pkg['repository'] = repository;
    assert.deepEqual(fields(packageProblems(pkg)), ['repository.url'], JSON.stringify(repository));
  }
});

test('a repository of another kind, another package name and a package.json that is no object are each named', () => {
  assert.deepEqual(fields(packageProblems({ ...goodPackage(), repository: { type: 'svn', url: PUBLIC_REPOSITORY_URL } })), ['repository.type']);
  assert.deepEqual(fields(packageProblems({ ...goodPackage(), repository: { url: PUBLIC_REPOSITORY_URL } })), ['repository.type']);
  assert.deepEqual(fields(packageProblems({ ...goodPackage(), name: 'not-anchorset' })), ['name']);
  assert.deepEqual(fields(packageProblems([goodPackage()])), ['package.json']);
  assert.deepEqual(fields(packageProblems(null)), ['package.json']);
});

test('every problem of a package.json is listed, not only the first', () => {
  assert.deepEqual(fields(packageProblems({ name: 'other', private: true })), ['private', 'name', 'repository.url']);
  assert.deepEqual(fields(packageProblems({ name: 'other', private: true, publishConfig: {} })), ['private', 'publishConfig', 'name', 'repository.url']);
});

test('the paths the gate refuses are the three a release tree can pick up by accident: an environment file, an npm credentials file and a ledger', () => {
  // The list names only what any project keeps out of a release. Everything else a source tree may hold is checked where the tree is made, not here.
  assert.deepEqual([...NEVER_PUBLISHED], ['.env', '.npmrc', '.ledger']);
});

test('a tree that holds a path which is never published is refused by that path', () => {
  for (const path of NEVER_PUBLISHED) {
    const root = tree(goodPackage(), [path]);
    try {
      assert.deepEqual(fields(treeProblems(root)), [`./${path}`]);
    } finally {
      rmSync(root, { recursive: true });
    }
  }
});

// A released README holds no marker line, and a tree without the plugin holds no section on it; the gate refuses a
// tree where either is left.
const PLUGIN_SECTION = `${README_PLUGIN_HEADING}\n\nA plugin is in this repository.\n`;
test('a README that still holds a build marker is refused, with or without the plugin', () => {
  for (const holdsPlugin of [true, false]) {
    for (const marker of ['<!-- with-plugin:start -->', '<!-- with-plugin:end -->', '<!--with-plugin:start-->']) {
      assert.deepEqual(fields(readmeProblems(`# t\n${marker}\n`, holdsPlugin)), ['./README.md'], marker);
    }
  }
});

test('a README with the plugin section is refused in a tree without the plugin, and stands in a tree with it', () => {
  assert.deepEqual(fields(readmeProblems(`# t\n\n${PLUGIN_SECTION}`, false)), ['./README.md']);
  assert.deepEqual(readmeProblems(`# t\n\n${PLUGIN_SECTION}`, true), []);
  assert.deepEqual(fields(readmeProblems('# t\n\n```bash\nclaude plugin install anchorset@anchorset\n```\n', false)), ['./README.md']);
  assert.deepEqual(readmeProblems('# t\n\nNo word on it.\n', false), []);
  assert.deepEqual(readmeProblems('# t\n\nNo word on it.\n', true), []);
});

test('the tree check reads the README: the section without the plugin folder is refused, with the folder it stands', () => {
  const root = tree(goodPackage());
  try {
    assert.deepEqual(treeProblems(root), [], 'a tree with no README says nothing about a plugin');
    writeFileSync(join(root, 'README.md'), `# t\n\n${PLUGIN_SECTION}`);
    assert.deepEqual(fields(treeProblems(root)), ['./README.md']);
    assert.deepEqual(fields(releaseTreeProblems(root, neverRun).problems), ['./README.md']);
    mkdirSync(join(root, PLUGIN_FOLDER));
    assert.deepEqual(treeProblems(root), []);
    writeFileSync(join(root, 'README.md'), `# t\n\n<!-- with-plugin:start -->\n${PLUGIN_SECTION}<!-- with-plugin:end -->\n`);
    assert.deepEqual(fields(treeProblems(root)), ['./README.md'], 'with the plugin held, only the markers are a problem');
    rmSync(join(root, 'README.md'));
    mkdirSync(join(root, 'README.md'));
    assert.deepEqual(fields(treeProblems(root)), ['./README.md'], 'a README that cannot be read is not known to be clean');
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('a link that points nowhere still counts as a path the tree holds', () => {
  const root = tree(goodPackage());
  try {
    symlinkSync(join(root, 'does-not-exist'), join(root, '.env'));
    assert.deepEqual(fields(treeProblems(root)), ['./.env']);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('a package.json that is missing, is not JSON or gives a key twice is refused as package.json', () => {
  const twice = `{"name":"${PACKAGE_NAME}","private":true,"repository":{"type":"git","url":"${PUBLIC_REPOSITORY_URL}"},"private":false}`;
  for (const text of ['{', twice]) {
    const root = tree(text);
    try {
      assert.deepEqual(fields(treeProblems(root)), ['package.json'], text);
    } finally {
      rmSync(root, { recursive: true });
    }
  }
  const empty = mkdtempSync(join(tmpdir(), 'anchorset-release-tree.'));
  try {
    assert.deepEqual(fields(treeProblems(empty)), ['package.json']);
  } finally {
    rmSync(empty, { recursive: true });
  }
});

test('the dry run is not started in a tree that is already refused', () => {
  const root = tree({ ...goodPackage(), private: true });
  try {
    const r = releaseTreeProblems(root, neverRun);
    assert.deepEqual(fields(r.problems), ['private']);
    assert.equal(r.dryRunRan, false);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('a dry run that does not exit 0 is a problem named by the command; one that never gave an exit code is too', () => {
  const root = tree(goodPackage());
  try {
    assert.deepEqual(releaseTreeProblems(root, () => passes()).problems, []);
    assert.deepEqual(fields(releaseTreeProblems(root, () => ({ status: 1, lastLines: ['npm error'], files: ['package.json'] })).problems), [DRY_RUN_FIELD]);
    assert.deepEqual(fields(releaseTreeProblems(root, () => ({ status: undefined, lastLines: [] })).problems), [DRY_RUN_FIELD]);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('a flag, with one dash or two, or a second path is a usage error, never a pass', () => {
  const lines: string[] = [];
  const io = { out: (s: string) => lines.push(s), err: (s: string) => lines.push(s) };
  for (const argv of [['--static'], ['-x'], ['-'], ['--'], ['--', 'a'], ['a', '-x'], ['a', 'b']]) {
    assert.equal(main(argv, io), 64, JSON.stringify(argv));
  }
  assert.equal(lines.length, 7);
  assert.ok(lines.every((l) => l.startsWith('usage:')));
});

// The three tests below start the tool as a process. npm is told to stay off the network through its own
// environment setting; the tool itself has no switch that skips or softens a check.
const offline = { ...process.env, npm_config_offline: 'true', npm_config_update_notifier: 'false' };

test('as a process: a tree whose package.json is private exits 2, names the field, and npm is not started', () => {
  const root = tree({ ...goodPackage(), private: true, scripts: { prepack: 'node -e "require(\'fs\').writeFileSync(\'npm-ran\', \'\')"' } });
  try {
    const r = spawnSync(process.execPath, [script, root], { encoding: 'utf8', env: offline });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /^REFUSED RELEASE_TREE$/m);
    assert.match(r.stderr, /^ {2}fields: private$/m);
    assert.match(r.stderr, /was not run/);
    assert.equal(r.stdout, '');
    assert.equal(existsSync(join(root, 'npm-ran')), false, 'the prepack script ran, so npm was started');
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('as a process: a clean tree in which the dry run fails exits 2 and names the command', () => {
  const root = tree({ ...goodPackage(), scripts: { prepack: 'node -e "process.exit(7)"' } });
  try {
    const r = spawnSync(process.execPath, [script, root], { encoding: 'utf8', env: offline });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /^ {2}fields: npm publish --dry-run$/m);
    assert.equal(r.stdout, '');
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('as a process: a clean tree in which the dry run passes exits 0', () => {
  const root = tree(goodPackage());
  try {
    const r = spawnSync(process.execPath, [script, root], { encoding: 'utf8', env: offline });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^release-tree-check: ok for /);
  } finally {
    rmSync(root, { recursive: true });
  }
});

// Fixture, not a published example: the entry points a manifest names are exactly those listed below.
test('the entry points of a manifest are main, types, each bin and each string leaf of exports', () => {
  const pkg = { main: 'dist/index.js', types: './dist/index.d.ts', bin: { a: 'dist/a.js', b: './dist/b.js' }, exports: { '.': { types: './dist/t.d.ts', default: ['./dist/d.js', { x: './dist/x.js' }] } } };
  assert.deepEqual(entryTargets(pkg).map(([, t]) => t), ['dist/index.js', './dist/index.d.ts', 'dist/a.js', './dist/b.js', './dist/t.d.ts', './dist/d.js', './dist/x.js']);
  assert.deepEqual(entryTargets({ bin: 'dist/cli.js' }), [['bin', 'dist/cli.js']]);
  assert.deepEqual(entryTargets(null), []);
  assert.deepEqual(entryTargets({ name: 'x' }), []);
});

test('an entry point that the tree does not hold is refused by the manifest field that names it', () => {
  const missing = (pkg: Record<string, unknown>, extra: readonly string[] = []): string[] => {
    const root = tree({ ...goodPackage(), ...pkg }, extra);
    try {
      return fields(releaseTreeProblems(root, () => passes(...extra)).problems);
    } finally {
      rmSync(root, { recursive: true });
    }
  };
  assert.deepEqual(missing({ bin: { anchorset: 'dist/cli.js' } }), ['bin']);
  assert.deepEqual(missing({ bin: 'dist/cli.js' }), ['bin']);
  assert.deepEqual(missing({ main: 'dist/index.js' }), ['main']);
  assert.deepEqual(missing({ types: 'dist/index.d.ts' }), ['types']);
  assert.deepEqual(missing({ exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } } }), ['exports', 'exports']);
  // Present: no problem. A folder is not a file. A path out of the tree and an absolute path are not there.
  assert.deepEqual(missing({ bin: { anchorset: './dist/cli.js' }, main: 'dist/cli.js' }, ['dist/cli.js']), []);
  assert.deepEqual(missing({ bin: 'dist' }, ['dist/cli.js']), ['bin']);
  assert.deepEqual(missing({ bin: '../kept.txt' }), ['bin']);
  assert.deepEqual(missing({ bin: join(tmpdir(), 'anchorset-absolute-target') }), ['bin']);
  assert.deepEqual(missing({ exports: { './*': './dist/*.js' } }), ['exports']);
  assert.deepEqual(missing({ exports: { './*': './dist/*.js' } }, ['dist/a.js']), []);
});

test('an entry point that is a link pointing nowhere is refused', () => {
  const root = tree({ ...goodPackage(), bin: { anchorset: 'dist/cli.js' } });
  try {
    mkdirSync(join(root, 'dist'));
    symlinkSync(join(root, 'dist', 'nowhere'), join(root, 'dist', 'cli.js'));
    assert.deepEqual(fields(releaseTreeProblems(root, () => passes('dist/cli.js')).problems), ['bin']);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('an entry point that is a link leading out of the tree is refused, and one leading to a file inside it is not', () => {
  const outside = mkdtempSync(join(tmpdir(), 'anchorset-release-outside.'));
  const root = tree({ ...goodPackage(), bin: { anchorset: 'dist/cli.js' } }, ['dist/real.js']);
  try {
    writeFileSync(join(outside, 'cli.js'), 'x\n');
    symlinkSync(join(outside, 'cli.js'), join(root, 'dist', 'cli.js'));
    assert.deepEqual(fields(releaseTreeProblems(root, () => passes('dist/cli.js', 'dist/real.js')).problems), ['bin']);
    rmSync(join(root, 'dist', 'cli.js'));
    symlinkSync(join(root, 'dist', 'real.js'), join(root, 'dist', 'cli.js'));
    assert.deepEqual(releaseTreeProblems(root, () => passes('dist/cli.js', 'dist/real.js')).problems, []);
  } finally {
    rmSync(root, { recursive: true });
    rmSync(outside, { recursive: true });
  }
});

test('typings, module and browser are entry points too, each named by its own field', () => {
  assert.deepEqual(entryTargets({ typings: 'a.d.ts', module: 'm.mjs', browser: 'b.js' }).map(([f]) => f), ['typings', 'module', 'browser']);
  assert.deepEqual(entryTargets({ browser: { './x.js': './y.js', './z.js': false } }), [['browser', './y.js']]);
  const missing = (pkg: Record<string, unknown>): string[] => {
    const root = tree({ ...goodPackage(), ...pkg });
    try {
      return fields(releaseTreeProblems(root, () => passes()).problems);
    } finally {
      rmSync(root, { recursive: true });
    }
  };
  assert.deepEqual(missing({ typings: 'dist/index.d.ts' }), ['typings']);
  assert.deepEqual(missing({ module: 'dist/index.mjs' }), ['module']);
  assert.deepEqual(missing({ browser: 'dist/index.js' }), ['browser']);
  assert.deepEqual(missing({ browser: { './a.js': './dist/b.js' } }), ['browser']);
});

test('an entry point that is in the tree but not in the files the dry run would pack is refused', () => {
  const root = tree({ ...goodPackage(), bin: { anchorset: 'dist/cli.js' }, exports: { './*': './dist/*.js' } }, ['dist/cli.js']);
  try {
    // Listed: no problem. Left out of the list: each field is named. A wildcard needs one packed file below its folder.
    assert.deepEqual(releaseTreeProblems(root, () => passes('dist/cli.js')).problems, []);
    assert.deepEqual(fields(releaseTreeProblems(root, () => passes()).problems), ['bin', 'exports']);
    assert.deepEqual(fields(releaseTreeProblems(root, () => passes('dist/cli.js.map')).problems), ['bin']);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('a dry run that exits 0 and gives no readable list of files is refused, naming the command', () => {
  const root = tree(goodPackage());
  try {
    for (const files of [undefined, null as unknown as undefined]) {
      assert.deepEqual(fields(releaseTreeProblems(root, () => ({ status: 0, lastLines: [], files })).problems), [DRY_RUN_FIELD]);
    }
    assert.deepEqual(fields(releaseTreeProblems(root, () => ({ status: 0, lastLines: [] })).problems), [DRY_RUN_FIELD]);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("the list of files is read from npm's JSON, and anything else is no list", () => {
  assert.deepEqual(packedFiles('{"files":[{"path":"a/b.js","size":1},{"path":"c"}]}'), ['a/b.js', 'c']);
  for (const text of ['', 'not json', '[]', '{}', '{"files":{}}', '{"files":[{"size":1}]}', '{"files":["a"]}', '{"files":[],"files":[]}']) {
    assert.equal(packedFiles(text), undefined, text);
  }
});

// npm prints the dry run in one of two shapes. npm 11.9.0 (with Node 25.6.1) prints the result itself; npm 11.17.0
// (with Node 24.19.0) prints one object keyed by the package name whose value is that result. Both are read, and
// nothing else is.
test("the list of files is read from both shapes npm prints: the result itself, and the result under the package's name", () => {
  const result = '{"id":"anchorset@0.1.0","name":"anchorset","files":[{"path":"dist/cli.js","size":1},{"path":"LICENSE"}]}';
  assert.deepEqual(packedFiles(result), ['dist/cli.js', 'LICENSE']);
  assert.deepEqual(packedFiles(`{${JSON.stringify(PACKAGE_NAME)}:${result}}`), ['dist/cli.js', 'LICENSE']);
  assert.deepEqual(packedFiles(`{${JSON.stringify(PACKAGE_NAME)}:{"files":[]}}`), []);
  for (const text of [
    `{"another-package":${result}}`, // keyed by a name that is not this package's
    `{${JSON.stringify(PACKAGE_NAME)}:${result},"another-package":${result}}`, // two packages: which list is the one?
    `{${JSON.stringify(PACKAGE_NAME)}:{}}`,
    `{${JSON.stringify(PACKAGE_NAME)}:[]}`,
    `{${JSON.stringify(PACKAGE_NAME)}:{"files":{}}}`,
    `{${JSON.stringify(PACKAGE_NAME)}:{"files":[{"size":1}]}}`,
    `{${JSON.stringify(PACKAGE_NAME)}:{${JSON.stringify(PACKAGE_NAME)}:${result}}}`, // nested twice
    `{"files":{},${JSON.stringify(PACKAGE_NAME)}:${result}}`, // a top-level "files" that is no list is not passed over
  ]) {
    assert.equal(packedFiles(text), undefined, text);
  }
});

// The tests below start the tool as a process with npm told to skip lifecycle scripts, as a user's own setting would.
const BUILD = `node -e "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/cli.js','')"`;
const skipsScripts = { ...offline, npm_config_ignore_scripts: 'true' };

test('as a process: with npm set to skip scripts, prepack still runs and the tree passes', () => {
  const root = tree({ ...goodPackage(), bin: { anchorset: 'dist/cli.js' }, scripts: { prepack: BUILD } });
  try {
    const r = spawnSync(process.execPath, [script, root], { encoding: 'utf8', env: skipsScripts });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(root, 'dist', 'cli.js')), true, 'prepack did not run');
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('as a process: with the skip set in a user-level npm config file, prepack still runs and the tree passes', () => {
  const userConfig = join(mkdtempSync(join(tmpdir(), 'anchorset-release-npmrc.')), 'npmrc');
  writeFileSync(userConfig, 'ignore-scripts=true\n');
  const root = tree({ ...goodPackage(), bin: { anchorset: 'dist/cli.js' }, scripts: { prepack: BUILD } });
  try {
    const r = spawnSync(process.execPath, [script, root], { encoding: 'utf8', env: { ...offline, npm_config_userconfig: userConfig } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(root, 'dist', 'cli.js')), true, 'prepack did not run');
  } finally {
    rmSync(root, { recursive: true });
    rmSync(join(userConfig, '..'), { recursive: true });
  }
});

test('as a process: an entry point that the manifest leaves out of "files" exits 2 and names the field', () => {
  // npm packs `main` and `bin` whatever "files" says; `types` it does not.
  const root = tree({ ...goodPackage(), types: 'dist/cli.js', scripts: { prepack: BUILD } });
  try {
    const r = spawnSync(process.execPath, [script, root], { encoding: 'utf8', env: offline });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /^ {2}fields: types$/m);
    assert.match(r.stderr, /in the tree but not in the list of files/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('as a process: a tree whose entry point no script builds exits 2 and names the field, under either npm setting', () => {
  for (const env of [offline, skipsScripts]) {
    const root = tree({ ...goodPackage(), bin: { anchorset: 'dist/cli.js' } });
    try {
      const r = spawnSync(process.execPath, [script, root], { encoding: 'utf8', env });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /^ {2}fields: bin$/m);
      assert.equal(r.stdout, '');
    } finally {
      rmSync(root, { recursive: true });
    }
  }
});

test('as a process: a project .npmrc is refused by name, and npm is not started', () => {
  const root = tree({ ...goodPackage(), scripts: { prepack: 'node -e "require(\'fs\').writeFileSync(\'npm-ran\', \'\')"' } });
  try {
    writeFileSync(join(root, '.npmrc'), 'ignore-scripts=true\n');
    const r = spawnSync(process.execPath, [script, root], { encoding: 'utf8', env: offline });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /^ {2}fields: \.\/\.npmrc$/m);
    assert.equal(existsSync(join(root, 'npm-ran')), false);
  } finally {
    rmSync(root, { recursive: true });
  }
});
