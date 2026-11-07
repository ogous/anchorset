import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { TOOL_VERSION } from '../src/index.ts';
import { main } from '../src/cli.ts';
import { PUBLIC_REPOSITORY_URL } from '../tools/release-tree-check.ts';
import { assertNoRateBesideRepeatedReading } from './helpers.ts';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// The plugin and this test travel together. Up to 0.3.0 the release tag held neither and a later commit added both; from
// 0.4.0 on, the release commit holds both.
// If this file is ever found in a tree that holds no plugin at all, the tests are skipped, with the reason printed, and
// nothing else changes. The skip is allowed only when neither plugin folder exists; in any tree that holds one of the
// two folders, a missing file is a failure, never a skip.
const here = (p: string): boolean => existsSync(new URL(`../${p}`, import.meta.url));
const withoutPlugin = !here('plugin') && !here('.claude-plugin');
const pluginTest = (name: string, fn: () => void): void => {
  if (withoutPlugin) test(name, { skip: 'this tree holds no plugin (no plugin/, no .claude-plugin/); the test travels with the plugin' }, fn);
  else test(name, fn);
};

// The plugin is a distribution file: it must name exactly the version of the package it sits beside.
pluginTest('the plugin manifest carries the package version', () => {
  const manifest = JSON.parse(read('plugin/.claude-plugin/plugin.json')) as { name: string; version: string };
  assert.equal(manifest.name, 'anchorset');
  assert.equal(manifest.version, TOOL_VERSION);
});

