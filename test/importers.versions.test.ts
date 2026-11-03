// The importers' set of tested tool versions (examples/importers/tested-versions.json), and what a run records of the
// system log it was re-graded from. Every grader here calls only a fake endpoint on 127.0.0.1, with a dummy key. A test that
// needs an installed tool is skipped when none is named by ANCHORSET_INSPECT_VENV.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it, test } from 'node:test';
import { hashOf, readsAsGap, sha256Hex } from '../src/index.ts';
import { buildInspectRun, SYSTEM_LOG_MARKER } from '../examples/importers/inspect/import.ts';
import { convertPromptfoo } from '../examples/importers/promptfoo/import.ts';
import { ImportRefusal, loadTestedVersions, parseTestedVersions, TESTED_VERSIONS_SCHEMA } from '../examples/importers/shared.ts';
import type { CasesFile, TestedTool } from '../examples/importers/shared.ts';
import type { BarFile } from '../src/index.ts';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const root = join(import.meta.dirname, '..');
const importers = join(root, 'examples', 'importers');
const SET_FILE = join(importers, 'tested-versions.json');
const IN = join(importers, 'inspect');
const PF = join(importers, 'promptfoo');
const REGRADE = join(IN, 'regrade.py');
const CLI = join(root, 'src', 'cli.ts');
const MAKE_PLAN = join(importers, 'make-plan.ts');
const READING = 'one-json-object-boolean-pass/v1';
const work = mkdtempSync(join(tmpdir(), 'anchorset-versions-'));
after(() => rmSync(work, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => {
  const d = join(work, `d${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};

const CLEAN_ENV = { PATH: process.env['PATH'] ?? '' };
const node = (args: string[]) => spawnSync(process.execPath, args, { encoding: 'utf8', env: CLEAN_ENV, cwd: root });
const jsonFile = (p: string): J => JSON.parse(readFileSync(p, 'utf8')) as J;
const SETS = { inspect_ai: loadTestedVersions('inspect_ai'), promptfoo: loadTestedVersions('promptfoo') };

type Tool = { name: TestedTool; dir: string; importArgs: string[]; cut: string; c3Moved: string };
const TOOLS: readonly Tool[] = [
  { name: 'inspect_ai', dir: IN, importArgs: [], cut: 'C', c3Moved: 'refund-bot/c3  pass -> fail' },
  { name: 'promptfoo', dir: PF, importArgs: ['--reading', READING], cut: 'pass', c3Moved: 'refund_safety/refund-bot/c3  old judge fails draws [] · new judge fails draws [0, 1, 2]' },
];

/** Imports a result file through the importer's own command, and returns the run's path. */
function importTo(tool: Tool, source: string, out: string) {
  return node([join(tool.dir, 'import.ts'), '--in', source, '--cases', join(tool.dir, 'cases.json'), '--bar', join(tool.dir, 'bar.json'), '--out', out, ...tool.importArgs]);
}
function imported(tool: Tool, source: string, out: string): void {
  const r = importTo(tool, source, out);
  assert.equal(r.status, 0, `${source}: ${r.stderr}`);
}
const plan = (tool: Tool, dir: string, out: string, moves: string) =>
  node([MAKE_PLAN, '--old', join(dir, 'old.json'), '--new', join(dir, 'new.json'), '--bar', join(tool.dir, 'bar.json'), '--out', out, '--system', 'refund-bot', '--stored-outputs', 'system-side-not-compared', '--measured-class', 'refund_policy', '--cut', tool.cut, '--label-rule', 'majority', '--pooling', 'items-equal', '--estimate-draws', '0,1,2', '--judge-moves', moves]);
const judgeChange = (tool: Tool, dir: string, planFile: string, ...extra: string[]) => node([CLI, 'judge-change', '--plan', planFile, '--bar', join(tool.dir, 'bar.json'), '--inputs', dir, ...extra]);
const MODEL_MOVES = 'judgeModelRequested,judgeModelServed';

/** The report from its first measured line on: what the two judges did, with no hash or file name in it. */
const measured = (report: string): string => report.slice(report.indexOf('\nclass refund_policy'));

// ---------------------------------------------------------------------------------------------------------------
// One file, read by all four holders; a malformed file refuses
// ---------------------------------------------------------------------------------------------------------------

const realList = (): string => readFileSync(SET_FILE, 'utf8');
/** The same malformed files for the three readers. Each is a change to the real file's parsed value, or a text of its own. */
const MALFORMED: readonly (readonly [string, (d: J) => void] | readonly [string, string | Buffer])[] = [
  ['not JSON', '{ not json'],
  ['bytes that are not UTF-8', Buffer.concat([Buffer.from(realList().slice(0, 40)), Buffer.from([0xff, 0xfe]), Buffer.from(realList().slice(40))])],
  ['a byte order mark', `\ufeff${realList()}`],
  ['a key given twice through an escape', realList().replace('"schema":', '"schema": "example.tested-versions/v1", "\\u0073chema":')],
  ['a __proto__ key', realList().replace('"schema":', '"__proto__": {}, "schema":')],
  ['a file over the limit of one mebibyte', realList().replace('"schema":', `"pad": "${'x'.repeat(1024 * 1024)}", "schema":`)],
  ['a file nested too deep to read', `${'['.repeat(200000)}${']'.repeat(200000)}`],
  ['a format written 2.0', realList().replace('"format": 2', '"format": 2.0')],
  ['a format written 2e0', realList().replace('"format": 2', '"format": 2e0')],
  ['a format written 3.0, in the other tool', realList().replace('"format": 3', '"format": 3.0')],
  ['a format too large to count exactly', realList().replace('"format": 2', '"format": 9007199254740993')],
  ['a format that is true', realList().replace('"format": 2', '"format": true')],
  ['an impossible month', (d) => { d['tools'].promptfoo.versions[0].testedOn = '2026-13-01'; }],
  ['an impossible date, 2026-99-99', (d) => { d['tools'].inspect_ai.versions[1].testedOn = '2026-99-99'; }],
  ['the thirtieth of February', (d) => { d['tools'].promptfoo.versions[1].testedOn = '2026-02-30'; }],
  ['the twenty-ninth of February outside a leap year', (d) => { d['tools'].inspect_ai.versions[0].testedOn = '1900-02-29'; }],
  ['day zero', (d) => { d['tools'].inspect_ai.versions[0].testedOn = '2026-01-00'; }],
  ['the year zero', (d) => { d['tools'].inspect_ai.versions[0].testedOn = '0000-01-01'; }],
  ['a text of no-break spaces', (d) => { d['tools'].promptfoo.versions[0].runtimes = '\u00a0\u00a0'; }],
  ['a text with an unpaired surrogate', realList().replace('"schema":', '"schema":').replace('"runtimes": "node', '"runtimes": "\\ud800 node')],
  ['a key given twice', '{"schema":"example.tested-versions/v1","schema":"example.tested-versions/v1","tools":{}}'],
  ['another schema', (d) => { d['schema'] = 'example.tested-versions/v0'; }],
  ['an extra top-level key', (d) => { d['override'] = true; }],
  ['a tool missing', (d) => { delete d['tools'].promptfoo; }],
  ['a tool too many', (d) => { d['tools'].other = d['tools'].promptfoo; }],
  ['no format', (d) => { delete d['tools'].inspect_ai.format; }],
  ['a format that is not a positive integer', (d) => { d['tools'].promptfoo.format = 0; }],
  ['versions not a list', (d) => { d['tools'].inspect_ai.versions = '0.3.275'; }],
  ['an empty list', (d) => { d['tools'].inspect_ai.versions = []; }],
  ['a bare version in the list', (d) => { d['tools'].promptfoo.versions[0] = '0.123.1'; }],
  ['an entry with no grading-path read', (d) => { delete d['tools'].inspect_ai.versions[0].gradingPathRead; }],
  ['an empty grading-path read', (d) => { d['tools'].promptfoo.versions[0].gradingPathRead = '  '; }],
  ['an entry with an unknown key', (d) => { d['tools'].promptfoo.versions[0].extra = 'x'; }],
  ['a version with a space', (d) => { d['tools'].inspect_ai.versions[0].version = '0.3 .275'; }],
  ['a version that is not text', (d) => { d['tools'].inspect_ai.versions[0].version = 3; }],
  ['a date of another form', (d) => { d['tools'].promptfoo.versions[0].testedOn = '13 October'; }],
  ['a version listed twice', (d) => { d['tools'].inspect_ai.versions.push(structuredClone(d['tools'].inspect_ai.versions[0])); }],
];
/** What the three readers must also agree to take. */
const WELL_FORMED: readonly (readonly [string, (d: J) => void])[] = [
  ['the file as it stands', () => undefined],
  ['the twenty-ninth of February in a leap year', (d) => { d['tools'].promptfoo.versions[0].testedOn = '2028-02-29'; d['tools'].inspect_ai.versions[0].testedOn = '2000-02-29'; }],
  ['the last day of a year, in the first year', (d) => { d['tools'].promptfoo.versions[0].testedOn = '0001-12-31'; }],
];
const malformedText = (m: (typeof MALFORMED)[number]): string | Buffer => {
  const change = m[1];
  if (typeof change === 'string' || Buffer.isBuffer(change)) return change;
  const d = jsonFile(SET_FILE);
  change(d);
  return JSON.stringify(d);
};

/** A copy of the example folder's readers with another list beside them, so the real file is never touched. */
function treeWith(setText: string | Buffer | undefined): string {
  const d = fresh();
  mkdirSync(join(d, 'inspect'));
  mkdirSync(join(d, 'promptfoo'));
  for (const f of ['regrade.py', 'template.txt', 'instructions.txt']) copyFileSync(join(IN, f), join(d, 'inspect', f));
  copyFileSync(join(PF, 'grader-provider.cjs'), join(d, 'promptfoo', 'grader-provider.cjs'));
  if (setText !== undefined) writeFileSync(join(d, 'tested-versions.json'), setText);
  return d;
}

/** A Python of 3.10 or later, or undefined. */
function python(): string | undefined {
  return ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python'].find((p) => spawnSync(p, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)']).status === 0);
}
/** Runs regrade.py's `main` with the installed version stated and the package kept out of reach: nothing after the version check can run. */
function regradeAs(scriptPath: string, version: string) {
  const py = python();
  assert.ok(py !== undefined, 'a Python of 3.10 or later is needed here');
  const d = `import runpy, sys, importlib.metadata as m; m.version = lambda n: ${JSON.stringify(version)}; sys.modules["inspect_ai"] = None; sys.exit(runpy.run_path(${JSON.stringify(scriptPath)}, run_name="not_main")["main"](["--log", "no-such-log.json", "--epochs", "1", "--check"]))`;
  return spawnSync(py, ['-c', d], { encoding: 'utf8', env: CLEAN_ENV });
}
/** A folder shaped as an installed promptfoo, with its entry file. */
function installedPromptfoo(version: string): string {
  const home = join(fresh(), 'node_modules', 'promptfoo');
  mkdirSync(join(home, 'dist', 'src'), { recursive: true });
  writeFileSync(join(home, 'package.json'), JSON.stringify({ name: 'promptfoo', version }));
  const entry = join(home, 'dist', 'src', 'entrypoint.js');
  writeFileSync(entry, '');
  return entry;
}
const require = createRequire(import.meta.url);
/** Builds the JavaScript grader at `graderPath` as promptfoo of `version` would, with no call. */
function constructUnderPromptfoo(graderPath: string, version: string): void {
  const entry = installedPromptfoo(version);
  const saved = process.argv[1];
  process.argv[1] = entry;
  try {
    delete require.cache[graderPath];
    const Grader = require(graderPath) as new (o: unknown) => unknown;
    new Grader({ id: 'file://grader-provider.cjs', config: { model: 'm', max_tokens: 8, baseUrl: 'http://127.0.0.1:18765', thinking: 'NOT_SENT', effort: 'NOT_SENT', maxReasks: 0 } });
  } finally {
    if (saved === undefined) process.argv.length = 1;
    else process.argv[1] = saved;
    delete require.cache[graderPath];
  }
}

describe('the one list', () => {
  it('has the schema, both tools, the format of each and, for each entry, every field; its folders exist', () => {
    const d = jsonFile(SET_FILE);
    assert.equal(d['schema'], TESTED_VERSIONS_SCHEMA);
    assert.deepEqual(Object.keys(d['tools']).sort(), ['inspect_ai', 'promptfoo']);
    assert.equal(d['tools'].inspect_ai.format, 2);
    assert.equal(d['tools'].promptfoo.format, 3);
    for (const tool of TOOLS) {
      for (const e of SETS[tool.name].entries) {
        for (const folder of [e.fixtures, e.badFixtures]) assert.ok(statSync(join(importers, folder)).isDirectory(), folder);
        assert.ok(e.gradingPathRead.length > 40, `${tool.name} ${e.version}: the grading-path read is a written line`);
      }
    }
  });

  it('holds at most three versions per tool, the reference version plus the two newest', () => {
    for (const tool of TOOLS) assert.ok(SETS[tool.name].versions.length <= 3, tool.name);
  });

  it('no other copy of a version stands in the code of the two importers, regrade.py, the JavaScript grader, the shared file or the fixture script', () => {
    const versions = TOOLS.flatMap((t) => SETS[t.name].versions);
    const code = (text: string): string => text.split('\n').filter((l) => !/^\s*(\/\/|#|\*|\/\*)/.test(l)).join('\n');
    for (const f of ['inspect/import.ts', 'inspect/regrade.py', 'promptfoo/import.ts', 'promptfoo/grader-provider.cjs', 'shared.ts', 'fixtures.sh']) {
      const text = code(readFileSync(join(importers, f), 'utf8'));
      for (const v of versions) assert.ok(!text.includes(v), `${f} holds ${v} in code`);
    }
  });

  it('the TypeScript reader refuses every malformed list with IMPORT_SHAPE, naming the file', () => {
    for (const m of MALFORMED) {
      const text = malformedText(m);
      assert.throws(() => parseTestedVersions(Buffer.from(text), 'inspect_ai'), (e: unknown) => e instanceof ImportRefusal && e.code === 'IMPORT_SHAPE' && e.message.includes('tested-versions.json'), m[0]);
    }
  });

  it('regrade.py refuses every malformed or missing list: exit 64, before anything else, and no traceback', () => {
    for (const m of [...MALFORMED, ['no file', undefined] as const]) {
      const text = m[1] === undefined ? undefined : malformedText(m as (typeof MALFORMED)[number]);
      const r = regradeAs(join(treeWith(text), 'inspect', 'regrade.py'), SETS.inspect_ai.versions[0] as string);
      assert.equal(r.status, 64, `${m[0]}: ${r.stderr}`);
      assert.match(r.stderr, /^usage error: examples\/importers\/tested-versions\.json .*Nothing was written and no call was made\.\n$/, m[0]);
      assert.doesNotMatch(r.stderr, /Traceback/, m[0]);
    }
  });

  it('the JavaScript grader refuses every malformed or missing list under promptfoo, before any call', () => {
    for (const m of [...MALFORMED, ['no file', undefined] as const]) {
      const text = m[1] === undefined ? undefined : malformedText(m as (typeof MALFORMED)[number]);
      const grader = join(treeWith(text), 'promptfoo', 'grader-provider.cjs');
      assert.throws(() => constructUnderPromptfoo(grader, SETS.promptfoo.versions[0] as string), /^Error: grader: examples\/importers\/tested-versions\.json .*No call was made\.$/, m[0]);
    }
  });

  it('the three readers take the same well-formed lists', () => {
    for (const [what, change] of WELL_FORMED) {
      const d = jsonFile(SET_FILE);
      change(d);
      const text = JSON.stringify(d);
      assert.doesNotThrow(() => parseTestedVersions(Buffer.from(text), 'inspect_ai'), what);
      const tree = treeWith(text);
      const r = regradeAs(join(tree, 'inspect', 'regrade.py'), SETS.inspect_ai.versions[0] as string);
      assert.doesNotMatch(r.stderr, /tested-versions\.json/, what);
      assert.doesNotThrow(() => constructUnderPromptfoo(join(tree, 'promptfoo', 'grader-provider.cjs'), SETS.promptfoo.versions[0] as string), what);
    }
  });

  it('the JavaScript grader does not read the list when promptfoo is not its host: the skill-evals path needs no such file', () => {
    const grader = join(treeWith(undefined), 'promptfoo', 'grader-provider.cjs');
    delete require.cache[grader];
    const Grader = require(grader) as new (o: unknown) => unknown;
    assert.doesNotThrow(() => new Grader({ id: 'file://grader-provider.cjs', config: { model: 'm', max_tokens: 8, baseUrl: 'http://127.0.0.1:18765', thinking: 'NOT_SENT', effort: 'NOT_SENT', maxReasks: 0 } }));
    delete require.cache[grader];
  });

  it('the importers refuse a malformed list as well: the command exits 2 with IMPORT_SHAPE and writes nothing', () => {
    const d = fresh();
    const tree = join(d, 'examples', 'importers');
    mkdirSync(join(tree, 'inspect'), { recursive: true });
    copyFileSync(join(importers, 'shared.ts'), join(tree, 'shared.ts'));
    for (const f of ['import.ts', 'recording_grader.py', 'cases.json', 'bar.json']) copyFileSync(join(IN, f), join(tree, 'inspect', f));
    writeFileSync(join(tree, 'tested-versions.json'), '{ not json');
    // The copy imports the library by its relative path, so the library is linked in beside it.
    spawnSync('ln', ['-s', join(root, 'src'), join(d, 'src')]);
    const out = join(d, 'run.json');
    const r = node([join(tree, 'inspect', 'import.ts'), '--in', join(IN, 'fixtures', 'old-judge.json'), '--cases', join(tree, 'inspect', 'cases.json'), '--bar', join(tree, 'inspect', 'bar.json'), '--out', out]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /REFUSED IMPORT_SHAPE/);
    assert.ok(!existsSync(out));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Refusal outside the set
// ---------------------------------------------------------------------------------------------------------------

const casesOf = (tool: Tool): CasesFile => jsonFile(join(tool.dir, 'cases.json')) as CasesFile;
const barOf = (tool: Tool): BarFile => jsonFile(join(tool.dir, 'bar.json')) as unknown as BarFile;
const convert = (tool: Tool, bytes: Uint8Array): unknown =>
  tool.name === 'inspect_ai' ? buildInspectRun(bytes, 'log.json', casesOf(tool), barOf(tool)) : convertPromptfoo(bytes, 'result.json', casesOf(tool), barOf(tool), READING);
const stamp = (tool: Tool, d: J, version: unknown): void => {
  if (tool.name === 'inspect_ai') d['eval'].packages.inspect_ai = version;
  else d['metadata'].promptfooVersion = version;
};

describe('a file of a listed version imports, and every other version is refused by name', () => {
  for (const tool of TOOLS) {
    it(`${tool.name}: each listed version imports`, () => {
      for (const e of SETS[tool.name].entries) assert.doesNotThrow(() => convert(tool, readFileSync(join(importers, e.fixtures, 'old-judge.json'))), e.version);
    });

    it(`${tool.name}: another version is IMPORT_TOOL_VERSION, naming the file's version and the whole set`, () => {
      const set = SETS[tool.name];
      const source = jsonFile(join(importers, (set.entries[0] as { fixtures: string }).fixtures, 'old-judge.json'));
      for (const version of ['0.0.1', '9.9.9', `${set.versions[0]}.post1`]) {
        const d = structuredClone(source);
        stamp(tool, d, version);
        assert.throws(() => convert(tool, Buffer.from(JSON.stringify(d))), (e: unknown) => {
          assert.ok(e instanceof ImportRefusal);
          assert.equal(e.code, 'IMPORT_TOOL_VERSION');
          assert.ok(e.message.includes(version), e.message);
          assert.ok(e.message.includes(`${tool.name} ${set.versions.join(', ')}`), e.message);
          return true;
        });
      }
    });

    it(`${tool.name}: a version that is not text, or none, is refused`, () => {
      const set = SETS[tool.name];
      const source = jsonFile(join(importers, (set.entries[0] as { fixtures: string }).fixtures, 'old-judge.json'));
      for (const version of [undefined, 3, ['0.3.275']]) {
        const d = structuredClone(source);
        stamp(tool, d, version);
        assert.throws(() => convert(tool, Buffer.from(JSON.stringify(d))), (e: unknown) => e instanceof ImportRefusal && e.code === 'IMPORT_TOOL_VERSION', String(version));
      }
    });

    it(`${tool.name}: the file format outside the entry is refused too`, () => {
      const set = SETS[tool.name];
      const d = jsonFile(join(importers, (set.entries[0] as { fixtures: string }).fixtures, 'old-judge.json'));
      if (tool.name === 'inspect_ai') d['version'] = set.format + 1;
      else d['results'].version = set.format + 1;
      assert.throws(() => convert(tool, Buffer.from(JSON.stringify(d))), (e: unknown) => e instanceof ImportRefusal && e.code === 'IMPORT_TOOL_VERSION');
    });
  }

  it('there is no override flag: an importer takes no flag and reads no variable about versions', () => {
    for (const tool of TOOLS) {
      const r = node([join(tool.dir, 'import.ts'), '--tested-version', '9.9.9']);
      assert.equal(r.status, 64, r.stderr);
    }
    for (const f of ['inspect/import.ts', 'inspect/regrade.py', 'promptfoo/import.ts', 'promptfoo/grader-provider.cjs']) {
      assert.doesNotMatch(readFileSync(join(importers, f), 'utf8'), /(process\.env|environ)[^\n]*(VERSION|TESTED)/, f);
    }
  });
});

