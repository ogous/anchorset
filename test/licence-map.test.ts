import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The licence map names the true licence of third-party text the examples hold. Two tools' own grading texts are copied
// into examples/importers (as text files, and as the prompts their logs record); both tools are MIT. This test finds every
// file that holds one of those texts and checks that REUSE.toml gives it the tool's licence and its copyright line, that
// LICENSES/ holds the MIT text, and that NOTICE names the tool, its version and the line. `reuse lint` cannot see this:
// it checks that a file has a licence, not that the licence is the true one.

const root = new URL('../', import.meta.url);
const read = (p: string): string => readFileSync(new URL(p, root), 'utf8');

interface Upstream { readonly tool: string; readonly version: string; readonly copyright: string; readonly notice: string; readonly phrases: readonly string[] }
const UPSTREAM: readonly Upstream[] = [
  // Copyright lines are those of each release's own licence file (inspect_ai 0.3.275: dist-info/licenses/LICENSE; promptfoo 0.123.1: LICENSE), read on 2026-10-08.
  // `notice` is the line as that file prints it, word for word, which NOTICE carries; `copyright` is the same holder and year in the
  // year-then-holder form of an SPDX-FileCopyrightText field, which REUSE.toml carries.
  { tool: 'inspect_ai', version: '0.3.275', copyright: '2024 UK AI Security Institute', notice: 'Copyright (c) 2024 UK AI Security Institute', phrases: ['assessing a submitted answer on a given task', 'After assessing the submitted answer'] },
  { tool: 'promptfoo', version: '0.123.1', copyright: '2025 Promptfoo', notice: 'Copyright (c) Promptfoo 2025', phrases: ['grading output according to a user-specified rubric'] },
];

/** Every file under examples/ (as a path from the repository root) that holds a phrase, by tool. */
function holders(): Map<string, string[]> {
  const found = new Map<string, string[]>(UPSTREAM.map((u) => [u.tool, []]));
  const walk = (dir: string): void => {
    for (const name of readdirSync(new URL(dir, root)).sort()) {
      const rel = `${dir}${name}`;
      if (name === '__pycache__' || name === 'node_modules') continue;
      if (statSync(new URL(rel, root)).isDirectory()) { walk(`${rel}/`); continue; }
      let text: string;
      try { text = read(rel); } catch { continue; }
      for (const u of UPSTREAM) if (u.phrases.some((p) => text.includes(p))) found.get(u.tool)?.push(rel);
    }
  };
  walk('examples/');
  return found;
}

interface Annotation { path: string[]; copyright: string[]; licence: string; precedence: string }
/** The few shapes REUSE.toml uses here: [[annotations]] blocks of `key = "string"` and `key = ["a", "b"]`. Anything else throws. */
function parseReuse(text: string): Annotation[] {
  const out: Annotation[] = [];
  let cur: Record<string, string | string[]> | undefined;
  const flush = (): void => {
    if (cur === undefined) return;
    const asList = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
    const licence = cur['SPDX-License-Identifier'];
    assert.equal(typeof licence, 'string', 'an annotation without one licence expression');
    out.push({ path: asList(cur['path']), copyright: asList(cur['SPDX-FileCopyrightText']), licence: licence as string, precedence: typeof cur['precedence'] === 'string' ? cur['precedence'] : 'closest' });
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('version')) continue;
    if (line === '[[annotations]]') { flush(); cur = {}; continue; }
    const m = /^([A-Za-z-]+) = (.+)$/.exec(line);
    assert.ok(m !== null && cur !== undefined, `REUSE.toml: a line this test does not read: ${line}`);
    const v = (m[2] as string).trim();
    cur[m[1] as string] = v.startsWith('[') ? (JSON.parse(v) as string[]) : (JSON.parse(v) as string);
  }
  flush();
  return out;
}
const globToRegExp = (g: string): RegExp => new RegExp('^' + g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$');
/** The annotation REUSE.toml applies to a path: the last one that matches. */
const effective = (annotations: Annotation[], rel: string): Annotation | undefined => annotations.filter((a) => a.path.some((g) => globToRegExp(g).test(rel))).at(-1);

test('the files that hold a tool\'s own grading text are found: both tools, each in more than one file', () => {
  const found = holders();
  for (const u of UPSTREAM) assert.ok((found.get(u.tool) ?? []).length >= 2, `${u.tool}: fewer than two files hold its grading text`);
  assert.ok((found.get('inspect_ai') ?? []).includes('examples/importers/inspect/template.txt'));
  assert.ok((found.get('inspect_ai') ?? []).includes('examples/importers/inspect/instructions.txt'));
});

test('REUSE.toml gives every file that holds a tool\'s grading text the tool\'s licence and copyright line, overriding the file', () => {
  const annotations = parseReuse(read('REUSE.toml'));
  const found = holders();
  for (const u of UPSTREAM) {
    for (const rel of found.get(u.tool) ?? []) {
      const a = effective(annotations, rel);
      assert.ok(a !== undefined, `${rel}: no annotation`);
      assert.ok(a.licence.split(' AND ').includes('MIT'), `${rel}: licence ${a.licence} does not include MIT`);
      assert.ok(a.copyright.includes(u.copyright), `${rel}: the copyright line "${u.copyright}" is missing from ${JSON.stringify(a.copyright)}`);
      assert.equal(a.precedence, 'override', `${rel}: the annotation does not override`);
      // A text file that is only the tool's text is MIT alone; a log holds the tool's text and this repository's synthetic data.
      if (rel.endsWith('.txt')) assert.equal(a.licence, 'MIT', `${rel}: a copied text file is MIT and nothing else`);
      else assert.ok(a.licence.split(' AND ').every((l) => l === 'MIT' || l === 'Apache-2.0'), `${rel}: unexpected licence ${a.licence}`);
    }
  }
});

test('LICENSES/ holds the MIT text, and NOTICE names each tool, its version, its copyright line and MIT', () => {
  assert.ok(existsSync(new URL('LICENSES/MIT.txt', root)), 'LICENSES/MIT.txt is missing');
  const mit = read('LICENSES/MIT.txt');
  assert.ok(mit.startsWith('MIT License\n') && mit.includes('Permission is hereby granted, free of charge'), 'LICENSES/MIT.txt is not the MIT text');
  const notice = read('NOTICE').replace(/\s+/g, ' ');
  for (const u of UPSTREAM) {
    assert.ok(notice.includes(`${u.tool} ${u.version}`), `NOTICE does not name ${u.tool} ${u.version}`);
    assert.ok(notice.includes(u.notice), `NOTICE does not carry the upstream line "${u.notice}" word for word`);
  }
  assert.ok(/\bMIT\b/.test(notice), 'NOTICE does not say MIT');
});

test('this test reads the same tree it ships in: the example folders exist', () => {
  assert.ok(existsSync(join(new URL('examples/importers/inspect/', root).pathname, 'template.txt')));
});