pluginTest('the skill pins the CLI to the package version, and to no other', () => {
  const skill = read('plugin/skills/anchorset/SKILL.md');
  const pins = [...skill.matchAll(/anchorset@([^\s`]+)/g)].map((m) => m[1]);
  assert.ok(pins.length >= 2);
  for (const pin of pins) assert.equal(pin, TOOL_VERSION);
  assert.ok(!/anchorset@latest/.test(skill));
});

// The same rule test/drift.test.ts holds the other shipped texts to; it is checked here because the skill file is not in every tree.
pluginTest('the skill puts no number on how often a repeated reading is called shifted', () => {
  assertNoRateBesideRepeatedReading(read('plugin/skills/anchorset/SKILL.md').replace(/\s+/g, ' '));
});

// The catalog serves the plugin from one released commit, never from whatever the default branch holds: a release
// commit carries the next version's plugin before that version is on npm, and a path source would hand it out at once.
// The pin names the commit by its full hash (Claude Code checks out `sha` when both it and `ref` are given); `ref`, when
// present, is the release tag. That the commit is on the pushed main, holds a version npm serves, and is the release tag's
// own commit (or the reviewed commit that stands for a release whose tag holds no plugin) is checked by the release
// process against the repository's history, which a copy of the files alone does not hold; this test holds the form, in
// CI and in any copy of the files.
pluginTest('the catalog pins the plugin to one commit of this repository', () => {
  const market = JSON.parse(read('.claude-plugin/marketplace.json')) as { plugins: { name: string; source: unknown }[] };
  assert.equal(market.plugins.length, 1);
  const { name, source } = market.plugins[0] as { name: string; source: unknown };
  assert.equal(name, 'anchorset');
  assert.ok(source !== null && typeof source === 'object' && !Array.isArray(source), 'the source is a pin, not a path');
  const pin = source as Record<string, unknown>;
  assert.ok(PUBLIC_REPOSITORY_URL.startsWith('git+'));
  assert.equal(pin.source, 'git-subdir');
  assert.equal(pin.url, PUBLIC_REPOSITORY_URL.slice('git+'.length));
  assert.equal(pin.path, 'plugin');
  assert.match(String(pin.sha), /^[0-9a-f]{40}$/);
  if ('ref' in pin) assert.match(String(pin.ref), /^v\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(pin).filter((k) => !['source', 'url', 'path', 'sha', 'ref'].includes(k)), []);
});

pluginTest('the skill states each exit code as the CLI does', () => {
  const skill = read('plugin/skills/anchorset/SKILL.md');
  const cli = read('src/cli.ts');
  assert.ok(cli.includes('exit codes: 0 ok · 1 regression · 2 refused comparison · 64 usage · 65 invalid input'));
  for (const phrase of ['1 is a regression', '2 is a refused comparison', '64 is a usage error', '65 is invalid input', 'They never exit 1']) {
    assert.ok(skill.replace(/\s+/g, ' ').includes(phrase.replace(/\s+/g, ' ')), phrase);
  }
  // The verdict line the skill tells the agent to look for is the one the CLI prints.
  assert.ok(cli.includes("verdict: ${code === EXIT_CODES.OK ? 'OK' : 'REGRESSION'}"));
  assert.ok(skill.includes('`verdict: OK`') && skill.includes('`verdict: REGRESSION`'));
});

// The rules are the plugin: a page that lost one would still install. Each is held by a phrase that carries its meaning.
pluginTest('the skill holds its seven rules and the two forms of a verdict', () => {
  const skill = read('plugin/skills/anchorset/SKILL.md');
  const cli = read('src/cli.ts');
  const flat = skill.replace(/\s+/g, ' ');
  for (const phrase of [
    '0 is no regression, 1 is a regression, 2 is a refused comparison',
    '0 means a report was printed',
    'Never call their exit 0 "passed"',
    "A verdict needs the tool's own verdict",
    '"kind": "evaluated"',
    '"kind": "refused"',
    'report the refusal as printed, with the fields it names, and stop',
    'Present no number from that',
    'Do not work around a refusal',
    'with other flag values',
    '`--allow-differ` only with fields the user names',
    'No statistics of your own',
    'Never write a run file, a run-input manifest, a bar, or a ratings or anchor file',
    'never run `write-run` on a manifest the user has not approved',
    'never one without the other and never their difference',
    '`validate`: 0 means `gate` would take the run',
    'never draft one',
    'the importers never read grades the user already has',
    'licensed under Apache-2.0',
    'Do not. A regression or a refusal is the result.',
    '`REFUSED <CODE>` and a `fields:` line on stderr',
    'a ratings or anchor file',
    'do not edit an input file to make it parse',
    'never fall back to another version or to `latest`',
    "Never start a paid re-grade without the user's word and the amount they allow for that run",
    'https://github.com/ogous/anchorset',
    "the agreeing count, each side's pass share and the bracket",
    'quote that line whole and report no kappa and no AC1',
    '(with `examples/importers/make-plan.ts`, run from a checkout at the release tag, and the flag values the user names)',
  ]) assert.ok(flat.includes(phrase.replace(/\s+/g, ' ')), phrase);
  // Rule 6 names the line the CLI prints when the two coefficients are withheld, and no line it does not print.
  assert.ok(flat.includes('`kappa and AC1: withheld (`') && cli.includes('kappa and AC1: withheld (${'));
  assert.ok(!flat.includes('no brackets') && !cli.includes('no brackets'));
  // Rule 7 names a script the repository holds.
  assert.ok(here('examples/importers/make-plan.ts'));
  // The text form of a refusal the skill describes is the one the CLI prints.
  assert.ok(cli.includes('REFUSED ${') && cli.includes('  fields: '));
  // The JSON spelling of a refusal is the one the CLI writes.
  assert.ok(cli.includes("kind: 'refused', command, code: r.code"));
  assert.equal([...skill.matchAll(/^\d\. \*\*/gm)].length, 7);
  // The JSON spelling of a verdict is the CLI's.
  assert.ok(cli.includes("kind: 'evaluated'") || cli.includes('kind: "evaluated"') || read('src/regression.ts').includes("'evaluated'"));
});

pluginTest('every command and flag the skill names is in the usage text of the CLI', () => {
  const skill = read('plugin/skills/anchorset/SKILL.md');
  const printed: string[] = [];
  assert.equal(main(['--help'], { out: (l: string) => void printed.push(l), err: () => {} }), 0);
  const usage = printed.join('\n');
  const table = skill.slice(skill.indexOf('| The user wants | Command |'), skill.indexOf('## Rules'));
  const commands = [...table.matchAll(/\| `([a-z-]+) /g)].map((m) => m[1]);
  assert.deepEqual([...new Set(commands)].sort(), ['agree', 'drift', 'flips', 'gate', 'judge-change', 'validate', 'write-run']);
  for (const c of commands) assert.ok(usage.includes(`anchorset ${c} `), c);
  for (const flag of new Set([...skill.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]))) {
    assert.ok(flag === '--help' || usage.includes(flag), flag);
  }
  // Each row's flags belong to that row's command: the usage text between its line and the next command's.
  const starts = [...usage.matchAll(/^  anchorset ([a-z-]+) /gm)].map((m) => ({ name: m[1] as string, at: m.index }));
  const usageOf = (name: string): string => {
    const i = starts.findIndex((s) => s.name === name);
    assert.ok(i >= 0, name);
    return usage.slice((starts[i] as { at: number }).at, starts[i + 1]?.at ?? usage.length);
  };
  const rows = [...table.matchAll(/\| `([a-z-]+) ([^`]*)`/g)];
  assert.equal(rows.length, 8);
  for (const row of rows) {
    const own = usageOf(row[1] as string);
    for (const flag of (row[2] as string).match(/--[a-z][a-z-]*/g) ?? []) assert.ok(own.includes(flag), `${row[1]} ${flag}`);
  }
  // No row carries --allow-differ: rule 5 of the skill leaves that flag to the user.
  assert.ok(!table.includes('--allow-differ'));
});

// A phrase check cannot see a sentence added beside a rule ("unless the user wants one"). The rules and the
// "make it pass" section are therefore held whole: an edit to them is deliberate, and re-pins this hash.
pluginTest('the rules of the skill are the reviewed text, byte for byte', () => {
  const skill = read('plugin/skills/anchorset/SKILL.md');
  const rules = skill.slice(skill.indexOf('## Rules'));
  assert.equal(createHash('sha256').update(rules, 'utf8').digest('hex'), '828f1b38a534b105e85a8ef7a1d7bd00fd6113dbfe9ceb175a6afbc5882d2a74');
});

// The plugin is a guide and nothing else: no script, no hook, no server, no command file.
pluginTest('the plugin holds two files and its manifests declare nothing that runs', () => {
  const files = (readdirSync(new URL('../plugin', import.meta.url), { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => `${e.parentPath.split('/plugin').pop() as string}/${e.name}`.replace(/^\//, ''))
    .sort();
  assert.deepEqual(files, ['.claude-plugin/plugin.json', 'skills/anchorset/SKILL.md']);
  const manifest = JSON.parse(read('plugin/.claude-plugin/plugin.json')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(manifest).sort(), ['author', 'description', 'keywords', 'license', 'name', 'repository', 'version']);
  assert.equal(manifest.license, 'Apache-2.0');
  const market = JSON.parse(read('.claude-plugin/marketplace.json')) as { plugins: Record<string, unknown>[] } & Record<string, unknown>;
  assert.deepEqual(Object.keys(market).sort(), ['description', 'name', 'owner', 'plugins']);
  assert.equal(market.plugins.length, 1);
  assert.deepEqual(Object.keys(market.plugins[0] as object).sort(), ['description', 'license', 'name', 'source']);
  assert.equal((market.plugins[0] as { license: string }).license, 'Apache-2.0');
  const front = /^---\nname: anchorset\ndescription: [^\n]+\n---\n/.exec(read('plugin/skills/anchorset/SKILL.md'));
  assert.ok(front !== null);
});

pluginTest('the marketplace description claims no verdict', () => {
  const market = read('.claude-plugin/marketplace.json');
  assert.ok(!/pass/i.test(market));
  assert.ok(!/pass/i.test(read('plugin/.claude-plugin/plugin.json')));
});