const refusalLines = (found: string, set: readonly string[]): string[] => [
  `usage error: inspect_ai ${found} is installed, and this importer was tested on inspect_ai ${set.join(', ')}.`,
  "Your system's log need not come from a tested version: it is read for its stored answers, and the run records its",
  'sha256 and the version it states. A log the tested tool cannot read is refused; one it misreads may not be detected. Grade from a separate environment:',
  `python -m venv .anchorset-grade && .anchorset-grade/bin/pip install inspect_ai==${set[set.length - 1]}`,
  'Nothing was written and no call was made.',
];

describe('an unlisted installed tool stops before any call', () => {
  it('regrade.py: exit 64, and the refusal text, word for word', () => {
    const r = regradeAs(REGRADE, '0.3.290');
    assert.equal(r.status, 64, r.stderr);
    assert.deepEqual(r.stderr.split('\n').slice(0, -1), refusalLines('0.3.290', SETS.inspect_ai.versions));
    assert.doesNotMatch(r.stderr, /If the tested tool cannot read it/);
  });

  it('regrade.py goes on under each listed version', () => {
    for (const v of SETS.inspect_ai.versions) {
      const r = regradeAs(REGRADE, v);
      assert.doesNotMatch(r.stderr, /is installed, and this importer was tested/, v);
    }
  });

  it('the JavaScript grader throws under an unlisted promptfoo, naming the set and the separate-environment command, and constructs under each listed one', () => {
    const grader = join(PF, 'grader-provider.cjs');
    const set = SETS.promptfoo.versions;
    assert.throws(() => constructUnderPromptfoo(grader, '0.124.0'), (e: unknown) => {
      const m = (e as Error).message;
      assert.match(m, /^grader: promptfoo 0\.124\.0 is running this grader/);
      assert.ok(m.includes(`tested on promptfoo ${set.join(', ')}`), m);
      assert.ok(m.includes(`npm install --prefix .anchorset-grade promptfoo@${set[set.length - 1]}`), m);
      assert.match(m, /No call was made\.$/);
      return true;
    });
    for (const v of set) assert.doesNotThrow(() => constructUnderPromptfoo(grader, v), v);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// What the run records
// ---------------------------------------------------------------------------------------------------------------

describe('the run records the version read from the file', () => {
  for (const tool of TOOLS) {
    for (const e of SETS[tool.name].entries) {
      it(`${tool.name} ${e.version}: in judgeDefinitionHash, judgeHarnessVersion and packetSource`, () => {
        const bytes = readFileSync(join(importers, e.fixtures, 'old-judge.json'));
        const out = join(fresh(), 'run.json');
        imported(tool, join(importers, e.fixtures, 'old-judge.json'), out);
        const run = jsonFile(out);
        const log = JSON.parse(bytes.toString('utf8')) as J;
        assert.ok(run['packetSource'].startsWith(`computed at import from ${tool.name} ${e.version} `), run['packetSource']);
        assert.ok(run['identity'].judgeHarnessVersion.startsWith(`${tool.name} ${e.version}; `), run['identity'].judgeHarnessVersion);
        if (tool.name === 'inspect_ai') {
          const o = log['eval'].scorers[0].options;
          assert.equal(run['identity'].judgeDefinitionHash, hashOf({ tool: 'inspect_ai', version: e.version, scorer: 'model_graded_qa', template: o.template, tools: [], reading: 'last-line-grade-letter/v1', maxReasks: 0 }));
        }
      });
    }
    it(`${tool.name}: two listed versions give different judge definition hashes`, () => {
      const hashes = SETS[tool.name].entries.map((e) => {
        const out = join(fresh(), 'run.json');
        imported(tool, join(importers, e.fixtures, 'old-judge.json'), out);
        return jsonFile(out)['identity'].judgeDefinitionHash;
      });
      assert.equal(new Set(hashes).size, SETS[tool.name].entries.length);
    });
  }
});

/** The sha256 of the import of the Inspect 0.3.275 old-judge.json, as it reads with the system-log text taken out. */
const OLD_JUDGE_BEFORE = 'fbb53bd679b4fb13b3b4c684b78cc27a00b8a1308d78752e6e7da99405b8cad6';
/** The same import as it stands: it differs in packetSource only, which gains `; system log UNKNOWN`. */
const OLD_JUDGE_NOW = '9d48a7a5900124f5a8676b8c4813da9c0606b63e0611fcb204df2a4640561f52';

test('the 0.3.275 old-judge.json gives the same run as before in every key but packetSource, which only gains the system-log text', () => {
  const tool = TOOLS[0] as Tool;
  const out = join(fresh(), 'run.json');
  imported(tool, join(IN, 'fixtures', 'old-judge.json'), out);
  const text = readFileSync(out, 'utf8');
  assert.equal(sha256Hex(text), OLD_JUDGE_NOW);
  assert.equal(text.split('; system log UNKNOWN').length, 2, 'the text stands once');
  assert.equal(sha256Hex(text.replace('; system log UNKNOWN', '')), OLD_JUDGE_BEFORE);
  assert.ok((jsonFile(out)['packetSource'] as string).endsWith("the question, answer and criterion slots of the grader's message; system log UNKNOWN"));
});

test('the example plans bind the run files the committed fixtures import to, so the guide\'s trial runs', () => {
  for (const tool of TOOLS) {
    const d = fresh();
    imported(tool, join(tool.dir, 'fixtures', 'old-judge.json'), join(d, 'old.json'));
    imported(tool, join(tool.dir, 'fixtures', 'new-judge.json'), join(d, 'new.json'));
    const p = jsonFile(join(tool.dir, 'plan.json'));
    assert.equal(p['systems']['refund-bot'].old, sha256Hex(readFileSync(join(d, 'old.json'))), tool.name);
    assert.equal(p['systems']['refund-bot'].new, sha256Hex(readFileSync(join(d, 'new.json'))), tool.name);
    const r = judgeChange(tool, d, join(tool.dir, 'plan.json'));
    assert.equal(r.status, 0, r.stderr);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The walk over every entry
// ---------------------------------------------------------------------------------------------------------------

describe('the walk over every entry', () => {
  for (const tool of TOOLS) {
    const entries = SETS[tool.name].entries;
    for (const e of entries) {
      describe(`${tool.name} ${e.version}`, () => {
        const d = fresh();
        it('imports the two judges\' files; judge-change gives the reference version\'s measurement', () => {
          imported(tool, join(importers, e.fixtures, 'old-judge.json'), join(d, 'old.json'));
          imported(tool, join(importers, e.fixtures, 'new-judge.json'), join(d, 'new.json'));
          const planFile = join(fresh(), 'plan.json');
          const p = plan(tool, d, planFile, MODEL_MOVES);
          assert.equal(p.status, 0, p.stderr);
          const r = judgeChange(tool, d, planFile);
          assert.equal(r.status, 0, r.stderr);
          assert.ok(r.stdout.includes(tool.c3Moved), r.stdout);
          const ref = entries[0] as (typeof entries)[number];
          const dRef = fresh();
          imported(tool, join(importers, ref.fixtures, 'old-judge.json'), join(dRef, 'old.json'));
          imported(tool, join(importers, ref.fixtures, 'new-judge.json'), join(dRef, 'new.json'));
          const planRef = join(fresh(), 'plan.json');
          assert.equal(plan(tool, dRef, planRef, MODEL_MOVES).status, 0);
          assert.equal(measured(r.stdout), measured(judgeChange(tool, dRef, planRef).stdout));
        });
        it('gate refuses the imported files', () => {
          const old = join(fresh(), 'old.json');
          const nw = join(fresh(), 'new.json');
          imported(tool, join(importers, e.fixtures, 'old-judge.json'), old);
          imported(tool, join(importers, e.fixtures, 'new-judge.json'), nw);
          const r = node([CLI, 'gate', '--baseline', old, '--candidate', nw, '--bar', join(tool.dir, 'bar.json')]);
          assert.equal(r.status, 2, r.stderr);
          assert.match(r.stderr + r.stdout, /IDENTITY_GAP/);
        });
        for (const bad of ['truncated', 'no-verdict', 'reask-exhausted']) {
          it(`refuses the bad-state file ${bad}`, () => {
            const out = join(fresh(), 'run.json');
            const r = importTo(tool, join(importers, e.badFixtures, `${bad}.json`), out);
            assert.equal(r.status, 2, r.stderr);
            assert.match(r.stderr, /REFUSED IMPORT_(UNGRADED|NO_RECORD)/);
            assert.ok(!existsSync(out));
          });
        }
      });
    }
  }
});

test('FIXTURES.sha256 holds the sha256 of every file it lists, and lists every fixture of every listed version', () => {
  const lines = readFileSync(join(importers, 'FIXTURES.sha256'), 'utf8').trimEnd().split('\n').map((l) => {
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(l);
    assert.ok(m !== null, l);
    return { sha: m[1] as string, path: m[2] as string };
  });
  for (const l of lines) assert.equal(sha256Hex(new Uint8Array(readFileSync(join(importers, l.path)))), l.sha, `${l.path}: run fixtures.sh again`);
  const listed = new Set(lines.map((l) => l.path));
  for (const tool of TOOLS) {
    for (const e of SETS[tool.name].entries) {
      for (const folder of [e.fixtures, e.badFixtures]) {
        for (const name of readdirSync(join(importers, folder))) {
          if (name.endsWith('.json')) assert.ok(listed.has(`${folder}/${name}`), `${folder}/${name}`);
        }
      }
    }
  }
  assert.ok(listed.has('tested-versions.json'));
});

// ---------------------------------------------------------------------------------------------------------------
// A cross-version pair
// ---------------------------------------------------------------------------------------------------------------

describe('a pair across two listed versions', () => {
  for (const tool of TOOLS) {
    const [a, b] = SETS[tool.name].entries;
    if (a === undefined || b === undefined) continue;
    const pair = (oldSource: string, newSource: string): string => {
      const d = fresh();
      imported(tool, join(importers, a.fixtures, oldSource), join(d, 'old.json'));
      imported(tool, join(importers, b.fixtures, newSource), join(d, 'new.json'));
      return d;
    };
    it(`${tool.name}: a wrong move list is refused, naming both fields, and no plan is written`, () => {
      const out = join(fresh(), 'plan.json');
      const r = plan(tool, pair('old-judge.json', 'old-judge.json'), out, 'judgeModelRequested');
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /IDENTITY_MISMATCH/);
      for (const f of ['judgeDefinitionHash', 'judgeHarnessVersion']) assert.ok(r.stderr.includes(f), r.stderr);
      assert.ok(!existsSync(out));
    });
    it(`${tool.name}: the right list runs, and no label differs at the same model`, () => {
      const d = pair('old-judge.json', 'old-judge.json');
      const out = join(fresh(), 'plan.json');
      const p = plan(tool, d, out, 'judgeDefinitionHash,judgeHarnessVersion');
      assert.equal(p.status, 0, p.stderr);
      const r = judgeChange(tool, d, out);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /labels that differ between the judges \(majority\) +0\.000/);
      assert.ok(!r.stdout.includes('pass -> fail'));
    });
    it(`${tool.name}: with the model moved as well, all four fields are named and printed`, () => {
      const d = pair('old-judge.json', 'new-judge.json');
      const out = join(fresh(), 'plan.json');
      const p = plan(tool, d, out, `${MODEL_MOVES},judgeDefinitionHash,judgeHarnessVersion`);
      assert.equal(p.status, 0, p.stderr);
      const r = judgeChange(tool, d, out);
      assert.equal(r.status, 0, r.stderr);
      for (const f of ['judgeModelRequested', 'judgeModelServed', 'judgeDefinitionHash', 'judgeHarnessVersion']) assert.ok(r.stdout.includes(f), f);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The marker, and the suffix forms
// ---------------------------------------------------------------------------------------------------------------

const INSPECT = TOOLS[0] as Tool;
const MARKED = join(importers, (SETS.inspect_ai.entries.find((e) => e.version !== SETS.inspect_ai.versions[0]) as { fixtures: string }).fixtures, 'old-judge.json');
const markedLog = (): J => jsonFile(MARKED);
const importLog = (d: J | string): J => (buildInspectRun(Buffer.from(typeof d === 'string' ? d : JSON.stringify(d)), 'log.json', casesOf(INSPECT), barOf(INSPECT)).run as J);
const SHA = 'a'.repeat(64);
const refusedShape = (d: J | string, what: string): void => {
  assert.throws(() => importLog(d), (e: unknown) => e instanceof ImportRefusal && e.code === 'IMPORT_SHAPE', what);
};

describe('the system-log marker', () => {
  it('a graded file with a marker: `; system log sha256:<hash>, stated version inspect_ai <version>`', () => {
    const log = markedLog();
    const m = log['eval'].metadata[SYSTEM_LOG_MARKER];
    assert.ok((importLog(log)['packetSource'] as string).endsWith(`; system log sha256:${m.sha256}, stated version inspect_ai ${m.version}`));
  });

  it('a marker that states no version: `; system log sha256:<hash>, stated version UNKNOWN`', () => {
    const log = markedLog();
    const m = { sha256: SHA, tool: 'inspect_ai', version: 'UNKNOWN' };
    log['eval'].metadata[SYSTEM_LOG_MARKER] = m;
    log['metadata'][SYSTEM_LOG_MARKER] = m;
    assert.ok((importLog(log)['packetSource'] as string).endsWith(`; system log sha256:${SHA}, stated version UNKNOWN`));
  });

  it('a graded file with no marker is not refused: `; system log UNKNOWN`', () => {
    const log = markedLog();
    delete log['eval'].metadata;
    delete log['metadata'][SYSTEM_LOG_MARKER];
    assert.ok((importLog(log)['packetSource'] as string).endsWith('; system log UNKNOWN'));
    assert.ok((importLog(jsonFile(join(IN, 'fixtures', 'old-judge.json')))['packetSource'] as string).endsWith('; system log UNKNOWN'));
  });

  it('other task metadata beside no marker changes nothing', () => {
    const log = markedLog();
    log['eval'].metadata = { other: 1 };
    log['metadata'] = { other: 1 };
    assert.ok((importLog(log)['packetSource'] as string).endsWith('; system log UNKNOWN'));
  });

  it('the promptfoo path: `; no system log`, on every listed version', () => {
    for (const e of SETS.promptfoo.entries) {
      const r = convertPromptfoo(readFileSync(join(importers, e.fixtures, 'old-judge.json')), 'r.json', casesOf(TOOLS[1] as Tool), barOf(TOOLS[1] as Tool), READING);
      assert.ok((r.run['packetSource'] as string).endsWith('; no system log'), e.version);
    }
  });

  const set = (value: unknown): J => {
    const log = markedLog();
    log['eval'].metadata[SYSTEM_LOG_MARKER] = value;
    log['metadata'][SYSTEM_LOG_MARKER] = value;
    return log;
  };
  for (const [what, value] of [
    ['not an object', 'sha256:x'],
    ['a list', []],
    ['no sha256', { tool: 'inspect_ai', version: '1' }],
    ['a short sha256', { sha256: 'abc', tool: 'inspect_ai', version: '1' }],
    ['an upper-case sha256', { sha256: SHA.toUpperCase(), tool: 'inspect_ai', version: '1' }],
    ['another tool', { sha256: SHA, tool: 'promptfoo', version: '1' }],
    ['no version', { sha256: SHA, tool: 'inspect_ai' }],
    ['a version that is not text', { sha256: SHA, tool: 'inspect_ai', version: 3 }],
    ['an empty version', { sha256: SHA, tool: 'inspect_ai', version: '' }],
    ['a version with a semicolon', { sha256: SHA, tool: 'inspect_ai', version: '1; system log UNKNOWN' }],
    ['a version with a comma', { sha256: SHA, tool: 'inspect_ai', version: '1,2' }],
    ['a version with a space', { sha256: SHA, tool: 'inspect_ai', version: '1 2' }],
    ['a version with a line feed', { sha256: SHA, tool: 'inspect_ai', version: '1\n2' }],
    ['a version outside ASCII', { sha256: SHA, tool: 'inspect_ai', version: '1é' }],
    ['a version that spells a gap', { sha256: SHA, tool: 'inspect_ai', version: 'unknown' }],
    ['an extra key', { sha256: SHA, tool: 'inspect_ai', version: '1', by: 'x' }],
    ['null', null],
  ] as const) {
    it(`a malformed marker refuses with IMPORT_SHAPE: ${what}`, () => refusedShape(set(value), what));
  }

  it('metadata that is not an object refuses', () => {
    const log = markedLog();
    log['eval'].metadata = 'x';
    log['metadata'] = {};
    refusedShape(log, 'metadata');
  });

  it('a duplicate marker refuses: the key twice in one object, a copy that differs, a marker at another place, the tool\'s copy with no marker', () => {
    const text = readFileSync(MARKED, 'utf8');
    const key = `"${SYSTEM_LOG_MARKER}": {`;
    const twice = text.replace(key, `"${SYSTEM_LOG_MARKER}": {"sha256":"${SHA}","tool":"inspect_ai","version":"1"}, ${key}`);
    assert.notEqual(twice, text);
    refusedShape(twice, 'the key twice');

    const differs = markedLog();
    differs['metadata'][SYSTEM_LOG_MARKER] = { sha256: SHA, tool: 'inspect_ai', version: '1' };
    refusedShape(differs, 'a copy that differs');

    const elsewhere = markedLog();
    elsewhere['samples'][0].metadata = { [SYSTEM_LOG_MARKER]: elsewhere['eval'].metadata[SYSTEM_LOG_MARKER] };
    refusedShape(elsewhere, 'a marker in a sample');

    const onlyCopy = markedLog();
    delete onlyCopy['eval'].metadata;
    refusedShape(onlyCopy, 'the copy alone');
  });
  it('a second marker under a root key with a slash refuses: places are compared key by key, and the message tells it from the real one', () => {
    const log = markedLog();
    log['eval/metadata'] = { [SYSTEM_LOG_MARKER]: { sha256: SHA, tool: 'inspect_ai', version: '9.9' } };
    assert.throws(
      () => importLog(log),
      (e: unknown) => e instanceof ImportRefusal && e.code === 'IMPORT_SHAPE' && e.fields.includes(`/eval~1metadata/${SYSTEM_LOG_MARKER}`) && e.message.includes(`/eval~1metadata/${SYSTEM_LOG_MARKER}`),
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Nothing compares the marker
// ---------------------------------------------------------------------------------------------------------------

test('two re-grades that differ only in the system log\'s stated version still compare in judge-change, with the same measurement', () => {
  const tool = INSPECT;
  const b = (SETS.inspect_ai.entries.find((e) => e.version !== SETS.inspect_ai.versions[0]) as { fixtures: string }).fixtures;
  const statedAs = (source: string, version: string): string => {
    const log = jsonFile(join(importers, b, source));
    const m = { ...log['eval'].metadata[SYSTEM_LOG_MARKER], version };
    log['eval'].metadata[SYSTEM_LOG_MARKER] = m;
    log['metadata'][SYSTEM_LOG_MARKER] = m;
    const p = join(fresh(), source);
    writeFileSync(p, JSON.stringify(log));
    return p;
  };
  const same = fresh();
  imported(tool, statedAs('old-judge.json', '0.3.299'), join(same, 'old.json'));
  imported(tool, statedAs('new-judge.json', '0.3.299'), join(same, 'new.json'));
  const moved = fresh();
  imported(tool, statedAs('old-judge.json', '0.3.299'), join(moved, 'old.json'));
  imported(tool, statedAs('new-judge.json', 'UNKNOWN'), join(moved, 'new.json'));
  assert.notEqual(jsonFile(join(same, 'new.json'))['packetSource'], jsonFile(join(moved, 'new.json'))['packetSource']);
  assert.deepEqual(jsonFile(join(same, 'new.json'))['identity'], jsonFile(join(moved, 'new.json'))['identity']);
  const planSame = join(fresh(), 'plan.json');
  const planMoved = join(fresh(), 'plan.json');
  assert.equal(plan(tool, same, planSame, MODEL_MOVES).status, 0);
  const p = plan(tool, moved, planMoved, MODEL_MOVES);
  assert.equal(p.status, 0, p.stderr);
  const r = judgeChange(tool, moved, planMoved);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(measured(r.stdout), measured(judgeChange(tool, same, planSame).stdout));
});

// ---------------------------------------------------------------------------------------------------------------
// The stated version and the count, in the script: no tool needed
// ---------------------------------------------------------------------------------------------------------------

function pyFunc(body: string): { status: number | null; stdout: string; stderr: string } {
  const py = python();
  assert.ok(py !== undefined, 'a Python of 3.10 or later is needed here');
  return spawnSync(py, ['-c', `import json, runpy\nfrom types import SimpleNamespace as NS\nm = runpy.run_path(${JSON.stringify(REGRADE)}, run_name="not_main")\n${body}`], { encoding: 'utf8', env: CLEAN_ENV });
}

describe('regrade.py: the stated version, as the run may record it', () => {
  const taken = ['0.3.286', '0.3.299', '1.0.0rc1', '1+local.2', 'UNKNOWN-1'];
  const gap = [null, 3, '', ' ', '0.3.286\n', '0.3 286', '0.3.2é', '0.3;1', '0.3,1', '\u001b[2K', 'unknown', 'UNKNOWN', 'N/A', 'none', 'null', 'not_sent', 'NOT-SENT', 'undefined', 'nil'];
  it('keeps a version of visible ASCII; every other value becomes UNKNOWN, decided before any call', () => {
    const r = pyFunc(`print(json.dumps([m["recorded_version"](v) for v in json.loads(${JSON.stringify(JSON.stringify([...taken, ...gap]))})]))`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [...taken, ...gap.map(() => 'UNKNOWN')]);
  });
  it('spells a gap exactly as the library does', () => {
    const spellings = ['unknown', 'N/A', 'n.a', 'none', 'null', 'nil', 'undefined', 'not sent', 'Not-Sent', 'not_sent', '0.3.286', 'known', 'nan'];
    const r = pyFunc(`print(json.dumps([m["recorded_version"](v) for v in json.loads(${JSON.stringify(JSON.stringify(spellings.map((s) => s.replaceAll(' ', '_'))))})]))`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual((JSON.parse(r.stdout) as string[]).map((v) => v === 'UNKNOWN'), spellings.map((s) => readsAsGap(s)));
  });
  it('holds the same list of spellings as the library', () => {
    const r = pyFunc('print(json.dumps(sorted(m["GAP_SPELLINGS"])))');
    assert.equal(r.status, 0, r.stderr);
    for (const s of JSON.parse(r.stdout) as string[]) assert.ok(readsAsGap(s), s);
  });
});

describe('regrade.py: the count of answers a log states', () => {
  const results = (fields: Record<string, number>): string => `NS(model_fields_set=set(${JSON.stringify(Object.keys(fields))}), ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(', ')})`;
  const problems = (res: string, read: number): string[] => {
    const r = pyFunc(`print(json.dumps(m["count_problems"](NS(results=${res}), ${read})))`);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout) as string[];
  };
  it('no problem when both stated counts are the number read', () => {
    assert.deepEqual(problems(results({ total_samples: 3, completed_samples: 3 }), 3), []);
    assert.deepEqual(problems(results({ total_samples: 6, completed_samples: 6 }), 6), []);
    assert.deepEqual(problems(results({ total_samples: 3 }), 3), [], 'total_samples is the count; completed_samples is checked where stated');
  });
  it('a log with no results, or none stating the field, states no count: a value the tool filled in is not a statement', () => {
    for (const res of ['None', 'NS(model_fields_set=set(), total_samples=0, completed_samples=0)', 'NS(model_fields_set={"completed_samples"}, total_samples=0, completed_samples=3)']) {
      assert.deepEqual(problems(res, 3), ['the log does not state how many answers it holds (results.total_samples)'], res);
    }
  });
  it('a stated count that differs from the number read is a problem, in either direction and in either field', () => {
    assert.deepEqual(problems(results({ total_samples: 4, completed_samples: 3 }), 3), ['the log states 4 answers (results.total_samples) and 3 were read']);
    assert.deepEqual(problems(results({ total_samples: 2, completed_samples: 3 }), 3), ['the log states 2 answers (results.total_samples) and 3 were read']);
    assert.deepEqual(problems(results({ total_samples: 3, completed_samples: 2 }), 3), ['the log states 2 completed answers (results.completed_samples) and 3 were read']);
    assert.deepEqual(problems(results({ total_samples: 0, completed_samples: 0 }), 3), ['the log states 0 answers (results.total_samples) and 3 were read', 'the log states 0 completed answers (results.completed_samples) and 3 were read']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The count, on a real installed tool, through the fake endpoint
// ---------------------------------------------------------------------------------------------------------------

/** The Python named by ANCHORSET_INSPECT_VENV, when it holds a listed version. */
function namedVenv(): { py: string; version: string } | undefined {
  const venv = process.env['ANCHORSET_INSPECT_VENV'];
  if (venv === undefined || venv === '') return undefined;
  const py = join(venv, 'bin', 'python');
  const r = spawnSync(py, ['-c', 'import importlib.metadata as m; print(m.version("inspect_ai"))'], { encoding: 'utf8', env: CLEAN_ENV });
  const version = r.stdout.trim();
  return r.status === 0 && SETS.inspect_ai.versions.includes(version) ? { py, version } : undefined;
}
const SKIP = 'no listed inspect_ai named by ANCHORSET_INSPECT_VENV';
const TOOL_ENV = { ...CLEAN_ENV, ANTHROPIC_API_KEY: 'dummy-key-for-local-fake-endpoint', HOME: work, HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1', PYTHONDONTWRITEBYTECODE: '1' };
const SOURCE = join(IN, 'fixtures', 'source.json');
const WRITTEN_BY_THE_OTHER = (b: string): string => join(importers, (SETS.inspect_ai.entries.find((e) => e.version !== b) as { fixtures: string }).fixtures, 'source.json');

/** Starts the fake endpoint on a free port. It answers only on 127.0.0.1. */
async function withEndpoint<T>(fn: (baseUrl: string, requests: () => number) => T | Promise<T>): Promise<T> {
  const log = join(fresh(), 'requests.jsonl');
  const ep = spawn(process.execPath, [join(importers, 'fake-endpoint.ts'), '--port', '0', '--reply-format', 'grade', '--log', log], { env: CLEAN_ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const port = await new Promise<string>((resolve, reject) => {
      let err = '';
      ep.stderr.on('data', (c: Buffer) => {
        err += c.toString();
        const m = /listening on 127\.0\.0\.1:(\d+)/.exec(err);
        if (m !== null) resolve(m[1] as string);
      });
      ep.on('exit', (code) => reject(new Error(`the endpoint exited ${String(code)}: ${err}`)));
    });
    return await fn(`http://127.0.0.1:${port}`, () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l !== '').length : 0));
  } finally {
    ep.kill();
  }
}
const editedLog = (edit: (d: J) => void, from = SOURCE): string => {
  const d = jsonFile(from);
  edit(d);
  const p = join(fresh(), 'log.json');
  writeFileSync(p, JSON.stringify(d));
  return p;
};
const check = (py: string, log: string) => spawnSync(py, [REGRADE, '--log', log, '--epochs', '1', '--check'], { encoding: 'utf8', env: TOOL_ENV, cwd: fresh() });
const grade = (py: string, log: string, base: string, out: string) =>
  spawnSync(py, [REGRADE, '--log', log, '--epochs', '1', '--judge-model', 'fake-judge-old', '--max-tokens', '256', '--temperature', '0', '--thinking', 'NOT_SENT', '--effort', 'NOT_SENT', '--max-reasks', '0', '--base-url', base, '--out-dir', out], { encoding: 'utf8', env: TOOL_ENV, cwd: fresh() });
const oneJson = (dir: string): string => join(dir, readdirSync(dir).find((f) => f.endsWith('.json')) as string);
/** A log read by the installed tool; the cases file is stated, one draw per case. */
const importOneDraw = (graded: string): J => jsonFile((() => {
  const out = join(fresh(), 'run.json');
  imported(INSPECT, graded, out);
  return out;
})());

describe('the system log need not come from a tested version', () => {
  const cases = (other: string): readonly (readonly [string, string, string])[] => [
    ['stating a version outside the set', editedLog((d) => { d['eval'].packages.inspect_ai = '0.3.299'; }), 'inspect_ai 0.3.299'],
    ['stating none', editedLog((d) => { delete d['eval'].packages; }), 'UNKNOWN'],
    ['written by another listed version', other, ''],
    ['stating an unprintable version', editedLog((d) => { d['eval'].packages.inspect_ai = '0.3.2é'; }), 'UNKNOWN'],
    ['stating a version with a semicolon', editedLog((d) => { d['eval'].packages.inspect_ai = '0.3;fake'; }), 'UNKNOWN'],
    ['stating a version with a comma', editedLog((d) => { d['eval'].packages.inspect_ai = '0.3,fake'; }), 'UNKNOWN'],
    ['stating a version that spells a gap', editedLog((d) => { d['eval'].packages.inspect_ai = 'n/a'; }), 'UNKNOWN'],
  ];

  it('each passes --check, which prints the sha256 and the stated version as recorded, not required; re-graded and imported, the run holds that value', async (t) => {
    const named = namedVenv();
    if (named === undefined) {
      t.skip(SKIP);
      return;
    }
    await withEndpoint(async (base, requests) => {
      for (const [what, log, statedAs] of cases(WRITTEN_BY_THE_OTHER(named.version))) {
        const sha = sha256Hex(new Uint8Array(readFileSync(log)));
        const stated = statedAs !== '' ? statedAs : `inspect_ai ${(jsonFile(log)['eval'].packages.inspect_ai as string)}`;
        const c = check(named.py, log);
        assert.equal(c.status, 0, `${what}: ${c.stderr}`);
        assert.ok(c.stdout.includes(`system log: sha256 ${sha}, stated version ${stated} (recorded, not required)`), `${what}: ${c.stdout}`);
        const out = fresh();
        const before = requests();
        const g = grade(named.py, log, base, out);
        assert.equal(g.status, 0, `${what}: ${g.stderr}`);
        assert.equal(requests() - before, 3, 'one call per slot, all to the fake endpoint');
        const run = importOneDraw(oneJson(out));
        assert.ok((run['packetSource'] as string).endsWith(`; system log sha256:${sha}, stated version ${stated}`), `${what}: ${run['packetSource'] as string}`);
        // The tool that re-grades is what the run names as the judge's: a log's stated version is never in an identity field.
        assert.ok((run['identity'].judgeHarnessVersion as string).startsWith(`inspect_ai ${named.version}; `));
      }
    });
  });

  it('a version that is not text is one the tested tool cannot read: refused, nothing sent', (t) => {
    const named = namedVenv();
    if (named === undefined) {
      t.skip(SKIP);
      return;
    }
    const c = check(named.py, editedLog((d) => { d['eval'].packages.inspect_ai = 7; }));
    assert.equal(c.status, 2, c.stderr);
    assert.match(c.stderr, /^refused: the source log cannot be read/);
  });

  it('the marker the script writes is at /eval/metadata, with the tool\'s copy at /metadata and nowhere else', async (t) => {
    const named = namedVenv();
    if (named === undefined) {
      t.skip(SKIP);
      return;
    }
    await withEndpoint((base) => {
      const out = fresh();
      const g = grade(named.py, SOURCE, base, out);
      assert.equal(g.status, 0, g.stderr);
      const log = jsonFile(oneJson(out));
      const expected = { sha256: sha256Hex(new Uint8Array(readFileSync(SOURCE))), tool: 'inspect_ai', version: jsonFile(SOURCE)['eval'].packages.inspect_ai };
      assert.deepEqual(log['eval'].metadata[SYSTEM_LOG_MARKER], expected);
      assert.deepEqual(log['metadata'][SYSTEM_LOG_MARKER], expected);
      assert.equal(JSON.stringify(log).split(`"${SYSTEM_LOG_MARKER}"`).length - 1, 2);
      assert.equal(log['eval'].packages.inspect_ai, named.version);
    });
  });
});

describe('the count, on a real log: refused before any call', () => {
  // A check makes no call. A run is pointed at a port nothing answers on, so that a call would end in another refusal.
  const DEAD = 'http://127.0.0.1:9';
  const refused = (py: string, log: string, line: RegExp): void => {
    for (const r of [check(py, log), grade(py, log, DEAD, join(work, `never-${++n}`))]) {
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /^refused: the source log cannot be replayed \(\d+ problem\(s\)\)\. Nothing was sent\./);
      assert.match(r.stderr, line);
    }
  };
  const withVenv = (name: string, fn: (py: string) => void): void => {
    it(name, (t) => {
      const named = namedVenv();
      if (named === undefined) {
        t.skip(SKIP);
        return;
      }
      fn(named.py);
    });
  };
  const NO_COUNT = /the log does not state how many answers it holds \(results\.total_samples\)/;
  withVenv('every committed source log states its count, and passes', (py) => {
    const c = check(py, SOURCE);
    assert.equal(c.status, 0, c.stderr);
  });
  withVenv('total_samples removed is refused', (py) => refused(py, editedLog((d) => { delete d['results'].total_samples; }), NO_COUNT));
  withVenv('the whole results block removed is refused', (py) => refused(py, editedLog((d) => { delete d['results']; }), NO_COUNT));
  withVenv('completed_samples removed alone is not refused: total_samples is the count', (py) => {
    const c = check(py, editedLog((d) => { delete d['results'].completed_samples; }));
    assert.equal(c.status, 0, c.stderr);
  });
  withVenv('a wrong count, too many, is refused', (py) => refused(py, editedLog((d) => { d['results'].total_samples = 4; }), /the log states 4 answers \(results\.total_samples\) and 3 were read/));
  withVenv('a wrong count, too few, is refused', (py) => refused(py, editedLog((d) => { d['results'].total_samples = 2; }), /the log states 2 answers \(results\.total_samples\) and 3 were read/));
  withVenv('a sample dropped from the log is refused', (py) => refused(py, editedLog((d) => { d['samples'].pop(); }), /the log states 3 answers \(results\.total_samples\) and 2 were read/));
  withVenv('a wrong completed count is refused', (py) => refused(py, editedLog((d) => { d['results'].completed_samples = 2; }), /the log states 2 completed answers \(results\.completed_samples\) and 3 were read/));
  withVenv('the count holds epochs: a log of two epochs states six and holds six, so the count passes and the duplicate ids are what refuse it', (py) => {
    const c = check(py, editedLog((d) => {
      d['eval'].config.epochs = 2;
      d['results'].total_samples = 6;
      d['results'].completed_samples = 6;
      d['samples'] = [...d['samples'], ...d['samples'].map((s: J) => ({ ...s, epoch: 2 }))];
    }));
    assert.equal(c.status, 2, c.stderr);
    assert.doesNotMatch(c.stderr, /results\.total_samples/);
    assert.match(c.stderr, /occurs 2 times/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The watch, CI and the texts
// ---------------------------------------------------------------------------------------------------------------

describe('the weekly watch', () => {
  const text = readFileSync(join(root, '.github', 'workflows', 'tool-watch.yml'), 'utf8');
  const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const jobs = text.slice(text.indexOf('\njobs:'));
  /** One job's text: from its key, at two spaces, to the next job's. */
  const job = (name: string): string => {
    const at = jobs.indexOf(`\n  ${name}:\n`);
    assert.ok(at >= 0, name);
    const rest = jobs.slice(at + 1);
    const next = /\n {2}[a-z-]+:\n/.exec(rest.slice(1));
    return next === null ? rest : rest.slice(0, next.index + 1);
  };
  it('runs on a schedule and by hand only, so it never runs on a push or a pull request', () => {
    assert.match(text, /\non:\n {2}schedule:\n/);
    assert.match(text, /workflow_dispatch:/);
    assert.doesNotMatch(text.slice(0, text.indexOf('\njobs:')), /\bpush:|pull_request/);
  });
  it('names no secret', () => {
    assert.doesNotMatch(text, /secrets\./);
    assert.doesNotMatch(text, /ANTHROPIC_API_KEY: *\$\{\{/);
  });
  it('separates installing the candidate from writing the issue: the job with write access installs nothing and runs nothing it fetched', () => {
    const issue = job('report');
    assert.match(issue, /issues: write/);
    assert.doesNotMatch(issue, /pip install|npm install|npm ci|uses: actions\/checkout/);
    const walk = job('candidate');
    assert.match(walk, /contents: read/);
    assert.doesNotMatch(walk, /issues: write|GH_TOKEN|github\.token/);
    assert.match(walk, /watch-candidate\.sh/);
  });
  it('its failure cannot fail ci.yml: neither workflow names the other', () => {
    assert.ok(!ci.includes('tool-watch'));
    assert.ok(!text.includes('ci.yml'));
    assert.doesNotMatch(ci, /workflow_run/);
  });
  it('adds no entry to the list itself: the candidate script changes a copy of the tree only', () => {
    const script = readFileSync(join(importers, 'watch-candidate.sh'), 'utf8');
    assert.match(script, /scratch copy/);
    assert.doesNotMatch(text, /git (push|commit)/);
    assert.doesNotMatch(script, /git (push|commit)/);
  });
});

test('no file under examples/ holds a path of a machine', () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === '__pycache__' || e.name === 'node_modules' ? [] : e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  const files = walk(join(root, 'examples'));
  assert.ok(files.length > 50, `only ${files.length} files were read`);
  const held = files.filter((f) => ['/private/tmp', '/Users/', '/var/folders/'].some((p) => readFileSync(f).includes(p))).map((f) => f.slice(root.length + 1));
  assert.deepEqual(held, []);
});

describe('CI and the texts follow the list', () => {
  it('ci.yml walks the list and pins no version of its own', () => {
    const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.match(ci, /tested-versions\.json/);
    for (const tool of TOOLS) for (const v of SETS[tool.name].versions) assert.ok(!ci.includes(v), `ci.yml holds ${v}`);
    assert.doesNotMatch(ci, /pip install inspect_ai==[0-9]|promptfoo@[0-9]/);
  });
  for (const f of ['docs/IMPORTERS.md', 'README.md', 'NOTICE', 'CHANGELOG.md']) {
    it(`${f} names every listed version`, () => {
      const text = readFileSync(join(root, f), 'utf8').replace(/\s+/g, ' ');
      for (const tool of TOOLS) for (const v of SETS[tool.name].versions) assert.ok(text.includes(v), `${f} does not name ${tool.name} ${v}`);
    });
  }
  it('the guide states the marker\'s limits in its stated words, and what is and is not pinned', () => {
    const guide = readFileSync(join(root, 'docs', 'IMPORTERS.md'), 'utf8').replace(/\s+/g, ' ');
    assert.ok(guide.includes('A malformed or duplicate marker refuses. A file with no marker records `; system log UNKNOWN`. A marker does not show who wrote it: a hand-written file can carry one, which stays a stated limit.'));
    assert.ok(guide.includes('A log the tested tool cannot read is refused; one it misreads may not be detected.'));
    assert.ok(guide.includes('does not state how many answers it holds'));
    assert.ok(!guide.includes('If the tested tool cannot read it'));
  });
  it('the row-profile sentence goes in with the guide: a changed tool that writes the same row shapes is not detected', () => {
    assert.ok(readFileSync(join(root, 'docs', 'IMPORTERS.md'), 'utf8').replace(/\s+/g, ' ').includes('A changed tool that writes the same row shapes is not detected'));
  });
});
